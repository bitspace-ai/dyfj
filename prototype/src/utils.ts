import { generateSpanId, generateULID } from "./kernel/mod.ts";
import { processEnv, resolvePrincipalId } from "./config/mod.ts";
import type { Journal } from "./store/mod.ts";

// ─── Telemetry helpers ────────────────────────────────────────────────────────

export async function writeModelSelectedEvent(journal: Journal, params: {
  selected: string;
  considered: string[];
  reason: string;
  sessionId: string;
  traceId: string;
  provider?: string;
  api?: string;
  durationMs?: number;
  parentSpanId?: string;
  authnFields?: Record<string, unknown>;
}): Promise<void> {
  await journal.commit({ events: [buildModelSelectedEventPayload(params)] });
}

function buildModelSelectedEventPayload(params: {
  selected: string;
  considered: string[];
  reason: string;
  sessionId: string;
  traceId: string;
  provider?: string;
  api?: string;
  durationMs?: number;
  eventId?: string;
  spanId?: string;
  parentSpanId?: string;
  principalId?: string;
  authnFields?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    event_id: params.eventId ?? generateULID(),
    session_id: params.sessionId,
    event_type: "model_selected",
    trace_id: params.traceId,
    span_id: params.spanId ?? generateSpanId(),
    parent_span_id: params.parentSpanId ?? null,
    principal_id: params.principalId ??
      resolvePrincipalId(processEnv),
    principal_type: "human",
    action: "select",
    resource: params.selected,
    authz_basis: "routing_heuristic",
    model_id: params.selected,
    provider: params.provider ?? null,
    api: params.api ?? null,
    ...params.authnFields,
    content: JSON.stringify({
      selected: params.selected,
      considered: params.considered,
      reason: params.reason,
    }),
    duration_ms: params.durationMs ?? null,
  };
}
