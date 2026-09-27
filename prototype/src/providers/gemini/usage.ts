/**
 * Gemini usage and cost. Reported totals are trusted when they cover the text
 * and reasoning the reader saw; anything received after the last covering
 * usage frame (or on an aborted stream) is added from a character estimate.
 * Thinking tokens are billed as output but reported apart from it.
 */
import type { WorkbenchModel, WorkbenchTurnParams } from "../types.ts";
import {
  estimateParamsInputText,
  estimateTextTokens,
  finiteNonnegativeTokenCount,
} from "../shared/tokens.ts";
import type { readGeminiJson, readGeminiStream } from "./stream.ts";

/** What either reader returns. */
export type GeminiReadResult =
  | Awaited<ReturnType<typeof readGeminiStream>>
  | Awaited<ReturnType<typeof readGeminiJson>>;

export function geminiUsage(
  result: GeminiReadResult,
  params: Pick<WorkbenchTurnParams, "systemPrompt" | "prompt" | "messages">,
  model: WorkbenchModel,
): { input: number; output: number; reasoning: number; costTotal: number } {
  const input = finiteNonnegativeTokenCount(result.inputTokens) ??
    estimateTextTokens(estimateParamsInputText(params));
  const estimatedOutput = estimateTextTokens(result.text);
  const reportedOutput = finiteNonnegativeTokenCount(result.outputTokens);
  const usageCoversOutput = !result.aborted &&
    (!("usageTextCharacters" in result) ||
      result.usageTextCharacters === result.text.length);
  const output = reportedOutput === undefined
    ? estimatedOutput
    : usageCoversOutput
    ? reportedOutput
    : reportedOutput + Math.ceil(
      Math.max(0, result.text.length - (result.usageTextCharacters ?? 0)) / 4,
    );
  const reportedReasoning = finiteNonnegativeTokenCount(
    result.reasoningTokens,
  );
  const reasoningCharacters = "reasoningCharacters" in result
    ? result.reasoningCharacters
    : 0;
  const usageReasoningCharacters = "usageReasoningCharacters" in result
    ? result.usageReasoningCharacters
    : undefined;
  const usageCoversReasoning = !result.aborted &&
    (usageReasoningCharacters === undefined ||
      usageReasoningCharacters === reasoningCharacters);
  const reasoning = reportedReasoning === undefined
    ? Math.ceil(reasoningCharacters / 4)
    : usageCoversReasoning
    ? reportedReasoning
    : reportedReasoning + Math.ceil(
      Math.max(
        0,
        reasoningCharacters - (usageReasoningCharacters ?? 0),
      ) / 4,
    );
  const billableOutput = output + reasoning;
  const costTotal = (input / 1_000_000) * model.costInput +
    (billableOutput / 1_000_000) * model.costOutput;
  return { input, output, reasoning, costTotal };
}
