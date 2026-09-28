/**
 * One budget-gated, observed provider call of the agent loop. Every call the
 * loop makes — the first, each tool follow-up, a forced conclusion, a
 * recovery retry — passes the per-call gates and is recorded, because a turn
 * can make several calls: paid consent and the entry ceiling are granted once
 * per turn by `budgetGate`, while the per-call and session limits and the
 * runaway-anomaly stop must hold before each call.
 */
import type {
  WorkbenchTurnParams,
  WorkbenchTurnResult,
} from "../providers/mod.ts";
import type { UnparsedToolCallMarkupDetectedEvent } from "../contract/mod.ts";
import { observedProviderCall } from "./observed-call.ts";
import type { RoutedTurn } from "./routed-turn.ts";
import {
  deliverUnparsedToolCallMarkupSignal,
  emitRuntimeEvent,
} from "./runtime-events.ts";

export type LoopCallPurpose =
  | "initial"
  | "tool_followup"
  | "forced_conclusion"
  | "recovery";

/** What the call is sized as before it is made. */
export interface LoopCallRequest {
  modelSlug: string;
  estimatedInputCount: number;
}

/** A call's result, with the span its tool calls hang below when recorded. */
export type LoopTurnResult = WorkbenchTurnResult & { providerSpanId?: string };

/** Gate, call, record, and report one agent-loop provider call. */
export async function observedTurn(
  turn: RoutedTurn,
  params: WorkbenchTurnParams,
  request: LoopCallRequest,
  purpose: LoopCallPurpose,
  onProviderError?: (error: unknown) => unknown,
): Promise<LoopTurnResult> {
  await gateCall(turn, request);
  const { state, input, route } = turn;
  const { turn: result, providerSpanId, persisted, recorded } =
    await observedProviderCall(turn.observed, {
      params,
      model: route.selected,
      order: ++state.providerCallOrder,
      purpose,
      authzBasis: "policy:local-default",
      recordUnparsedToolCallMarkup: true,
      mapProviderError: onProviderError,
    });
  if (recorded) {
    // Per-turn aggregates across every provider call the loop makes, so the
    // receipt and model_response count the whole turn, not the last call.
    state.cacheReadTokens += result.usage.cacheRead;
    state.cacheWriteTokens += result.usage.cacheWrite;
    state.reasoningTokens += result.usage.reasoning ?? 0;
    state.turnInputTokens += result.usage.input;
    state.turnOutputTokens += result.usage.output;
    state.turnCostUsd += result.usage.cost.total;
    await emitRuntimeEvent(input.frames?.onRuntimeEvent, {
      type: "afterProviderResponse",
      sessionId: state.session.sessionId,
      modelSlug: result.model.slug,
      inputCount: result.usage.input,
      outputCount: result.usage.output,
      totalMs: result.timings.totalMs,
    });
    if (result.unparsedToolCallMarkup) {
      await discloseUnparsedMarkup(turn, result.unparsedToolCallMarkup);
    }
  }
  return {
    ...result,
    ...(persisted ? { providerSpanId } : {}),
  };
}

/** The per-call gates, then the `beforeProviderRequest` frame. */
async function gateCall(
  turn: RoutedTurn,
  request: LoopCallRequest,
): Promise<void> {
  const { state, input, route } = turn;
  const { budget, anomalyConfig, sessionId } = state.session;
  const { selected } = route;
  if (selected.tier > 0) {
    // Fresh cross-session daily figure before every paid call, so concurrent
    // sessions see each other's completed spend (in-flight calls remain
    // invisible; the overshoot shows in receipts).
    const fresh = await state.session.fetchBaselines(sessionId);
    budget.refreshDailyOtherSessions(fresh.dailyOtherSessionsUsd);
  }
  // Runaway-anomaly hard stop FIRST, on actual recorded spend — it holds
  // where the estimate-based ceiling below is blind (multi-call turn
  // accumulation, spend a scope confirmation already covered). An approval
  // admits the spend level it was shown; recorded spend past it re-prompts.
  await route.anomalyGate.ensureAllowed(
    budget.checkAnomaly(selected.tier, anomalyConfig),
  );
  await route.budgetCeilingGate.ensureAllowed(
    budget.checkPreCall(
      selected.tier,
      selected.costInput,
      request.estimatedInputCount,
    ),
  );
  await emitRuntimeEvent(input.frames?.onRuntimeEvent, {
    type: "beforeProviderRequest",
    sessionId,
    modelSlug: request.modelSlug,
    estimatedInputCount: request.estimatedInputCount,
  });
}

/**
 * The required disclosure that tool-call markup was present but not parsed:
 * narrated when there is no frame channel, and always delivered fail-closed.
 */
async function discloseUnparsedMarkup(
  turn: RoutedTurn,
  markup: NonNullable<WorkbenchTurnResult["unparsedToolCallMarkup"]>,
): Promise<void> {
  const { input, state } = turn;
  const warningEvent: UnparsedToolCallMarkupDetectedEvent = {
    type: "unparsedToolCallMarkupDetected",
    sessionId: state.session.sessionId,
    count: markup.count,
    countIsLowerBound: markup.countIsLowerBound,
  };
  if (!input.frames?.onRuntimeEvent) {
    const amount = warningEvent.countIsLowerBound
      ? `at least ${warningEvent.count}`
      : String(warningEvent.count);
    state.session.log(
      `WARNING: unparsed tool-call markup was present (${amount} unmatched opening(s)); ` +
        "no tools were executed from it",
    );
  }
  await deliverUnparsedToolCallMarkupSignal(
    input.frames?.onRuntimeEvent,
    warningEvent,
  );
}
