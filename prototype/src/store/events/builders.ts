/**
 * Typed event constructors, one per `events.event_type`
 * (`specs/02-data-layer.md` section 3). Every event `journal.commit` appends
 * is built here, so an event's columns are checked against the generated
 * `EventInsert` and its type's required fields at compile time.
 *
 * A builder only sets `event_type`: it adds, drops and converts nothing, so
 * the row written is exactly the fields passed in.
 */

import type { EventInsert, EventType } from "../generated/rows.ts";

/** Every `events` column except the type, which the builder sets. */
export type EventFields = Omit<EventInsert, "event_type">;

/** `EventFields` with `K` required and non-null. */
export type EventFieldsWith<K extends keyof EventFields> =
  & EventFields
  & { [P in K]-?: NonNullable<EventFields[P]> };

/** The authentication evidence columns every event may carry. */
export type AuthnEventFields = Pick<
  EventFields,
  | "authn_status"
  | "authn_mechanism"
  | "authn_issuer_ref"
  | "authn_session_ref"
  | "authn_authenticated_at"
  | "authn_expires_at"
  | "authn_evidence_ref"
>;

/** An insert whose `event_type` is known. */
export type TypedEventInsert<T extends EventType> = EventInsert & {
  event_type: T;
};

function build<T extends EventType>(
  eventType: T,
  fields: EventFields,
): TypedEventInsert<T> {
  return { ...fields, event_type: eventType };
}

/** A turn starts; `content` carries the operator's prompt. */
export function sessionStartEvent(
  fields: EventFieldsWith<"content">,
): TypedEventInsert<"session_start"> {
  return build("session_start", fields);
}

/** A turn ends. */
export function sessionEndEvent(
  fields: EventFields,
): TypedEventInsert<"session_end"> {
  return build("session_end", fields);
}

/** Routing chose a model; `content` records what was considered and why. */
export function modelSelectedEvent(
  fields: EventFieldsWith<"content">,
): TypedEventInsert<"model_selected"> {
  return build("model_selected", fields);
}

/** One native provider call, a content-free trace span. */
export function providerCallEvent(
  fields: EventFieldsWith<
    "model_id" | "provider_call_order" | "provider_call_purpose"
  >,
): TypedEventInsert<"provider_call"> {
  return build("provider_call", fields);
}

/**
 * A native turn's answer, with its usage and cost. `model_id` is null when the
 * turn was cancelled before a model was selected.
 */
export function modelResponseEvent(
  fields: EventFields,
): TypedEventInsert<"model_response"> {
  return build("model_response", fields);
}

/** The transcript was compressed. */
export function contextCompressedEvent(
  fields: EventFieldsWith<"content">,
): TypedEventInsert<"context_compressed"> {
  return build("context_compressed", fields);
}

/** A tool invocation, allowed or denied. */
export function toolCallEvent(
  fields: EventFieldsWith<"tool_name" | "tool_call_id">,
): TypedEventInsert<"tool_call"> {
  return build("tool_call", fields);
}

/** A turn failed. */
export function errorEvent(fields: EventFields): TypedEventInsert<"error"> {
  return build("error", fields);
}

/** The session's budget roll-up; `content` carries the summary. */
export function budgetSummaryEvent(
  fields: EventFieldsWith<"content">,
): TypedEventInsert<"budget_summary"> {
  return build("budget_summary", fields);
}

/** An external-agent runner was selected for the turn. */
export function runnerSelectedEvent(
  fields: EventFieldsWith<"runner_kind" | "runner_profile">,
): TypedEventInsert<"runner_selected"> {
  return build("runner_selected", fields);
}

/** An external agent asked for permission, and the verdict. */
export function agentPermissionEvent(
  fields: EventFieldsWith<"runner_kind" | "permission_verdict">,
): TypedEventInsert<"agent_permission"> {
  return build("agent_permission", fields);
}

/** An external agent's answer and its outer evidence. */
export function agentResponseEvent(
  fields: EventFieldsWith<"runner_kind" | "runner_profile">,
): TypedEventInsert<"agent_response"> {
  return build("agent_response", fields);
}

/**
 * One builder per event type. A new `event_type` in the DDL fails typecheck
 * here until it has a builder.
 */
export const EVENT_BUILDERS: {
  readonly [T in EventType]: (fields: never) => TypedEventInsert<T>;
} = {
  model_response: modelResponseEvent,
  tool_call: toolCallEvent,
  error: errorEvent,
  session_start: sessionStartEvent,
  session_end: sessionEndEvent,
  model_selected: modelSelectedEvent,
  budget_summary: budgetSummaryEvent,
  context_compressed: contextCompressedEvent,
  provider_call: providerCallEvent,
  runner_selected: runnerSelectedEvent,
  agent_permission: agentPermissionEvent,
  agent_response: agentResponseEvent,
};
