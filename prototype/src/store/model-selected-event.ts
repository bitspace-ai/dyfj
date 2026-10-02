import { generateSpanId, generateULID } from "../kernel/mod.ts";
import { processEnv, resolvePrincipalId } from "../config/mod.ts";
import {
  type AuthnEventFields,
  modelSelectedEvent,
} from "./events/builders.ts";
import type { EventInsert } from "./generated/rows.ts";
import type { Journal } from "./port.ts";

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
  /** Default: the principal the process environment names. */
  principalId?: string;
  authnFields?: AuthnEventFields;
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
  authnFields?: AuthnEventFields;
}): EventInsert {
  return modelSelectedEvent({
    event_id: params.eventId ?? generateULID(),
    session_id: params.sessionId,
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
  });
}
