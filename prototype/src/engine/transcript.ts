/**
 * Transcript arithmetic and step projection shared by the agent loop and
 * context-sizing stages.
 */
import {
  messageEstimateText,
  type ProviderReplay,
  type WorkbenchMessage,
  type WorkbenchToolCall,
} from "../providers/mod.ts";
import type { ToolResultSummary } from "./runtime-types.ts";

/** Concatenated text of a transcript, for the fallback input-token estimate. */
export function transcriptEstimateText(
  systemPrompt: string,
  messages: WorkbenchMessage[],
): string {
  const body = messages.map(messageEstimateText).join("\n");
  return `${systemPrompt}\n${body}`;
}

/** The fallback input-count estimate: four characters per token. */
export function estimateRuntimeInputCount(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Turn one agent-loop step into transcript messages: the assistant turn that
 * requested the tools (its text plus the tool-call intentions) followed by one
 * `tool` message per result, each linked back to its call by id. Appending
 * these to the running history is what lets the next step see the model's own
 * prior reasoning and the matching results - instead of a flattened summary
 * string that drops the trail and invites confabulation. The reply's `replay`,
 * when it has one, rides on the assistant turn so the adapter can send the
 * reply back as the model produced it (Anthropic thinking blocks); it lives
 * only in this in-memory transcript, never in the event log.
 */
export function toolStepToMessages(
  assistantText: string,
  toolCalls: WorkbenchToolCall[] | undefined,
  stepResults: ToolResultSummary[],
  replay?: ProviderReplay,
): WorkbenchMessage[] {
  const messages: WorkbenchMessage[] = [
    {
      role: "assistant",
      content: assistantText,
      toolCalls,
      ...(replay === undefined ? {} : { replay }),
    },
  ];
  for (const result of stepResults) {
    messages.push({
      role: "tool",
      toolCallId: result.callId,
      name: result.commandId,
      content: result.result,
      ...(result.isError ? { isError: true } : {}),
      ...(result.trimmedFrom === undefined
        ? {}
        : { trimmedFrom: result.trimmedFrom }),
    });
  }
  return messages;
}
