/**
 * Rebuilt transcript selection, header formatting, and continuity state
 * preparation for external-agent (ACP) turns (BIT-924, BIT-939).
 */
import { assertAcpPromptWithinLimit } from "../../acp-client.ts";
import type { AcpContinuityEvidence } from "../../acp-session-map.ts";
import {
  type ContinuityReconstructionReason,
  DomainError,
  type ExternalAgentTranscriptLeftOutCause,
  type ExternalAgentTurnReceipt,
  historyOmissionForDelivery,
  type HistoryOmissionProjection,
  type HistoryOmissionReceipt,
  prependHistoryOmissionNotice,
  type WorkbenchRuntimeEvent,
} from "../../contract/mod.ts";
import type { WorkbenchMessage } from "../../providers/mod.ts";
import { prependChildContextLine } from "./dispatch-lineage.ts";

export type WorkbenchTextMessage = Extract<
  WorkbenchMessage,
  { role: "user" | "assistant" }
>;
export type WorkbenchAssistantMessage = Extract<
  WorkbenchMessage,
  { role: "assistant" }
>;
export type WorkbenchToolResultMessage = Extract<
  WorkbenchMessage,
  { role: "tool" }
>;

export type RenderHistoryTextFn = (message: WorkbenchTextMessage) => string[];
export type RenderToolExchangeFn = (
  call: { id: string; name: string; arguments: Record<string, unknown> },
  result: WorkbenchToolResultMessage,
) => string[];

const HISTORY_FIELD_BYTE_LIMIT_MESSAGES: ReadonlySet<string> = new Set([
  "ACP continuity reconstruction exceeded the history message limit",
  "ACP continuity reconstruction exceeded the tool call id limit",
  "ACP continuity reconstruction exceeded the tool name limit",
  "ACP continuity reconstruction exceeded the tool argument limit",
  "ACP continuity reconstruction exceeded the tool result limit",
]);

export function isHistoryFieldByteLimitError(error: unknown): boolean {
  return error instanceof DomainError &&
    HISTORY_FIELD_BYTE_LIMIT_MESSAGES.has(error.message);
}

export function validateTurnCapDroppedMessages(
  turnCapDroppedMessages: number | undefined,
): number {
  if (turnCapDroppedMessages === undefined) return 0;
  if (
    !Number.isSafeInteger(turnCapDroppedMessages) ||
    turnCapDroppedMessages < 0
  ) {
    throw new DomainError(
      "ACP continuity reconstruction received an invalid turn-cap count",
    );
  }
  return turnCapDroppedMessages === 0 ? 0 : turnCapDroppedMessages;
}

export function leftOutToolCallsLine(toolCallsLeftOut: number): string {
  return `[Tool calls left out: ${toolCallsLeftOut}]`;
}

export function shortenedTranscriptHeaderLines(
  priorMessagesLeftOut: number,
  priorMessagesShown: number,
  toolCallsLeftOut = 0,
  toolCallsShown = 0,
): string[] {
  return [
    "This transcript is shortened.",
    `Prior messages left out: ${priorMessagesLeftOut}. Prior messages shown: ${priorMessagesShown}.`,
    ...(toolCallsLeftOut > 0
      ? [
        `Tool calls left out in shown part: ${toolCallsLeftOut}. Tool calls shown: ${toolCallsShown}.`,
      ]
      : []),
    "The shown part may start partway through the session, and may begin with an",
    "agent message or a tool record whose request is not shown.",
  ];
}

export function formatReconstructedTranscriptPrompt(input: {
  headerLines: readonly string[];
  footerLine: string;
  bodyLines: readonly string[];
  priorMessagesLeftOut: number;
  priorMessagesShown: number;
  toolCallsLeftOut?: number;
  toolCallsShown?: number;
  prompt: string;
}): string {
  const lines: string[] = [
    ...input.headerLines,
    ...(input.priorMessagesLeftOut > 0
      ? shortenedTranscriptHeaderLines(
        input.priorMessagesLeftOut,
        input.priorMessagesShown,
        input.toolCallsLeftOut ?? 0,
        input.toolCallsShown ?? 0,
      )
      : []),
    ...input.bodyLines,
    input.footerLine,
    `Operator (current turn): ${input.prompt}`,
  ];
  return lines.join("\n");
}

function isTextPassMessage(
  message: WorkbenchMessage,
): message is WorkbenchTextMessage {
  if (message.role === "user") return true;
  if (message.role === "assistant") {
    return message.content !== "" || (message.toolCalls?.length ?? 0) === 0;
  }
  return false;
}

function countAssistantCallsInSpan(
  priorMessages: readonly WorkbenchMessage[],
  spanStart: number,
): number {
  let count = 0;
  for (let index = spanStart; index < priorMessages.length; index++) {
    const message = priorMessages[index];
    if (message.role === "assistant") {
      count += message.toolCalls?.length ?? 0;
    }
  }
  return count;
}

function buildSpanBodyLines(input: {
  priorMessages: readonly WorkbenchMessage[];
  spanStart: number;
  renderedTextByIndex: ReadonlyMap<number, readonly string[]>;
  includedToolLinesByAssistantIndex: ReadonlyMap<number, readonly string[]>;
  includeLeftOutMarks: boolean;
}): string[] {
  const lines: string[] = [];
  let pendingLeftOutCalls = 0;
  const flushLeftOutCalls = () => {
    if (pendingLeftOutCalls > 0) {
      if (input.includeLeftOutMarks) {
        lines.push(leftOutToolCallsLine(pendingLeftOutCalls));
      }
      pendingLeftOutCalls = 0;
    }
  };
  for (let index = input.spanStart; index < input.priorMessages.length; index++) {
    const message = input.priorMessages[index];
    if (message.role === "user") {
      const textLines = input.renderedTextByIndex.get(index) ?? [];
      if (textLines.length > 0) {
        flushLeftOutCalls();
        lines.push(...textLines);
      }
    } else if (message.role === "assistant") {
      const textLines = input.renderedTextByIndex.get(index) ?? [];
      if (textLines.length > 0) {
        flushLeftOutCalls();
        lines.push(...textLines);
      }
      const callCount = message.toolCalls?.length ?? 0;
      if (callCount > 0) {
        const toolLines = input.includedToolLinesByAssistantIndex.get(index);
        if (toolLines !== undefined) {
          flushLeftOutCalls();
          lines.push(...toolLines);
        } else {
          pendingLeftOutCalls += callCount;
        }
      }
    }
  }
  flushLeftOutCalls();
  return lines;
}

interface KeptSpanCallGroup {
  assistantIndex: number;
  addedMessages: number;
  calls: NonNullable<WorkbenchAssistantMessage["toolCalls"]>;
  toolResults: WorkbenchToolResultMessage[];
}

function collectKeptSpanCallGroups(
  priorMessages: readonly WorkbenchMessage[],
  spanStart: number,
): KeptSpanCallGroup[] {
  const seenCallIds = new Set<string>();
  const groups: KeptSpanCallGroup[] = [];
  for (let index = spanStart; index < priorMessages.length; index++) {
    const message = priorMessages[index];
    if (message.role === "user") continue;
    if (message.role === "tool") {
      throw new DomainError(
        "ACP continuity reconstruction found unpaired tool history",
      );
    }
    const calls = message.toolCalls ?? [];
    let toolEnd = index + 1;
    while (
      toolEnd < priorMessages.length &&
      priorMessages[toolEnd].role === "tool"
    ) {
      toolEnd += 1;
    }
    const toolCount = toolEnd - (index + 1);
    if (calls.length !== toolCount) {
      throw new DomainError(
        "ACP continuity reconstruction found unpaired tool history",
      );
    }
    if (calls.length === 0) continue;
    const toolResults = priorMessages.slice(
      index + 1,
      toolEnd,
    ) as WorkbenchToolResultMessage[];
    for (let callIndex = 0; callIndex < calls.length; callIndex++) {
      const call = calls[callIndex];
      const paired = toolResults[callIndex];
      if (
        paired === undefined ||
        paired.toolCallId !== call.id ||
        seenCallIds.has(call.id)
      ) {
        throw new DomainError(
          "ACP continuity reconstruction found unpaired tool history",
        );
      }
      seenCallIds.add(call.id);
    }
    groups.push({
      assistantIndex: index,
      addedMessages: toolResults.length + (message.content === "" ? 1 : 0),
      calls,
      toolResults,
    });
    index = toolEnd - 1;
  }
  return groups;
}

function renderCallGroupLines(
  group: KeptSpanCallGroup,
  renderToolExchange: RenderToolExchangeFn,
): string[] {
  const rendered: string[] = [];
  for (let index = 0; index < group.calls.length; index++) {
    rendered.push(
      ...renderToolExchange(group.calls[index], group.toolResults[index]),
    );
  }
  return rendered;
}

export function fitsFinalPromptLimit(decoratedPrompt: string): boolean {
  try {
    assertAcpPromptWithinLimit(decoratedPrompt);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "ACP prompt exceeded the input limit"
    ) {
      return false;
    }
    throw error;
  }
}

type ReconstructionStopCause = Exclude<
  ExternalAgentTranscriptLeftOutCause,
  "turn_cap"
>;

interface TwoPassFraming {
  headerLines: readonly string[];
  footerLine: string;
  maxPriorMessages: number;
  renderHistoryText: RenderHistoryTextFn;
  renderToolExchange: RenderToolExchangeFn;
}

function runTextPass(input: TwoPassFraming & {
  priorMessages: readonly WorkbenchMessage[];
  prompt: string;
  turnCapDropped: number;
  decorateFinalPrompt: (
    reconstructedPrompt: string,
    toolExchanges: number,
  ) => string;
}): {
  keptTextCount: number;
  keptSpanStart: number;
  renderedTextByIndex: Map<number, string[]>;
  stopCause?: ReconstructionStopCause;
} {
  const renderedTextByIndex = new Map<number, string[]>();
  const emptyToolLines = new Map<number, readonly string[]>();
  let keptTextCount = 0;
  let oldestKeptTextIndex: number | undefined;
  let stopCause: ReconstructionStopCause | undefined;

  for (let index = input.priorMessages.length - 1; index >= 0; index--) {
    const message = input.priorMessages[index];
    if (!isTextPassMessage(message)) continue;
    if (keptTextCount + 1 > input.maxPriorMessages) {
      stopCause = "message_limit";
      break;
    }
    let textLines: string[];
    try {
      textLines = input.renderHistoryText(message);
    } catch (error) {
      if (isHistoryFieldByteLimitError(error)) {
        stopCause = "byte_limit";
        break;
      }
      throw error;
    }
    renderedTextByIndex.set(index, textLines);
    const candidateShown = keptTextCount + 1;
    const candidateLeftOut = input.turnCapDropped +
      (input.priorMessages.length - candidateShown);
    const candidateCallsLeftOut = countAssistantCallsInSpan(
      input.priorMessages,
      index,
    );
    const candidatePrompt = formatReconstructedTranscriptPrompt({
      headerLines: input.headerLines,
      footerLine: input.footerLine,
      bodyLines: buildSpanBodyLines({
        priorMessages: input.priorMessages,
        spanStart: index,
        renderedTextByIndex,
        includedToolLinesByAssistantIndex: emptyToolLines,
        includeLeftOutMarks: true,
      }),
      priorMessagesLeftOut: candidateLeftOut,
      priorMessagesShown: candidateShown,
      toolCallsLeftOut: candidateCallsLeftOut,
      toolCallsShown: 0,
      prompt: input.prompt,
    });
    if (!fitsFinalPromptLimit(input.decorateFinalPrompt(candidatePrompt, 0))) {
      renderedTextByIndex.delete(index);
      stopCause = "prompt_limit";
      break;
    }
    keptTextCount = candidateShown;
    oldestKeptTextIndex = index;
  }

  const keptSpanStart = stopCause === undefined
    ? 0
    : (oldestKeptTextIndex ?? input.priorMessages.length);
  return { keptTextCount, keptSpanStart, renderedTextByIndex, stopCause };
}

function runToolPass(input: TwoPassFraming & {
  priorMessages: readonly WorkbenchMessage[];
  keptSpanStart: number;
  keptTextCount: number;
  renderedTextByIndex: ReadonlyMap<number, readonly string[]>;
  callGroups: readonly KeptSpanCallGroup[];
  prompt: string;
  turnCapDropped: number;
  decorateFinalPrompt: (
    reconstructedPrompt: string,
    toolExchanges: number,
  ) => string;
}): {
  priorMessagesShown: number;
  toolExchanges: number;
  toolCallsLeftOut: number;
  includedToolLinesByAssistantIndex: Map<number, string[]>;
  stopCause?: ReconstructionStopCause;
} {
  const includedToolLinesByAssistantIndex = new Map<number, string[]>();
  const totalCallsInSpan = input.callGroups.reduce(
    (sum, group) => sum + group.calls.length,
    0,
  );
  let priorMessagesShown = input.keptTextCount;
  let toolExchanges = 0;
  let stopCause: ReconstructionStopCause | undefined;

  for (let index = input.callGroups.length - 1; index >= 0; index--) {
    const group = input.callGroups[index];
    const candidateShown = priorMessagesShown + group.addedMessages;
    if (candidateShown > input.maxPriorMessages) {
      stopCause = "message_limit";
      break;
    }
    let renderedToolLines: string[];
    try {
      renderedToolLines = renderCallGroupLines(group, input.renderToolExchange);
    } catch (error) {
      if (isHistoryFieldByteLimitError(error)) {
        stopCause = "byte_limit";
        break;
      }
      throw error;
    }
    includedToolLinesByAssistantIndex.set(
      group.assistantIndex,
      renderedToolLines,
    );
    const candidateToolExchanges = toolExchanges + group.calls.length;
    const candidateCallsLeftOut = totalCallsInSpan - candidateToolExchanges;
    const candidateLeftOut = input.turnCapDropped +
      (input.priorMessages.length - candidateShown);
    const candidatePrompt = formatReconstructedTranscriptPrompt({
      headerLines: input.headerLines,
      footerLine: input.footerLine,
      bodyLines: buildSpanBodyLines({
        priorMessages: input.priorMessages,
        spanStart: input.keptSpanStart,
        renderedTextByIndex: input.renderedTextByIndex,
        includedToolLinesByAssistantIndex,
        includeLeftOutMarks: true,
      }),
      priorMessagesLeftOut: candidateLeftOut,
      priorMessagesShown: candidateShown,
      toolCallsLeftOut: candidateCallsLeftOut,
      toolCallsShown: candidateToolExchanges,
      prompt: input.prompt,
    });
    if (
      !fitsFinalPromptLimit(
        input.decorateFinalPrompt(candidatePrompt, candidateToolExchanges),
      )
    ) {
      includedToolLinesByAssistantIndex.delete(group.assistantIndex);
      stopCause = "prompt_limit";
      break;
    }
    priorMessagesShown = candidateShown;
    toolExchanges = candidateToolExchanges;
  }

  return {
    priorMessagesShown,
    toolExchanges,
    toolCallsLeftOut: totalCallsInSpan - toolExchanges,
    includedToolLinesByAssistantIndex,
    stopCause,
  };
}

function tryCompleteUnlabelledTranscript(input: TwoPassFraming & {
  priorMessages: readonly WorkbenchMessage[];
  prompt: string;
  decorateFinalPrompt: (
    reconstructedPrompt: string,
    toolExchanges: number,
  ) => string;
}): ReconstructedAcpContinuity | undefined {
  const renderedTextByIndex = new Map<number, string[]>();
  const emptyToolLines = new Map<number, readonly string[]>();

  for (let index = input.priorMessages.length - 1; index >= 0; index--) {
    const message = input.priorMessages[index];
    if (!isTextPassMessage(message)) continue;
    let textLines: string[];
    try {
      textLines = input.renderHistoryText(message);
    } catch (error) {
      if (isHistoryFieldByteLimitError(error)) return undefined;
      throw error;
    }
    renderedTextByIndex.set(index, textLines);
    const partialUnlabelled = formatReconstructedTranscriptPrompt({
      headerLines: input.headerLines,
      footerLine: input.footerLine,
      bodyLines: buildSpanBodyLines({
        priorMessages: input.priorMessages,
        spanStart: index,
        renderedTextByIndex,
        includedToolLinesByAssistantIndex: emptyToolLines,
        includeLeftOutMarks: false,
      }),
      priorMessagesLeftOut: 0,
      priorMessagesShown: input.priorMessages.length,
      prompt: input.prompt,
    });
    if (!fitsFinalPromptLimit(input.decorateFinalPrompt(partialUnlabelled, 0))) {
      return undefined;
    }
  }

  const callGroups = collectKeptSpanCallGroups(input.priorMessages, 0);
  const includedToolLinesByAssistantIndex = new Map<number, string[]>();
  let toolExchanges = 0;

  for (let index = callGroups.length - 1; index >= 0; index--) {
    const group = callGroups[index];
    let renderedToolLines: string[];
    try {
      renderedToolLines = renderCallGroupLines(group, input.renderToolExchange);
    } catch (error) {
      if (isHistoryFieldByteLimitError(error)) return undefined;
      throw error;
    }
    includedToolLinesByAssistantIndex.set(
      group.assistantIndex,
      renderedToolLines,
    );
    toolExchanges += group.calls.length;
    const candidateUnlabelled = formatReconstructedTranscriptPrompt({
      headerLines: input.headerLines,
      footerLine: input.footerLine,
      bodyLines: buildSpanBodyLines({
        priorMessages: input.priorMessages,
        spanStart: 0,
        renderedTextByIndex,
        includedToolLinesByAssistantIndex,
        includeLeftOutMarks: false,
      }),
      priorMessagesLeftOut: 0,
      priorMessagesShown: input.priorMessages.length,
      prompt: input.prompt,
    });
    if (
      !fitsFinalPromptLimit(
        input.decorateFinalPrompt(candidateUnlabelled, toolExchanges),
      )
    ) {
      return undefined;
    }
  }

  const completePrompt = formatReconstructedTranscriptPrompt({
    headerLines: input.headerLines,
    footerLine: input.footerLine,
    bodyLines: buildSpanBodyLines({
      priorMessages: input.priorMessages,
      spanStart: 0,
      renderedTextByIndex,
      includedToolLinesByAssistantIndex,
      includeLeftOutMarks: false,
    }),
    priorMessagesLeftOut: 0,
    priorMessagesShown: input.priorMessages.length,
    prompt: input.prompt,
  });
  if (
    !fitsFinalPromptLimit(
      input.decorateFinalPrompt(completePrompt, toolExchanges),
    )
  ) {
    return undefined;
  }
  return {
    prompt: completePrompt,
    priorMessagesProjected: input.priorMessages.length,
    toolExchanges,
    priorMessagesLeftOut: 0,
    toolCallsLeftOut: 0,
    leftOutCauses: [],
  };
}

export interface ReconstructedAcpContinuity {
  prompt: string;
  priorMessagesProjected: number;
  toolExchanges: number;
  priorMessagesLeftOut: number;
  toolCallsLeftOut: number;
  leftOutCauses: ExternalAgentTranscriptLeftOutCause[];
}

export function reconstructTwoPassTranscript(input: TwoPassFraming & {
  priorMessages: readonly WorkbenchMessage[];
  prompt: string;
  turnCapDroppedMessages?: number;
  decorateFinalPrompt?: (
    reconstructedPrompt: string,
    toolExchanges: number,
  ) => string;
}): ReconstructedAcpContinuity {
  const turnCapDropped = validateTurnCapDroppedMessages(
    input.turnCapDroppedMessages,
  );
  const decorateFinalPrompt = input.decorateFinalPrompt ?? ((value) => value);

  const textPass = runTextPass({
    ...input,
    turnCapDropped,
    decorateFinalPrompt,
  });
  const callGroups = collectKeptSpanCallGroups(
    input.priorMessages,
    textPass.keptSpanStart,
  );
  const toolPass = runToolPass({
    ...input,
    keptSpanStart: textPass.keptSpanStart,
    keptTextCount: textPass.keptTextCount,
    renderedTextByIndex: textPass.renderedTextByIndex,
    callGroups,
    turnCapDropped,
    decorateFinalPrompt,
  });

  const priorMessagesLeftOut = turnCapDropped +
    (input.priorMessages.length - toolPass.priorMessagesShown);

  if (
    priorMessagesLeftOut > 0 &&
    turnCapDropped === 0 &&
    input.priorMessages.length <= input.maxPriorMessages &&
    textPass.stopCause !== "byte_limit" &&
    toolPass.stopCause !== "byte_limit"
  ) {
    const complete = tryCompleteUnlabelledTranscript({
      ...input,
      decorateFinalPrompt,
    });
    if (complete !== undefined) {
      assertAcpPromptWithinLimit(
        decorateFinalPrompt(complete.prompt, complete.toolExchanges),
      );
      return complete;
    }
  }

  const leftOutCauses: ExternalAgentTranscriptLeftOutCause[] = [];
  const addCause = (cause: ExternalAgentTranscriptLeftOutCause | undefined) => {
    if (cause !== undefined && !leftOutCauses.includes(cause)) {
      leftOutCauses.push(cause);
    }
  };
  if (turnCapDropped > 0) addCause("turn_cap");
  addCause(textPass.stopCause);
  addCause(toolPass.stopCause);

  const reconstructed = formatReconstructedTranscriptPrompt({
    headerLines: input.headerLines,
    footerLine: input.footerLine,
    bodyLines: buildSpanBodyLines({
      priorMessages: input.priorMessages,
      spanStart: textPass.keptSpanStart,
      renderedTextByIndex: textPass.renderedTextByIndex,
      includedToolLinesByAssistantIndex:
        toolPass.includedToolLinesByAssistantIndex,
      includeLeftOutMarks: true,
    }),
    priorMessagesLeftOut,
    priorMessagesShown: toolPass.priorMessagesShown,
    toolCallsLeftOut: toolPass.toolCallsLeftOut,
    toolCallsShown: toolPass.toolExchanges,
    prompt: input.prompt,
  });
  assertAcpPromptWithinLimit(
    decorateFinalPrompt(reconstructed, toolPass.toolExchanges),
  );
  return {
    prompt: reconstructed,
    priorMessagesProjected: toolPass.priorMessagesShown,
    toolExchanges: toolPass.toolExchanges,
    priorMessagesLeftOut,
    toolCallsLeftOut: toolPass.toolCallsLeftOut,
    leftOutCauses,
  };
}

export interface PreparedAcpTurnContinuity {
  warmPrompt: string;
  directPrompt: string;
  reconstructPrompt?: () => string;
  continuity?: AcpContinuityEvidence;
  historyOmission?: HistoryOmissionReceipt;
  onWarmMapContinuity(evidence: AcpContinuityEvidence): void;
  reconstructingEvent(
    sessionId: string,
    reason?: ContinuityReconstructionReason,
  ): WorkbenchRuntimeEvent | undefined;
  counts(): {
    priorMessagesProjected: number;
    toolExchangesProjected: number;
    priorMessagesLeftOut: number;
    toolCallsLeftOut: number;
    leftOutCauses: ExternalAgentTranscriptLeftOutCause[];
  };
  receiptContinuity(
    priorExternalSessionId?: string,
  ): ExternalAgentTurnReceipt["runner"]["continuity"];
}

export function prepareAcpTurnContinuity(input: {
  prompt: string;
  conversationMessages?: readonly WorkbenchMessage[];
  turnCapDroppedMessages?: number;
  historyOmission?: HistoryOmissionProjection;
  isDispatchedChild: boolean;
  hasSessionMap: boolean;
  reconstruct(args: {
    priorMessages: readonly WorkbenchMessage[];
    prompt: string;
    turnCapDroppedMessages: number;
    decorateFinalPrompt: (
      reconstructedPrompt: string,
      toolExchanges: number,
    ) => string;
  }): ReconstructedAcpContinuity;
}): PreparedAcpTurnContinuity {
  const priorMessages = input.conversationMessages ?? [];
  const turnCapDroppedMessages = validateTurnCapDroppedMessages(
    input.turnCapDroppedMessages,
  );
  const hasPriorHistory = priorMessages.length > 0 ||
    turnCapDroppedMessages > 0;
  const initialProjectedOmission = historyOmissionForDelivery(
    input.historyOmission,
    "projected-transcript",
  );
  const projectedOmissionWithPairs = (
    toolExchangesSent: number,
  ): HistoryOmissionReceipt | undefined =>
    initialProjectedOmission === undefined
      ? undefined
      : historyOmissionForDelivery(
        {
          ...input.historyOmission!,
          projectedPairs: toolExchangesSent,
        },
        "projected-transcript",
      );
  const decorateProjected = (
    reconstructedPrompt: string,
    toolExchangesSent: number,
  ): string =>
    prependChildContextLine(
      prependHistoryOmissionNotice(
        reconstructedPrompt,
        projectedOmissionWithPairs(toolExchangesSent),
      ),
      input.isDispatchedChild,
    );

  let priorMessagesProjected = 0;
  let toolExchangesProjected = 0;
  let priorMessagesLeftOut = 0;
  let toolCallsLeftOut = 0;
  let leftOutCauses: ExternalAgentTranscriptLeftOutCause[] = [];
  let continuity: AcpContinuityEvidence | undefined;

  const reconstructPrompt = !hasPriorHistory ? undefined : () => {
    const projection = input.reconstruct({
      priorMessages,
      prompt: input.prompt,
      turnCapDroppedMessages,
      decorateFinalPrompt: decorateProjected,
    });
    priorMessagesProjected = projection.priorMessagesProjected;
    toolExchangesProjected = projection.toolExchanges;
    priorMessagesLeftOut = projection.priorMessagesLeftOut;
    toolCallsLeftOut = projection.toolCallsLeftOut;
    leftOutCauses = projection.leftOutCauses;
    return decorateProjected(projection.prompt, toolExchangesProjected);
  };

  let directPrompt = prependChildContextLine(
    prependHistoryOmissionNotice(
      input.prompt,
      historyOmissionForDelivery(input.historyOmission, "no-prior-transcript"),
    ),
    input.isDispatchedChild,
  );
  if (!input.hasSessionMap && reconstructPrompt !== undefined) {
    directPrompt = reconstructPrompt();
    continuity = {
      state: "reconstructed",
      durableResume: "unavailable-client-verification",
    };
  } else if (!input.hasSessionMap) {
    continuity = { state: "new", durableResume: "not-required" };
  }
  if (!input.hasSessionMap) {
    assertAcpPromptWithinLimit(directPrompt);
  }

  const warmPrompt = prependChildContextLine(
    prependHistoryOmissionNotice(
      input.prompt,
      historyOmissionForDelivery(input.historyOmission, "warm-no-replay"),
    ),
    input.isDispatchedChild,
  );

  return {
    warmPrompt,
    directPrompt,
    reconstructPrompt,
    get continuity() {
      return continuity;
    },
    get historyOmission() {
      if (continuity === undefined) return undefined;
      if (continuity.state === "reconstructed") {
        return projectedOmissionWithPairs(toolExchangesProjected);
      }
      return historyOmissionForDelivery(
        input.historyOmission,
        continuity.state === "new" ? "no-prior-transcript" : "warm-no-replay",
      );
    },
    onWarmMapContinuity(evidence: AcpContinuityEvidence) {
      continuity = evidence;
    },
    reconstructingEvent: (sessionId, reason) =>
      buildContinuityReconstructingEvent(
        continuity,
        sessionId,
        reason,
        priorMessagesProjected,
        priorMessagesLeftOut,
      ),
    counts() {
      return {
        priorMessagesProjected,
        toolExchangesProjected,
        priorMessagesLeftOut,
        toolCallsLeftOut,
        leftOutCauses,
      };
    },
    receiptContinuity(priorExternalSessionId?: string) {
      if (continuity === undefined) return undefined;
      return {
        state: continuity.state,
        claimSource: "workbench_observed" as const,
        durableResume: continuity.durableResume,
        ...(continuity.state === "reconstructed"
          ? {
            priorMessagesProjected,
            toolExchangesProjected,
            ...(priorMessagesLeftOut > 0
              ? { priorMessagesLeftOut, leftOutCauses }
              : {}),
            ...(toolCallsLeftOut > 0 ? { toolCallsLeftOut } : {}),
          }
          : {}),
        ...(priorExternalSessionId === undefined
          ? {}
          : { priorExternalSessionId }),
      };
    },
  };
}

function buildContinuityReconstructingEvent(
  continuity: AcpContinuityEvidence | undefined,
  sessionId: string,
  reason: ContinuityReconstructionReason = "not_held",
  priorMessagesProjected: number,
  priorMessagesLeftOut: number,
): WorkbenchRuntimeEvent | undefined {
  if (continuity?.state !== "reconstructed") return undefined;
  return {
    type: "continuityReconstructing",
    sessionId,
    reason,
    priorMessagesProjected,
    priorMessagesLeftOut,
  };
}
