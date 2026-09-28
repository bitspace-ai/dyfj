/**
 * The native turn's last stage: `completeTurn` records a turn the agent loop
 * finished, `failTurn` classifies a turn that threw, and `finalize` closes
 * the session (session_end, budget summary, receipt, session content) and
 * returns the result — or rethrows the turn's error after the receipt.
 */
import { generateSpanId, generateULID } from "../kernel/mod.ts";
import { summarizeError } from "../contract/mod.ts";
import {
  buildWorkbenchSessionContent,
  errorEvent,
  modelResponseEvent,
  sessionEndEvent,
  updateWorkbenchSession,
} from "../store/mod.ts";
import {
  BudgetCeilingDeclinedError,
  BudgetExceededError,
} from "../budget/mod.ts";
import { ContextWindowOverflowError } from "../context/mod.ts";
import {
  classifyErrorKind,
  PaidEscalationDeclinedError,
  WorkspaceContextUnavailableError,
} from "./errors.ts";
import { writeMaybe } from "./event-writes.ts";
import { routeReasonForMode } from "./route.ts";
import type {
  NativeWorkbenchRuntimeResult,
  WorkbenchRuntimeInput,
} from "./runtime-types.ts";
import {
  buildBudgetTallyLine,
  buildWorkbenchReceipt,
  shouldPrintBudgetTally,
} from "./receipt.ts";
import { printNextWorkResult, validateNextWorkJson } from "./next-work.ts";
import { emitRuntimeEvent } from "./runtime-events.ts";
import {
  commitEvent,
  type NativeTurnPorts,
  type TurnState,
} from "./turn-state.ts";
import type { AgentLoopOutcome } from "./agent-loop.ts";
import type { LoopTurnResult } from "./observed-turn.ts";

// Event-write integrity policy, decoupled from mode. INTEGRITY events are the
// recomputable audit log + session-existence record, so a failed write fails
// the turn rather than silently dropping. BEST_EFFORT events (telemetry,
// denormalized projections derivable from events, and error notifications
// that must not mask the real error) are logged-and-skipped on failure. These
// are the `bestEffort` argument to writeMaybe().
const INTEGRITY = false;
const BEST_EFFORT = true;

/** Present and record a turn the agent loop finished (or saw cancelled). */
export async function completeTurn(
  state: TurnState,
  input: WorkbenchRuntimeInput,
  ports: NativeTurnPorts,
  { result: turn, streamedText }: AgentLoopOutcome,
): Promise<void> {
  const { session } = state;
  const { log, isNextWork } = session;
  input.cancellationWindow?.closeCancellation();
  if (turn.stopReason === "aborted") {
    if (streamedText) {
      log("");
    } else {
      log(turn.text);
    }
  } else if (isNextWork) {
    const result = validateNextWorkJson(turn.text);
    state.validation = { ok: result.ok, errors: result.errors };
    printNextWorkResult(result, turn.text, log);
  } else if (streamedText) {
    log("");
  } else {
    log(turn.text);
  }
  state.finalText = turn.text;
  state.finalStopReason = turn.stopReason;

  state.selectedForReceipt = {
    displayName: turn.model.displayName,
    slug: turn.model.slug,
    tier: turn.model.tier,
    provider: turn.model.provider,
    api: turn.model.api,
  };
  state.routingReason = routeReasonForMode(
    turn.selection.reason,
    turn.model.tier,
    isNextWork,
  );
  state.callTimings = turn.timings;

  const responseSpanId = generateSpanId();
  printBudgetTally(state, input, turn.model.tier);

  await state.audit.writeIntegrity(() =>
    commitEvent(
      ports.store,
      modelResponseEvent({
        event_id: generateULID(),
        session_id: session.sessionId,
        trace_id: session.traceId,
        span_id: responseSpanId,
        parent_span_id: session.turnRootSpanId,
        principal_id: session.principalId,
        principal_type: "agent",
        action: "invoke",
        resource: turn.model.slug,
        authz_basis: "policy:local-default",
        model_id: turn.model.slug,
        provider: turn.model.provider,
        api: turn.model.api,
        // Aggregate across every provider call in this turn (the agent loop
        // may make several) so the audit event counts the whole turn, not
        // just the final call.
        tokens_input: state.turnInputTokens,
        tokens_output: state.turnOutputTokens,
        tokens_cache_read: state.cacheReadTokens,
        tokens_cache_write: state.cacheWriteTokens,
        cost_total: state.turnCostUsd,
        ...session.authnEventFields,
        content: isNextWork
          ? JSON.stringify({
            worklet_id: session.workletId,
            validation: state.validation,
            raw: turn.text,
          })
          : turn.text,
        stop_reason: turn.stopReason,
        duration_ms: turn.timings.totalMs,
      }),
    )
  );
  await emitRuntimeEvent(
    input.frames?.onRuntimeEvent,
    turn.stopReason === "aborted"
      ? {
        type: "turnAborted",
        sessionId: session.sessionId,
        traceId: session.traceId,
        turnId: input.turnId,
      }
      : {
        type: "turnCompleted",
        sessionId: session.sessionId,
        traceId: session.traceId,
      },
  );
}

/** The running budget tally line, when the tally mode asks for it. */
function printBudgetTally(
  state: TurnState,
  input: WorkbenchRuntimeInput,
  tier: LoopTurnResult["model"]["tier"],
): void {
  // Per-call budget.record() happens inside the observed call, so the
  // session summary already aggregates every call in this (and prior) turns.
  const summary = state.session.budget.getSummary();
  const paidCalls = (summary.byTier["1"]?.calls ?? 0) +
    (summary.byTier["2"]?.calls ?? 0);
  // DYFJ_BUDGET_TALLY is parsed at the boundary; the core reads only the
  // input field.
  if (!shouldPrintBudgetTally(input.budgetTallyMode ?? "paid", { paidCalls })) {
    return;
  }
  state.session.log("");
  state.session.log(buildBudgetTallyLine({
    turn: {
      tokensInput: state.turnInputTokens,
      tokensOutput: state.turnOutputTokens,
      costUsd: state.turnCostUsd,
      tier,
    },
    session: {
      totalCostUsd: summary.totalCostUsd,
      totalTokensInput: summary.totalTokensInput,
      totalTokensOutput: summary.totalTokensOutput,
      paidCalls,
      sessionLimitUsd: summary.config.sessionLimitUsd,
    },
  }));
}

/**
 * Classify a turn that threw: report it (`turnFailed`, or `turnAborted` for a
 * cancellation at an approval), record it on the audit log, and keep the
 * error on `state.turnError` when the caller must see it after the receipt.
 */
export async function failTurn(
  state: TurnState,
  input: WorkbenchRuntimeInput,
  ports: NativeTurnPorts,
  err: unknown,
): Promise<void> {
  const { session } = state;
  const { log } = session;
  input.cancellationWindow?.closeCancellation();
  const cancelledAtApproval = input.abortSignal?.aborted === true &&
    err === input.abortSignal.reason;
  // errorName crosses the wire too, so it gets the same discipline as
  // errorMessage: a fixed literal from the class table, never `.name` —
  // that is a plain writable string property, so a foreign error could
  // carry an arbitrary or oversized payload in it.
  const name = classifyErrorKind(err);
  // errorMessage crosses the wire verbatim (server/rpc/turn.ts relays every
  // runtime event to the connected client): an integrity write's failure
  // can be a rejected event-log INSERT whose driver message embeds the
  // whole offending value (e.g. a huge turn.text), so this must never carry
  // the raw message — summarizeError applies the same cap the client side
  // enforces defensively, at the point of origin instead.
  if (!cancelledAtApproval) {
    await emitRuntimeEvent(input.frames?.onRuntimeEvent, {
      type: "turnFailed",
      sessionId: session.sessionId,
      traceId: session.traceId,
      errorName: name,
      errorMessage: summarizeError(err),
    });
  }
  // instanceof, never `name` — name is a plain mutable string property any
  // Error can be given, so branching on it would let a foreign error simply
  // claim one of these class names and ride its raw-.message treatment
  // straight past the whole policy. instanceof checks the real prototype
  // chain instead.
  if (cancelledAtApproval) {
    await recordCancelledTurn(state, input, ports);
  } else if (err instanceof PaidEscalationDeclinedError) {
    // verdict.reason is already sanitized at construction (see the class),
    // so it's safe to read directly here.
    const verdict = err.verdict;
    const detail = verdict.reason ? ` (${verdict.reason})` : "";
    log(
      verdict.decision === "escalate"
        ? `\nPaid inference escalation required - no model call made${detail}.`
        : `\nPaid inference declined - no model call made${detail}.`,
    );
    state.turnError = err;
  } else if (err instanceof BudgetExceededError) {
    // summarizeError, not raw .message: a confirmed DomainError still only
    // gets the shared 500-byte cap, never an unbounded pass-through.
    await writeErrorEvent(state, ports, err, "workbench_model", "error");
    log(`\nBudget exceeded: ${summarizeError(err)}`);
  } else if (err instanceof WorkspaceContextUnavailableError) {
    await writeErrorEvent(state, ports, err, "workbench_context", "error");
    log(`\n${summarizeError(err)}`);
    state.turnError = err;
  } else if (err instanceof ContextWindowOverflowError) {
    // Expected operational condition, not an "Unexpected error": record it
    // on the audit log with the length stop it came from, show the operator
    // the condition + options, and propagate so every transport reports a
    // failed turn. No model_response event was written, so a resumed
    // transcript carries no half-turn from this failure.
    await writeErrorEvent(state, ports, err, "workbench_model", "length");
    log(`\n${summarizeError(err)}`);
    state.turnError = err;
  } else if (err instanceof BudgetCeilingDeclinedError) {
    // Already sanitized at construction — safe to read directly.
    const detail = err.reason;
    log(
      `\nBudget ceiling confirmation declined${
        detail ? `: ${detail}` : ""
      } — the over-budget call was not made.`,
    );
    state.turnError = err;
  } else {
    // Sanitized, not the raw message: this branch also catches a failed
    // INTEGRITY write (e.g. model_response), whose driver error can embed
    // the entire rejected value (turn.text). That value already failed to
    // persist in its own event; echoing it into this one durable row gains
    // no audit signal and risks writing the exact oversized/sensitive
    // payload this policy exists to keep contained.
    await writeErrorEvent(state, ports, err, "workbench_model", "error");
    // Sanitized here too: the injected presenter (e.g. the in-process
    // CLI's `log: console.log`) would otherwise print the raw error —
    // including any driver-embedded turn content — before the class-only
    // console.error below even runs.
    log("\nUnexpected error:", summarizeError(err));
    // Fixed literal from the class table — `.constructor.name` is a
    // writable property a foreign error can shadow with a payload.
    console.error(`[turn-error] ${classifyErrorKind(err)}`);
    state.turnError = err;
  }
}

/** A turn cancelled at an approval: its partial response, then turnAborted. */
async function recordCancelledTurn(
  state: TurnState,
  input: WorkbenchRuntimeInput,
  ports: NativeTurnPorts,
): Promise<void> {
  const { session } = state;
  state.finalStopReason = "aborted";
  const cancelledSpanId = generateSpanId();
  await state.audit.writeIntegrity(() =>
    commitEvent(
      ports.store,
      modelResponseEvent({
        event_id: generateULID(),
        session_id: session.sessionId,
        trace_id: session.traceId,
        span_id: cancelledSpanId,
        parent_span_id: session.turnRootSpanId,
        principal_id: session.principalId,
        principal_type: "agent",
        action: "invoke",
        resource: state.selectedForEvents?.slug ?? "workbench_model",
        authz_basis: "policy:local-default",
        model_id: state.selectedForEvents?.slug ?? null,
        provider: state.selectedForEvents?.provider ?? null,
        api: state.selectedForEvents?.api ?? null,
        tokens_input: state.turnInputTokens,
        tokens_output: state.turnOutputTokens,
        tokens_cache_read: state.cacheReadTokens,
        tokens_cache_write: state.cacheWriteTokens,
        cost_total: state.turnCostUsd,
        ...session.authnEventFields,
        content: state.finalText,
        stop_reason: "aborted",
        duration_ms: ports.clock.now() - session.startedAt,
      }),
    )
  );
  await emitRuntimeEvent(input.frames?.onRuntimeEvent, {
    type: "turnAborted",
    sessionId: session.sessionId,
    traceId: session.traceId,
    turnId: input.turnId,
  });
}

/** A best-effort `error` event carrying the sanitized failure. */
async function writeErrorEvent(
  state: TurnState,
  ports: NativeTurnPorts,
  err: unknown,
  fallbackResource: string,
  stopReason: "error" | "length",
): Promise<void> {
  const { session } = state;
  await writeMaybe(
    () =>
      commitEvent(
        ports.store,
        errorEvent({
          event_id: generateULID(),
          session_id: session.sessionId,
          trace_id: session.traceId,
          span_id: generateSpanId(),
          parent_span_id: session.turnRootSpanId,
          principal_id: session.principalId,
          principal_type: "agent",
          action: "invoke",
          resource: state.selectedForEvents?.slug ?? fallbackResource,
          authz_basis: "policy:local-default",
          model_id: state.selectedForEvents?.slug ?? null,
          provider: state.selectedForEvents?.provider ?? null,
          api: state.selectedForEvents?.api ?? null,
          ...session.authnEventFields,
          content: summarizeError(err),
          stop_reason: stopReason,
          duration_ms: ports.clock.now() - session.startedAt,
        }),
      ),
    BEST_EFFORT,
    state.audit.noteSkippedEventWrite,
  );
}

/**
 * Close the session whatever happened: session_end, the budget summary, the
 * receipt and the session's content row. Then surface the turn's error or a
 * failed integrity write to the caller instead of masking it behind a normal
 * receipt, or return the result.
 */
export async function finalize(
  state: TurnState,
  ports: NativeTurnPorts,
): Promise<NativeWorkbenchRuntimeResult> {
  const { session } = state;
  const { store } = ports;
  await writeMaybe(() =>
    commitEvent(
      store,
      sessionEndEvent({
        event_id: generateULID(),
        session_id: session.sessionId,
        trace_id: session.traceId,
        span_id: generateSpanId(),
        parent_span_id: session.turnRootSpanId,
        principal_id: session.principalId,
        principal_type: "human",
        action: "end",
        resource: "workbench_session",
        authz_basis: session.authContext.authzBasis,
        ...session.authnEventFields,
        duration_ms: ports.clock.now() - session.startedAt,
      }),
    ), INTEGRITY);

  // The count captured here reflects skips up to this point. If this
  // summary write itself fails, its skip fires before the receipt is built
  // below, so it reaches the console line AND the receipt — but not this
  // event's own content. The later session-content write is the only skip
  // that lands after every persisted surface: console line only.
  await writeMaybe(
    () =>
      session.budget.writeSummaryEvent(
        store.journal,
        { skippedEventWrites: state.audit.skippedEventWrites },
        { parentSpanId: session.turnRootSpanId },
      ),
    BEST_EFFORT,
    state.audit.noteSkippedEventWrite,
  );

  const receipt = turnReceipt(state, ports);
  await writeMaybe(
    () =>
      updateWorkbenchSession({
        journal: store.journal,
        sessionId: session.sessionId,
        content: buildWorkbenchSessionContent({
          mode: session.mode,
          prompt: session.prompt,
          traceId: session.traceId,
          contextSources: state.contextSourceLines,
          receipt,
        }),
      }),
    BEST_EFFORT,
    state.audit.noteSkippedEventWrite,
  );
  session.log("");
  session.log(receipt);
  // The runtime never closes the shared store: a long-running host runs
  // many concurrent turns through it, and its lifecycle is owned by the
  // entrypoint. An unexpected turn error (credential missing, provider
  // failure) or a failed integrity write must reach the caller — the receipt
  // above still prints, but the turn is not a success.
  if (state.turnError !== null) throw state.turnError;
  if (state.audit.fatalEventError !== null) {
    throw state.audit.fatalEventError;
  }
  return turnResult(state, receipt);
}

function paidInferenceUsed(state: TurnState): boolean {
  const summary = state.session.budget.getSummary();
  return ((summary.byTier["1"]?.calls ?? 0) +
    (summary.byTier["2"]?.calls ?? 0)) > 0;
}

function turnReceipt(state: TurnState, ports: NativeTurnPorts): string {
  const { session } = state;
  const summary = session.budget.getSummary();
  return buildWorkbenchReceipt({
    sessionId: session.sessionId,
    traceId: session.traceId,
    modelName: state.selectedForReceipt?.displayName ?? "none",
    modelSlug: state.selectedForReceipt?.slug ?? "none",
    provider: state.selectedForReceipt?.provider,
    api: state.selectedForReceipt?.api,
    tier: state.selectedForReceipt?.tier ?? 0,
    routingReason: state.routingReason,
    totalCostUsd: summary.totalCostUsd,
    totalTokensInput: summary.totalTokensInput,
    totalTokensOutput: summary.totalTokensOutput,
    totalCacheReadTokens: state.cacheReadTokens,
    totalCacheWriteTokens: state.cacheWriteTokens,
    totalReasoningTokens: state.reasoningTokens,
    totalCalls: summary.totalCalls,
    contextBudget: state.contextBudget,
    contextProfile: state.contextProfile,
    timings: state.callTimings,
    contextSources: state.contextSourceLines,
    paidInferenceUsed: paidInferenceUsed(state),
    estimatedCostUsd: state.estimatedCostUsd,
    workletId: session.workletId,
    totalElapsedMs: ports.clock.now() - session.startedAt,
    validation: state.validation,
    agent: {
      toolStepsUsed: state.toolSteps,
      maxToolSteps: session.maxToolSteps,
      limitReached: state.toolStepLimitReached,
    },
    skippedEventWrites: state.audit.skippedEventWrites,
    historyOmission: state.historyOmission,
  });
}

function turnResult(
  state: TurnState,
  receipt: string,
): NativeWorkbenchRuntimeResult {
  const { session } = state;
  const summary = session.budget.getSummary();
  return {
    sessionId: session.sessionId,
    traceId: session.traceId,
    stopReason: state.finalStopReason,
    text: state.finalText,
    receipt,
    model: {
      displayName: state.selectedForReceipt?.displayName ?? "none",
      slug: state.selectedForReceipt?.slug ?? "none",
      provider: state.selectedForReceipt?.provider,
      api: state.selectedForReceipt?.api,
      tier: state.selectedForReceipt?.tier ?? 0,
    },
    route: {
      reason: state.routingReason,
    },
    cost: {
      estimatedUsd: state.estimatedCostUsd,
      totalUsd: summary.totalCostUsd,
      paidInferenceUsed: paidInferenceUsed(state),
    },
    tokens: {
      input: summary.totalTokensInput,
      output: summary.totalTokensOutput,
      cacheRead: state.cacheReadTokens,
      cacheWrite: state.cacheWriteTokens,
      reasoning: state.reasoningTokens,
      totalCalls: summary.totalCalls,
    },
    context: {
      profile: state.contextProfile,
      sources: state.contextSourceLines,
      budget: state.contextBudget,
    },
    ...(state.historyOmission === undefined
      ? {}
      : { historyOmission: state.historyOmission }),
    agent: {
      toolStepsUsed: state.toolSteps,
      maxToolSteps: session.maxToolSteps,
      limitReached: state.toolStepLimitReached,
    },
    validation: state.validation,
  };
}
