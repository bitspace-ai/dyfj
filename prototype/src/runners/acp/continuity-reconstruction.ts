/**
 * Shortened transcript exchange selection, header formatting, and continuity
 * state preparation for external-agent (ACP) turns (BIT-924).
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

export type WorkbenchAssistantMessage = Extract<
  WorkbenchMessage,
  { role: "assistant" }
>;
export type WorkbenchToolResultMessage = Extract<
  WorkbenchMessage,
  { role: "tool" }
>;

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

export function shortenedTranscriptHeaderLines(
  priorMessagesLeftOut: number,
  priorMessagesShown: number,
): string[] {
  return [
    "This transcript is shortened.",
    `Prior messages left out: ${priorMessagesLeftOut}. Prior messages shown: ${priorMessagesShown}.`,
    "The shown part may start partway through the session, and may begin with an",
    "agent message or a tool record whose request is not shown.",
  ];
}

export function formatReconstructedTranscriptPrompt(input: {
  headerLines: readonly string[];
  footerLine: string;
  exchangeLines: readonly (readonly string[])[];
  priorMessagesLeftOut: number;
  priorMessagesShown: number;
  prompt: string;
}): string {
  const lines: string[] = [
    ...input.headerLines,
    ...(input.priorMessagesLeftOut > 0
      ? shortenedTranscriptHeaderLines(
        input.priorMessagesLeftOut,
        input.priorMessagesShown,
      )
      : []),
    ...input.exchangeLines.flat(),
    input.footerLine,
    `Operator (current turn): ${input.prompt}`,
  ];
  return lines.join("\n");
}

export type SelectedExchange =
  | { kind: "stop_message_limit" }
  | {
    kind: "exchange";
    exchangeStart: number;
    messageCount: number;
    newest: WorkbenchMessage;
    assistantMessage?: WorkbenchAssistantMessage;
    toolResults: WorkbenchToolResultMessage[];
  };

export function selectNewestExchange(
  priorMessages: readonly WorkbenchMessage[],
  cursor: number,
  keptMessages: number,
  maxPriorMessages: number,
): SelectedExchange {
  const newest = priorMessages[cursor - 1];
  let exchangeStart = cursor - 1;
  let assistantMessage: WorkbenchAssistantMessage | undefined;
  let toolResults: WorkbenchToolResultMessage[] = [];

  if (newest.role === "assistant") {
    assistantMessage = newest;
  } else if (newest.role === "tool") {
    let toolStart = cursor - 1;
    while (toolStart > 0 && priorMessages[toolStart - 1].role === "tool") {
      toolStart -= 1;
    }
    const trailingTools = cursor - toolStart;
    const preceding = toolStart > 0 ? priorMessages[toolStart - 1] : undefined;
    if (
      preceding === undefined ||
      preceding.role !== "assistant" ||
      trailingTools > (preceding.toolCalls ?? []).length
    ) {
      if (keptMessages + 1 > maxPriorMessages) {
        return { kind: "stop_message_limit" };
      }
      throw new DomainError(
        "ACP continuity reconstruction found unpaired tool history",
      );
    }
    exchangeStart = toolStart - 1;
    assistantMessage = preceding;
    toolResults = priorMessages.slice(
      toolStart,
      cursor,
    ) as WorkbenchToolResultMessage[];
  }

  const messageCount = cursor - exchangeStart;
  if (keptMessages + messageCount > maxPriorMessages) {
    return { kind: "stop_message_limit" };
  }
  return {
    kind: "exchange",
    exchangeStart,
    messageCount,
    newest,
    assistantMessage,
    toolResults,
  };
}

export function collectPairedExchangeCalls(
  assistantMessage: WorkbenchAssistantMessage | undefined,
  toolResults: readonly WorkbenchToolResultMessage[],
  seenCallIds: ReadonlySet<string>,
): Set<string> {
  const exchangeCallIds = new Set<string>();
  if (assistantMessage === undefined) return exchangeCallIds;
  const calls = assistantMessage.toolCalls ?? [];
  if (calls.length !== toolResults.length) {
    throw new DomainError(
      "ACP continuity reconstruction found unpaired tool history",
    );
  }
  for (let index = 0; index < calls.length; index++) {
    const call = calls[index];
    const paired = toolResults[index];
    if (
      paired === undefined ||
      paired.toolCallId !== call.id ||
      seenCallIds.has(call.id) ||
      exchangeCallIds.has(call.id)
    ) {
      throw new DomainError(
        "ACP continuity reconstruction found unpaired tool history",
      );
    }
    exchangeCallIds.add(call.id);
  }
  return exchangeCallIds;
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

export interface ReconstructedAcpContinuity {
  prompt: string;
  priorMessagesProjected: number;
  toolExchanges: number;
  priorMessagesLeftOut: number;
  leftOutCauses: ExternalAgentTranscriptLeftOutCause[];
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
