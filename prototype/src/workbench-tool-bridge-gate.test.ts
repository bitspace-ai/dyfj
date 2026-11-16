import assert from "node:assert/strict";
import { it } from "node:test";
import { buildToolCatalog } from "./tools/catalog.ts";
import { GateRuns } from "./tools/builtin/gate-runs.ts";
import { bindCodexTurn, type BridgeTurn, type ExternalAgentToolBridge } from "./workbench-tool-bridge.ts";

it("gate wiring: native catalog and Codex bridge register the same configured tools", async () => {
  const gate = { config: { commands: { full: ["npm", "test"] }, timeoutSeconds: 1800 }, runs: new GateRuns() };
  const native = buildToolCatalog({ gate: { ...gate, sessionId: "s" } }, { workspaceRoot: "/workspace" }, [], []).list();
  assert.deepEqual(native.map(c => c.id), ["gate/start", "gate/wait", "gate/cancel"]);
  let active: BridgeTurn | undefined;
  const dependency: ExternalAgentToolBridge = {
    toolTimeoutSeconds: 20,
    bridge: async () => ({ socketPath: "/unused", bind: () => "token", activate: (_id, turn) => { active = turn; return () => {}; } }),
  };
  const bound = await bindCodexTurn(dependency, "s", { runner: { profile: "codex-chatgpt" }, workspaceRoot: "/workspace" }, { gate });
  assert.ok(bound); bound.activate("trace", "span", async () => {});
  assert.ok(active);
  assert.deepEqual(active.commands.filter(c => c.id.startsWith("gate/")).map(c => c.id), native.map(c => c.id));
  assert.match(active.commands.find(c => c.id === "gate/wait")!.description, /10 seconds/);
});
