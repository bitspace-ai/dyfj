import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkbenchRuntimeEvent } from "../../contract/mod.ts";
import {
  type FrameSink,
  SessionOwners,
  type TurnRuntime,
  type WorkbenchRuntimeResult,
} from "../../engine/mod.ts";
import { MapEnv } from "../../../testing/fakes/map-env.ts";
import { buildTurnCore, type TurnApprover } from "./turn-core.ts";

// The runtime fake returns a receipt-shaped stub, not a full result.
const result = (value: unknown) => value as WorkbenchRuntimeResult;

test("the turn core runs a turn with no RPC connection, through the approver and sink it is given", async () => {
  const owners = new SessionOwners();
  const runRuntime: TurnRuntime = async (input) => {
    input.frames?.onTextDelta?.("hello");
    await input.frames?.onRuntimeEvent?.(
      { type: "turnCompleted", sessionId: "s", traceId: "t" },
    );
    return result({
      verdict: await input.approver?.confirmToolApproval?.({
        commandId: "write_file",
        callId: "c1",
        title: "Write File",
        arguments: { path: "notes.md" },
      }),
    });
  };
  const core = buildTurnCore({
    owners,
    runRuntime,
    fetchSessionEvents: () => Promise.resolve([]),
    env: new MapEnv(),
  });

  const asked: unknown[] = [];
  const approver: TurnApprover = {
    confirmToolApproval: (request) => {
      asked.push(request);
      return Promise.resolve({ decision: "deny", reason: "stub says no" });
    },
    confirmExternalAgentPermission: () =>
      Promise.reject(new Error("not asked in this test")),
    confirmBudgetCeiling: () =>
      Promise.reject(new Error("not asked in this test")),
  };
  const deltas: string[] = [];
  const events: WorkbenchRuntimeEvent[] = [];
  const frames: FrameSink = {
    onTextDelta: (text) => void deltas.push(text),
    onRuntimeEvent: (event) => void events.push(event),
  };

  const resolved = core.resolve({ prompt: "edit notes" });
  assert.ok(!("error" in resolved));
  const receipt = await core.run(resolved, {
    ticket: owners.admit(),
    approver,
    frames,
  });

  assert.deepStrictEqual(receipt, {
    verdict: { decision: "deny", reason: "stub says no" },
  });
  assert.deepStrictEqual(asked, [{
    commandId: "write_file",
    callId: "c1",
    title: "Write File",
    arguments: { path: "notes.md" },
  }]);
  assert.deepStrictEqual(deltas, ["hello"]);
  assert.deepStrictEqual(events, [
    { type: "turnCompleted", sessionId: "s", traceId: "t" },
  ]);
});
