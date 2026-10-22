// The executor transport: an opt-in bash runner that hands each command to the
// isolated machine's trusted supervisor over a Unix socket, which runs it in
// the secret-free executor, instead of spawning it in the runtime. These tests
// stand a scripted supervisor on a real socket. Every failure must surface as
// an error the bash tool reports: nothing falls back to a local spawn.
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { after, before, describe, it } from "node:test";
import { MapEnv } from "../../../testing/fakes/map-env.ts";
import {
  BASH_ALLOWLIST_BASIS,
  BASH_COMMAND_ENV_KEYS,
  defineBash,
} from "./exec.ts";

const transportModule = () => import("./executor-transport.ts");

let dir: string;

before(async () => {
  // Under /tmp, not the platform temp dir: a Unix socket path is short.
  dir = await mkdtemp("/tmp/dyfj-exec-");
});

after(async () => {
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
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { path, requests, server };
}

function answer(socket: Socket, response: unknown) {
  socket.end(`${JSON.stringify(response)}\n`);
}

const OK = {
  v: 1,
  code: 0,
  signal: null,
  stdout: "hello\n",
  stderr: "",
  timedOut: false,
};

async function runner(path: string, options: Record<string, number> = {}) {
  const { createExecutorRunner } = await transportModule();
  return createExecutorRunner(path, options);
}

describe("a command handed to the executor", () => {
  it("sends one versioned request and returns the supervisor's result", async () => {
    const s = await supervisor((_, socket) => answer(socket, OK));
    const run = await runner(s.path);
    const result = await run("echo hello", "/run/dyfj/workspace", 5_000, {
      PATH: "/usr/bin",
    });
    assert.deepStrictEqual(s.requests, [{
      v: 1,
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
      answer(socket, { v: 1, error: "cwd outside the executor's mounts" })
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
      ["a reply of another version", `${JSON.stringify({ ...OK, v: 2 })}\n`],
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

  it("sends only names the executor's command environment lists", async () => {
    const root = await realpath(dir);
    const s = await supervisor((_, socket) => answer(socket, OK));
    const env: Record<string, string> = { DYFJ_EXECUTOR_SOCKET: s.path };
    for (const key of ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ", "TMPDIR"]) {
      env[key] = "x";
    }
    const bash = defineBash(root, { env: new MapEnv(env) });
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
    });
    const out = await bash.executor(call("echo hello"), context);
    assert.match(out, /^error: cannot run command: executor unavailable/);
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
