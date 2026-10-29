/**
 * Anthropic cost, including prompt-cache traffic.
 */
import type { WorkbenchModel } from "../types.ts";

export function anthropicCost(
  model: WorkbenchModel,
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  },
): number {
  const { input, output, cacheRead, cacheWrite } = usage;
  // Anthropic prices cache traffic from the model's own published cache rates.
  // The 5-minute cache-write multiplier is a uniform 1.25x of the row's input
  // price, but the absolute write prices still differ by model, and the
  // cache-read multiplier is not uniform at all: 0.1x input on most models,
  // 0.05x on some and 0.025x on others. The row is the source of those two
  // numbers; guessing a multiplier here would price some models wrong.
  //
  // A row that declares no cache price falls back to its input rate. Refusing
  // the call is not available at this point — it is priced after the provider
  // answered, so a refusal would discard the record of spend already
  // incurred. The fallback uses the full input rate, which can substantially
  // overestimate a cache read (up to 40x, where reads cost 0.025x input) and
  // understate a cache write, which costs more than input. Every Anthropic row
  // in the catalog declares both.
  const cacheReadRate = model.costCacheRead ?? model.costInput;
  const cacheWriteRate = model.costCacheWrite ?? model.costInput;
  // input_tokens excludes cache traffic; total prompt = input + read + write.
  return (input / 1_000_000) * model.costInput +
    (cacheRead / 1_000_000) * cacheReadRate +
    (cacheWrite / 1_000_000) * cacheWriteRate +
    (output / 1_000_000) * model.costOutput;
}
