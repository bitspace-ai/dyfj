/**
 * Fit an agent-loop request to the model's context window before it is
 * sent, and bound each fresh tool result against the window left for the
 * turn. A request the estimate says is over the window is never sent: it is
 * shrunk (earlier tool results to a marker, oldest first), then elder turns
 * are compressed with the transcript compressor, then the current turn's
 * results are shrunk, and only a request that still does not fit fails the
 * turn with the structured context-overflow error.
 *
 * The live transcript is fitted in place: the loop owns that array and
 * every later call starts from the fitted state. Durable `tool_call` and
 * `context_compressed` events are what resume rebuilds from — shrinking
 * writes none, compression writes its own — so this is a projection of what
 * the model is sent, not a rewrite of the log (context/request-fit.ts).
 */
import {
  modelRequestedOutputCap,
  type WorkbenchMessage,
  type WorkbenchToolDefinition,
} from "../providers/mod.ts";
import {
  ContextWindowOverflowError,
  countTurns,
  currentTurnStart,
  partitionForCompression,
  requestEstimateText,
  requestInputBudget,
  shrinkToolResults,
  toolResultShareChars,
  trimToolResult,
  VERBATIM_TAIL_TURNS,
} from "../context/mod.ts";
import { compressTranscript } from "./compression.ts";
import type { RoutedTurn } from "./routed-turn.ts";
import { emitRuntimeEvent } from "./runtime-events.ts";
import type { ToolResultSummary } from "./runtime-types.ts";
import { estimateRuntimeInputCount } from "./transcript.ts";

/** The request as it would be sent: what the estimate measures. */
export interface LoopRequest {
  systemPrompt: string;
  /** The live transcript; `fitRequest` fits it in place. */
  messages: WorkbenchMessage[];
  /** The tool definitions the request offers; none on a forced conclusion. */
  tools: WorkbenchToolDefinition[] | undefined;
}

export type FitTrigger = "before_send" | "provider_rejected";

export interface FitLimits {
  contextWindow: number;
  /** The input tokens the request may carry. */
  budgetTokens: number;
}

/** The estimated input tokens of a request, tool definitions included. */
export function estimateRequest(request: LoopRequest): number {
  return estimateRuntimeInputCount(
    requestEstimateText(request.systemPrompt, request.messages, request.tools),
  );
}

/**
 * The window and input budget a fit runs against; null when the catalog
 * declares no window and the caller supplies none (unknown is not
 * unlimited, but there is nothing to measure against).
 */
export function fitLimits(
  turn: RoutedTurn,
  override: Partial<FitLimits> = {},
): FitLimits | null {
  const contextWindow = override.contextWindow ??
    turn.route.selected.contextWindow;
  if (contextWindow === undefined) return null;
  return {
    contextWindow,
    budgetTokens: override.budgetTokens ??
      requestInputBudget(
        contextWindow,
        modelRequestedOutputCap(turn.route.selected),
      ),
  };
}

export interface FitOutcome {
  /** The request's estimate once fitting is done. */
  estimatedTokens: number;
  /** Whether the transcript was changed by the fit. */
  changed: boolean;
}

/**
 * Make `request` fit `limits` (the turn's own when absent), in place. Emits
 * `contextFitted` when anything changed; throws `ContextWindowOverflowError`
 * when the request still does not fit, before any provider call.
 */
export async function fitRequest(
  turn: RoutedTurn,
  request: LoopRequest,
  trigger: FitTrigger,
  override: Partial<FitLimits> = {},
): Promise<FitOutcome> {
  const limits = fitLimits(turn, override);
  const before = estimateRequest(request);
  if (limits === null || before <= limits.budgetTokens) {
    return { estimatedTokens: before, changed: false };
  }
  const { messages } = request;
  const estimate = (candidate: readonly WorkbenchMessage[]) =>
    estimateRequest({ ...request, messages: [...candidate] });
  const shrink = (from: number, to: number): number => {
    const shrunk = shrinkToolResults(
      messages,
      { from, to },
      limits.budgetTokens,
      estimate,
      limits.contextWindow,
    );
    messages.splice(0, messages.length, ...shrunk.messages);
    return shrunk.trims.length;
  };
  // 1. Earlier turns' tool results, oldest first: stale evidence goes
  //    before anything the current turn gathered.
  let trimmed = shrink(0, currentTurnStart(messages));
  // 2. Elder turns compressed, when there are any and shrinking was not
  //    enough. The current prompt is already inside the tail (it is the
  //    last user message), so the retained count takes no +1 — the same
  //    rule as the overflow recoverer in compression.ts.
  let compressed = false;
  if (estimateRequest(request) > limits.budgetTokens) {
    const { elder, tail } = partitionForCompression(
      messages,
      VERBATIM_TAIL_TURNS,
    );
    if (elder.length > 0) {
      const outcome = await compressTranscript(
        turn,
        elder,
        countTurns(tail),
        "request_fit",
      );
      if (outcome.status === "compressed") {
        messages.splice(0, messages.length, outcome.summaryMessage, ...tail);
        compressed = true;
      }
    }
  }
  // 3. The current turn's own results, oldest first, as the last resort
  //    before failing.
  if (estimateRequest(request) > limits.budgetTokens) {
    trimmed += shrink(currentTurnStart(messages), messages.length);
  }
  const after = estimateRequest(request);
  const changed = trimmed > 0 || compressed;
  if (changed) {
    await emitRuntimeEvent(turn.input.frames?.onRuntimeEvent, {
      type: "contextFitted",
      sessionId: turn.state.session.sessionId,
      modelSlug: turn.route.selected.slug,
      contextWindow: limits.contextWindow,
      budgetTokens: limits.budgetTokens,
      estimatedTokensBefore: before,
      estimatedTokensAfter: after,
      trimmedToolResults: trimmed,
      compressed,
      trigger,
    });
    turn.state.session.log(
      `[context fitted to the ${limits.contextWindow}-token window: ` +
        `~${before} → ~${after} tokens` +
        (trimmed > 0 ? `, ${trimmed} tool result(s) trimmed` : "") +
        (compressed ? ", elder turns compressed" : "") + "]",
    );
  }
  if (after > limits.budgetTokens) {
    throw new ContextWindowOverflowError({
      modelSlug: turn.route.selected.slug,
      contextWindow: limits.contextWindow,
      inputTokens: after,
      outputTokens: 0,
    });
  }
  return { estimatedTokens: after, changed };
}

/**
 * Bound one fresh tool result to its share of the window left for the
 * turn: the budget less the request so far, split among the calls still to
 * run in the step. A result over its share is cut with the marker; the
 * durable event already holds the full result. Returns the summary the
 * transcript gets.
 */
export async function boundToolResult(
  turn: RoutedTurn,
  summary: ToolResultSummary,
  requestSoFarTokens: number,
  callsRemaining: number,
): Promise<ToolResultSummary> {
  const limits = fitLimits(turn);
  if (limits === null) return summary;
  const share = toolResultShareChars(
    limits.budgetTokens - requestSoFarTokens,
    callsRemaining,
  );
  const trimmed = trimToolResult(
    summary.result,
    share,
    summary.commandId,
    limits.contextWindow,
  );
  if (trimmed === null) return summary;
  await emitRuntimeEvent(turn.input.frames?.onRuntimeEvent, {
    type: "toolResultTrimmed",
    sessionId: turn.state.session.sessionId,
    commandId: summary.commandId,
    callId: summary.callId,
    contextWindow: limits.contextWindow,
    keptChars: trimmed.keptChars,
    totalChars: trimmed.totalChars,
  });
  return { ...summary, result: trimmed.content };
}
