export interface WorkbenchEventRow {
  event_type: string;
  session_id: string;
  trace_id: string;
}

export interface WorkbenchEventSequenceResult {
  ok: boolean;
  errors: string[];
  eventTypes: string[];
  sessionId: string | null;
  traceId: string | null;
}

export function verifyWorkbenchEventSequence(rows: WorkbenchEventRow[]): WorkbenchEventSequenceResult {
  const errors: string[] = [];
  const eventTypes = rows.map((row) => row.event_type);
  const sessionIds = new Set(rows.map((row) => row.session_id));
  const traceIds = new Set(rows.map((row) => row.trace_id));

  if (rows.length === 0) errors.push("no events found");
  if (sessionIds.size > 1) errors.push("events span multiple session_id values");
  if (traceIds.size > 1) errors.push("events span multiple trace_id values");

  for (const required of ["session_start", "model_selected", "session_end", "budget_summary"]) {
    if (!eventTypes.includes(required)) errors.push(`missing event_type: ${required}`);
  }

  if (!eventTypes.includes("model_response") && !eventTypes.includes("error")) {
    errors.push("missing event_type: model_response or error");
  }

  if (!appearsInOrder(eventTypes, ["session_start", "model_selected"])) {
    errors.push("model_selected does not follow session_start");
  }
  if (!appearsInOrder(eventTypes, ["session_end", "budget_summary"])) {
    errors.push("budget_summary does not follow session_end");
  }

  return {
    ok: errors.length === 0,
    errors,
    eventTypes,
    sessionId: sessionIds.size === 1 ? [...sessionIds][0] : null,
    traceId: traceIds.size === 1 ? [...traceIds][0] : null,
  };
}

function appearsInOrder(values: string[], ordered: string[]): boolean {
  let idx = -1;
  for (const expected of ordered) {
    idx = values.indexOf(expected, idx + 1);
    if (idx === -1) return false;
  }
  return true;
}
