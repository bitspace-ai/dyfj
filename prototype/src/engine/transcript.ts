/**
 * Transcript arithmetic shared by the stages that size a provider request:
 * the text a transcript contributes and the fallback input-count estimate.
 */
import type { WorkbenchMessage } from "../providers/mod.ts";

/** Concatenated text of a transcript, for the fallback input-token estimate. */
export function transcriptEstimateText(
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

/** The fallback input-count estimate: four characters per token. */
export function estimateRuntimeInputCount(text: string): number {
  return Math.ceil(text.length / 4);
}
