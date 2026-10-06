/**
 * Length-stop recovery around every agent-loop provider call: classify a
 * `stopReason: "length"` result (catalog limits + reported usage), then either
 * run ONE bounded continuation retry (output budget exhausted) or fail
 * structured (context overflow) — with the overflow-recovery hook given one
 * shot first. Every retry goes back through `observedTurn`, so the budget
 * gates and usage recording hold for it.
 *
 * A provider that rejects the request outright as larger than its window
 * (`ProviderContextExceededError`, an HTTP 400 rather than a length stop)
 * is the same overflow: the request is refitted against the counts the
 * provider reported and retried once; a rejection that survives that, or
 * one on any other retry, fails the turn with `ContextWindowOverflowError`.
 *
 * Tool calls on a length-stopped response are a cut-off plan: every path
 * that delivers a truncated result strips them, so the loop never executes a
 * plan the model did not finish stating.
 */
import {
  modelRequestedOutputCap,
  modelSupportsTranscriptRetry,
  ProviderContextExceededError,
  type WorkbenchTurnParams,
} from "../providers/mod.ts";
import {
  buildContinuationMessages,
  classifyLengthStop,
  CONTEXT_OVERFLOW_WINDOW_FRACTION,
  ContextWindowOverflowError,
  isBudgetRefusal,
} from "../context/mod.ts";
import type { LengthRecoveryOutcome } from "../contract/mod.ts";
import { compressionRecoverer } from "./compression.ts";
import { estimateRequest, fitLimits, fitRequest } from "./fit-request.ts";
import {
  type LoopCallPurpose,
  type LoopCallRequest,
  type LoopTurnResult,
  observedTurn,
} from "./observed-turn.ts";
import type { RoutedTurn } from "./routed-turn.ts";
import {
  deliverSupersedingRetrySignal,
  emitRuntimeEvent,
} from "./runtime-events.ts";
import {
  estimateRuntimeInputCount,
  transcriptEstimateText,
} from "./transcript.ts";

/** A length stop's prompt- and output-side token totals. */
interface LengthStop {
  result: LoopTurnResult;
  promptTokens: number;
  outputTokens: number;
  emitRecovery: (
    outcome: LengthRecoveryOutcome,
    retriesUsed: number,
  ) => Promise<void>;
}

/**
 * Make one loop call, recovering once from a length stop or a context-size
 * rejection. A rejection that outlives its one refit — on the retry, or on
 * a length-recovery retry — fails structured, naming the window.
 */
export async function recoveredTurn(
  turn: RoutedTurn,
  params: WorkbenchTurnParams,
  request: LoopCallRequest,
  purpose: LoopCallPurpose,
  onProviderError?: (error: unknown) => unknown,
): Promise<LoopTurnResult> {
  try {
    return await recoveredCall(turn, params, request, purpose, onProviderError);
  } catch (err) {
    if (!(err instanceof ProviderContextExceededError)) throw err;
    throw new ContextWindowOverflowError({
      modelSlug: turn.route.selected.slug,
      contextWindow: fitLimits(turn, {
        contextWindow: err.report.limitTokens,
      })?.contextWindow,
      inputTokens: err.report.requestedTokens ?? request.estimatedInputCount,
      outputTokens: 0,
    });
  }
}

async function recoveredCall(
  turn: RoutedTurn,
  params: WorkbenchTurnParams,
  request: LoopCallRequest,
  purpose: LoopCallPurpose,
  onProviderError?: (error: unknown) => unknown,
): Promise<LoopTurnResult> {
  let result: LoopTurnResult;
  try {
    result = await observedTurn(
      turn,
      params,
      request,
      purpose,
      onProviderError,
    );
  } catch (err) {
    if (!(err instanceof ProviderContextExceededError)) throw err;
    const { retried, contextWindow } = await refitRejected(
      turn,
      params,
      request,
      err,
      onProviderError,
    );
    return retried.stopReason === "length"
      ? await settleRefitRetry(turn, retried, contextWindow)
      : retried;
  }
  if (result.stopReason !== "length") return result;
  const stop = await classifyStop(turn, result);
  // A transcript retry only works where the adapter builds its request from
  // `messages`; elsewhere (Google) it would replay the original request
  // verbatim, so recovery must not attempt it.
  const retryable = modelSupportsTranscriptRetry(result.model);
  if (stop.classification === "context_overflow") {
    return await recoverOverflow(
      turn,
      params,
      request,
      stop,
      retryable,
      onProviderError,
    );
  }
  return await continueTruncated(turn, params, request, stop, retryable);
}

/**
 * The provider refused a request the estimate had passed: refit it against
 * the counts the provider reported — its measured size calibrates the
 * estimate, its limit bounds the window — so the retry is smaller by the
 * ratio it was over, and retry once. A refit that changes nothing
 * would resend the same request, so it fails instead; the retry's own
 * rejection fails structured here, with the window and size this recovery
 * learned.
 */
async function refitRejected(
  turn: RoutedTurn,
  params: WorkbenchTurnParams,
  request: LoopCallRequest,
  rejection: ProviderContextExceededError,
  onProviderError?: (error: unknown) => unknown,
): Promise<{ retried: LoopTurnResult; contextWindow: number }> {
  const loopRequest = {
    systemPrompt: params.systemPrompt,
    messages: params.messages ?? [],
    tools: params.tools,
  };
  const estimate = estimateRequest(turn, loopRequest);
  const { requestedTokens, limitTokens } = rejection.report;
  const catalogWindow = turn.route.selected.contextWindow;
  const contextWindow = limitTokens === undefined
    ? catalogWindow
    : Math.min(limitTokens, catalogWindow ?? limitTokens);
  if (contextWindow === undefined) throw rejection;
  const limits = fitLimits(turn, { contextWindow });
  // The provider's count against the estimate is the estimator's error on
  // this transcript, and the provider measured the request it refused: the
  // budget shrinks by the whole ratio. A floor would leave the one retry
  // predictably over the window exactly when the estimate was most wrong.
  const scale = requestedTokens !== undefined && requestedTokens > estimate
    ? estimate / requestedTokens
    : 1;
  let budgetTokens = Math.floor((limits?.budgetTokens ?? 0) * scale);
  // The provider's verdict outranks the estimate: whatever the report said,
  // the retry must be smaller than what was refused.
  if (budgetTokens >= estimate) budgetTokens = Math.floor(estimate / 2);
  const fitted = await fitRequest(
    turn,
    loopRequest,
    "provider_rejected",
    { limits: { contextWindow, budgetTokens } },
  );
  if (!fitted.changed) throw rejection;
  turn.state.session.log(
    "\n[the provider rejected the request as over its context window; " +
      "refitted and retrying]",
  );
  try {
    const retried = await observedTurn(
      turn,
      { ...params, messages: loopRequest.messages },
      {
        modelSlug: request.modelSlug,
        estimatedInputCount: estimateRuntimeInputCount(
          transcriptEstimateText(params.systemPrompt, loopRequest.messages),
        ),
      },
      "recovery",
      onProviderError,
    );
    return { retried, contextWindow };
  } catch (err) {
    if (!(err instanceof ProviderContextExceededError)) throw err;
    // The retry was refused too. Fail with what this recovery learned —
    // the window the first rejection bounded, the retry's own fitted size —
    // preferring any counts the second rejection states, so a count-less
    // second rejection does not fall back to the catalog window and the
    // stale pre-refit estimate.
    throw new ContextWindowOverflowError({
      modelSlug: turn.route.selected.slug,
      contextWindow: err.report.limitTokens === undefined
        ? contextWindow
        : Math.min(err.report.limitTokens, contextWindow),
      inputTokens: err.report.requestedTokens ?? fitted.estimatedTokens,
      outputTokens: 0,
    });
  }
}

/**
 * The refit retry length-stopped. Recovery is bounded to the one retry
 * already made, so no continuation or compression follows: the stop is
 * classified like any other (reported as `lengthStopDetected`) against the
 * window the rejection taught, overflow fails structured, and exhaustion
 * delivers the truncated partial with its cut-off tool plan stripped —
 * never a plan the model did not finish.
 */
async function settleRefitRetry(
  turn: RoutedTurn,
  retried: LoopTurnResult,
  contextWindow: number,
): Promise<LoopTurnResult> {
  // Classified against the window the rejection taught, not the catalog's:
  // a stop that filled the provider's real window is overflow even where
  // the catalog window would have read it as exhaustion.
  const stop = await classifyStop(turn, retried, contextWindow);
  if (stop.classification === "context_overflow") {
    await stop.emitRecovery("overflow_failed", 1);
    throw overflowError(
      retried,
      stop.promptTokens,
      stop.outputTokens,
      contextWindow,
    );
  }
  await stop.emitRecovery("still_truncated", 1);
  turn.state.session.log(
    "\n[response truncated at the output limit after the refit retry; " +
      "not retrying further]",
  );
  return { ...retried, toolCalls: undefined };
}

/**
 * Classify the stop and report it as a `lengthStopDetected` frame, against
 * the catalog window unless a provider rejection taught a smaller one.
 */
async function classifyStop(
  turn: RoutedTurn,
  result: LoopTurnResult,
  contextWindow: number | undefined = result.model.contextWindow,
): Promise<LengthStop & { classification: string }> {
  const { input, state } = turn;
  const sessionId = state.session.sessionId;
  // Prompt-side total for window arithmetic: Anthropic's input_tokens
  // excludes cache traffic, so the cached prompt must be added back.
  const promptTokens = result.usage.input + result.usage.cacheRead +
    result.usage.cacheWrite;
  // Output-side total must include reasoning/thinking tokens: they are drawn
  // from the output budget and occupy the context window, but providers like
  // Gemini report them separately from visible output. Both the cap check and
  // the window arithmetic need the true consumption, or a thinking-heavy stop
  // is misclassified (e.g. reported as overflow and hard-failed when the
  // output cap was actually the cause).
  const outputTokens = result.usage.output + (result.usage.reasoning ?? 0);
  // Classify against the output cap the request actually carried — the
  // Anthropic/Google adapters send fixed caps below what the catalog row says
  // the model can do, and a stop at the requested cap is exhaustion.
  const outputCap = modelRequestedOutputCap(result.model);
  const classification = classifyLengthStop(
    { contextWindow, maxOutputTokens: outputCap },
    { input: promptTokens, output: outputTokens },
  );
  await emitRuntimeEvent(input.frames?.onRuntimeEvent, {
    type: "lengthStopDetected",
    sessionId,
    modelSlug: result.model.slug,
    classification,
    severity: classification === "context_overflow" ? "error" : "warn",
    inputTokens: promptTokens,
    outputTokens,
    contextWindow,
    maxOutputTokens: outputCap,
  });
  return {
    result,
    promptTokens,
    outputTokens,
    classification,
    emitRecovery: (outcome, retriesUsed) =>
      emitRuntimeEvent(input.frames?.onRuntimeEvent, {
        type: "lengthRecoveryFinished",
        sessionId,
        modelSlug: result.model.slug,
        outcome,
        retriesUsed,
      }),
  };
}

/**
 * Context overflow: give the recovery hook one shot (the caller's, else
 * compress-then-retry), announce the superseding retry before any retry
 * output exists, and fail structured when there is no plan or the retry still
 * overflows. Never loops.
 */
async function recoverOverflow(
  turn: RoutedTurn,
  params: WorkbenchTurnParams,
  request: LoopCallRequest,
  stop: LengthStop,
  retryable: boolean,
  onProviderError?: (error: unknown) => unknown,
): Promise<LoopTurnResult> {
  const { result, emitRecovery } = stop;
  const recover = turn.ports.recoverContextOverflow ??
    compressionRecoverer(turn);
  if (!retryable) {
    await emitRecovery("overflow_failed", 0);
    throw overflowError(result, stop.promptTokens, stop.outputTokens);
  }
  let retried: LoopTurnResult | undefined;
  let retriesUsed = 0;
  try {
    const plan = await recover({
      sessionId: turn.state.session.sessionId,
      modelSlug: result.model.slug,
      contextWindow: result.model.contextWindow,
      // Reasoning-inclusive, consistent with classification: the compression
      // consumer sizes its plan from true token pressure.
      usage: { input: stop.promptTokens, output: stop.outputTokens },
      systemPrompt: params.systemPrompt,
      // Snapshot: the hook must not be able to mutate the live agent-loop
      // transcript, even when it throws or returns null.
      messages: structuredClone(params.messages ?? []),
    });
    if (plan !== null) {
      // The retry's answer REPLACES the partial that already streamed —
      // announce the supersede before any retry deltas (deltas and events
      // share one ordered channel on every streaming transport) so a
      // rendering consumer can reset its buffer. The log note is the same
      // signal for the in-process presenter, which has no event channel.
      //
      // Fail-closed, and deliberately BEFORE retriesUsed is counted: if the
      // signal cannot be delivered, the retry must not start at all, because
      // its deltas would concatenate onto the stale ones the consumer still
      // has on screen. The throw lands in the catch below, which closes the
      // recovery trail — and no retry was consumed.
      await deliverSupersedingRetrySignal(turn.input.frames?.onRuntimeEvent, {
        type: "supersedingRetryStarted",
        sessionId: turn.state.session.sessionId,
        modelSlug: result.model.slug,
        reason: "context_overflow_recovery",
      });
      retriesUsed = 1;
      turn.state.session.log(
        "\n[context recovered — retrying; the reply restarts below]",
      );
      // The plan is sized like any other request before it goes out: a
      // compressed transcript whose verbatim tail still carries oversized
      // tool results is shrunk, not sent over the window. Compression had
      // its one shot in the plan itself.
      await fitRequest(
        turn,
        {
          systemPrompt: params.systemPrompt,
          messages: plan.messages,
          tools: params.tools,
        },
        "before_send",
        { compress: false },
      );
      retried = await observedTurn(
        turn,
        { ...params, messages: plan.messages },
        {
          modelSlug: request.modelSlug,
          estimatedInputCount: estimateRuntimeInputCount(
            transcriptEstimateText(params.systemPrompt, plan.messages),
          ),
        },
        "recovery",
        onProviderError,
      );
    }
  } catch (err) {
    // Close the recovery trail before the error surfaces as turnFailed. A
    // plan that cannot be made to fit is the overflow itself, not an
    // errored retry: no request was made.
    await emitRecovery(
      err instanceof ContextWindowOverflowError && retried === undefined
        ? "overflow_failed"
        : "retry_errored",
      retriesUsed,
    );
    throw err;
  }
  if (retried === undefined) {
    await emitRecovery("overflow_failed", 0);
    throw overflowError(result, stop.promptTokens, stop.outputTokens);
  }
  return await settleOverflowRetry(retried, emitRecovery);
}

/**
 * The overflow retry's own outcome. A retry that length-stopped is
 * reclassified against ITS OWN usage and caps: compression can resolve the
 * overflow while the fresh answer then hits its output cap, which is a
 * bounded truncation, not another overflow carrying stale usage.
 */
async function settleOverflowRetry(
  retried: LoopTurnResult,
  emitRecovery: LengthStop["emitRecovery"],
): Promise<LoopTurnResult> {
  if (retried.stopReason !== "length") {
    await emitRecovery("recovered", 1);
    return retried;
  }
  const retryPromptTokens = retried.usage.input + retried.usage.cacheRead +
    retried.usage.cacheWrite;
  const retryOutputTokens = retried.usage.output +
    (retried.usage.reasoning ?? 0);
  const retryClass = classifyLengthStop(
    {
      contextWindow: retried.model.contextWindow,
      maxOutputTokens: modelRequestedOutputCap(retried.model),
    },
    { input: retryPromptTokens, output: retryOutputTokens },
  );
  if (retryClass === "context_overflow") {
    await emitRecovery("overflow_failed", 1);
    throw overflowError(retried, retryPromptTokens, retryOutputTokens);
  }
  // Output-exhausted after a successful compression: bounded terminal
  // outcome, no third call. Strip the cut-off tool plan.
  await emitRecovery("still_truncated", 1);
  return { ...retried, toolCalls: undefined };
}

function overflowError(
  result: LoopTurnResult,
  inputTokens: number,
  outputTokens: number,
  contextWindow: number | undefined = result.model.contextWindow,
): ContextWindowOverflowError {
  return new ContextWindowOverflowError({
    modelSlug: result.model.slug,
    contextWindow,
    inputTokens,
    outputTokens,
  });
}

/**
 * Output budget exhausted: one continuation retry on a COPY of the
 * transcript (the loop's live `messages` stay untouched, so a refused or
 * failed retry leaves turn state as it was). The merged text keeps the
 * streamed view consistent: the partial already went out; the retry streams
 * only its continuation.
 */
async function continueTruncated(
  turn: RoutedTurn,
  params: WorkbenchTurnParams,
  request: LoopCallRequest,
  stop: LengthStop,
  retryable: boolean,
): Promise<LoopTurnResult> {
  const { result, emitRecovery } = stop;
  const log = turn.state.session.log;
  if (!retryable) {
    await emitRecovery("retry_unsupported", 0);
    log(
      "\n[response truncated at the output limit; this model's adapter " +
        "cannot run a continuation retry]",
    );
    return { ...result, toolCalls: undefined };
  }
  const continuation = buildContinuationMessages(
    params.messages ?? [{ role: "user", content: params.prompt }],
    result.text,
  );
  const continuationInput = estimateRuntimeInputCount(
    transcriptEstimateText(params.systemPrompt, continuation),
  );
  // Feasibility pre-check: when both the output cap AND the context window
  // bind this stop, the continuation (original transcript + partial answer +
  // nudge) no longer fits the window, so a retry would be a doomed
  // over-window call. Skip it and deliver the capped partial. The threshold
  // reuses the classification's window-evidence fraction.
  if (
    result.model.contextWindow !== undefined &&
    continuationInput >=
      result.model.contextWindow * CONTEXT_OVERFLOW_WINDOW_FRACTION
  ) {
    await emitRecovery("retry_would_overflow", 0);
    log(
      "\n[response truncated at the output limit; the continuation would " +
        "exceed the context window, so it was not retried]",
    );
    return { ...result, toolCalls: undefined };
  }
  // The continuation is sized like any other request: its tool results may
  // be shrunk to fit the input budget (which, unlike the window check
  // above, reserves room for the output); one that still cannot fit is the
  // same doomed retry, skipped the same way. No compression here: the
  // nudge is a user message no session_start backs.
  try {
    await fitRequest(
      turn,
      {
        systemPrompt: params.systemPrompt,
        messages: continuation,
        tools: params.tools,
      },
      "before_send",
      { compress: false },
    );
  } catch (err) {
    if (!(err instanceof ContextWindowOverflowError)) throw err;
    await emitRecovery("retry_would_overflow", 0);
    log(
      "\n[response truncated at the output limit; the continuation would " +
        "exceed the context window, so it was not retried]",
    );
    return { ...result, toolCalls: undefined };
  }
  let retried: LoopTurnResult;
  try {
    retried = await observedTurn(
      turn,
      { ...params, messages: continuation },
      {
        modelSlug: request.modelSlug,
        // Re-measured: the fit above may have shrunk the continuation.
        estimatedInputCount: estimateRuntimeInputCount(
          transcriptEstimateText(params.systemPrompt, continuation),
        ),
      },
      "recovery",
    );
  } catch (err) {
    if (isBudgetRefusal(err)) {
      // The envelope refused the retry, not the turn: the paid partial
      // output already streamed to the operator, so deliver it truncated
      // rather than discarding it. First-call budget errors — and a
      // runaway-anomaly halt anywhere — still fail the turn.
      await emitRecovery("retry_refused_budget", 0);
      log(
        `\n[response truncated at the output limit; retry skipped: ${
          (err as Error).message
        }]`,
      );
      return { ...result, toolCalls: undefined };
    }
    await emitRecovery("retry_errored", 1);
    throw err;
  }
  const merged = { ...retried, text: result.text + retried.text };
  if (retried.stopReason === "length") {
    await emitRecovery("still_truncated", 1);
    log(
      "\n[response still truncated after one continuation retry; " +
        "not retrying further]",
    );
    return { ...merged, toolCalls: undefined };
  }
  await emitRecovery("recovered", 1);
  return merged;
}
