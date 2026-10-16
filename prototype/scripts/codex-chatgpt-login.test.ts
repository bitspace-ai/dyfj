// The Codex ChatGPT login's command and its failure handling, with the
// profile builder and spawn stubbed: no adapter starts and no login runs.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import type { AcpExecutionProfile } from "../src/acp-client.ts";
import { DomainError } from "../src/contract/mod.ts";
import type { CodexChatGptProfileOptions } from "../src/external-agent-runtime.ts";
import { type CodexLoginDeps, runCodexChatGptLogin } from "./codex-chatgpt-login.ts";

const PROFILE: AcpExecutionProfile = {
  slug: "codex-chatgpt",
  command: "/runner/bin/node-shim",
  args: ["/adapter/dist/index.js"],
  environment: { HOME: "/runner/home", PATH: "/runner/bin", NO_BROWSER: "1" },
  workspace: "/work",
  transport: "local_stdio",
  accessRoute: "local_sidecar",
  costBasis: "subscription_quota",
} as AcpExecutionProfile;

interface Spawned {
  command: string;
  args: readonly string[];
  options: Parameters<CodexLoginDeps["spawn"]>[2];
}

function harness(overrides: Partial<CodexLoginDeps> = {}) {
  const built: Array<{ workspace: string; options: CodexChatGptProfileOptions }> =
    [];
  const spawned: Spawned[] = [];
  const child = new EventEmitter();
  const out: string[] = [];
  const err: string[] = [];
  const deps: CodexLoginDeps = {
    args: [],
    cwd: "/repo/prototype",
    nodePathEnv: undefined,
    execPath: "/usr/local/bin/node",
    buildProfile: (workspace, options) => {
      built.push({ workspace, options });
      return Promise.resolve(PROFILE);
    },
    spawn: (command, args, options) => {
      spawned.push({ command, args, options });
      return child;
    },
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    ...overrides,
  };
  return { deps, built, spawned, child, out, err };
}

describe("codex-chatgpt-login", () => {
  it("runs the profile's command with login appended, its workspace and env minus NO_BROWSER", async () => {
    const h = harness();
    const status = runCodexChatGptLogin(h.deps);
    await new Promise((resolve) => setImmediate(resolve));
    h.child.emit("exit", 0);
    assert.strictEqual(await status, 0);
    assert.deepStrictEqual(h.spawned, [{
      command: "/runner/bin/node-shim",
      args: ["/adapter/dist/index.js", "login"],
      options: {
        cwd: "/work",
        env: { HOME: "/runner/home", PATH: "/runner/bin" },
        stdio: "inherit",
      },
    }]);
    assert.strictEqual(PROFILE.environment.NO_BROWSER, "1");
  });

  it("builds the profile on the current Node, with no toolchain, when DYFJ_NODE_PATH is unset or empty", async () => {
    for (const nodePathEnv of [undefined, ""]) {
      const h = harness({ nodePathEnv });
      const status = runCodexChatGptLogin(h.deps);
      await new Promise((resolve) => setImmediate(resolve));
      h.child.emit("exit", 0);
      await status;
      assert.deepStrictEqual(h.built, [{
        workspace: "/repo/prototype",
        options: {
          nodePath: "/usr/local/bin/node",
          toolchainPath: "",
          rustupHome: "",
        },
      }]);
    }
  });

  it("builds the profile on DYFJ_NODE_PATH when it is set", async () => {
    const h = harness({ nodePathEnv: "/opt/node/bin/node" });
    const status = runCodexChatGptLogin(h.deps);
    await new Promise((resolve) => setImmediate(resolve));
    h.child.emit("exit", 0);
    await status;
    assert.strictEqual(h.built[0]?.options.nodePath, "/opt/node/bin/node");
  });

  it("exits with the adapter's status, and 1 when it dies by a signal", async () => {
    for (const [code, expected] of [[3, 3], [null, 1]] as const) {
      const h = harness();
      const status = runCodexChatGptLogin(h.deps);
      await new Promise((resolve) => setImmediate(resolve));
      h.child.emit("exit", code);
      assert.strictEqual(await status, expected);
    }
  });

  it("reports a missing adapter binary by its error code alone and exits 1", async () => {
    const h = harness();
    const status = runCodexChatGptLogin(h.deps);
    await new Promise((resolve) => setImmediate(resolve));
    h.child.emit(
      "error",
      Object.assign(new Error("spawn /runner/bin/node-shim ENOENT"), {
        code: "ENOENT",
      }),
    );
    assert.strictEqual(await status, 1);
    assert.deepStrictEqual(h.err, [
      "dyfj: codex-chatgpt-login could not start the Codex adapter (ENOENT)",
    ]);
  });

  it("exits 1 when spawn itself throws", async () => {
    const h = harness({
      spawn: () => {
        throw Object.assign(new Error("bad"), { code: "EACCES" });
      },
    });
    assert.strictEqual(await runCodexChatGptLogin(h.deps), 1);
    assert.deepStrictEqual(h.err, [
      "dyfj: codex-chatgpt-login could not start the Codex adapter (EACCES)",
    ]);
  });

  it("prints the profile's fixed diagnostic and starts nothing when no usable Node is found", async () => {
    const h = harness({
      buildProfile: () =>
        Promise.reject(new DomainError("Codex ACP executable is unavailable")),
    });
    assert.strictEqual(await runCodexChatGptLogin(h.deps), 1);
    assert.deepStrictEqual(h.spawned, []);
    assert.deepStrictEqual(h.err, [
      "dyfj: codex-chatgpt-login: Codex ACP executable is unavailable",
    ]);
  });

  it("rethrows an unexpected profile error rather than printing it", async () => {
    const h = harness({
      buildProfile: () => Promise.reject(new Error("/private/path detail")),
    });
    await assert.rejects(runCodexChatGptLogin(h.deps), /private\/path/);
    assert.deepStrictEqual(h.err, []);
  });

  it("prints its usage for --help and builds nothing", async () => {
    const h = harness({ args: ["--help"] });
    assert.strictEqual(await runCodexChatGptLogin(h.deps), 0);
    assert.match(h.out[0] ?? "", /^usage: npm run codex-chatgpt-login/);
    assert.deepStrictEqual(h.built, []);
    assert.deepStrictEqual(h.spawned, []);
  });
});
