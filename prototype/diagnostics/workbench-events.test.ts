import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  verifyWorkbenchEventSequence,
  type WorkbenchEventRow,
} from "./workbench-events.ts";

const SESSION_ID = "01TESTSESSION00000000000000";
const TRACE_ID = "0123456789abcdef0123456789abcdef";

function row(eventType: string): WorkbenchEventRow {
  return {
    event_type: eventType,
    session_id: SESSION_ID,
    trace_id: TRACE_ID,
  };
}

describe("verifyWorkbenchEventSequence", () => {
  it("accepts the current no-tool Workbench success sequence", () => {
    const result = verifyWorkbenchEventSequence([
      row("session_start"),
      row("model_selected"),
      row("model_response"),
      row("session_end"),
      row("budget_summary"),
    ]);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.sessionId, SESSION_ID);
    assert.strictEqual(result.traceId, TRACE_ID);
    assert.deepStrictEqual(result.eventTypes, [
      "session_start",
      "model_selected",
      "model_response",
      "session_end",
      "budget_summary",
    ]);
  });

  it("accepts an error event instead of a model response", () => {
    const result = verifyWorkbenchEventSequence([
      row("session_start"),
      row("model_selected"),
      row("error"),
      row("session_end"),
      row("budget_summary"),
    ]);

    assert.strictEqual(result.ok, true);
  });

  it("rejects mixed session ids", () => {
    const result = verifyWorkbenchEventSequence([
      row("session_start"),
      { ...row("model_selected"), session_id: "01OTHERSESSION0000000000000" },
      row("model_response"),
      row("session_end"),
      row("budget_summary"),
    ]);

    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(
      ["events span multiple session_id values"].filter((item) =>
        !result.errors.includes(item)
      ),
      [],
    );
  });

  it("rejects a missing model_selected event", () => {
    const result = verifyWorkbenchEventSequence([
      row("session_start"),
      row("model_response"),
      row("session_end"),
      row("budget_summary"),
    ]);

    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(
      ["missing event_type: model_selected"].filter((item) =>
        !result.errors.includes(item)
      ),
      [],
    );
  });
});
