/**
 * The observed provider call (specs/01-architecture.md §5.1): the one
 * implementation of "call the provider, write its `provider_call` event,
 * record its usage with the budget tracker". The agent loop and transcript
 * compression both go through it.
 *
 * Budget gates run before this call and stay with the caller: the agent loop
 * and compression gate against different models and refresh different
 * baselines. What happens after the usage is recorded (turn aggregates,
 * runtime events, receipts) also stays with the caller.
 */
import { generateSpanId, generateULID } from "../kernel/mod.ts";
import type { Clock } from "../kernel/mod.ts";
import { type EventInsert, providerCallEvent } from "../store/mod.ts";
import type { BudgetTracker } from "../budget/mod.ts";
import {
  runWorkbenchTurn,
  type WorkbenchTurnParams,
  type WorkbenchTurnResult,
} from "../providers/mod.ts";
import { classifyErrorKind } from "./errors.ts";
import { writeMaybe } from "./event-writes.ts";

export type ProviderCallPurpose =
  | "initial"
  | "tool_followup"
  | "forced_conclusion"
  | "recovery"
  | "context_compression";

/** The turn-scoped context every provider call in a turn shares. */
export interface ObservedCallContext {
  /** Writes one event row; a rejection is counted as a skipped write. */
  writeEvent(event: EventInsert): Promise<void>;
  budget: BudgetTracker;
  clock: Clock;
  sessionId: string;
  traceId: string;
  principalId: string;
  /** The turn's root span; every provider call hangs below it. */
  turnRootSpanId: string;
  authnEventFields: Pick<
    EventInsert,
    "authn_status" | "authn_mechanism" | "authn_issuer_ref"
  >;
  /** Counts a best-effort event write that failed. */
  onSkippedEventWrite(): void;
}

export interface ObservedCallRequest {
  params: WorkbenchTurnParams;
  /** The model the call is routed to, named on a failed call's event. */
  model: { slug: string; provider: string; api: string };
  /** The turn-wide provider call sequence number. */
  order: number;
  purpose: ProviderCallPurpose;
  authzBasis: string;
  /**
   * Whether the event carries the unparsed tool-call markup counts. Agent-loop
   * calls do; compression calls never have.
   */
  recordUnparsedToolCallMarkup: boolean;
  /**
   * Maps a provider error before it is classified on the event and rethrown.
   * Identity when absent.
   */
  mapProviderError?: (error: unknown) => unknown;
}

export interface ObservedCallResult {
  turn: WorkbenchTurnResult;
  providerSpanId: string;
  /** Whether the `provider_call` event was written. */
  persisted: boolean;
  /** Whether the request reached the provider, so its usage was recorded. */
  recorded: boolean;
}

/**
 * Call the provider once. A failed call writes an error `provider_call` event
 * and rethrows (mapped by `mapProviderError`); a completed call writes its
 * event with usage and cost, then records the usage with the budget tracker
 * unless the request was never dispatched. Event writes are best-effort: a
 * failure is counted, never thrown.
 */
export async function observedProviderCall(
  context: ObservedCallContext,
  request: ObservedCallRequest,
): Promise<ObservedCallResult> {
  const providerSpanId = generateSpanId();
  const startedAt = context.clock.now();
  const eventBase = {
    session_id: context.sessionId,
    trace_id: context.traceId,
    span_id: providerSpanId,
    parent_span_id: context.turnRootSpanId,
    principal_id: context.principalId,
    principal_type: "agent",
    action: "invoke",
  } as const;
  let turn: WorkbenchTurnResult;
  try {
    turn = await runWorkbenchTurn({
      ...request.params,
      sessionId: request.params.sessionId ?? context.sessionId,
    });
  } catch (err) {
    const safeError = request.mapProviderError?.(err) ?? err;
    await writeMaybe(
      () =>
        context.writeEvent(providerCallEvent({
          event_id: generateULID(),
          ...eventBase,
          resource: request.model.slug,
          authz_basis: request.authzBasis,
          model_id: request.model.slug,
          provider: request.model.provider,
          api: request.model.api,
          provider_call_order: request.order,
          provider_call_purpose: request.purpose,
          provider_error_class: classifyErrorKind(safeError),
          content: null,
          thinking: null,
          stop_reason: "error",
          duration_ms: context.clock.now() - startedAt,
          ...context.authnEventFields,
        })),
      true,
      context.onSkippedEventWrite,
    );
    throw safeError;
  }
  let persisted = true;
  await writeMaybe(
    () =>
      context.writeEvent(providerCallEvent({
        event_id: generateULID(),
        ...eventBase,
        resource: turn.model.slug,
        authz_basis: request.authzBasis,
        model_id: turn.model.slug,
        provider: turn.model.provider,
        api: turn.model.api,
        tokens_input: turn.usage.input,
        tokens_output: turn.usage.output,
        tokens_cache_read: turn.usage.cacheRead,
        tokens_cache_write: turn.usage.cacheWrite,
        cost_total: turn.usage.cost.total,
        stop_reason: turn.stopReason,
        provider_call_order: request.order,
        provider_call_purpose: request.purpose,
        ...(request.recordUnparsedToolCallMarkup && turn.unparsedToolCallMarkup
          ? {
            unparsed_tool_call_count: turn.unparsedToolCallMarkup.count,
            unparsed_tool_call_count_is_lower_bound:
              turn.unparsedToolCallMarkup.countIsLowerBound,
          }
          : {}),
        content: null,
        thinking: null,
        duration_ms: context.clock.now() - startedAt,
        ...context.authnEventFields,
      })),
    true,
    () => {
      persisted = false;
      context.onSkippedEventWrite();
    },
  );
  const recorded = turn.requestDispatched !== false;
  if (recorded) context.budget.record(turn.usage, turn.model.tier);
  return { turn, providerSpanId, persisted, recorded };
}
