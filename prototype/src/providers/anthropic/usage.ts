/**
 * Anthropic cost, including prompt-cache traffic.
 */
import type { WorkbenchModel } from "../types.ts";

// Cache pricing multipliers relative to base input price: reads ~0.1x,
// 5-minute-TTL writes 1.25x.
const ANTHROPIC_CACHE_READ_COST_MULTIPLIER = 0.1;
const ANTHROPIC_CACHE_WRITE_COST_MULTIPLIER = 1.25;

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
  // input_tokens excludes cache traffic; total prompt = input + read + write.
  return (input / 1_000_000) * model.costInput +
    (cacheRead / 1_000_000) * model.costInput *
      ANTHROPIC_CACHE_READ_COST_MULTIPLIER +
    (cacheWrite / 1_000_000) * model.costInput *
      ANTHROPIC_CACHE_WRITE_COST_MULTIPLIER +
    (output / 1_000_000) * model.costOutput;
}
