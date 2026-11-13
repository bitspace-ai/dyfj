import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ACP_TOOL_OUTPUT_TRUNCATION_MARKER,
  applyAcpToolPatch,
  finishAcpToolEvidence,
  MAX_ACP_TOOL_EVIDENCE_FIELD_BYTES,
  newAcpToolEvidenceAccumulator,
} from "./acp-tool-evidence.ts";
import { prepareAcpToolEvidence } from "./acp-tool-evidence-record.ts";

function command(extra: Record<string, unknown> = {}) {
  const accumulator = newAcpToolEvidenceAccumulator();
  applyAcpToolPatch(accumulator, {
    sessionUpdate: "tool_call",
    toolCallId: "command",
    title: "Run check",
    kind: "execute",
    status: "in_progress",
    rawInput: { command: "check" },
    ...extra,
  });
  const patch = (fields: Record<string, unknown>) => applyAcpToolPatch(accumulator, {
    sessionUpdate: "tool_call_update",
    toolCallId: "command",
    ...fields,
  });
  return {
    accumulator,
    patch,
    chunk: (data: unknown) => patch({ _meta: { terminal_output_delta: { data } } }),
    end: (exit_code: unknown, status = "completed") => patch({
      status,
      _meta: { terminal_exit: { exit_code } },
    }),
    captured: () => finishAcpToolEvidence(accumulator).calls[0],
    prepared: () => prepareAcpToolEvidence(finishAcpToolEvidence(accumulator)).calls[0],
  };
}

describe("ACP terminal command evidence", () => {
  for (const [status, exitCode] of [["completed", 0], ["failed", 7]] as const) {
    it(`records two chunks and the exit code of a ${status} command`, () => {
      const call = command();
      call.chunk("first\n");
      call.chunk("second\n");
      call.end(exitCode, status);
      assert.deepStrictEqual(call.prepared(), {
        outcome: "recorded",
        toolCallId: "command",
        toolName: "acp.execute",
        toolArguments: '{"title":"Run check","kind":"execute","input":{"command":"check"}}',
        toolResult: JSON.stringify({ exitCode, output: "first\nsecond\n" }),
        toolIsError: status === "failed",
      });
    });
  }

  it("records an exit code with empty output, including a null exit", () => {
    for (const exitCode of [0, null]) {
      const call = command();
      call.end(exitCode);
      const record = call.prepared();
      assert.equal(record.outcome, "recorded");
      assert.equal(record.toolResult, JSON.stringify({ exitCode, output: "" }));
    }
  });

  it("bounds accumulated UTF-8 output and keeps oversized commands partial", () => {
    const call = command();
    for (const data of ["a".repeat(8_190), "🦀more", "ignored".repeat(2_000)]) {
      call.chunk(data);
      // Inspect the accumulator, not just the finished snapshot: no growing
      // chunk list or unbounded terminal string may hide behind a cut result.
      const state = call.accumulator.calls.get("command") as unknown as { terminal?: { output: string } };
      assert.ok(state.terminal, "terminal output must be accumulated");
      assert.ok(Buffer.byteLength(state.terminal.output) <= MAX_ACP_TOOL_EVIDENCE_FIELD_BYTES);
    }
    call.end(0);
    const record = call.prepared();
    assert.partialDeepStrictEqual(record, { outcome: "partial", reason: "oversized_output" });
    assert.ok(record.toolResult?.endsWith(ACP_TOOL_OUTPUT_TRUNCATION_MARKER));
    assert.ok(Buffer.byteLength(record.toolResult!) <= MAX_ACP_TOOL_EVIDENCE_FIELD_BYTES);
    assert.ok(!record.toolResult!.includes("ignored"));
  });

  it("rejects credential-shaped chunks and keeps no output", () => {
    // Constructed canary, including a shape split across updates and one
    // arriving after the kept output has reached its bound.
    const secret = "abcdefghijklmnopqrstuvwxyz012345";
    for (const chunks of [
      ["safe\n", `password="${secret}"`],
      ["to", `ken=${secret}`],
      ["x".repeat(9_000), `password="${secret}"`],
      [`to\u0000ken=${secret}`],
    ]) {
      const call = command();
      for (const chunk of chunks) call.chunk(chunk);
      call.chunk("later safe text");
      call.end(0);
      assert.partialDeepStrictEqual(call.prepared(), { outcome: "rejected", reason: "credential_shaped" });
      assert.equal(call.captured().rawOutputJson, undefined);
      assert.equal(call.prepared().toolResult, undefined);
      assert.ok(!JSON.stringify(call.accumulator.entries).includes(secret));
      assert.ok(!JSON.stringify(call.accumulator.entries).includes("safe"));
    }
  });

  it("marks malformed terminal data and exit codes as output problems", () => {
    for (const _meta of [
      { terminal_output_delta: { data: 42 } },
      { terminal_output_delta: null },
      { terminal_output_delta: {} },
      { terminal_exit: { exit_code: "0" } },
      { terminal_exit: { exit_code: 0.5 } },
      { terminal_exit: {} },
    ]) {
      const call = command();
      call.patch({ _meta });
      call.end(0);
      assert.deepStrictEqual(call.captured().problems, ["malformed"]);
      assert.equal(call.captured().rawOutputJson, undefined);
      assert.partialDeepStrictEqual(call.prepared(), { outcome: "rejected", reason: "malformed" });
    }
  });

  it("preserves the existing rawOutput-only recorded case exactly", () => {
    // The completedCall("call-a") case in acp-tool-evidence.test.ts.
    const call = command({
      toolCallId: "call-a",
      title: "Run call-a",
      status: "completed",
      rawInput: { command: ["call-a"] },
      rawOutput: { exitCode: 0 },
    });
    assert.deepStrictEqual(call.prepared(), {
      outcome: "recorded",
      toolCallId: "call-a",
      toolName: "acp.execute",
      toolArguments: '{"title":"Run call-a","kind":"execute","input":{"command":["call-a"]}}',
      toolResult: '{"exitCode":0}',
      toolIsError: false,
    });
  });

  it("redacts MCP terminal metadata, including when MCP identity arrives later", () => {
    for (const late of [false, true]) {
      const identity = {
        title: "mcp.fixture.check",
        rawInput: { server: "fixture", tool: "check", arguments: { text: "private input" } },
      };
      const call = command(late ? {} : identity);
      call.chunk("private output");
      call.end(0);
      if (late) call.patch(identity);
      const record = call.prepared();
      assert.equal(record.outcome, "recorded");
      assert.equal(record.toolResult, '"[redacted]"');
      assert.ok(!JSON.stringify(call.accumulator.entries).includes("private"));
    }
  });

  it("merges rawOutput object fields and checks the combined result", () => {
    const call = command({ rawOutput: { detail: "kept", exitCode: 99, output: "old" } });
    call.chunk("clean\u0000 output");
    call.end(0);
    const record = call.prepared();
    assert.equal(record.outcome, "recorded");
    assert.deepStrictEqual(JSON.parse(record.toolResult!), {
      detail: "kept", exitCode: 0, output: "clean\u0000 output",
    });
    // The shared rawOutput path preserves JSON escaping of controls.
    assert.ok(!record.toolResult!.includes("\u0000"));
    const large = command({ rawOutput: { detail: "x".repeat(4_100) } });
    large.chunk("y".repeat(4_100));
    large.end(0);
    assert.partialDeepStrictEqual(large.prepared(), { outcome: "partial", reason: "oversized_output" });
  });

  it("captures final-only output and ignores unrelated metadata without reading terminal ids", () => {
    const call = command();
    call.patch({ status: "completed", _meta: {
      terminal_output_delta: {
        data: "final only",
        get terminal_id() { throw new Error("terminal id read"); },
      },
      terminal_exit: {
        exit_code: 0,
        get terminal_id() { throw new Error("terminal id read"); },
      },
      get unrelated() { throw new Error("unrelated metadata read"); },
    } });
    assert.equal(call.prepared().toolResult, '{"exitCode":0,"output":"final only"}');
  });

  it("keeps a command with terminal output but no final status partial", () => {
    const call = command();
    call.chunk("unfinished");
    const record = call.prepared();
    assert.partialDeepStrictEqual(record, { outcome: "partial", reason: "incomplete_status" });
    assert.equal(record.toolResult, '{"exitCode":null,"output":"unfinished"}');
  });
});
