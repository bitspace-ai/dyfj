/**
 * OpenAI-compatible usage and cost. Provider-reported totals are trusted when
 * they cover everything the reader saw; text or reasoning that arrived after
 * the last covering usage frame (or on an aborted stream) is added from a
 * character estimate, so the metered output is a lower bound, never an
 * undercount of what was received.
 */
import type { WorkbenchModel, WorkbenchTurnParams } from "../types.ts";
import {
  estimateParamsInputText,
  estimateTextTokens,
  finiteNonnegativeTokenCount,
} from "../shared/tokens.ts";
import type { readOpenAIChatJson } from "./response.ts";
import type { readOpenAIChatStream } from "./stream.ts";

/** What either reader returns. */
export type OpenAIChatReadResult =
  | Awaited<ReturnType<typeof readOpenAIChatStream>>
  | Awaited<ReturnType<typeof readOpenAIChatJson>>;

export interface OpenAIChatUsageSummary {
  /** Uncached prompt tokens; `cacheRead` and `cacheWrite` are reported apart. */
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  costTotal: number;
}

/**
 * `generatedText` is the raw generated text before any text tool-call
 * recovery rewrote it.
 */
export function openAIChatUsage(
  result: OpenAIChatReadResult,
  generatedText: string,
  params: Pick<WorkbenchTurnParams, "systemPrompt" | "prompt" | "messages">,
  model: WorkbenchModel,
): OpenAIChatUsageSummary {
  const prompt = finiteNonnegativeTokenCount(result.usage?.prompt_tokens) ??
    estimateTextTokens(estimateParamsInputText(params));
  // prompt_tokens includes cache traffic. Split it out to match the other
  // adapters (input excludes cache), clamped so the parts never exceed it.
  const details = result.usage?.prompt_tokens_details;
  const cacheRead = Math.min(
    prompt,
    finiteNonnegativeTokenCount(details?.cached_tokens) ?? 0,
  );
  const cacheWrite = Math.min(
    prompt - cacheRead,
    finiteNonnegativeTokenCount(details?.cache_write_tokens) ?? 0,
  );
  const input = prompt - cacheRead - cacheWrite;
  const reportedCompletion = finiteNonnegativeTokenCount(
    result.usage?.completion_tokens,
  );
  const reportedReasoning = finiteNonnegativeTokenCount(
    result.usage?.completion_tokens_details?.reasoning_tokens,
  );
  const reasoningCharacters = "reasoningCharacters" in result
    ? result.reasoningCharacters
    : 0;
  const estimatedReasoning = Math.ceil(reasoningCharacters / 4);
  const usageCoversReasoning = !result.aborted &&
    (!("usageReasoningCharacters" in result) ||
      result.usageReasoningCharacters === result.reasoningCharacters);
  const toolCallCharacters = "toolCallCharacters" in result
    ? result.toolCallCharacters
    : 0;
  const estimatedGeneratedOutput = Math.ceil(
    (generatedText.length + toolCallCharacters) / 4,
  );
  const usageCoversGeneratedOutput = !result.aborted &&
    (!("usageGeneratedCharacters" in result) ||
      result.usageGeneratedCharacters ===
        generatedText.length + toolCallCharacters);
  const usageCoversCompletionReasoning = !result.aborted &&
    (!("usageCompletionReasoningCharacters" in result) ||
      result.usageCompletionReasoningCharacters ===
        result.reasoningCharacters);
  const usageCoversCompletionTotal = usageCoversGeneratedOutput &&
    usageCoversCompletionReasoning;
  let reasoning: number;
  let output: number;
  let billableOutput: number;
  if (reportedCompletion === undefined) {
    reasoning = reportedReasoning === undefined
      ? estimatedReasoning
      : usageCoversReasoning
      ? reportedReasoning
      : reportedReasoning + Math.ceil(
        Math.max(
          0,
          reasoningCharacters - (result.usageReasoningCharacters ?? 0),
        ) / 4,
      );
    output = estimatedGeneratedOutput;
    billableOutput = output + reasoning;
  } else if (usageCoversCompletionTotal) {
    const split = reportedReasoning === undefined
      ? estimatedReasoning
      : usageCoversReasoning
      ? reportedReasoning
      : reportedReasoning + Math.ceil(
        Math.max(
          0,
          reasoningCharacters - (result.usageReasoningCharacters ?? 0),
        ) / 4,
      );
    reasoning = Math.min(split, reportedCompletion);
    output = reportedCompletion - reasoning;
    billableOutput = reportedCompletion;
  } else {
    const generatedAfterUsage = Math.ceil(
      Math.max(
        0,
        generatedText.length + toolCallCharacters -
          (result.usageGeneratedCharacters ?? 0),
      ) / 4,
    );
    const reasoningAfterCompletionUsage = Math.ceil(
      Math.max(
        0,
        reasoningCharacters -
          (result.usageCompletionReasoningCharacters ?? 0),
      ) / 4,
    );
    reasoning = reportedReasoning === undefined
      ? estimatedReasoning
      : reportedReasoning + Math.ceil(
        Math.max(
          0,
          reasoningCharacters - (result.usageReasoningCharacters ?? 0),
        ) / 4,
      );
    billableOutput = Math.max(
      reportedCompletion + generatedAfterUsage +
        reasoningAfterCompletionUsage,
      reasoning + estimatedGeneratedOutput,
    );
    output = billableOutput - reasoning;
  }
  // An unpriced cache rate falls back to the input rate: never understate.
  const costTotal = (input / 1_000_000) * model.costInput +
    (cacheRead / 1_000_000) * (model.costCacheRead ?? model.costInput) +
    (cacheWrite / 1_000_000) * (model.costCacheWrite ?? model.costInput) +
    (billableOutput / 1_000_000) * model.costOutput;
  return { input, cacheRead, cacheWrite, output, reasoning, costTotal };
}
