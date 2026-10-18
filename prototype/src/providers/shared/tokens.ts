/**
 * Token estimates and per-token timing, shared by the adapters.
 */
import type {
  WorkbenchCallTimings,
  WorkbenchMessage,
  WorkbenchTurnParams,
} from "../types.ts";

export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function finiteNonnegativeTokenCount(
  value: unknown,
): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/**
 * Text used for the fallback input-token estimate when the provider does not
 * report prompt_tokens. Covers the full conversation (system + history, or the
 * seed prompt when there is no history) so multi-step turns are not undercounted.
 */
export function estimateParamsInputText(
  params: Pick<WorkbenchTurnParams, "systemPrompt" | "prompt" | "messages">,
): string {
  const history = params.messages && params.messages.length > 0
    ? params.messages.map(messageEstimateText).join("\n")
    : params.prompt;
  return `${params.systemPrompt}\n${history}`;
}

/**
 * The text one transcript message contributes to a size estimate. An
 * assistant turn with a reply to replay counts as that reply's blocks, which
 * is what goes out while it is still valid: its thinking signatures are sent
 * back and billed as input, and they can far outweigh the visible text.
 */
export function messageEstimateText(message: WorkbenchMessage): string {
  if (message.role !== "assistant") return message.content;
  if (message.replay !== undefined) {
    return JSON.stringify(message.replay.content);
  }
  return message.content +
    (message.toolCalls ? JSON.stringify(message.toolCalls) : "");
}

export function withTimePerOutputToken(
  timings: WorkbenchCallTimings,
  outputTokens: number,
): WorkbenchCallTimings {
  if (outputTokens <= 0) return timings;

  if (timings.generationMs !== undefined) {
    if (outputTokens <= 1) return timings;
    return {
      ...timings,
      timePerOutputTokenMs: Math.round(
        timings.generationMs / (outputTokens - 1),
      ),
    };
  }

  return timings;
}
