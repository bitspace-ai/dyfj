import { generateSpanId, generateULID, systemClock } from "../kernel/mod.ts";
import {
  type AcpRunnerSelection,
  DomainError,
  type ExternalAgentWorkbenchRuntimeResult,
  type LengthRecoveryOutcome,
  summarizeError,
  type UnparsedToolCallMarkupDetectedEvent,
} from "../contract/mod.ts";
import { processEnv } from "../config/mod.ts";
import {
  buildWorkbenchSessionContent,
  contextCompressedEvent,
  errorEvent,
  type EventInsert,
  modelResponseEvent,
  sessionEndEvent,
  updateWorkbenchSession,
} from "../store/mod.ts";
import {
  estimateTextTokens,
  isLocalWorkbenchModel,
  modelRequestedOutputCap,
  modelStreamsToolCalls,
  modelSupportsTranscriptRetry,
  runWorkbenchTurn,
  selectWorkbenchModel,
  type WorkbenchCallTimings,
  type WorkbenchMessage,
  type WorkbenchModel,
  type WorkbenchToolCall,
  type WorkbenchTurnResult,
} from "../providers/mod.ts";
import {
  BudgetCeilingDeclinedError,
  BudgetExceededError,
  createRunawayAnomalyGate,
  createTurnBudgetCeilingGate,
} from "../budget/mod.ts";
import {
  buildContinuationMessages,
  classifyLengthStop,
  compressElderTranscript,
  COMPRESSION_SYSTEM_PROMPT,
  type CompressionCompletion,
  type CompressionOutcome,
  CONTEXT_COMPRESSION_TRIGGER_FRACTION,
  CONTEXT_OVERFLOW_WINDOW_FRACTION,
  type ContextOverflowRecoverer,
  ContextWindowOverflowError,
  countTurns,
  isBudgetRefusal,
  partitionForCompression,
  VERBATIM_TAIL_TURNS,
} from "../context/mod.ts";
import { createCommandRegistry, invokeCommandWithEvent } from "../tools/mod.ts";
import { writeModelSelectedEvent } from "../utils.ts";
import {
  classifyErrorKind,
  ContextCompressionPersistenceUncertainError,
  PaidEscalationDeclinedError,
  ToolStepLimitConclusionError,
  WorkspaceContextUnavailableError,
} from "./errors.ts";
import { writeMaybe } from "./event-writes.ts";
import {
  type ObservedCallContext,
  observedProviderCall,
} from "./observed-call.ts";
import {
  confirmPaidRoute,
  resolveRoute,
  routeReasonForMode,
  selectModelRoute,
} from "./route.ts";
import type {
  ExternalAgentRunner,
  NativeWorkbenchRuntimeResult,
  ToolResultSummary,
  WorkbenchRuntimeInput,
  WorkbenchRuntimeResult,
  WorkbenchRuntimeServices,
  WorkbenchValidationSummary,
} from "./runtime-types.ts";
import {
  buildBudgetTallyLine,
  buildWorkbenchReceipt,
  shouldPrintBudgetTally,
} from "./receipt.ts";
import { printNextWorkResult, validateNextWorkJson } from "./next-work.ts";
import {
  deliverSupersedingRetrySignal,
  deliverUnparsedToolCallMarkupSignal,
  emitRuntimeEvent,
} from "./runtime-events.ts";
import { openSession, recordNewSession } from "./open-session.ts";
import { buildContext } from "./build-context.ts";
import {
  commitEvent,
  type NativeTurnPorts,
  newTurnState,
} from "./turn-state.ts";

function forcedConclusionSystemPrompt(
  baseSystemPrompt: string,
  reason: "limit" | "repeated_tool_calls",
): string {
  const reasonText = reason === "limit"
    ? "tool use ended because the configured Workbench tool-step limit was reached"
    : "tool use ended because the model repeated prior tool calls";
  return baseSystemPrompt + "\n\n" +
    `Workbench instruction: ${reasonText}. Answer the original operator prompt ` +
    "from the transcript above. Do not request or call more tools.";
}

/**
 * Turn one agent-loop step into transcript messages: the assistant turn that
 * requested the tools (its text plus the tool-call intentions) followed by one
 * `tool` message per result, each linked back to its call by id. Appending these
 * to the running history is what lets the next step see the model's own prior
 * reasoning and the matching results — instead of a flattened summary string
 * that drops the trail and invites confabulation.
 */
export function toolStepToMessages(
  assistantText: string,
  toolCalls: WorkbenchToolCall[] | undefined,
  stepResults: ToolResultSummary[],
): WorkbenchMessage[] {
  const messages: WorkbenchMessage[] = [
    { role: "assistant", content: assistantText, toolCalls },
  ];
  for (const result of stepResults) {
    messages.push({
      role: "tool",
      toolCallId: result.callId,
      name: result.commandId,
      content: result.result,
      ...(result.isError ? { isError: true } : {}),
    });
  }
  return messages;
}

/** Concatenated text of a transcript, for the fallback input-token estimate. */
function transcriptEstimateText(
  systemPrompt: string,
  messages: WorkbenchMessage[],
): string {
  const body = messages
    .map((m) =>
      m.role === "assistant"
        ? m.content + (m.toolCalls ? JSON.stringify(m.toolCalls) : "")
        : m.content
    )
    .join("\n");
  return `${systemPrompt}\n${body}`;
}

function commandResultText(
  result: { isError: boolean; reason?: string; result?: unknown },
): string {
  if (result.isError) return result.reason ?? "command failed";
  return typeof result.result === "string"
    ? result.result
    : JSON.stringify(result.result);
}

function estimateRuntimeInputCount(text: string): number {
  return Math.ceil(text.length / 4);
}

function requireExternalAgentRunner(
  services: WorkbenchRuntimeServices | undefined,
): ExternalAgentRunner {
  const runner = services?.externalAgentRunner;
  if (runner === undefined) {
    throw new DomainError("No external-agent runner is configured");
  }
  return runner;
}

export function runWorkbenchRuntime(
  runtimeInput: WorkbenchRuntimeInput & { runner: AcpRunnerSelection },
  services: WorkbenchRuntimeServices & {
    externalAgentRunner: ExternalAgentRunner;
  },
): Promise<ExternalAgentWorkbenchRuntimeResult>;
export function runWorkbenchRuntime(
  runtimeInput: WorkbenchRuntimeInput & { runner?: undefined },
  services: WorkbenchRuntimeServices,
): Promise<NativeWorkbenchRuntimeResult>;
export function runWorkbenchRuntime(
  runtimeInput: WorkbenchRuntimeInput,
  services: WorkbenchRuntimeServices,
): Promise<WorkbenchRuntimeResult>;
export async function runWorkbenchRuntime(
  runtimeInput: WorkbenchRuntimeInput,
  services: WorkbenchRuntimeServices,
): Promise<WorkbenchRuntimeResult> {
  const route = await resolveRoute(runtimeInput, services.store.models);
  if (route.runner === "acp") {
    return await requireExternalAgentRunner(services).run({
      ...runtimeInput,
      routingOptions: route.routingOptions,
      runner: route.selection,
    });
  }

  return await runNativeWorkbenchRuntime(runtimeInput, {
    store: services.store,
    ceilingConfirmations: services.ceilingConfirmations,
    clock: services.clock ?? systemClock,
    env: services.env ?? processEnv,
    providerIo: {
      ...(services.http === undefined ? {} : { fetchFn: services.http }),
      ...(services.env === undefined
        ? {}
        : { getEnv: (name: string) => services.env?.get(name) }),
    },
  });
}

async function runNativeWorkbenchRuntime(
  runtimeInput: WorkbenchRuntimeInput,
  ports: NativeTurnPorts,
): Promise<NativeWorkbenchRuntimeResult> {
  const { store } = ports;
  const writeEvent = (
    event: EventInsert,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> => commitEvent(store, event, options);
  const eventExists = (eventId: string) => store.events.exists(eventId);
  const { routingOptions, defaultCompanionModel, permissionLevel } =
    runtimeInput;

  const session = await openSession(runtimeInput, ports);
  const state = newTurnState(session, createCommandRegistry());
  const {
    mode,
    prompt: cliPrompt,
    log,
    sessionId,
    traceId,
    startedAt: sessionStart,
    principalId,
    anomalyConfig,
    fetchBaselines,
    budget,
    authContext,
    authnEventFields,
    isNextWork,
    usesRepoAskContext,
    workletId,
    turnRootSpanId,
    maxToolSteps,
  } = session;
  // Event-write integrity policy, decoupled from mode. INTEGRITY
  // events are the recomputable audit log + session-existence record, so a
  // failed write fails the turn rather than silently dropping. BEST_EFFORT
  // events (telemetry, denormalized projections derivable from events, and
  // error notifications that must not mask the real error) are logged-and-
  // skipped on failure. These are the `bestEffort` argument to writeMaybe().
  const INTEGRITY = false;
  const BEST_EFFORT = true;
  const noteSkippedEventWrite = state.audit.noteSkippedEventWrite;
  const writeIntegrity = (operation: () => Promise<void>) =>
    state.audit.writeIntegrity(operation);
  // Capture an unexpected turn error (e.g. a missing hosted credential) so the
  // finally can re-throw it after the receipt. Without this the catch's else
  // branch logs only to server stderr and the turn looks like a benign empty
  // ($0 / 0-token) success to the client.
  let turnError: unknown = null;
  let providerCallOrder = 0;
  // Shared by every provider call this turn makes (agent loop and
  // compression): observedProviderCall writes each call's provider_call event
  // under the turn root span and records its usage with this turn's tracker.
  const observedCallContext: ObservedCallContext = {
    writeEvent: (event) => writeEvent(event),
    budget,
    clock: ports.clock,
    sessionId,
    traceId,
    principalId,
    turnRootSpanId,
    authnEventFields,
    onSkippedEventWrite: noteSkippedEventWrite,
  };

  let selectedForReceipt:
    | {
      displayName: string;
      slug: string;
      tier: 0 | 1 | 2;
      provider?: string;
      api?: string;
    }
    | null = null;
  let selectedForEvents:
    | { slug: string; provider: string; api: string }
    | null = null;
  let routingReason = "not_selected";
  let estimatedCostUsd = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  // Reasoning/thinking tokens are provider-reported when available. Streaming
  // adapters that receive plaintext reasoning before an interrupt can estimate
  // uncovered usage. The receipt surfaces them separately; the provider
  // adapter includes them in billable cost.
  let reasoningTokens = 0;
  // Per-turn aggregates across every provider call the agent loop makes, so
  // receipts/events count the whole turn, not just the final call.
  let turnInputTokens = 0;
  let turnOutputTokens = 0;
  let turnCostUsd = 0;
  let callTimings: WorkbenchCallTimings | undefined;
  let validation: WorkbenchValidationSummary | undefined;
  let toolSteps = 0;
  let toolStepLimitReached = false;
  let finalText = "";
  let finalStopReason: WorkbenchTurnResult["stopReason"] = "error";
  const captureTurnState = (turn: WorkbenchTurnResult): void => {
    finalText = turn.text;
    finalStopReason = turn.stopReason;
    callTimings = turn.timings;
  };
  try {
    await buildContext(state, runtimeInput, ports);
    const { systemPrompt, modelPrompt, commandRegistry, commandTools } = state;
    const contextSourceLines = state.contextSourceLines;
    await recordNewSession(state, ports);

    const { models, selection, routingReason: selectedRoutingReason } =
      await selectModelRoute(store.models, {
        mode,
        routingOptions,
        defaultCompanionModel,
      });
    const selected = selection.selected;
    selectedForReceipt = {
      displayName: selected.displayName,
      slug: selected.slug,
      tier: selected.tier,
      provider: selected.provider,
      api: selected.api,
    };
    routingReason = selectedRoutingReason;
    selectedForEvents = {
      slug: selected.slug,
      provider: selected.provider,
      api: selected.api,
    };
    const estimatedInputTokens = estimateTextTokens(
      `${systemPrompt}\n${modelPrompt}`,
    );
    const preCall = budget.checkPreCall(
      selected.tier,
      selected.costInput,
      estimatedInputTokens,
    );
    // Scope-persistent store: a confirmed overrun raises the envelope for its
    // scope (session marks per session id, the daily mark per local day)
    // instead of re-prompting next turn.
    const budgetCeilingGate = createTurnBudgetCeilingGate(
      runtimeInput.confirmBudgetCeiling,
      ports.ceilingConfirmations.for(sessionId),
    );
    // Turn-scoped: an approval covers the spend level it was shown (the entry
    // check and the first call's check see identical actuals); any recorded
    // increment re-prompts, and nothing survives the turn.
    const anomalyGate = createRunawayAnomalyGate(
      runtimeInput.confirmRunawayAnomaly,
    );

    // Hard stop BEFORE the soft ceiling confirm: a turn entered in an
    // anomalous state must halt first — otherwise the ceiling prompt records
    // its scope-period confirmation before the operator ever sees the halt,
    // and an aborted turn leaves that confirmation behind.
    await anomalyGate.ensureAllowed(
      budget.checkAnomaly(selected.tier, anomalyConfig),
    );
    await budgetCeilingGate.ensureAllowed(preCall);
    estimatedCostUsd = preCall.estimatedCost;

    await confirmPaidRoute({
      modelName: selected.displayName,
      modelSlug: selected.slug,
      tier: selected.tier,
      routingReason,
      estimatedCostUsd: preCall.estimatedCost,
      sessionCostSoFarUsd: preCall.sessionCostSoFar,
      sessionLimitUsd: preCall.sessionLimitUsd,
      perCallLimitUsd: preCall.perCallLimitUsd,
    }, runtimeInput.confirmPaidEscalation);

    await writeMaybe(
      () =>
        writeModelSelectedEvent(store.journal, {
          selected: selected.slug,
          considered: selection.considered,
          reason: routingReason,
          sessionId,
          traceId,
          provider: selected.provider,
          api: selected.api,
          durationMs: ports.clock.now() - sessionStart,
          parentSpanId: turnRootSpanId,
          authnFields: authnEventFields,
        }),
      BEST_EFFORT,
      noteSkippedEventWrite,
    );
    await emitRuntimeEvent(runtimeInput.onRuntimeEvent, {
      type: "modelSelected",
      sessionId,
      modelSlug: selected.slug,
      tier: selected.tier,
      reason: routingReason,
    });

    // Compress elder conversation turns into a named-section summary. Routes
    // only to an on-machine local provider on a loopback endpoint (the session
    // model when it is tier 0 and local, else the registry's preferred tier-0
    // local model); it never issues a hosted-provider request, declining if no
    // local model is routable. The call is budget-gated and recorded like any provider
    // call. Every failure path returns a declined OUTCOME rather than throwing;
    // the caller decides what a decline means — the proactive path continues on
    // the uncompressed transcript, the reactive recoverer returns null (its turn
    // then fails structured). Either way turn state is never corrupted.
    // `turnsRetained` is the number of turns that, AT THE MOMENT THIS EVENT IS
    // WRITTEN, already exist in the event stream and survive verbatim in the live
    // transcript. It is the caller's to compute, not this closure's: the two
    // triggers differ on whether the current prompt is already inside `tail`,
    // and getting that wrong silently drops a retained turn on resume.
    const compressTranscript = async (
      elder: WorkbenchMessage[],
      turnsRetained: number,
      trigger: "proactive" | "context_overflow",
    ): Promise<CompressionOutcome> => {
      let compressionModel: WorkbenchModel;
      try {
        // Locality is a ROUTING input, not only a backstop: tier does not imply
        // on-machine, so both arms must consider local rows only. The session
        // model may itself be a tier-0 hosted row, and the registry's preferred
        // tier-0 row may be hosted while a local one exists — either would
        // otherwise decline compression despite a routable local model. Filter to
        // on-machine candidates first, then let the selector apply its own
        // pricing/preference rules within them.
        const localTier0 = models.filter(
          (model) => model.tier === 0 && isLocalWorkbenchModel(model),
        );
        compressionModel =
          selected.tier === 0 && isLocalWorkbenchModel(selected)
            ? selected
            : selectWorkbenchModel(
              localTier0,
              { tier: 0 },
              defaultCompanionModel,
            ).selected;
      } catch {
        // Empty candidate set (or an unpriced one) throws from the selector; a
        // decline is the only outcome — compression never escalates off-machine.
        return {
          status: "declined",
          reason: "no local model routable for compression",
        };
      }
      // Locality boundary — NOT tier alone: a tier-0 row could name a hosted
      // provider, which would send the elder transcript off-machine. Require an
      // on-machine local provider on a loopback URL; decline otherwise, never
      // escalating compression to a hosted endpoint.
      if (!isLocalWorkbenchModel(compressionModel)) {
        return {
          status: "declined",
          reason: "no on-machine local model for compression",
        };
      }
      const runCompletion: CompressionCompletion = async (compressionInput) => {
        const estimatedInputCount = estimateRuntimeInputCount(
          transcriptEstimateText(COMPRESSION_SYSTEM_PROMPT, compressionInput),
        );
        // Gate on the compression model's OWN tier (0 → free, so the gates pass
        // trivially); a paid model — which selection forbids — would be caught
        // here, and any budget refusal declines compression via the catch in
        // compressElderTranscript rather than failing the turn.
        await anomalyGate.ensureAllowed(
          budget.checkAnomaly(compressionModel.tier, anomalyConfig),
        );
        await budgetCeilingGate.ensureAllowed(
          budget.checkPreCall(
            compressionModel.tier,
            compressionModel.costInput,
            estimatedInputCount,
          ),
        );
        // No tools, no streaming to the operator: the compression turn produces
        // a structured summary out of band, never rendered as reply text.
        const { turn, recorded } = await observedProviderCall(
          observedCallContext,
          {
            params: {
              systemPrompt: COMPRESSION_SYSTEM_PROMPT,
              prompt: "",
              messages: compressionInput,
              routing: { modelId: compressionModel.slug },
              models,
              abortSignal: runtimeInput.abortSignal,
              sessionId,
              ...ports.providerIo,
            },
            model: compressionModel,
            order: ++providerCallOrder,
            purpose: "context_compression",
            authzBasis: "policy:local-compression",
            recordUnparsedToolCallMarkup: false,
          },
        );
        if (recorded) {
          reasoningTokens += turn.usage.reasoning ?? 0;
        }
        return {
          text: turn.text,
          modelSlug: turn.model.slug,
          stopReason: turn.stopReason,
        };
      };
      const outcome = await compressElderTranscript(
        elder,
        runCompletion,
        (msgs) => estimateRuntimeInputCount(transcriptEstimateText("", msgs)),
        runtimeInput.abortSignal,
      );
      if (outcome.status !== "compressed") return outcome;
      // Persist FIRST and durably. The live turn only uses the compressed
      // transcript once the event that lets resume reconstruct it is written;
      // a failed write DECLINES compression (fall back to uncompressed) so the
      // live transcript can never diverge from what resume would rebuild. This
      // is the one context event that is not best-effort — losing it would make
      // resume silently inconsistent.
      // The id is generated HERE, not inside writeEvent, so a rejected write can
      // be probed for by id — see the ambiguity handling below.
      const compressionEventId = generateULID();
      try {
        await writeEvent(contextCompressedEvent({
          event_id: compressionEventId,
          session_id: sessionId,
          trace_id: traceId,
          span_id: generateSpanId(),
          parent_span_id: turnRootSpanId,
          principal_id: principalId,
          principal_type: "agent",
          action: "compress",
          resource: "conversation_context",
          authz_basis: "policy:local-compression",
          ...authnEventFields,
          content: JSON.stringify({
            summary: outcome.summary,
            // LOAD-BEARING for replay: the count of turns kept verbatim at this
            // event's boundary, counted per THE TURN-COUNTING INVARIANT (see
            // countTurns). Trailing, so it needs no shared base — replay rebuilds
            // the full history while the live seed is capped to the recent turns,
            // and a leading count would mean different things to each.
            // `turnsCompressed` below is observability only (the CLI status
            // line); replay never keys on it.
            turnsRetained,
            turnsCompressed: outcome.turnsCompressed,
            compressorModelSlug: outcome.compressorModelSlug,
            trigger,
            tokensBeforeEstimate: outcome.tokensBeforeEstimate,
            tokensAfterEstimate: outcome.tokensAfterEstimate,
          }),
        }));
      } catch (err) {
        // Log the error CLASS, not its message: the failing write carries the
        // conversation summary, and a DB/serialization error can quote it —
        // this channel is content-free by convention. classifyErrorKind
        // never reads a string OFF the candidate (.name and .constructor.name
        // are both ordinary, attacker-shapeable properties — a crafted
        // `{constructor: {name: "..."}}` spoofs constructor.name exactly like
        // a plain object spoofs .name) — classification comes from instanceof
        // against classes this codebase controls, full stop.
        const kind = classifyErrorKind(err);
        // A rejected INSERT does NOT mean "not persisted": the row may have
        // committed and only the acknowledgment been lost. Continuing
        // uncompressed on that assumption would let a durable event resurface on
        // resume as a summary the live turn never used. Probe by id to resolve
        // the three real cases.
        let landed: boolean;
        try {
          landed = await eventExists(compressionEventId);
        } catch (probeErr) {
          // Genuinely ambiguous — we cannot learn whether the row is durable, so
          // no choice here is safe: continuing uncompressed may diverge from a
          // resume that applies the event, and adopting may pin a summary that
          // was never stored. Ambiguity is the one case that fails the turn.
          const probeKind = classifyErrorKind(probeErr);
          throw new ContextCompressionPersistenceUncertainError(
            kind,
            probeKind,
          );
        }
        if (!landed) {
          // Genuinely not persisted: decline and let the caller continue on the
          // uncompressed transcript — the designed graceful fallback.
          console.warn(
            `context compression event write failed (${kind}); declining`,
          );
          return {
            status: "declined",
            reason: "compression event not persisted",
          };
        }
        // Rejected, but the row IS durable. Adopt the compression: resume will
        // rebuild from this event, so the live transcript must match it.
        console.warn(
          `context compression event write reported ${kind} but the row is ` +
            `durable; adopting the compressed transcript`,
        );
      }
      // Durable now: surface it live — visible context source (receipt +
      // inspector) and a runtime event, so compression is never invisible.
      contextSourceLines.push(
        `compressed conversation summary (${outcome.turnsCompressed} turns ` +
          `→ ~${outcome.tokensAfterEstimate} tokens)`,
      );
      await emitRuntimeEvent(runtimeInput.onRuntimeEvent, {
        type: "contextCompressed",
        sessionId,
        compressorModelSlug: outcome.compressorModelSlug,
        trigger,
        turnsCompressed: outcome.turnsCompressed,
        tokensBeforeEstimate: outcome.tokensBeforeEstimate,
        tokensAfterEstimate: outcome.tokensAfterEstimate,
      });
      return outcome;
    };

    // Reactive recovery: compress-then-retry. Used when a turn overflows the
    // context window and the caller supplied no recoverContextOverflow of its
    // own (tests inject theirs). The length-recovery machinery drives the retry
    // and presents it via the superseding-retry contract; a declined compression
    // returns null, which fails the turn with the existing structured
    // ContextWindowOverflowError — never a corrupted transcript.
    const defaultCompressionRecoverer: ContextOverflowRecoverer = async (
      context,
    ) => {
      const { elder, tail } = partitionForCompression(
        context.messages,
        VERBATIM_TAIL_TURNS,
      );
      // No +1 here, unlike the proactive path: context.messages is the transcript
      // that overflowed, which ALREADY ends with the current prompt, so the
      // prompt is inside `tail` and counting it again would over-retain on
      // resume.
      const outcome = await compressTranscript(
        elder,
        countTurns(tail),
        "context_overflow",
      );
      if (outcome.status !== "compressed") return null;
      return { messages: [outcome.summaryMessage, ...tail] };
    };

    log(`Model:  ${selected.displayName} (tier ${selected.tier})`);
    log(`Route:  ${routingReason}\n`);
    const runObservedTurn = async (
      params: Parameters<typeof runWorkbenchTurn>[0],
      request: { modelSlug: string; estimatedInputCount: number },
      purpose: "initial" | "tool_followup" | "forced_conclusion" | "recovery",
      onProviderError?: (error: unknown) => unknown,
    ) => {
      // Budget-gate and record EVERY provider call: the agent loop can make
      // several calls in one turn, so per-call and session limits must be
      // enforced before each one and usage recorded after each one (paid
      // consent and ceiling confirmation are granted once per turn above;
      // per-call + session limits and MAX_TOOL_STEPS bound loop spend).
      if (selected.tier > 0) {
        // Fresh cross-session daily figure before every paid call, so
        // concurrent sessions see each other's completed spend (in-flight
        // calls remain invisible; the overshoot shows in receipts).
        const fresh = await fetchBaselines(sessionId);
        budget.refreshDailyOtherSessions(fresh.dailyOtherSessionsUsd);
      }
      // Runaway-anomaly hard stop FIRST, on actual recorded spend — it holds
      // where the estimate-based ceiling below is blind (multi-call turn
      // accumulation, spend a scope confirmation already covered). An approval
      // admits the spend level it was shown; recorded spend past it re-prompts.
      await anomalyGate.ensureAllowed(
        budget.checkAnomaly(selected.tier, anomalyConfig),
      );
      const callPre = budget.checkPreCall(
        selected.tier,
        selected.costInput,
        request.estimatedInputCount,
      );
      await budgetCeilingGate.ensureAllowed(callPre);
      await emitRuntimeEvent(runtimeInput.onRuntimeEvent, {
        type: "beforeProviderRequest",
        sessionId,
        modelSlug: request.modelSlug,
        estimatedInputCount: request.estimatedInputCount,
      });
      const { turn, providerSpanId, persisted, recorded } =
        await observedProviderCall(observedCallContext, {
          params,
          model: selected,
          order: ++providerCallOrder,
          purpose,
          authzBasis: "policy:local-default",
          recordUnparsedToolCallMarkup: true,
          mapProviderError: onProviderError,
        });
      if (recorded) {
        cacheReadTokens += turn.usage.cacheRead;
        cacheWriteTokens += turn.usage.cacheWrite;
        reasoningTokens += turn.usage.reasoning ?? 0;
        turnInputTokens += turn.usage.input;
        turnOutputTokens += turn.usage.output;
        turnCostUsd += turn.usage.cost.total;
        await emitRuntimeEvent(runtimeInput.onRuntimeEvent, {
          type: "afterProviderResponse",
          sessionId,
          modelSlug: turn.model.slug,
          inputCount: turn.usage.input,
          outputCount: turn.usage.output,
          totalMs: turn.timings.totalMs,
        });
        if (turn.unparsedToolCallMarkup) {
          const warningEvent: UnparsedToolCallMarkupDetectedEvent = {
            type: "unparsedToolCallMarkupDetected",
            sessionId,
            count: turn.unparsedToolCallMarkup.count,
            countIsLowerBound: turn.unparsedToolCallMarkup.countIsLowerBound,
          };
          if (!runtimeInput.onRuntimeEvent) {
            const amount = warningEvent.countIsLowerBound
              ? `at least ${warningEvent.count}`
              : String(warningEvent.count);
            log(
              `WARNING: unparsed tool-call markup was present (${amount} unmatched opening(s)); ` +
                "no tools were executed from it",
            );
          }
          await deliverUnparsedToolCallMarkupSignal(
            runtimeInput.onRuntimeEvent,
            warningEvent,
          );
        }
      }
      return {
        ...turn,
        ...(persisted ? { providerSpanId } : {}),
      };
    };
    // Length-stop recovery around every provider call: classify a
    // stopReason "length" result (catalog limits + reported usage), then
    // either run ONE bounded continuation retry (output budget exhausted) or
    // fail structured (context overflow) — with the overflow-recovery hook
    // given one shot first when injected. All retries go back through
    // runObservedTurn, so the budget gates and usage recording hold for them.
    const runRecoveredTurn = async (
      params: Parameters<typeof runWorkbenchTurn>[0],
      request: { modelSlug: string; estimatedInputCount: number },
      purpose: "initial" | "tool_followup" | "forced_conclusion" | "recovery",
      onProviderError?: (error: unknown) => unknown,
    ): Promise<
      Awaited<ReturnType<typeof runWorkbenchTurn>> & { providerSpanId?: string }
    > => {
      const turn = await runObservedTurn(
        params,
        request,
        purpose,
        onProviderError,
      );
      if (turn.stopReason !== "length") return turn;
      // Prompt-side total for window arithmetic: Anthropic's input_tokens
      // excludes cache traffic, so the cached prompt must be added back.
      const promptTokens = turn.usage.input + turn.usage.cacheRead +
        turn.usage.cacheWrite;
      // Output-side total must include reasoning/thinking tokens: they are
      // drawn from the output budget and occupy the context window, but
      // providers like Gemini report them separately from visible output. Both
      // the cap check and the window arithmetic need the true consumption, or
      // a thinking-heavy stop is misclassified (e.g. reported as overflow and
      // hard-failed when the output cap was actually the cause).
      const outputTokens = turn.usage.output + (turn.usage.reasoning ?? 0);
      // Classify against the output cap the request actually carried — the
      // Anthropic/Google adapters send fixed caps below what the catalog row
      // says the model can do, and a stop at the requested cap is exhaustion.
      const outputCap = modelRequestedOutputCap(turn.model);
      const classification = classifyLengthStop(
        { contextWindow: turn.model.contextWindow, maxOutputTokens: outputCap },
        { input: promptTokens, output: outputTokens },
      );
      const emitRecovery = (
        outcome: LengthRecoveryOutcome,
        retriesUsed: number,
      ) =>
        emitRuntimeEvent(runtimeInput.onRuntimeEvent, {
          type: "lengthRecoveryFinished",
          sessionId,
          modelSlug: turn.model.slug,
          outcome,
          retriesUsed,
        });
      await emitRuntimeEvent(runtimeInput.onRuntimeEvent, {
        type: "lengthStopDetected",
        sessionId,
        modelSlug: turn.model.slug,
        classification,
        severity: classification === "context_overflow" ? "error" : "warn",
        inputTokens: promptTokens,
        outputTokens,
        contextWindow: turn.model.contextWindow,
        maxOutputTokens: outputCap,
      });
      // A transcript retry only works where the adapter builds its request
      // from `messages`; elsewhere (Google) it would replay the original
      // request verbatim, so recovery must not attempt it. Tool calls on a
      // length-stopped response are a cut-off plan — every path that delivers
      // a truncated result strips them so the agent loop never executes a
      // plan the model did not finish stating.
      const retryable = modelSupportsTranscriptRetry(turn.model);

      if (classification === "context_overflow") {
        const details = {
          modelSlug: turn.model.slug,
          contextWindow: turn.model.contextWindow,
          inputTokens: promptTokens,
          outputTokens,
        };
        const recover = runtimeInput.recoverContextOverflow ??
          defaultCompressionRecoverer;
        if (recover !== undefined && retryable) {
          let retried:
            | Awaited<ReturnType<typeof runWorkbenchTurn>>
            | undefined;
          let retriesUsed = 0;
          try {
            const plan = await recover({
              sessionId,
              modelSlug: turn.model.slug,
              contextWindow: turn.model.contextWindow,
              // Reasoning-inclusive, consistent with classification and every
              // other "output" in this path: the compression consumer sizes
              // its plan from true token pressure, not just visible output.
              usage: { input: promptTokens, output: outputTokens },
              systemPrompt: params.systemPrompt,
              // Snapshot: the hook must not be able to mutate the live
              // agent-loop transcript, even when it throws or returns null.
              messages: structuredClone(params.messages ?? []),
            });
            if (plan !== null) {
              // The retry's answer REPLACES the partial that already streamed
              // — announce the supersede before any retry deltas (deltas and
              // events share one ordered channel on every streaming transport)
              // so a rendering consumer can reset its buffer. The log note is
              // the same signal for the in-process presenter, which renders
              // deltas but has no event channel.
              //
              // Fail-closed, and deliberately BEFORE retriesUsed is counted: if
              // the signal cannot be delivered, the retry must not start at all,
              // because its deltas would concatenate onto the stale ones the
              // consumer still has on screen. The throw lands in the catch below,
              // which closes the recovery trail — and no retry was consumed.
              await deliverSupersedingRetrySignal(runtimeInput.onRuntimeEvent, {
                type: "supersedingRetryStarted",
                sessionId,
                modelSlug: turn.model.slug,
                reason: "context_overflow_recovery",
              });
              retriesUsed = 1;
              log(
                "\n[context recovered — retrying; the reply restarts below]",
              );
              retried = await runObservedTurn(
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
            // Close the recovery trail before the error surfaces as turnFailed.
            await emitRecovery("retry_errored", retriesUsed);
            throw err;
          }
          if (retried !== undefined) {
            if (retried.stopReason !== "length") {
              await emitRecovery("recovered", 1);
              return retried;
            }
            // The retry itself length-stopped: reclassify against ITS OWN
            // usage and caps, not the first attempt's. Compression can resolve
            // the overflow while the fresh answer then hits its output cap —
            // that must be reported as a bounded truncation, not another
            // context overflow carrying the first attempt's stale usage.
            const retryPromptTokens = retried.usage.input +
              retried.usage.cacheRead + retried.usage.cacheWrite;
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
              throw new ContextWindowOverflowError({
                modelSlug: retried.model.slug,
                contextWindow: retried.model.contextWindow,
                inputTokens: retryPromptTokens,
                outputTokens: retryOutputTokens,
              });
            }
            // Output-exhausted after a successful compression: bounded
            // terminal outcome, no third call. Strip the cut-off tool plan.
            await emitRecovery("still_truncated", 1);
            return { ...retried, toolCalls: undefined };
          }
        }
        await emitRecovery("overflow_failed", 0);
        throw new ContextWindowOverflowError(details);
      }

      // Output budget exhausted: one continuation retry on a COPY of the
      // transcript (the loop's live `messages` array stays untouched, so a
      // refused/failed retry leaves turn state exactly as it was). The merged
      // text keeps the streamed view consistent: the partial already went out
      // through onTextDelta; the retry streams only its continuation.
      if (!retryable) {
        await emitRecovery("retry_unsupported", 0);
        log(
          "\n[response truncated at the output limit; this model's adapter " +
            "cannot run a continuation retry]",
        );
        return { ...turn, toolCalls: undefined };
      }
      const continuation = buildContinuationMessages(
        params.messages ?? [{ role: "user", content: params.prompt }],
        turn.text,
      );
      const continuationInput = estimateRuntimeInputCount(
        transcriptEstimateText(params.systemPrompt, continuation),
      );
      // Feasibility pre-check: when both the output cap AND the context window
      // bind this stop, the continuation (original transcript + partial answer
      // + nudge) no longer fits the window, so a retry would be a doomed
      // over-window call (wasted spend + a provider error). Skip it and deliver
      // the capped partial. Threshold reuses the classification's window-
      // evidence fraction: at/above it there is no room left for a continuation.
      if (
        turn.model.contextWindow !== undefined &&
        continuationInput >=
          turn.model.contextWindow * CONTEXT_OVERFLOW_WINDOW_FRACTION
      ) {
        await emitRecovery("retry_would_overflow", 0);
        log(
          "\n[response truncated at the output limit; the continuation would " +
            "exceed the context window, so it was not retried]",
        );
        return { ...turn, toolCalls: undefined };
      }
      let retried;
      try {
        retried = await runObservedTurn(
          { ...params, messages: continuation },
          {
            modelSlug: request.modelSlug,
            estimatedInputCount: continuationInput,
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
          return { ...turn, toolCalls: undefined };
        }
        await emitRecovery("retry_errored", 1);
        throw err;
      }
      const merged = { ...retried, text: turn.text + retried.text };
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
    };
    let streamedText = false;
    // The OpenAI-compatible wire path streams text AND captures tool calls from
    // the same SSE stream, so tool-offering calls can stream live there; the
    // Anthropic/Google readers cannot, so tool-offering calls stay buffered for
    // them (tool calls are then captured from the buffered JSON instead).
    const streamsToolCalls = modelStreamsToolCalls(selected);
    const liveDelta = runtimeInput.onTextDelta === undefined
      ? undefined
      : (delta: string) => {
        streamedText = true;
        runtimeInput.onTextDelta?.(delta);
      };
    // Seed the conversation transcript: prior turns (companion mode only;
    // one-shot ask/next-work carry no history) followed by the current user
    // message. This is passed to the FIRST turn so resumed conversations carry
    // their history as structured messages, and the agent loop appends to it.
    let seededHistory: WorkbenchMessage[] = !usesRepoAskContext
      ? runtimeInput.conversationMessages ?? []
      : [];
    // Proactive compression: when the seeded transcript would cross ~50% of the
    // active model's context window, compress the elder turns before the first
    // provider call, keeping the most recent turns verbatim. A declined
    // compression leaves the transcript untouched and the turn runs uncompressed.
    if (seededHistory.length > 0 && selected.contextWindow !== undefined) {
      const prospective: WorkbenchMessage[] = [
        ...seededHistory,
        { role: "user", content: modelPrompt },
      ];
      const estimatedTokens = estimateRuntimeInputCount(
        transcriptEstimateText(systemPrompt, prospective),
      );
      if (
        estimatedTokens >=
          selected.contextWindow * CONTEXT_COMPRESSION_TRIGGER_FRACTION
      ) {
        const { elder, tail } = partitionForCompression(
          seededHistory,
          VERBATIM_TAIL_TURNS,
        );
        // +1 for the current prompt: it was already persisted as a session_start
        // BEFORE this compression event, and it is appended to the live
        // transcript just below — so at this event's boundary the retained turns
        // are `tail` plus that prompt. Partitioning `seededHistory` (which
        // excludes the prompt) makes this off-by-one easy to miss; resume would
        // silently drop the oldest retained turn.
        const outcome = await compressTranscript(
          elder,
          countTurns(tail) + 1,
          "proactive",
        );
        if (outcome.status === "compressed") {
          seededHistory = [outcome.summaryMessage, ...tail];
        }
      }
    }
    const messages: WorkbenchMessage[] = [
      ...seededHistory,
      { role: "user", content: modelPrompt },
    ];
    let turn = await runRecoveredTurn({
      systemPrompt,
      prompt: modelPrompt,
      messages,
      routing: routingOptions,
      defaultModelId: defaultCompanionModel,
      models,
      jsonObject: isNextWork,
      tools: commandTools,
      abortSignal: runtimeInput.abortSignal,
      ...ports.providerIo,
      // Stream when not producing JSON and either no tools are offered or the
      // provider can stream tool calls — this also restores live token
      // streaming for ordinary companion replies (tools registered, none used).
      onTextDelta: isNextWork
        ? undefined
        : (commandTools.length === 0 || streamsToolCalls)
        ? liveDelta
        : undefined,
    }, {
      modelSlug: selected.slug,
      estimatedInputCount: estimateRuntimeInputCount(
        transcriptEstimateText(systemPrompt, messages),
      ),
    }, "initial");
    captureTurnState(turn);
    // Agent loop: iterate model<->tools until the model stops requesting tools,
    // repeats itself, or hits the step cap. On the OpenAI-compatible path each
    // gather step streams live (text deltas + captured tool calls); elsewhere
    // gather steps buffer and only the forced conclusion streams. Momentum is
    // also surfaced via the per-step log and the tool_call events. Tools are
    // dropped to force a concluding answer at the cap or when the model thrashes
    // (a whole step of calls it already made this turn).
    // `messages` (seeded above with prior conversation + the current user
    // message, and passed to the first turn) now grows as the loop iterates:
    // the model's own assistant turns (with tool-call intentions) and the
    // matching tool results are appended each step and replayed on the next
    // call, so multi-step turns stay coherent.
    if (
      runtimeInput.abortSignal?.aborted &&
      turn.stopReason !== "error"
    ) {
      turn = { ...turn, stopReason: "aborted", toolCalls: undefined };
    }
    const seenToolCalls = new Set<string>();
    toolLoop:
    while (
      !isNextWork &&
      !runtimeInput.abortSignal?.aborted &&
      turn.toolCalls &&
      turn.toolCalls.length > 0 &&
      toolSteps < maxToolSteps
    ) {
      toolSteps++;
      log(
        `Step ${toolSteps}: running ${turn.toolCalls.length} tool call(s)...`,
      );
      await emitRuntimeEvent(runtimeInput.onRuntimeEvent, {
        type: "toolStepStarted",
        sessionId,
        step: toolSteps,
        toolCallCount: turn.toolCalls.length,
      });
      const stepSignatures = turn.toolCalls.map(
        (toolCall) => `${toolCall.name}:${JSON.stringify(toolCall.arguments)}`,
      );
      const allRepeats = stepSignatures.every((sig) => seenToolCalls.has(sig));
      for (const sig of stepSignatures) seenToolCalls.add(sig);
      const requestedToolCalls = turn.toolCalls;
      const stepResults: ToolResultSummary[] = [];
      for (const toolCall of requestedToolCalls) {
        if (
          runtimeInput.abortSignal?.aborted &&
          turn.stopReason !== "error"
        ) {
          turn = { ...turn, stopReason: "aborted", toolCalls: undefined };
          break toolLoop;
        }
        const toolStartedAt = ports.clock.now();
        const startedEvent = emitRuntimeEvent(runtimeInput.onRuntimeEvent, {
          type: "toolCallStarted",
          sessionId,
          commandId: toolCall.name,
          callId: toolCall.id,
        });
        let commandResult: Awaited<ReturnType<typeof invokeCommandWithEvent>>;
        try {
          // Starting event emission and invoking the command happen in the same
          // event-loop turn, so an external signal delivered on a later turn
          // cannot land between them. The emitter invocation itself is the
          // boundary; a synchronously mutating observer does not undo it.
          const commandOutcome = invokeCommandWithEvent(
            commandRegistry,
            {
              commandId: toolCall.name,
              callId: toolCall.id,
              caller: {
                principalId: "workbench",
                principalType: "agent",
              },
              arguments: toolCall.arguments,
            },
            {
              sessionId,
              traceId,
              parentSpanId: turn.providerSpanId ?? turnRootSpanId,
              // Agent-loop tool calls (call + result) are audit-relevant, but
              // BEST_EFFORT rather than integrity-required, unlike session_start
              // and model_response: a tool result's size is bounded only by the
              // model-facing tool cap (tools/builtin/file.ts), not by anything this loop
              // controls, so the event copy (capped below the TEXT column limit
              // in buildCommandToolCallEventPayload, but still one INSERT per
              // tool call) can fail for reasons unrelated to whether the tool
              // call itself succeeded. A per-tool-call event-write failure must
              // not fail an otherwise-successful tool step or turn — the model
              // already has the real result on the transcript either way.
              writeEvent: (event) =>
                writeMaybe(
                  () => writeEvent(event),
                  BEST_EFFORT,
                  noteSkippedEventWrite,
                ),
            },
            runtimeInput.confirmToolApproval,
            {
              // Operator permission profile: on a loopback turn with permissionLevel
              // "operator", contained mutating tools auto-approve instead of prompting.
              permissionLevel: permissionLevel ?? "strict",
              loopback: authContext.transport === "loopback",
            },
          ).then(
            (value) => ({ ok: true as const, value }),
            (error) => ({ ok: false as const, error }),
          );
          // emitRuntimeEvent contains observer rejection, so this await cannot
          // bypass the already-started command's settlement.
          await startedEvent;
          const outcome = await commandOutcome;
          if (!outcome.ok) throw outcome.error;
          commandResult = outcome.value;
          await emitRuntimeEvent(runtimeInput.onRuntimeEvent, {
            type: "toolCallCompleted",
            sessionId,
            commandId: toolCall.name,
            callId: toolCall.id,
            isError: commandResult.isError,
            durationMs: ports.clock.now() - toolStartedAt,
          });
        } catch (err) {
          if (
            runtimeInput.abortSignal?.aborted &&
            err === runtimeInput.abortSignal.reason
          ) {
            turn = { ...turn, stopReason: "aborted", toolCalls: undefined };
            break toolLoop;
          }
          // errorMessage crosses the wire like turnFailed does — sanitized
          // the same way. Tool RESULTS (the model-facing text on a completed
          // call) are a separate, untouched product surface; this is only
          // the runtime-event error field for a call that threw outright
          // (invokeCommandWithEvent's own executors don't throw — see
          // tools/invoke.ts — so anything reaching here is already unexpected).
          await emitRuntimeEvent(runtimeInput.onRuntimeEvent, {
            type: "toolCallCompleted",
            sessionId,
            commandId: toolCall.name,
            callId: toolCall.id,
            isError: true,
            durationMs: ports.clock.now() - toolStartedAt,
            // Fixed literal from the class table — `.name` is a writable
            // property a foreign error can shadow with a payload.
            errorName: classifyErrorKind(err),
            errorMessage: summarizeError(err),
          });
          throw err;
        }
        stepResults.push({
          commandId: toolCall.name,
          callId: toolCall.id,
          isError: commandResult.isError,
          result: commandResultText(commandResult),
        });
        if (
          runtimeInput.abortSignal?.aborted &&
          turn.stopReason !== "error"
        ) {
          turn = { ...turn, stopReason: "aborted", toolCalls: undefined };
          break toolLoop;
        }
      }

      const atCap = toolSteps >= maxToolSteps;
      const forceConclude = atCap || allRepeats;
      if (forceConclude) {
        log(
          atCap
            ? `Reached the ${maxToolSteps}-step tool limit; forcing a concluding answer.`
            : "Model repeated prior tool calls; forcing a concluding answer.",
        );
        if (atCap) {
          await emitRuntimeEvent(runtimeInput.onRuntimeEvent, {
            type: "toolStepLimitReached",
            sessionId,
            maxSteps: maxToolSteps,
          });
        }
      }
      // Append this step to the transcript: the assistant turn that requested
      // the tools (text + tool-call intentions) and one tool message per result.
      messages.push(
        ...toolStepToMessages(turn.text, requestedToolCalls, stepResults),
      );
      // When forcing a conclusion (step cap or thrash), drop tools and nudge a
      // final answer; otherwise the model continues naturally from the results.
      if (atCap) toolStepLimitReached = true;
      const followUpSystemPrompt = forceConclude
        ? forcedConclusionSystemPrompt(
          systemPrompt,
          atCap ? "limit" : "repeated_tool_calls",
        )
        : systemPrompt;
      const followUpInputCount = estimateRuntimeInputCount(
        transcriptEstimateText(followUpSystemPrompt, messages),
      );
      streamedText = false;
      turn = await runRecoveredTurn(
        {
          systemPrompt: followUpSystemPrompt,
          prompt: modelPrompt,
          messages,
          routing: routingOptions,
          defaultModelId: defaultCompanionModel,
          models,
          tools: forceConclude ? undefined : commandTools,
          historyTools: forceConclude ? commandTools : undefined,
          abortSignal: runtimeInput.abortSignal,
          ...ports.providerIo,
          // Stream the gather step when the provider streams tool calls, and
          // always stream the forced no-tools conclusion.
          onTextDelta: streamsToolCalls || forceConclude
            ? liveDelta
            : undefined,
        },
        {
          modelSlug: selected.slug,
          estimatedInputCount: followUpInputCount,
        },
        forceConclude ? "forced_conclusion" : "tool_followup",
        atCap ? () => new ToolStepLimitConclusionError() : undefined,
      );
      captureTurnState(turn);
      if (
        runtimeInput.abortSignal?.aborted &&
        turn.stopReason !== "error"
      ) {
        turn = { ...turn, stopReason: "aborted", toolCalls: undefined };
      }
    }
    if (
      runtimeInput.abortSignal?.aborted &&
      turn.stopReason !== "error"
    ) {
      turn = { ...turn, stopReason: "aborted", toolCalls: undefined };
    }
    runtimeInput.onCancellationClosed?.();
    if (turn.stopReason === "aborted") {
      if (streamedText) {
        log("");
      } else {
        log(turn.text);
      }
    } else if (isNextWork) {
      const result = validateNextWorkJson(turn.text);
      validation = { ok: result.ok, errors: result.errors };
      printNextWorkResult(result, turn.text, log);
    } else if (streamedText) {
      log("");
    } else {
      log(turn.text);
    }
    finalText = turn.text;
    finalStopReason = turn.stopReason;

    selectedForReceipt = {
      displayName: turn.model.displayName,
      slug: turn.model.slug,
      tier: turn.model.tier,
      provider: turn.model.provider,
      api: turn.model.api,
    };
    routingReason = routeReasonForMode(
      turn.selection.reason,
      turn.model.tier,
      isNextWork,
    );
    callTimings = turn.timings;

    const responseSpanId = generateSpanId();
    // Per-call budget.record() now happens inside runObservedTurn, so the
    // session summary already aggregates every call in this (and prior) turns.
    const summary = budget.getSummary();
    const paidCalls = (summary.byTier["1"]?.calls ?? 0) +
      (summary.byTier["2"]?.calls ?? 0);
    if (
      shouldPrintBudgetTally(
        // DYFJ_BUDGET_TALLY is parsed at the boundary; the core reads
        // only the input field.
        runtimeInput.budgetTallyMode ?? "paid",
        {
          paidCalls,
        },
      )
    ) {
      log("");
      log(buildBudgetTallyLine({
        turn: {
          tokensInput: turnInputTokens,
          tokensOutput: turnOutputTokens,
          costUsd: turnCostUsd,
          tier: turn.model.tier,
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

    await writeIntegrity(() =>
      writeEvent(modelResponseEvent({
        event_id: generateULID(),
        session_id: sessionId,
        trace_id: traceId,
        span_id: responseSpanId,
        parent_span_id: turnRootSpanId,
        principal_id: principalId,
        principal_type: "agent",
        action: "invoke",
        resource: turn.model.slug,
        authz_basis: "policy:local-default",
        model_id: turn.model.slug,
        provider: turn.model.provider,
        api: turn.model.api,
        // Aggregate across every provider call in this turn (the agent loop may
        // make several) so the audit event counts the whole turn, not just the
        // final call.
        tokens_input: turnInputTokens,
        tokens_output: turnOutputTokens,
        tokens_cache_read: cacheReadTokens,
        tokens_cache_write: cacheWriteTokens,
        cost_total: turnCostUsd,
        ...authnEventFields,
        content: isNextWork
          ? JSON.stringify({
            worklet_id: workletId,
            validation,
            raw: turn.text,
          })
          : turn.text,
        stop_reason: turn.stopReason,
        duration_ms: turn.timings.totalMs,
      }))
    );
    await emitRuntimeEvent(
      runtimeInput.onRuntimeEvent,
      turn.stopReason === "aborted"
        ? {
          type: "turnAborted",
          sessionId,
          traceId,
          turnId: runtimeInput.turnId,
        }
        : {
          type: "turnCompleted",
          sessionId,
          traceId,
        },
    );
  } catch (err: unknown) {
    runtimeInput.onCancellationClosed?.();
    const cancelledAtApproval = runtimeInput.abortSignal?.aborted === true &&
      err === runtimeInput.abortSignal.reason;
    // errorName crosses the wire too, so it gets the same discipline as
    // errorMessage: a fixed literal from the class table, never `.name` —
    // that is a plain writable string property, so a foreign error could
    // carry an arbitrary or oversized payload in it.
    const name = classifyErrorKind(err);
    // errorMessage crosses the wire verbatim (uds-server.ts relays every
    // runtime event to the connected client): an integrity write's failure
    // can be a rejected event-log INSERT whose driver message embeds the
    // whole offending value (e.g. a huge turn.text), so this must never carry
    // the raw message — summarizeError applies the same cap the client side
    // enforces defensively, at the point of origin instead.
    if (!cancelledAtApproval) {
      await emitRuntimeEvent(runtimeInput.onRuntimeEvent, {
        type: "turnFailed",
        sessionId,
        traceId,
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
      finalStopReason = "aborted";
      const cancelledSpanId = generateSpanId();
      await writeIntegrity(() =>
        writeEvent(modelResponseEvent({
          event_id: generateULID(),
          session_id: sessionId,
          trace_id: traceId,
          span_id: cancelledSpanId,
          parent_span_id: turnRootSpanId,
          principal_id: principalId,
          principal_type: "agent",
          action: "invoke",
          resource: selectedForEvents?.slug ?? "workbench_model",
          authz_basis: "policy:local-default",
          model_id: selectedForEvents?.slug ?? null,
          provider: selectedForEvents?.provider ?? null,
          api: selectedForEvents?.api ?? null,
          tokens_input: turnInputTokens,
          tokens_output: turnOutputTokens,
          tokens_cache_read: cacheReadTokens,
          tokens_cache_write: cacheWriteTokens,
          cost_total: turnCostUsd,
          ...authnEventFields,
          content: finalText,
          stop_reason: "aborted",
          duration_ms: ports.clock.now() - sessionStart,
        }))
      );
      await emitRuntimeEvent(runtimeInput.onRuntimeEvent, {
        type: "turnAborted",
        sessionId,
        traceId,
        turnId: runtimeInput.turnId,
      });
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
      turnError = err;
    } else if (err instanceof BudgetExceededError) {
      await writeMaybe(
        () =>
          writeEvent(errorEvent({
            event_id: generateULID(),
            session_id: sessionId,
            trace_id: traceId,
            span_id: generateSpanId(),
            parent_span_id: turnRootSpanId,
            principal_id: principalId,
            principal_type: "agent",
            action: "invoke",
            resource: selectedForEvents?.slug ?? "workbench_model",
            authz_basis: "policy:local-default",
            model_id: selectedForEvents?.slug ?? null,
            provider: selectedForEvents?.provider ?? null,
            api: selectedForEvents?.api ?? null,
            ...authnEventFields,
            // summarizeError, not raw .message: a confirmed DomainError still
            // only gets the shared 500-byte cap, never an unbounded pass-through.
            content: summarizeError(err),
            stop_reason: "error",
            duration_ms: ports.clock.now() - sessionStart,
          })),
        BEST_EFFORT,
        noteSkippedEventWrite,
      );
      log(`\nBudget exceeded: ${summarizeError(err)}`);
    } else if (err instanceof WorkspaceContextUnavailableError) {
      await writeMaybe(
        () =>
          writeEvent(errorEvent({
            event_id: generateULID(),
            session_id: sessionId,
            trace_id: traceId,
            span_id: generateSpanId(),
            parent_span_id: turnRootSpanId,
            principal_id: principalId,
            principal_type: "agent",
            action: "invoke",
            resource: selectedForEvents?.slug ?? "workbench_context",
            authz_basis: "policy:local-default",
            model_id: selectedForEvents?.slug ?? null,
            provider: selectedForEvents?.provider ?? null,
            api: selectedForEvents?.api ?? null,
            ...authnEventFields,
            content: summarizeError(err),
            stop_reason: "error",
            duration_ms: ports.clock.now() - sessionStart,
          })),
        BEST_EFFORT,
        noteSkippedEventWrite,
      );
      log(`\n${summarizeError(err)}`);
      turnError = err;
    } else if (err instanceof ContextWindowOverflowError) {
      // Expected operational condition, not an "Unexpected error": record it
      // on the audit log with the length stop it came from, show the operator
      // the condition + options, and propagate so every transport reports a
      // failed turn. No model_response event was written, so a resumed
      // transcript carries no half-turn from this failure.
      await writeMaybe(
        () =>
          writeEvent(errorEvent({
            event_id: generateULID(),
            session_id: sessionId,
            trace_id: traceId,
            span_id: generateSpanId(),
            parent_span_id: turnRootSpanId,
            principal_id: principalId,
            principal_type: "agent",
            action: "invoke",
            resource: selectedForEvents?.slug ?? "workbench_model",
            authz_basis: "policy:local-default",
            model_id: selectedForEvents?.slug ?? null,
            provider: selectedForEvents?.provider ?? null,
            api: selectedForEvents?.api ?? null,
            ...authnEventFields,
            content: summarizeError(err),
            stop_reason: "length",
            duration_ms: ports.clock.now() - sessionStart,
          })),
        BEST_EFFORT,
        noteSkippedEventWrite,
      );
      log(`\n${summarizeError(err)}`);
      turnError = err;
    } else if (err instanceof BudgetCeilingDeclinedError) {
      // Already sanitized at construction — safe to read directly.
      const detail = err.reason;
      log(
        `\nBudget ceiling confirmation declined${
          detail ? `: ${detail}` : ""
        } — the over-budget call was not made.`,
      );
      turnError = err;
    } else {
      await writeMaybe(
        () =>
          writeEvent(errorEvent({
            event_id: generateULID(),
            session_id: sessionId,
            trace_id: traceId,
            span_id: generateSpanId(),
            parent_span_id: turnRootSpanId,
            principal_id: principalId,
            principal_type: "agent",
            action: "invoke",
            resource: selectedForEvents?.slug ?? "workbench_model",
            authz_basis: "policy:local-default",
            model_id: selectedForEvents?.slug ?? null,
            provider: selectedForEvents?.provider ?? null,
            api: selectedForEvents?.api ?? null,
            ...authnEventFields,
            // Sanitized, not the raw message: this branch also catches a failed
            // INTEGRITY write (e.g. model_response), whose driver error can
            // embed the entire rejected value (turn.text). That value already
            // failed to persist in its own event; echoing it into this one
            // durable row gains no audit signal and risks writing the exact
            // oversized/sensitive payload this issue exists to keep contained.
            content: summarizeError(err),
            stop_reason: "error",
            duration_ms: ports.clock.now() - sessionStart,
          })),
        BEST_EFFORT,
        noteSkippedEventWrite,
      );
      // Sanitized here too: the injected presenter (e.g. the in-process
      // CLI's `log: console.log`) would otherwise print the raw error —
      // including any driver-embedded turn content — before the class-only
      // console.error below even runs.
      log("\nUnexpected error:", summarizeError(err));
      // Fixed literal from the class table — `.constructor.name` is a
      // writable property a foreign error can shadow with a payload.
      console.error(`[turn-error] ${classifyErrorKind(err)}`);
      turnError = err;
    }
  } finally {
    await writeMaybe(() =>
      writeEvent(sessionEndEvent({
        event_id: generateULID(),
        session_id: sessionId,
        trace_id: traceId,
        span_id: generateSpanId(),
        parent_span_id: turnRootSpanId,
        principal_id: principalId,
        principal_type: "human",
        action: "end",
        resource: "workbench_session",
        authz_basis: authContext.authzBasis,
        ...authnEventFields,
        duration_ms: ports.clock.now() - sessionStart,
      })), INTEGRITY);

    // The count captured here reflects skips up to this point. If this
    // summary write itself fails, its skip fires before the receipt is built
    // below, so it reaches the console line AND the receipt — but not this
    // event's own content. The later session-content write is the only skip
    // that lands after every persisted surface: console line only.
    await writeMaybe(
      () =>
        budget.writeSummaryEvent(
          store.journal,
          { skippedEventWrites: state.audit.skippedEventWrites },
          { parentSpanId: turnRootSpanId },
        ),
      BEST_EFFORT,
      noteSkippedEventWrite,
    );

    const summary = budget.getSummary();
    const paidInferenceUsed = ((summary.byTier["1"]?.calls ?? 0) +
      (summary.byTier["2"]?.calls ?? 0)) > 0;
    const receipt = buildWorkbenchReceipt({
      sessionId,
      traceId,
      modelName: selectedForReceipt?.displayName ?? "none",
      modelSlug: selectedForReceipt?.slug ?? "none",
      provider: selectedForReceipt?.provider,
      api: selectedForReceipt?.api,
      tier: selectedForReceipt?.tier ?? 0,
      routingReason,
      totalCostUsd: summary.totalCostUsd,
      totalTokensInput: summary.totalTokensInput,
      totalTokensOutput: summary.totalTokensOutput,
      totalCacheReadTokens: cacheReadTokens,
      totalCacheWriteTokens: cacheWriteTokens,
      totalReasoningTokens: reasoningTokens,
      totalCalls: summary.totalCalls,
      contextBudget: state.contextBudget,
      contextProfile: state.contextProfile,
      timings: callTimings,
      contextSources: state.contextSourceLines,
      paidInferenceUsed,
      estimatedCostUsd,
      workletId,
      totalElapsedMs: ports.clock.now() - sessionStart,
      validation,
      agent: {
        toolStepsUsed: toolSteps,
        maxToolSteps,
        limitReached: toolStepLimitReached,
      },
      skippedEventWrites: state.audit.skippedEventWrites,
      historyOmission: state.historyOmission,
    });
    await writeMaybe(
      () =>
        updateWorkbenchSession({
          journal: store.journal,
          sessionId,
          content: buildWorkbenchSessionContent({
            mode,
            prompt: cliPrompt,
            traceId,
            contextSources: state.contextSourceLines,
            receipt,
          }),
        }),
      BEST_EFFORT,
      noteSkippedEventWrite,
    );
    log("");
    log(receipt);
    // the runtime no longer closes the shared Dolt pool. A long-running
    // host (the UDS server) runs many concurrent turns through this function; a
    // per-turn close would end the pool out from under an in-flight turn and
    // crash it. Pool lifecycle is owned by the entrypoint (an in-process caller
    // closes it in a finally; the server keeps it for the process lifetime).
    // If an integrity audit/transcript write failed inside
    // the try above, surface it to the caller instead of masking it behind a
    // normal receipt (session_end + best-effort cleanup above still ran).
    // An unexpected turn error (credential missing, provider failure) must reach
    // the caller — the receipt above still prints, but the turn is not a success.
    if (turnError !== null) throw turnError;
    if (state.audit.fatalEventError !== null) {
      throw state.audit.fatalEventError;
    }
    return {
      sessionId,
      traceId,
      stopReason: finalStopReason,
      text: finalText,
      receipt,
      model: {
        displayName: selectedForReceipt?.displayName ?? "none",
        slug: selectedForReceipt?.slug ?? "none",
        provider: selectedForReceipt?.provider,
        api: selectedForReceipt?.api,
        tier: selectedForReceipt?.tier ?? 0,
      },
      route: {
        reason: routingReason,
      },
      cost: {
        estimatedUsd: estimatedCostUsd,
        totalUsd: summary.totalCostUsd,
        paidInferenceUsed,
      },
      tokens: {
        input: summary.totalTokensInput,
        output: summary.totalTokensOutput,
        cacheRead: cacheReadTokens,
        cacheWrite: cacheWriteTokens,
        reasoning: reasoningTokens,
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
        toolStepsUsed: toolSteps,
        maxToolSteps,
        limitReached: toolStepLimitReached,
      },
      validation,
    };
  }
}
