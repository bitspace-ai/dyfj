/**
 * The `agentLoop` stage (specs/01-architecture.md §5.1): the turn's first
 * provider call, then model↔tools steps until the model stops requesting
 * tools, repeats itself, or reaches the step cap. Each call is an observed,
 * budget-gated call with length-stop recovery (`recovered-turn.ts`); each
 * tool call goes through `invokeCommandWithEvent`.
 *
 * On the OpenAI-compatible path each gather step streams live (text deltas
 * and captured tool calls); elsewhere gather steps buffer and only the forced
 * conclusion streams. Tools are dropped to force a concluding answer at the
 * cap or when the model thrashes (a whole step of calls it already made this
 * turn). The transcript grows as the loop iterates: the model's own
 * assistant turns (with their tool-call intentions) and the matching tool
 * results are appended each step and replayed on the next call.
 */
import {
  modelStreamsToolCalls,
  type WorkbenchMessage,
  type WorkbenchToolCall,
  type WorkbenchTurnParams,
} from "../providers/mod.ts";
import { invokeCommandWithEvent } from "../tools/mod.ts";
import { summarizeError } from "../contract/mod.ts";
import { classifyErrorKind, ToolStepLimitConclusionError } from "./errors.ts";
import { writeMaybe } from "./event-writes.ts";
import type { LoopTurnResult } from "./observed-turn.ts";
import { recoveredTurn } from "./recovered-turn.ts";
import type { RoutedTurn } from "./routed-turn.ts";
import { emitRuntimeEvent } from "./runtime-events.ts";
import type { ToolResultSummary } from "./runtime-types.ts";
import {
  estimateRuntimeInputCount,
  transcriptEstimateText,
} from "./transcript.ts";
import { commitEvent, type TurnState } from "./turn-state.ts";

export interface AgentLoopOutcome {
  /** The last call's result; aborted when the turn was cancelled. */
  result: LoopTurnResult;
  /** Whether the last call's text reached the client as live deltas. */
  streamedText: boolean;
}

/** Live-delta plumbing: whether text has streamed since the last call. */
interface Streaming {
  streamedText: boolean;
  streamsToolCalls: boolean;
  liveDelta: ((delta: string) => void) | undefined;
}

/** Run the stage over the seeded transcript, which it extends in place. */
export async function agentLoop(
  turn: RoutedTurn,
  messages: WorkbenchMessage[],
): Promise<AgentLoopOutcome> {
  const { state, input, route } = turn;
  const { session } = state;
  const streaming: Streaming = {
    streamedText: false,
    // The OpenAI-compatible wire path streams text AND captures tool calls
    // from the same SSE stream, so tool-offering calls can stream live there;
    // the Anthropic/Google readers cannot, so tool-offering calls stay
    // buffered for them.
    streamsToolCalls: modelStreamsToolCalls(route.selected),
    liveDelta: undefined,
  };
  if (input.onTextDelta !== undefined) {
    streaming.liveDelta = (delta) => {
      streaming.streamedText = true;
      input.onTextDelta?.(delta);
    };
  }
  let result = await recoveredTurn(turn, {
    ...callParams(turn, state.systemPrompt, messages),
    jsonObject: session.isNextWork,
    tools: state.commandTools,
    // Stream when not producing JSON and either no tools are offered or the
    // provider can stream tool calls — this also keeps live token streaming
    // for ordinary companion replies (tools registered, none used).
    onTextDelta: session.isNextWork
      ? undefined
      : (state.commandTools.length === 0 || streaming.streamsToolCalls)
      ? streaming.liveDelta
      : undefined,
  }, {
    modelSlug: route.selected.slug,
    estimatedInputCount: estimateRuntimeInputCount(
      transcriptEstimateText(state.systemPrompt, messages),
    ),
  }, "initial");
  captureTurnState(state, result);
  result = abortedIfCancelled(turn, result);
  const seenToolCalls = new Set<string>();
  while (
    !session.isNextWork &&
    !input.abortSignal?.aborted &&
    result.toolCalls &&
    result.toolCalls.length > 0 &&
    state.toolSteps < session.maxToolSteps
  ) {
    const step = await runToolStep(turn, result, seenToolCalls);
    if (step === "aborted") {
      result = { ...result, stopReason: "aborted", toolCalls: undefined };
      break;
    }
    result = await followUp(turn, result, messages, step, streaming);
    captureTurnState(state, result);
    result = abortedIfCancelled(turn, result);
  }
  result = abortedIfCancelled(turn, result);
  return { result, streamedText: streaming.streamedText };
}

/** The call parameters every loop call shares. */
function callParams(
  turn: RoutedTurn,
  systemPrompt: string,
  messages: WorkbenchMessage[],
): WorkbenchTurnParams {
  const { state, input, route } = turn;
  return {
    systemPrompt,
    prompt: state.modelPrompt,
    messages,
    routing: input.routingOptions,
    defaultModelId: input.defaultCompanionModel,
    models: route.models,
    abortSignal: input.abortSignal,
    ...turn.ports.providerIo,
  };
}

/** Keep the last call's text, stop reason and timings for the receipt. */
function captureTurnState(state: TurnState, result: LoopTurnResult): void {
  state.finalText = result.text;
  state.finalStopReason = result.stopReason;
  state.callTimings = result.timings;
}

/** A cancelled turn ends aborted, unless the provider already failed it. */
function abortedIfCancelled(
  turn: RoutedTurn,
  result: LoopTurnResult,
): LoopTurnResult {
  if (turn.input.abortSignal?.aborted && result.stopReason !== "error") {
    return { ...result, stopReason: "aborted", toolCalls: undefined };
  }
  return result;
}

interface ToolStep {
  requestedToolCalls: WorkbenchToolCall[];
  stepResults: ToolResultSummary[];
  /** Every call in the step repeats one already made this turn. */
  allRepeats: boolean;
}

/** Run one step's tool calls, in order; "aborted" when the turn is cancelled. */
async function runToolStep(
  turn: RoutedTurn,
  result: LoopTurnResult,
  seenToolCalls: Set<string>,
): Promise<ToolStep | "aborted"> {
  const { state, input } = turn;
  const requestedToolCalls = result.toolCalls ?? [];
  state.toolSteps++;
  state.session.log(
    `Step ${state.toolSteps}: running ${requestedToolCalls.length} tool call(s)...`,
  );
  await emitRuntimeEvent(input.onRuntimeEvent, {
    type: "toolStepStarted",
    sessionId: state.session.sessionId,
    step: state.toolSteps,
    toolCallCount: requestedToolCalls.length,
  });
  const stepSignatures = requestedToolCalls.map(
    (toolCall) => `${toolCall.name}:${JSON.stringify(toolCall.arguments)}`,
  );
  const allRepeats = stepSignatures.every((sig) => seenToolCalls.has(sig));
  for (const sig of stepSignatures) seenToolCalls.add(sig);
  const stepResults: ToolResultSummary[] = [];
  const cancelled = () =>
    input.abortSignal?.aborted === true && result.stopReason !== "error";
  for (const toolCall of requestedToolCalls) {
    if (cancelled()) return "aborted";
    const summary = await invokeTool(turn, result, toolCall);
    if (summary === "aborted") return "aborted";
    stepResults.push(summary);
    if (cancelled()) return "aborted";
  }
  return { requestedToolCalls, stepResults, allRepeats };
}

/**
 * Invoke one tool call through the command registry, framed by its
 * `toolCallStarted` / `toolCallCompleted` frames. "aborted" when the call
 * ended because the turn was cancelled (an approval interrupted by cancel).
 */
async function invokeTool(
  turn: RoutedTurn,
  result: LoopTurnResult,
  toolCall: WorkbenchToolCall,
): Promise<ToolResultSummary | "aborted"> {
  const { state, input, ports } = turn;
  const { session } = state;
  const toolStartedAt = ports.clock.now();
  const completed = {
    type: "toolCallCompleted" as const,
    sessionId: session.sessionId,
    commandId: toolCall.name,
    callId: toolCall.id,
  };
  const startedEvent = emitRuntimeEvent(input.onRuntimeEvent, {
    type: "toolCallStarted",
    sessionId: session.sessionId,
    commandId: toolCall.name,
    callId: toolCall.id,
  });
  try {
    // Starting event emission and invoking the command happen in the same
    // event-loop turn, so an external signal delivered on a later turn cannot
    // land between them. The emitter invocation itself is the boundary; a
    // synchronously mutating observer does not undo it.
    const commandOutcome = startCommand(turn, result, toolCall).then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error }),
    );
    // emitRuntimeEvent contains observer rejection, so this await cannot
    // bypass the already-started command's settlement.
    await startedEvent;
    const outcome = await commandOutcome;
    if (!outcome.ok) throw outcome.error;
    const commandResult = outcome.value;
    await emitRuntimeEvent(input.onRuntimeEvent, {
      ...completed,
      isError: commandResult.isError,
      durationMs: ports.clock.now() - toolStartedAt,
    });
    return {
      commandId: toolCall.name,
      callId: toolCall.id,
      isError: commandResult.isError,
      result: commandResultText(commandResult),
    };
  } catch (err) {
    if (input.abortSignal?.aborted && err === input.abortSignal.reason) {
      return "aborted";
    }
    // errorMessage crosses the wire like turnFailed does — sanitized the same
    // way. Tool RESULTS (the model-facing text on a completed call) are a
    // separate, untouched product surface; this is only the runtime-event
    // error field for a call that threw outright (invokeCommandWithEvent's
    // own executors don't throw — see tools/invoke.ts — so anything reaching
    // here is already unexpected).
    await emitRuntimeEvent(input.onRuntimeEvent, {
      ...completed,
      isError: true,
      durationMs: ports.clock.now() - toolStartedAt,
      // Fixed literal from the class table — `.name` is a writable property
      // a foreign error can shadow with a payload.
      errorName: classifyErrorKind(err),
      errorMessage: summarizeError(err),
    });
    throw err;
  }
}

/** Start the command; its approval comes through the `Approver` port. */
function startCommand(
  turn: RoutedTurn,
  result: LoopTurnResult,
  toolCall: WorkbenchToolCall,
): ReturnType<typeof invokeCommandWithEvent> {
  const { state, input, ports } = turn;
  const { session } = state;
  return invokeCommandWithEvent(
    state.commandRegistry,
    {
      commandId: toolCall.name,
      callId: toolCall.id,
      caller: { principalId: "workbench", principalType: "agent" },
      arguments: toolCall.arguments,
    },
    {
      sessionId: session.sessionId,
      traceId: session.traceId,
      parentSpanId: result.providerSpanId ?? session.turnRootSpanId,
      // Agent-loop tool calls (call + result) are audit-relevant, but
      // BEST_EFFORT rather than integrity-required, unlike session_start and
      // model_response: a tool result's size is bounded only by the
      // model-facing tool cap (tools/builtin/file.ts), not by anything this
      // loop controls, so the event copy can fail for reasons unrelated to
      // whether the tool call itself succeeded. A per-tool-call event-write
      // failure must not fail an otherwise-successful tool step or turn — the
      // model already has the real result on the transcript either way.
      writeEvent: (event) =>
        writeMaybe(
          () => commitEvent(ports.store, event),
          true,
          state.audit.noteSkippedEventWrite,
        ),
    },
    input.confirmToolApproval,
    {
      // Operator permission profile: on a loopback turn with permissionLevel
      // "operator", contained mutating tools auto-approve instead of
      // prompting.
      permissionLevel: input.permissionLevel ?? "strict",
      loopback: session.authContext.transport === "loopback",
    },
  );
}

/**
 * Append the step to the transcript and make the next call: a normal
 * follow-up, or — at the step cap or when the model repeated itself — a
 * forced conclusion with tools dropped.
 */
async function followUp(
  turn: RoutedTurn,
  result: LoopTurnResult,
  messages: WorkbenchMessage[],
  step: ToolStep,
  streaming: Streaming,
): Promise<LoopTurnResult> {
  const { state, input } = turn;
  const { session } = state;
  const atCap = state.toolSteps >= session.maxToolSteps;
  const forceConclude = atCap || step.allRepeats;
  if (forceConclude) {
    session.log(
      atCap
        ? `Reached the ${session.maxToolSteps}-step tool limit; forcing a concluding answer.`
        : "Model repeated prior tool calls; forcing a concluding answer.",
    );
    if (atCap) {
      await emitRuntimeEvent(input.onRuntimeEvent, {
        type: "toolStepLimitReached",
        sessionId: session.sessionId,
        maxSteps: session.maxToolSteps,
      });
    }
  }
  messages.push(
    ...toolStepToMessages(
      result.text,
      step.requestedToolCalls,
      step.stepResults,
    ),
  );
  if (atCap) state.toolStepLimitReached = true;
  const systemPrompt = forceConclude
    ? forcedConclusionSystemPrompt(
      state.systemPrompt,
      atCap ? "limit" : "repeated_tool_calls",
    )
    : state.systemPrompt;
  const estimatedInputCount = estimateRuntimeInputCount(
    transcriptEstimateText(systemPrompt, messages),
  );
  streaming.streamedText = false;
  return await recoveredTurn(
    turn,
    {
      ...callParams(turn, systemPrompt, messages),
      tools: forceConclude ? undefined : state.commandTools,
      historyTools: forceConclude ? state.commandTools : undefined,
      // Stream the gather step when the provider streams tool calls, and
      // always stream the forced no-tools conclusion.
      onTextDelta: streaming.streamsToolCalls || forceConclude
        ? streaming.liveDelta
        : undefined,
    },
    { modelSlug: turn.route.selected.slug, estimatedInputCount },
    forceConclude ? "forced_conclusion" : "tool_followup",
    atCap ? () => new ToolStepLimitConclusionError() : undefined,
  );
}

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
 * `tool` message per result, each linked back to its call by id. Appending
 * these to the running history is what lets the next step see the model's own
 * prior reasoning and the matching results — instead of a flattened summary
 * string that drops the trail and invites confabulation.
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
