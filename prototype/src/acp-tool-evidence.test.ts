import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyAcpToolPatch,
  finishAcpToolEvidence,
  newAcpToolEvidenceAccumulator,
} from "./acp-tool-evidence.ts";

const completedCall = (toolCallId: string) => ({
  sessionUpdate: "tool_call",
  toolCallId,
  title: `Run ${toolCallId}`,
  kind: "execute",
  status: "completed",
  rawInput: { command: [toolCallId] },
  rawOutput: { exitCode: 0 },
});

describe("ACP tool evidence capture", () => {
  it("counts updates without a call id as one entry, where they arrived", () => {
    const accumulator = newAcpToolEvidenceAccumulator();
    applyAcpToolPatch(accumulator, completedCall("call-a"));
    applyAcpToolPatch(accumulator, {
      sessionUpdate: "tool_call",
      title: "Run unnamed",
      kind: "execute",
      rawInput: { command: ["true"] },
    });
    applyAcpToolPatch(accumulator, {
      sessionUpdate: "tool_call_update",
      status: "completed",
      rawOutput: { exitCode: 0 },
    });
    applyAcpToolPatch(accumulator, completedCall("call-b"));
    const evidence = finishAcpToolEvidence(accumulator);
    assert.strictEqual(evidence.observedCalls, 3);
    assert.deepStrictEqual(
      evidence.calls.map((call) => [call.toolCallId, call.problems]),
      [
        ["call-a", []],
        [undefined, [
          "malformed",
          "missing_raw_input",
          "incomplete_status",
          "missing_raw_output",
        ]],
        ["call-b", []],
      ],
    );
    // The id-less entry keeps none of the values its updates carried.
    assert.deepStrictEqual(evidence.calls[1], {
      problems: evidence.calls[1].problems,
    });
  });

  it("marks only the entry whose id a second announcement reuses", () => {
    const accumulator = newAcpToolEvidenceAccumulator();
    applyAcpToolPatch(accumulator, completedCall("call-a"));
    applyAcpToolPatch(accumulator, completedCall("call-b"));
    applyAcpToolPatch(accumulator, completedCall("call-a"));
    const evidence = finishAcpToolEvidence(accumulator);
    assert.deepStrictEqual(
      evidence.calls.map((call) => [call.toolCallId, call.problems]),
      [["call-a", ["malformed"]], ["call-b", []]],
    );
  });
});
