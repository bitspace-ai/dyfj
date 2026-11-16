import assert from "node:assert/strict";
import { it } from "node:test";
import { defineGateTools } from "./gate.ts";
import { GateRuns } from "./gate-runs.ts";
import { createCommandRegistry } from "../registry.ts";
import { invokeCommand, invokeCommandWithEvent } from "../invoke.ts";
import type { CommandCall } from "../definition.ts";

function registry(optIn: boolean) {
  const [start] = defineGateTools({
    config: { commands: { full: ["npm", "test"] }, timeoutSeconds: 1800 },
    runs: new GateRuns(), workspaceRoot: "/work", sessionId: "s",
    sessionGrantable: optIn ? ["gate/start:full"] : [],
  });
  assert.ok(start);
  const registry = createCommandRegistry();
  registry.register({ ...start, executor: () => ({ run: "stand-in", state: "passed", mode: "full", paths: [], exitCode: 0, statusLine: null, tail: "", logPath: null }) });
  return { registry, start };
}
const call = (reason: string): CommandCall => ({
  commandId: "gate/start", callId: reason, caller: { principalId: "m", principalType: "agent" },
  arguments: { mode: "full", reason },
});

it("gate opt-in: first full prompts, next uses a mode-only grant, a new session asks again", async () => {
  const { registry: commands, start } = registry(true);

  let prompts = 0;
  const approve = async (request: { grantable?: boolean }) => {
    prompts++; assert.equal(request.grantable, true);
    return { decision: "approve" as const, scope: "session" as const };
  };
  const sessionGrants = new Set<string>();
  const context = { permissionLevel: "operator" as const, loopback: true, sessionGrants };
  const first = await invokeCommand(commands, call("first"), approve, context);
  assert.equal(first.authzBasis, "policy:allow:operator-approved-opt-in-session-grant");
  assert.equal(prompts, 1);
  const events: unknown[] = [];
  const second = await invokeCommandWithEvent(commands, call("different reason"), {
    sessionId: "s", traceId: "trace", writeEvent: event => { events.push(event); },
  }, approve, context);
  assert.equal(events.length, 1);
  assert.match(JSON.stringify(events[0]), /policy:allow:operator-opt-in-session-grant/);
  assert.equal(second.authzBasis, "policy:allow:operator-opt-in-session-grant");
  assert.equal(prompts, 1);
  assert.equal(sessionGrants.size, 1);
  assert.deepEqual(JSON.parse([...sessionGrants][0]!)[1], { mode: "full" });
  await invokeCommand(commands, call("new session"), approve, { ...context, sessionGrants: new Set() });
  assert.equal(prompts, 2);
});

it("gate opt-in: without the entry a session approval never creates a grant", async () => {
  const { registry: commands } = registry(false);
  const sessionGrants = new Set<string>();
  let prompts = 0;
  const approve = async (request: { grantable?: boolean }) => {
    prompts++; assert.notEqual(request.grantable, true);
    return { decision: "approve" as const, scope: "session" as const };
  };
  for (let i = 0; i < 2; i++) await invokeCommand(commands, call("test"), approve, {
    permissionLevel: "strict", loopback: true, sessionGrants,
  });
  assert.equal(prompts, 2); assert.equal(sessionGrants.size, 0);
});
