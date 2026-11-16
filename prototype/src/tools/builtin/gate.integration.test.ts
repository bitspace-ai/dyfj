import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { createCommandRegistry } from "../registry.ts";
import { invokeCommandWithEvent } from "../invoke.ts";
import type { CommandCall } from "../definition.ts";

const call = (id: string, args: Record<string, unknown>): CommandCall => ({
  commandId: id, callId: "c", caller: { principalId: "m", principalType: "agent" }, arguments: args,
});
async function fixture(script: string, timeoutSeconds = 10) {
  const { GateRuns } = await import("./gate-runs.ts");
  const { defineGateTools } = await import("./gate.ts");
  const root = await mkdtemp(join(tmpdir(), "gate-run-"));
  const runs = new GateRuns();
  const config = { commands: { full: [process.execPath, "-e", script] }, timeoutSeconds };
  const tools = defineGateTools({ config, runs, sessionId: "one", workspaceRoot: root });
  const registry = createCommandRegistry(); tools.forEach(t => registry.register(t));
  const execute = async (id: string, args: Record<string, unknown>) => tools.find(tool => tool.id === id)!.executor(call(id, args), { authzBasis: "test" });
  return { root, runs, registry, execute,
    close: async () => { await runs.close(); await rm(root, { recursive: true, force: true }); },
  };
}

it("gate runs: one active run, session isolation, and unknown after restart", async () => {
  const h = await fixture("setInterval(() => {}, 1000)");
  try {
    const started = await h.execute("gate/start", { mode: "full" });
    await assert.rejects(h.execute("gate/start", { mode: "full" }), new RegExp(started.run));
    assert.equal(h.runs.get("other", started.run).state, "unknown");
    assert.equal((await h.runs.wait("other", started.run, 0)).state, "unknown");
    assert.equal(h.runs.cancel("other", started.run).state, "unknown");
    assert.equal(h.runs.get("one", started.run).state, "running");
    const { GateRuns } = await import("./gate-runs.ts");
    assert.equal(new GateRuns().get("one", started.run).state, "unknown");
  } finally { await h.close(); }
});

for (const [code, state] of [[0, "passed"], [7, "failed"]] as const) {
  it(`gate wait: ${state} records exit ${code}, final status and full log`, async () => {
    const line = 'gate-status {"result":"' + (code === 0 ? "pass" : "fail") + '"}';
    const h = await fixture(`console.log('x'.repeat(40000)); console.log(${JSON.stringify(line)}); process.exitCode=${code}`);
    try {
      const started = await h.execute("gate/start", { mode: "full" });
      const done = await h.execute("gate/wait", { run: started.run, wait_seconds: 30 });
      assert.equal(done.state, state); assert.equal(done.exitCode, code);
      assert.equal(done.statusLine, line); assert.ok(Buffer.byteLength(done.tail) <= 16384);
      assert.equal(done.logPath, join(h.root, "logs", "gate", `${started.run}.log`));
      assert.ok((await readFile(done.logPath!, "utf8")).length > 40000);
    } finally { await h.close(); }
  });
}

const stubborn = `const {spawn}=require('node:child_process');
process.on('SIGTERM',()=>{});
const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'inherit'});
console.log('child:'+child.pid); setInterval(()=>{},1000);`;
for (const cancel of [false, true]) {
  it(`gate ${cancel ? "cancel" : "timeout"}: kills a SIGTERM-ignoring process group`, async () => {
    const h = await fixture(stubborn, cancel ? 10 : 1);
    let child: number | undefined;
    try {
      const started = await h.execute("gate/start", { mode: "full" });
      for (let i = 0; i < 100; i++) {
        const match = h.runs.get("one", started.run).tail.match(/child:(\d+)/);
        if (match) { child = Number(match[1]); break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.ok(child, "stand-in child started");
      if (cancel) await h.execute("gate/cancel", { run: started.run });
      const done = await h.execute("gate/wait", { run: started.run, wait_seconds: 30 });
      assert.equal(done.state, cancel ? "cancelled" : "timed-out");
      for (let i = 0; i < 100; i++) {
        try { process.kill(child, 0); } catch { child = undefined; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(child, undefined, "descendant stopped without ps");
    } finally { await h.close(); }
  });
}

it("gate start: records exactly one tool_call with mode and paths", async () => {
  const h = await fixture("console.log('ok')");
  try {
    const events: unknown[] = [];
    await invokeCommandWithEvent(h.registry, call("gate/start", { mode: "full", reason: "test" }), {
      sessionId: "one", traceId: "trace", writeEvent: event => { events.push(event); },
    }, async () => ({ decision: "approve" }), { permissionLevel: "operator", loopback: true });
    assert.equal(events.length, 1);
    assert.match(JSON.stringify(events[0]), /gate\/start/);
    assert.match(JSON.stringify(events[0]), /full/);
    assert.match(JSON.stringify(events[0]), /paths/);
  } finally { await h.close(); }
});
