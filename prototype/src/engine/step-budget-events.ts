/**
 * The durable record of a turn's tool-step budget decisions (BIT-992).
 *
 * Each decision the loop makes about its step budget is one `step_budget`
 * event: the figures it decided from (the soft limit, the ceiling, the
 * effective limit, the step) and what it decided. Written best-effort, like
 * every other telemetry row the agent loop adds: a failed write must not fail
 * a turn whose tool call already succeeded.
 */
import { generateSpanId, generateULID } from "../kernel/mod.ts";
import { stepBudgetEvent } from "../store/events/builders.ts";
import type { EventInsert } from "../store/generated/rows.ts";
import { writeMaybe } from "./event-writes.ts";
import { commitEvent, type TurnState } from "./turn-state.ts";
import type { StepDecision } from "./step-budget.ts";

/** The `content` a `step_budget` event carries: figures, then the decision. */
export interface StepBudgetRecord {
  decision: "continue" | "extended" | "stop";
  /** The configured step count before any extension. */
  softLimit: number;
  /** The hard bound, however productive the turn is. */
  ceiling: number;
  /** The step count the turn may reach after this decision. */
  effectiveLimit: number;
  /** The tool step just completed, counting from 1. */
  step: number;
  /** Whether that step made forward progress. */
  productive: boolean;
  /** Why tool use ended; present only on a stop. */
  reason?: string;
  /** Consecutive unproductive steps at the soft limit. */
  stalledSteps: number;
}

/** The event row for one decision. */
export function stepBudgetEventPayload(
  state: TurnState,
  record: StepBudgetRecord,
): EventInsert {
  const { session } = state;
  return stepBudgetEvent({
    event_id: generateULID(),
    session_id: session.sessionId,
    trace_id: session.traceId,
    span_id: generateSpanId(),
    parent_span_id: session.turnRootSpanId,
    principal_id: session.principalId,
    principal_type: "human",
    action: "budget",
    resource: "tool_steps",
    authz_basis: "system",
    ...session.authnEventFields,
    model_id: state.selectedForEvents?.slug ?? null,
    provider: state.selectedForEvents?.provider ?? null,
    api: state.selectedForEvents?.api ?? null,
    content: JSON.stringify(record),
  });
}

/** Write one decision to the durable log, best-effort. */
export async function writeStepBudgetEvent(
  state: TurnState,
  record: StepBudgetRecord,
  store: Parameters<typeof commitEvent>[0],
): Promise<void> {
  await writeMaybe(
    () => commitEvent(store, stepBudgetEventPayload(state, record)),
    true,
    state.audit.noteSkippedEventWrite,
  );
}

/** The record for a decision, from the figures it was decided on. */
export function stepBudgetRecord(
  decision: StepDecision,
  figures: {
    softLimit: number;
    ceiling: number;
    effectiveLimit: number;
    step: number;
    productive: boolean;
    stalledSteps: number;
  },
): StepBudgetRecord {
  return {
    decision: decision.kind,
    ...figures,
    ...(decision.kind === "stop" ? { reason: decision.reason } : {}),
  };
}
