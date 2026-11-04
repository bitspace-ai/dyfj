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

  it("rejects a title whose sanitized form is credential-shaped", () => {
    const prepared = prepareAcpToolEvidence({
      status: "captured",
      observedCalls: 1,
      calls: [{
        ...call("call-a"),
        title: "to\u0000ken=abcdefghijklmnopqrstuvwxyz012345",
        rawOutputJson: undefined,
        problems: ["missing_raw_output"],
      }],
    });
    assert.partialDeepStrictEqual(prepared.calls[0], {
      outcome: "rejected",
      reason: "credential_shaped",
    });
    assert.ok(
      !JSON.stringify(prepared).includes("abcdefghijklmnopqrstuvwxyz012345"),
    );
  });
});
