// The executor transport: an opt-in bash runner that hands each command to the
// isolated machine's trusted supervisor over a Unix socket, which runs it in
// the secret-free executor, instead of spawning it in the runtime. These tests
// stand a scripted supervisor on a real socket. Every failure must surface as
// an error the bash tool reports: nothing falls back to a local spawn.
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { MapEnv } from "../../../testing/fakes/map-env.ts";
import { unixSocketBindSkip } from "../../../testing/unix-socket-bind.ts";
import { nodeSocketHost } from "../../transport/mod.ts";
import {
  BASH_ALLOWLIST_BASIS,
  BASH_COMMAND_ENV_KEYS,
  defineBash,
} from "./exec.ts";
import { defineGit, GIT_COMMAND_ENV_KEYS } from "./git.ts";

const transportModule = () => import("./executor-transport.ts");

// One suite around the whole file: its `after` closes every supervisor and
// removes their directory before the root-level hooks run, among them the
// gate's per-file handle check, which otherwise could look while the
// recursive removal was still in flight.
// The suite runs scripted socket servers. Where the sandbox refuses the bind it
// skips with that reason, never under CI (`unix-socket-bind.ts`).
const socketSkip = await unixSocketBindSkip();

describe("the executor transport", { skip: socketSkip ?? false }, () => {
  let dir: string;

  before(async () => {
    // The lane's TMPDIR, which the gate keeps short enough for socket paths.
    dir = await mkdtemp(join(tmpdir(), "dyfj-exec-"));
  });

  // Every scripted supervisor, closed before the directory holding their
  // sockets is removed, so no socket unlink is still pending when the file ends.
  const servers: Server[] = [];

  after(async () => {
    await Promise.all(
      servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    await rm(dir, { recursive: true, force: true });
  });

  let counter = 0;

  /** A scripted supervisor: `reply` answers each request's first line. */
  async function supervisor(
    reply: (request: any, socket: Socket) => void,
  ): Promise<{ path: string; requests: any[]; server: Server }> {
    const path = `${dir}/s${counter++}.sock`;
    const requests: any[] = [];
    const server = createServer((socket) => {
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const end = buffer.indexOf("\n");
        if (end === -1) return;
        const request = JSON.parse(buffer.slice(0, end));
        requests.push(request);
        reply(request, socket);
      });
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve) => server.listen(path, resolve));
    servers.push(server);
    return { path, requests, server };
  }

  function answer(socket: Socket, response: unknown) {
    socket.end(`${JSON.stringify(response)}\n`);
  }

  const OK = {
    v: 2,
    code: 0,
    signal: null,
    stdout: "hello\n",
    stderr: "",
    timedOut: false,
  };

  async function runner(path: string, options: Record<string, number> = {}) {
    const { createExecutorRunner } = await transportModule();
    return createExecutorRunner(path, nodeSocketHost.connect, options);
  }

  const dialExecutor = nodeSocketHost.connect;

  describe("a command handed to the executor", () => {
    it("sends one versioned request and returns the supervisor's result", async () => {
      const s = await supervisor((_, socket) => answer(socket, OK));
      const run = await runner(s.path);
      const result = await run("echo hello", "/run/dyfj/workspace", 5_000, {
        PATH: "/usr/bin",
      });
      assert.deepStrictEqual(s.requests, [{
        v: 2,
        op: "exec",
        argv: ["bash", "-c", "echo hello"],
        cwd: "/run/dyfj/workspace",
        env: { PATH: "/usr/bin" },
        timeoutMs: 5_000,
      }]);
      assert.deepStrictEqual(result, {
        code: 0,
        signal: null,
        stdout: "hello\n",
        stderr: "",
        timedOut: false,
      });
    });

    it("sends the attested binding when a call carries one", async () => {
      const s = await supervisor((_, socket) => answer(socket, OK));
      const run = await runner(s.path);
      await run("true", "/w", 1_000, {}, "0123456789abcdef0123456789abcdef");
      assert.equal(
        (s.requests[0] as Record<string, unknown>).binding,
        "0123456789abcdef0123456789abcdef",
      );
    });

    it("asks for an attestation with the nonce and returns the reply", async () => {
      const reply = { v: 2, nonce: "ab".repeat(16), instance: "cd".repeat(16) };
      const { requestAttestation } = await transportModule();
      const s = await supervisor((_, socket) => answer(socket, reply));
      const got = await requestAttestation(s.path, dialExecutor, "ab".repeat(16));
      assert.deepStrictEqual(s.requests, [{
        v: 2,
        op: "attest",
        nonce: "ab".repeat(16),
      }]);
      assert.deepStrictEqual(got, reply);
    });

    it("reports a refused attestation as an error", async () => {
      const { requestAttestation } = await transportModule();
      const s = await supervisor((_, socket) =>
        answer(socket, { v: 2, error: "request has an unknown op" })
      );
      await assert.rejects(
        requestAttestation(s.path, dialExecutor, "ab".repeat(16)),
        /executor refused the command: request has an unknown op/,
      );
    });

    it("passes a timeout's termination through for the status line", async () => {
      const termination = { group: "stopped", exited: true, outputClosed: true };
      const s = await supervisor((_, socket) =>
        answer(socket, {
          ...OK,
          code: null,
          signal: "SIGKILL",
          timedOut: true,
          termination,
        })
      );
      const result = await (await runner(s.path))("sleep 9", "/w", 1_000, {});
      assert.strictEqual(result.timedOut, true);
      assert.deepStrictEqual(result.termination, termination);
    });

    it("reports a refusal as an error carrying the supervisor's reason", async () => {
      const s = await supervisor((_, socket) =>
        answer(socket, { v: 2, error: "cwd outside the executor's mounts" })
      );
      await assert.rejects(
        (await runner(s.path))("true", "/etc", 1_000, {}),
        /executor refused the command: cwd outside the executor's mounts/,
      );
    });
  });

  describe("the transport fails closed", () => {
    it("when no supervisor listens", async () => {
      await assert.rejects(
        (await runner(`${dir}/absent.sock`))("true", "/w", 1_000, {}),
        /executor unavailable/,
      );
    });

    for (
      const [label, raw] of [
        ["a reply that is not JSON", "nope\n"],
        ["a reply of another version", `${JSON.stringify({ ...OK, v: 1 })}\n`],
        [
          "a reply with a malformed field",
          `${JSON.stringify({ ...OK, code: "0" })}\n`,
        ],
        ["a connection closed without a reply", ""],
      ] as const
    ) {
      it(`on ${label}`, async () => {
        const s = await supervisor((_, socket) => socket.end(raw));
        await assert.rejects(
          (await runner(s.path))("true", "/w", 1_000, {}),
          /executor reply/,
        );
      });
    }

    it("on a reply larger than the cap", async () => {
      const s = await supervisor((_, socket) =>
        answer(socket, { ...OK, stdout: "x".repeat(4_096) })
      );
      await assert.rejects(
        (await runner(s.path, { maxReplyBytes: 1_024 }))("true", "/w", 1_000, {}),
        /executor reply exceeded 1024 bytes/,
      );
    });

    it("when the supervisor does not answer by the deadline and its grace", async () => {
      const s = await supervisor(() => {});
      const started = Date.now();
      await assert.rejects(
        (await runner(s.path, { graceMs: 50 }))("true", "/w", 100, {}),
        /executor did not answer within 150 ms/,
      );
      assert.ok(Date.now() - started < 2_000);
    });
  });

  describe("the bash tool", () => {
    const context = { authzBasis: "policy:allow:operator-approved" };
    const call = (command: string) => ({
      commandId: "bash",
      callId: "c1",
      caller: { principalId: "p", principalType: "human" as const },
      arguments: { command },
    });

    it("runs through the executor when the socket is configured", async () => {
      const root = await realpath(dir);
      const s = await supervisor((_, socket) => answer(socket, OK));
      const bash = defineBash(root, {
        env: new MapEnv({ DYFJ_EXECUTOR_SOCKET: s.path, PATH: "/usr/bin" }),
        dialExecutor,
      });
      const out = await bash.executor(call("echo hello"), context);
      assert.strictEqual(out, "exit 0\nhello");
      assert.strictEqual(s.requests.length, 1);
      assert.strictEqual(s.requests[0].cwd, root);
      assert.ok(
        !Object.hasOwn(s.requests[0].env, "DYFJ_EXECUTOR_SOCKET"),
        "the socket path is not passed to the command",
      );
    });

    it("binds a call to the attested instance it was allowed under", async () => {
      const root = await realpath(dir);
      const s = await supervisor((_, socket) => answer(socket, OK));
      const bash = defineBash(root, {
        env: new MapEnv({ DYFJ_EXECUTOR_SOCKET: s.path, PATH: "/usr/bin" }),
        dialExecutor,
      });
      await bash.executor(call("echo hello"), {
        authzBasis: "policy:allow:attested-envelope",
        binding: "ef".repeat(16),
      });
      await bash.executor(call("echo hello"), context);
      assert.strictEqual(s.requests[0].binding, "ef".repeat(16));
      assert.ok(!Object.hasOwn(s.requests[1], "binding"), "an approved call is not bound");
    });

    it("is contained, with no read-only classifier, when the socket is set", () => {
      const contained = defineBash("/work", {
        env: new MapEnv({ DYFJ_EXECUTOR_SOCKET: "/run/dyfj-exec/exec.sock" }),
      });
      assert.strictEqual(contained.containment?.route, "linux-isolated");
      assert.strictEqual(contained.readOnlyCall, undefined);
      const native = defineBash("/work", { env: new MapEnv({}) });
      assert.strictEqual(native.containment, undefined);
      assert.strictEqual(typeof native.readOnlyCall, "function");
    });

    it("sends only names the executor's command environment lists", async () => {
      const root = await realpath(dir);
      const s = await supervisor((_, socket) => answer(socket, OK));
      const env: Record<string, string> = { DYFJ_EXECUTOR_SOCKET: s.path };
      for (const key of ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ", "TMPDIR"]) {
        env[key] = "x";
      }
      const bash = defineBash(root, { env: new MapEnv(env), dialExecutor });
      await bash.executor(call("git status"), { authzBasis: BASH_ALLOWLIST_BASIS });
      const sent = Object.keys(s.requests[0].env);
      assert.ok(sent.includes("GIT_CONFIG_COUNT"), "the git safety switches are sent");
      assert.deepStrictEqual(
        sent.filter((name) => !BASH_COMMAND_ENV_KEYS.includes(name)),
        [],
      );
    });

    it("reports an unreachable executor rather than run the command locally", async () => {
      const root = await realpath(dir);
      const bash = defineBash(root, {
        env: new MapEnv({ DYFJ_EXECUTOR_SOCKET: `${dir}/absent.sock` }),
        dialExecutor,
      });
      const out = await bash.executor(call("echo hello"), context);
      assert.match(out, /^error: cannot run command: executor unavailable/);
    });

    it("lets the socket win over an injected runner: the runner never runs", async () => {
      const root = await realpath(dir);
      const s = await supervisor((_, socket) => answer(socket, OK));
      let local = 0;
      const bash = defineBash(root, {
        env: new MapEnv({ DYFJ_EXECUTOR_SOCKET: s.path }),
        dialExecutor,
        runner: async () => {
          local += 1;
          return { code: 0, signal: null, stdout: "local", stderr: "", timedOut: false };
        },
      });
      const out = await bash.executor(call("echo hello"), context);
      assert.strictEqual(local, 0);
      assert.strictEqual(s.requests.length, 1);
      assert.strictEqual(out, "exit 0\nhello");
    });

    it("refuses every command when the socket is set but no dialer was given", async () => {
      const root = await realpath(dir);
      const bash = defineBash(root, {
        env: new MapEnv({ DYFJ_EXECUTOR_SOCKET: `${dir}/any.sock` }),
      });
      const out = await bash.executor(call("echo hello"), context);
      assert.match(out, /^error: cannot run command: executor unavailable: no executor connection/);
    });

    it("tells the model the command runs in the isolated executor", () => {
      const bash = defineBash("/work", {
        env: new MapEnv({ DYFJ_EXECUTOR_SOCKET: "/run/dyfj-exec/exec.sock" }),
      });
      assert.match(bash.description, /isolated executor/);
      assert.match(bash.description, /no network/);
      assert.doesNotMatch(bash.description, /NOT sandboxed/);
    });

    it("keeps today's description when no socket is configured", () => {
      const bash = defineBash("/work", { env: new MapEnv({}) });
      assert.match(bash.description, /NOT sandboxed/);
    });
  });

  describe("a process handed to the executor", () => {
    it("sends the argv as given", async () => {
      const { createExecutorProcessRunner } = await transportModule();
      const s = await supervisor((_, socket) => answer(socket, OK));
      const run = createExecutorProcessRunner(s.path, dialExecutor);
      await run(["git", "--no-pager", "status"], "/work", 1_000, { PATH: "/usr/bin" });
      assert.deepStrictEqual(s.requests[0].argv, ["git", "--no-pager", "status"]);
      assert.ok(!Object.hasOwn(s.requests[0], "stdin"), "no stdin unless given");
    });

    it("sends stdin as its own field, apart from the argv", async () => {
      const { createExecutorProcessRunner } = await transportModule();
      const s = await supervisor((_, socket) => answer(socket, OK));
      const run = createExecutorProcessRunner(s.path, dialExecutor);
      await run(["cat"], "/work", 1_000, {}, undefined, "canary-body\n");
      assert.strictEqual(s.requests[0].stdin, "canary-body\n");
      assert.deepStrictEqual(s.requests[0].argv, ["cat"]);
      assert.ok(!Object.hasOwn(s.requests[0], "binding"));
    });
  });

  // With writable git metadata in the workspace, a hook or fsmonitor the
  // executor plants must never run in the runtime, which holds secrets and
  // egress. So the git tool, like bash, runs git only in the executor.
  describe("the git tool", () => {
    const context = { authzBasis: "policy:allow:operator-approved" };
    const call = (args: Record<string, unknown>) => ({
      commandId: "git",
      callId: "g1",
      caller: { principalId: "p", principalType: "human" as const },
      arguments: args,
    });

    it("binds an envelope-allowed operation, and is contained", async () => {
      const root = await realpath(dir);
      const s = await supervisor((_, socket) => answer(socket, OK));
      const git = defineGit(root, {
        env: new MapEnv({ DYFJ_EXECUTOR_SOCKET: s.path, PATH: "/usr/bin" }),
        dialExecutor,
      });
      assert.strictEqual(git.containment?.route, "linux-isolated");
      // Its fixed deadline is what the envelope's limit checks.
      assert.strictEqual(git.containment?.callTimeoutMs?.({
        commandId: "git",
        callId: "g0",
        caller: { principalId: "p", principalType: "human" },
        arguments: { subcommand: "status" },
      }), 30_000);
      await git.executor(call({ subcommand: "status" }), {
        authzBasis: "policy:allow:attested-envelope",
        binding: "ef".repeat(16),
      });
      assert.strictEqual(s.requests[0].binding, "ef".repeat(16));
    });

    it("runs git in the executor when the socket is configured, never here", async () => {
      const root = await realpath(dir);
      const s = await supervisor((_, socket) => answer(socket, OK));
      const git = defineGit(root, {
        env: new MapEnv({ DYFJ_EXECUTOR_SOCKET: s.path, PATH: "/usr/bin" }),
        dialExecutor,
      });
      const out = await git.executor(call({ subcommand: "status" }), context);
      assert.match(String(out), /^exit 0/);
      assert.strictEqual(s.requests.length, 1);
      assert.strictEqual(s.requests[0].argv[0], "git");
      assert.strictEqual(s.requests[0].cwd, root);
      assert.deepStrictEqual(
        Object.keys(s.requests[0].env).filter((name) => !GIT_COMMAND_ENV_KEYS.includes(name)),
        [],
      );
    });

    it("refuses every operation when the socket is set but no dialer was given", async () => {
      const root = await realpath(dir);
      const git = defineGit(root, {
        env: new MapEnv({ DYFJ_EXECUTOR_SOCKET: `${dir}/any.sock` }),
      });
      const out = await git.executor(call({ subcommand: "status" }), context);
      assert.match(String(out), /^error: cannot run git: executor unavailable: no executor connection/);
    });

    it("tells the model git runs in the isolated executor", () => {
      const git = defineGit("/work", {
        env: new MapEnv({ DYFJ_EXECUTOR_SOCKET: "/run/dyfj-exec/exec.sock" }),
        dialExecutor,
      });
      assert.match(git.description, /isolated executor/);
    });
  });
});
