import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ACP_TOOL_OUTPUT_TRUNCATION_MARKER,
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

  describe("credential shapes inside string values", () => {
    // Synthetic values: shaped like a credential, never a real one.
    const secret = "abcdefghijklmnopqrstuvwxyz012345";
    const filler = "x".repeat(20_000);
    const shapes = {
      "embedded JSON": `{"token":"${secret}"}`,
      "a quoted assignment": `password="${secret}"`,
    };
    const placements = {
      "inside the kept prefix": (text: string) => `${text}${filler}`,
      "beyond the kept prefix": (text: string) => `${filler}\n${text}`,
    };

    for (const [shapeName, shape] of Object.entries(shapes)) {
      for (const [placementName, place] of Object.entries(placements)) {
        it(`rejects an oversized output holding ${shapeName} ${placementName}`, () => {
          const accumulator = newAcpToolEvidenceAccumulator();
          applyAcpToolPatch(accumulator, {
            ...completedCall("call-a"),
            rawOutput: { stdout: place(shape) },
          });
          const evidence = finishAcpToolEvidence(accumulator);
          assert.deepStrictEqual(evidence.calls[0].problems, [
            "credential_shaped",
          ]);
          assert.strictEqual(evidence.calls[0].rawOutputJson, undefined);
          assert.ok(!JSON.stringify(evidence).includes(secret));
        });
      }

      it(`rejects an in-bound output holding ${shapeName}`, () => {
        const accumulator = newAcpToolEvidenceAccumulator();
        applyAcpToolPatch(accumulator, {
          ...completedCall("call-a"),
          rawOutput: { stdout: shape },
        });
        const evidence = finishAcpToolEvidence(accumulator);
        assert.deepStrictEqual(evidence.calls[0].problems, [
          "credential_shaped",
        ]);
        assert.ok(!JSON.stringify(evidence).includes(secret));
      });

      it(`rejects an input holding ${shapeName}`, () => {
        const accumulator = newAcpToolEvidenceAccumulator();
        applyAcpToolPatch(accumulator, {
          ...completedCall("call-a"),
          rawInput: { command: ["printf", shape] },
        });
        const evidence = finishAcpToolEvidence(accumulator);
        assert.deepStrictEqual(evidence.calls[0].problems, [
          "credential_shaped",
        ]);
        assert.strictEqual(evidence.calls[0].rawInputJson, undefined);
        assert.ok(!JSON.stringify(evidence).includes(secret));
      });
    }

    it("still keeps a clean oversized output, cut with a marker", () => {
      const accumulator = newAcpToolEvidenceAccumulator();
      applyAcpToolPatch(accumulator, {
        ...completedCall("call-a"),
        rawOutput: { stdout: filler },
      });
      const evidence = finishAcpToolEvidence(accumulator);
      assert.deepStrictEqual(evidence.calls[0].problems, ["oversized_output"]);
      assert.ok(evidence.calls[0].rawOutputJson?.endsWith(
        ACP_TOOL_OUTPUT_TRUNCATION_MARKER,
      ));
    });

    it("rejects an output whose embedded JSON escapes a key's letters", () => {
      const accumulator = newAcpToolEvidenceAccumulator();
      applyAcpToolPatch(accumulator, {
        ...completedCall("call-a"),
        rawOutput: { stdout: `{"\\u0074oken":"${secret}"}${filler}` },
      });
      const evidence = finishAcpToolEvidence(accumulator);
      assert.deepStrictEqual(evidence.calls[0].problems, [
        "credential_shaped",
      ]);
      assert.ok(!JSON.stringify(evidence).includes(secret));
    });

    it("keeps neither raw field when only the output is credential-shaped", () => {
      const accumulator = newAcpToolEvidenceAccumulator();
      applyAcpToolPatch(accumulator, {
        ...completedCall("call-a"),
        rawOutput: { stdout: shapes["embedded JSON"] },
      });
      const evidence = finishAcpToolEvidence(accumulator);
      assert.deepStrictEqual(evidence.calls[0], {
        toolCallId: "call-a",
        title: "Run call-a",
        kind: "execute",
        status: "completed",
        problems: ["credential_shaped"],
      });
    });

    it("rejects an output holding a backslash-prefixed credential key", () => {
      const accumulator = newAcpToolEvidenceAccumulator();
      applyAcpToolPatch(accumulator, {
        ...completedCall("call-a"),
        rawOutput: { stdout: `\\token=${secret}` },
      });
      const evidence = finishAcpToolEvidence(accumulator);
      assert.deepStrictEqual(evidence.calls[0].problems, [
        "credential_shaped",
      ]);
    });

    it("decodes nested escaping up to the cap, and stops there", () => {
      const nested = (text: string, levels: number) => {
        let out = text;
        for (let level = 0; level < levels; level += 1) {
          out = JSON.stringify(out).slice(1, -1);
        }
        return out;
      };
      const capture = (stdout: string) => {
        const accumulator = newAcpToolEvidenceAccumulator();
        applyAcpToolPatch(accumulator, {
          ...completedCall("call-a"),
          rawOutput: { stdout },
        });
        return finishAcpToolEvidence(accumulator).calls[0].problems;
      };
      assert.deepStrictEqual(
        capture(nested(`{"\\u0074oken":"${secret}"}`, 3)),
        ["credential_shaped"],
      );
      // Hostile nesting far past the cap is checked in a few linear passes,
      // then kept cut like any clean oversized output.
      assert.deepStrictEqual(
        capture(`\\${"u005c".repeat(4_000)}u0041`),
        ["oversized_output"],
      );
    });

    it("measures an oversized input before serializing it, and keeps none", () => {
      const accumulator = newAcpToolEvidenceAccumulator();
      applyAcpToolPatch(accumulator, {
        ...completedCall("call-a"),
        rawInput: { command: Array.from({ length: 100_000 }, () => 0) },
      });
      applyAcpToolPatch(accumulator, {
        ...completedCall("call-b"),
        rawInput: { command: ["printf", `${shapes["embedded JSON"]}${filler}`] },
      });
      const evidence = finishAcpToolEvidence(accumulator);
      for (const call of evidence.calls) {
        assert.deepStrictEqual(call.problems, ["oversized_input"]);
        assert.strictEqual(call.rawInputJson, undefined);
      }
      assert.ok(!JSON.stringify(evidence).includes(secret));
    });
  });
});
