import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { MapEnv } from "../testing/fakes/map-env.ts";
import { nestedSandboxSkipReason } from "../testing/nested-sandbox.ts";
import { unixSocketBindSkip } from "../testing/unix-socket-bind.ts";
import type { EventInsert } from "./store/mod.ts";
import { listenLoopbackProbe } from "./transport/mod.ts";
import { bootSandbox } from "./tools/builtin/srt-sandbox.ts";
import { bindCodexTurn, WORKBENCH_BRIDGE_SHIM_PATH, WORKBENCH_BRIDGE_TOKEN_ENV, WorkbenchToolBridge } from "./workbench-tool-bridge.ts";

const socketSkip = await unixSocketBindSkip() ?? false;
const dependencies = SandboxManager.isSupportedPlatform()
  ? SandboxManager.checkDependencies()
  : { errors: ["unsupported platform"] };
const srtSkip = dependencies.errors.length ? dependencies.errors.join("; ") : nestedSandboxSkipReason() ?? socketSkip;
const hostEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, env: hostEnv, encoding: "utf8" }).trim();
}
async function connect(bridge: WorkbenchToolBridge, token: string) {
  const client = new Client({ name: "git-bridge-test", version: "0" });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [WORKBENCH_BRIDGE_SHIM_PATH, bridge.socketPath],
    env: { [WORKBENCH_BRIDGE_TOKEN_ENV]: token }, stderr: "ignore",
  }));
  return client;
}
function resultText(result: unknown): string {
  assert.ok(result && typeof result === "object" && "content" in result);
  assert.ok(Array.isArray(result.content));
  return result.content.map(part => part.text).join("");
}

test("a bridged git call records exactly one git tool_call event", { skip: socketSkip }, async () => {
  const root = await mkdtemp(join(tmpdir(), "git-bridge-"));
  const bridge = await WorkbenchToolBridge.start(root);
  let client: Client | undefined;
  try {
    const events: EventInsert[] = [];
    const bound = await bindCodexTurn({ bridge: async () => bridge, toolTimeoutSeconds: 300 }, "session", {
      runner: { profile: "codex-chatgpt" }, workspaceRoot: root,
      approver: { confirmToolApproval: async () => ({ decision: "deny" }) },
    });
    assert.ok(bound, "git must bind for event recording");
    const release = bound.activate("0".repeat(32), "1".repeat(16), async event => { events.push(event); });
    try {
      client = await connect(bridge, bound.workbenchTools.token);
      await client.callTool({ name: "git", arguments: { subcommand: "commit", message: "test" } });
      assert.equal(events.length, 1);
      assert.equal(events[0].event_type, "tool_call");
      assert.equal(events[0].tool_name, "git");
      assert.equal(events[0].authz_basis, "policy:deny:approval-denied");
    } finally { release(); }
  } finally { await client?.close(); await bridge.close(); await rm(root, { recursive: true, force: true }); }
});

for (const mainCheckout of [false, true]) {
  test(mainCheckout ? "bridged sandboxed add and commit update a main checkout without prompting" : "bridged sandboxed add and commit update the linked worktree branch", { skip: srtSkip }, async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "git-bridge-srt-")));
    const main = join(base, "main");
    const home = join(base, "home");
    await mkdir(main); await mkdir(home);
    const bridge = await WorkbenchToolBridge.start(base);
    let client: Client | undefined;
    try {
      git(main, "init", "-q", "-b", "main");
      git(main, "config", "user.name", "test");
      git(main, "config", "user.email", "test@example.invalid");
      git(main, "config", "commit.gpgsign", "false");
      git(main, "config", "gc.auto", "0");
      await writeFile(join(main, "file.txt"), "base\n");
      git(main, "add", "file.txt"); git(main, "commit", "-qm", "base");
      const root = mainCheckout ? main : join(base, "worktree");
      if (!mainCheckout) git(main, "worktree", "add", "-qb", "session", root);
      const env = new MapEnv({ ...hostEnv, HOME: home });
      const sandbox = await bootSandbox({ env, home, listenProbe: listenLoopbackProbe });
      assert.equal(sandbox.status.state, "on", JSON.stringify(sandbox.status));
      let prompts = 0;
      const bound = await bindCodexTurn({ bridge: async () => bridge, toolTimeoutSeconds: 300 }, "session", {
        runner: { profile: "codex-chatgpt" }, workspaceRoot: root, permissionLevel: "operator",
        approver: { confirmToolApproval: async () => { prompts++; return { decision: "deny" }; } },
      }, { env, sandbox });
      assert.ok(bound, "sandboxed workspace git must bind");
      const release = bound.activate("0".repeat(32), "1".repeat(16), async () => {});
      try {
        client = await connect(bridge, bound.workbenchTools.token);
        await writeFile(join(root, "file.txt"), "changed\n");
        const added = resultText(await client.callTool({ name: "git", arguments: { subcommand: "add", paths: ["file.txt"] } }));
        assert.match(added, /^exit 0/, added);
        const committed = resultText(await client.callTool({ name: "git", arguments: { subcommand: "commit", message: "bridged commit" } }));
        assert.match(committed, /^exit 0/, committed);
        if (mainCheckout) {
          assert.equal(git(main, "log", "-1", "--format=%s", "main"), "bridged commit");
          assert.equal(git(main, "show", "main:file.txt"), "changed");
        } else {
          assert.equal(git(main, "log", "-1", "--format=%s", "session"), "bridged commit");
          assert.equal(git(main, "show", "session:file.txt"), "changed");
          assert.equal(git(main, "log", "-1", "--format=%s", "main"), "base");
        }
        assert.equal(prompts, 0);
      } finally { release(); }
    } finally { await client?.close(); await bridge.close(); await SandboxManager.reset(); await rm(base, { recursive: true, force: true }); }
  });
}
