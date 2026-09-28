import { generateSpanId, generateULID, systemClock } from "../kernel/mod.ts";
import {
  type AcpRunnerSelection,
  DomainError,
  type ExternalAgentWorkbenchRuntimeResult,
  summarizeError,
} from "../contract/mod.ts";
import { processEnv } from "../config/mod.ts";
import {
  buildWorkbenchSessionContent,
  errorEvent,
  type EventInsert,
  modelResponseEvent,
  sessionEndEvent,
  updateWorkbenchSession,
} from "../store/mod.ts";
import {
  modelStreamsToolCalls,
  type WorkbenchMessage,
  type WorkbenchToolCall,
  type WorkbenchTurnResult,
} from "../providers/mod.ts";
import {
  BudgetCeilingDeclinedError,
  BudgetExceededError,
} from "../budget/mod.ts";
import { ContextWindowOverflowError } from "../context/mod.ts";
import { createCommandRegistry, invokeCommandWithEvent } from "../tools/mod.ts";
import {
  classifyErrorKind,
  PaidEscalationDeclinedError,
  ToolStepLimitConclusionError,
  WorkspaceContextUnavailableError,
} from "./errors.ts";
import { writeMaybe } from "./event-writes.ts";
import {
  type ObservedCallContext,
  observedProviderCall,
} from "./observed-call.ts";
import { resolveRoute, routeReasonForMode } from "./route.ts";
import type {
  ExternalAgentRunner,
  NativeWorkbenchRuntimeResult,
  ToolResultSummary,
  WorkbenchRuntimeInput,
  WorkbenchRuntimeResult,
  WorkbenchRuntimeServices,
} from "./runtime-types.ts";
import {
  buildBudgetTallyLine,
  buildWorkbenchReceipt,
  shouldPrintBudgetTally,
} from "./receipt.ts";
import { printNextWorkResult, validateNextWorkJson } from "./next-work.ts";
import { emitRuntimeEvent } from "./runtime-events.ts";
import { openSession, recordNewSession } from "./open-session.ts";
import { buildContext } from "./build-context.ts";
import {
  commitEvent,
  type NativeTurnPorts,
  newTurnState,
} from "./turn-state.ts";
import { budgetGate } from "./budget-gate.ts";
import type { RoutedTurn } from "./routed-turn.ts";
import { loadTranscript } from "./load-transcript.ts";
import {
  estimateRuntimeInputCount,
  transcriptEstimateText,
} from "./transcript.ts";
import { recoveredTurn } from "./recovered-turn.ts";
import type { LoopTurnResult } from "./observed-turn.ts";

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

function commandResultText(
  result: { isError: boolean; reason?: string; result?: unknown },
): string {
  if (result.isError) return result.reason ?? "command failed";
  return typeof result.result === "string"
    ? result.result
    : JSON.stringify(result.result);
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
    budgetScopes: services.budgetScopes,
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

  const captureTurnState = (turn: WorkbenchTurnResult): void => {
    state.finalText = turn.text;
    state.finalStopReason = turn.stopReason;
    state.callTimings = turn.timings;
  };
  try {
    await buildContext(state, runtimeInput, ports);
    const { systemPrompt, modelPrompt, commandRegistry, commandTools } = state;
    const contextSourceLines = state.contextSourceLines;
    await recordNewSession(state, ports);

    const route = await budgetGate(state, runtimeInput, ports);
    const { models, selected, budgetCeilingGate, anomalyGate } = route;

    const routed: RoutedTurn = {
      state,
      input: runtimeInput,
      ports,
      route,
      observed: observedCallContext,
    };

    log(`Model:  ${selected.displayName} (tier ${selected.tier})`);
    log(`Route:  ${state.routingReason}\n`);
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
    const messages = await loadTranscript(routed);
    let turn: LoopTurnResult = await recoveredTurn(routed, {
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
      state.toolSteps < maxToolSteps
    ) {
      state.toolSteps++;
      log(
        `Step ${state.toolSteps}: running ${turn.toolCalls.length} tool call(s)...`,
      );
      await emitRuntimeEvent(runtimeInput.onRuntimeEvent, {
        type: "toolStepStarted",
        sessionId,
        step: state.toolSteps,
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

      const atCap = state.toolSteps >= maxToolSteps;
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
      if (atCap) state.toolStepLimitReached = true;
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
      turn = await recoveredTurn(
        routed,
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
          tokensInput: state.turnInputTokens,
          tokensOutput: state.turnOutputTokens,
          costUsd: state.turnCostUsd,
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
        tokens_input: state.turnInputTokens,
        tokens_output: state.turnOutputTokens,
        tokens_cache_read: state.cacheReadTokens,
        tokens_cache_write: state.cacheWriteTokens,
        cost_total: state.turnCostUsd,
        ...authnEventFields,
        content: isNextWork
          ? JSON.stringify({
            worklet_id: workletId,
            validation: state.validation,
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
      state.finalStopReason = "aborted";
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
          ...authnEventFields,
          content: state.finalText,
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
            resource: state.selectedForEvents?.slug ?? "workbench_model",
            authz_basis: "policy:local-default",
            model_id: state.selectedForEvents?.slug ?? null,
            provider: state.selectedForEvents?.provider ?? null,
            api: state.selectedForEvents?.api ?? null,
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
            resource: state.selectedForEvents?.slug ?? "workbench_context",
            authz_basis: "policy:local-default",
            model_id: state.selectedForEvents?.slug ?? null,
            provider: state.selectedForEvents?.provider ?? null,
            api: state.selectedForEvents?.api ?? null,
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
            resource: state.selectedForEvents?.slug ?? "workbench_model",
            authz_basis: "policy:local-default",
            model_id: state.selectedForEvents?.slug ?? null,
            provider: state.selectedForEvents?.provider ?? null,
            api: state.selectedForEvents?.api ?? null,
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
            resource: state.selectedForEvents?.slug ?? "workbench_model",
            authz_basis: "policy:local-default",
            model_id: state.selectedForEvents?.slug ?? null,
            provider: state.selectedForEvents?.provider ?? null,
            api: state.selectedForEvents?.api ?? null,
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
      paidInferenceUsed,
      estimatedCostUsd: state.estimatedCostUsd,
      workletId,
      totalElapsedMs: ports.clock.now() - sessionStart,
      validation: state.validation,
      agent: {
        toolStepsUsed: state.toolSteps,
        maxToolSteps,
        limitReached: state.toolStepLimitReached,
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
        paidInferenceUsed,
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
        maxToolSteps,
        limitReached: state.toolStepLimitReached,
      },
      validation: state.validation,
    };
  }
}
