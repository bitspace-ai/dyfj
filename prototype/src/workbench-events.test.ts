import { describe, expect, test } from "vitest";
import {
  verifyWorkbenchEventSequence,
  type WorkbenchEventRow,
} from "./workbench-events";

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
  test("accepts the current no-tool Workbench success sequence", () => {
    const result = verifyWorkbenchEventSequence([
      row("session_start"),
      row("model_selected"),
      row("model_response"),
      row("session_end"),
      row("budget_summary"),
    ]);

    expect(result.ok).toBe(true);
    expect(result.sessionId).toBe(SESSION_ID);
    expect(result.traceId).toBe(TRACE_ID);
    expect(result.eventTypes).toEqual([
      "session_start",
      "model_selected",
      "model_response",
      "session_end",
      "budget_summary",
    ]);
  });

  test("accepts an error event instead of a model response", () => {
    const result = verifyWorkbenchEventSequence([
      row("session_start"),
      row("model_selected"),
      row("error"),
      row("session_end"),
      row("budget_summary"),
    ]);

    expect(result.ok).toBe(true);
  });

  test("rejects mixed session ids", () => {
    const result = verifyWorkbenchEventSequence([
      row("session_start"),
      { ...row("model_selected"), session_id: "01OTHERSESSION0000000000000" },
      row("model_response"),
      row("session_end"),
      row("budget_summary"),
    ]);

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("events span multiple session_id values");
  });

  test("rejects a missing model_selected event", () => {
    const result = verifyWorkbenchEventSequence([
      row("session_start"),
      row("model_response"),
      row("session_end"),
      row("budget_summary"),
    ]);

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("missing event_type: model_selected");
  });
});
