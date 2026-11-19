import { MapEnv } from "../../../testing/fakes/map-env.ts";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { nestedSandboxSkipReason } from "../../../testing/nested-sandbox.ts";
import { listenLoopbackProbe } from "../../transport/mod.ts";
import { bootSandbox } from "./srt-sandbox.ts";
import { SANDBOX_NPM_CACHE } from "./srt-policy.ts";
import { defineGateTools } from "./gate.ts";
import { GateRuns } from "./gate-runs.ts";
import type { CommandCall } from "../definition.ts";

const dependencies = SandboxManager.isSupportedPlatform()
  ? SandboxManager.checkDependencies()
  : { errors: ["unsupported platform"] };

it("gate fast: real srt contains the run and sets the sandbox npm cache", {
  skip: dependencies.errors.length ? dependencies.errors.join("; ") : nestedSandboxSkipReason() ?? false,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "gate-fast-"));
  const home = await mkdtemp(join(tmpdir(), "gate-fast-home-"));
  const runs = new GateRuns(new MapEnv({ HOME: home }));
  try {
    const sandbox = await bootSandbox({ listenProbe: listenLoopbackProbe, home });
    assert.equal(sandbox.status.state, "on", JSON.stringify(sandbox.status));
    const argv = [process.execPath, "-e", `
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      assert.equal(process.env.npm_config_cache, ${JSON.stringify(SANDBOX_NPM_CACHE)});
      assert.throws(() => fs.writeFileSync(${JSON.stringify(join(home, "outside-workspace"))}, 'no'),
        error => error.code === 'EPERM' || error.code === 'EACCES');
      console.log('sandboxed fast cache=' + process.env.npm_config_cache);
    `];
    const [start] = defineGateTools({
      config: { commands: { full: [process.execPath], fast: argv }, timeoutSeconds: 10 },
      runs, sessionId: "s", workspaceRoot: root, sandbox,
    });
    const view = await start!.executor({
      commandId: "gate/start", callId: "c", caller: { principalId: "m", principalType: "agent" },
      arguments: { mode: "fast" },
    }, { authzBasis: "policy:allow:sandboxed" });
    const done = await runs.wait("s", view.run, 10);
    assert.equal(done.exitCode, 0, done.tail);
    assert.ok(done.tail.includes(`sandboxed fast cache=${SANDBOX_NPM_CACHE}`), done.tail);
  } finally { await runs.close(); await SandboxManager.reset(); await rm(root, { recursive: true, force: true }); await rm(home, { recursive: true, force: true }); }
});

it("gate files: real srt streams the full log and cancels the process group", {
  skip: dependencies.errors.length ? dependencies.errors.join("; ") : nestedSandboxSkipReason() ?? false,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "gate-srt-"));
  const home = await mkdtemp(join(tmpdir(), "gate-srt-home-"));
  const runs = new GateRuns(new MapEnv({ HOME: home }));
  try {
    const sandbox = await bootSandbox({ listenProbe: listenLoopbackProbe, home });
    assert.equal(sandbox.status.state, "on", JSON.stringify(sandbox.status));
    await writeFile(join(root, "stand-in.js"), "console.log('ready'); setInterval(()=>{}, 1000)");
    const [start, wait, cancel] = defineGateTools({
      config: { commands: { full: [process.execPath], files: [process.execPath] }, timeoutSeconds: 10 },
      runs, sessionId: "s", workspaceRoot: root, sandbox,
    });
    const call = (id: string, args: Record<string, unknown>): CommandCall => ({ commandId: id, callId: "c", caller: { principalId: "m", principalType: "agent" }, arguments: args });
    const view = await start!.executor(call("gate/start", { mode: "files", paths: ["stand-in.js"] }), { authzBasis: "policy:allow:sandboxed" });
    for (let i = 0; i < 200 && !runs.get("s", view.run).tail.includes("ready"); i++) await new Promise(r => setTimeout(r, 10));
    assert.match(runs.get("s", view.run).tail, /ready/);
    assert.match(await readFile(view.logPath!, "utf8"), /ready/);
    // Even a home-rooted workspace cannot write the runtime log tree.
    const denied = await sandbox.runArgv([process.execPath, "-e",
      `require('node:fs').writeFileSync(${JSON.stringify(view.logPath)}, 'changed')`], {
      root: home, cwd: home, timeoutMs: 5000, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    });
    assert.notEqual(denied.code, 0);
    assert.match(await readFile(view.logPath!, "utf8"), /ready/);
    await cancel!.executor(call("gate/cancel", { run: view.run }), { authzBasis: "test" });
    const done = await wait!.executor(call("gate/wait", { run: view.run, wait_seconds: 10 }), { authzBasis: "test" });
    assert.equal(done.state, "cancelled");
  } finally { await runs.close(); await SandboxManager.reset(); await rm(root, { recursive: true, force: true }); await rm(home, { recursive: true, force: true }); }
});
