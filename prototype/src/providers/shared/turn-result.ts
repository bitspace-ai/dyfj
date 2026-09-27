/**
 * The result of a turn the caller cancelled, and the recovery that turns a
 * caller abort into that result instead of an error.
 */
import type { ProviderTurnRequest } from "../adapter.ts";
import type { WorkbenchTurnResult } from "../types.ts";
import { isAbortFromSignal, ProviderRequestAbortedError } from "./abort.ts";
import { estimateParamsInputText, estimateTextTokens } from "./tokens.ts";

export function abortedWorkbenchTurnResult(
  request: ProviderTurnRequest,
  elapsedMs = 0,
  requestDispatched = true,
): WorkbenchTurnResult {
  const { model, selection } = request;
  const input = requestDispatched
    ? estimateTextTokens(estimateParamsInputText(request))
    : 0;
  return {
    text: "",
    model,
    selection,
    usage: {
      input,
      output: 0,
      cost: { total: (input / 1_000_000) * model.costInput },
      cacheRead: 0,
      cacheWrite: 0,
    },
    stopReason: "aborted",
    timings: {
      responseHeadersMs: 0,
      totalMs: elapsedMs,
    },
    ...(requestDispatched ? {} : { requestDispatched: false as const }),
  };
}

export function recoverWorkbenchAbort(
  error: unknown,
  request: ProviderTurnRequest,
  signal: AbortSignal | undefined,
): WorkbenchTurnResult {
  if (error instanceof ProviderRequestAbortedError) {
    return abortedWorkbenchTurnResult(request, error.elapsedMs);
  }
  if (isAbortFromSignal(error, signal)) {
    return abortedWorkbenchTurnResult(request);
  }
  throw error;
}
