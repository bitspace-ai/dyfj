import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { prepareAcpToolEvidence } from "./acp-tool-evidence-record.ts";

const call = (toolCallId: string) => ({
  toolCallId,
  title: "Run check",
  kind: "execute",
  status: "completed" as const,
  rawInputJson: "{}",
  rawOutputJson: "{}",
  problems: [],
});

describe("prepareAcpToolEvidence", () => {
  it("rejects a call id that sanitizing would change", () => {
    const prepared = prepareAcpToolEvidence({
      status: "captured",
      observedCalls: 2,
      calls: [call("call-a"), call("call-\u0000a")],
    });
    assert.deepStrictEqual(
      prepared.calls.map((entry) => [
        entry.outcome,
        entry.toolCallId,
        entry.outcome === "recorded" ? undefined : entry.reason,
      ]),
      [["recorded", "call-a", undefined], ["rejected", undefined, "malformed"]],
    );
  });
});
