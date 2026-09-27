// Usage and cost for the synthetic API family: reported counts when present,
// otherwise the shared four-characters-per-token estimate.

import type {
  ProviderTurnRequest,
  WorkbenchModel,
} from "../../../src/providers/mod.ts";
import {
  estimateParamsInputText,
  estimateTextTokens,
  finiteNonnegativeTokenCount,
} from "../../../src/providers/shared/tokens.ts";
import type { SyntheticRead } from "./stream.ts";

export function syntheticUsage(
  read: SyntheticRead,
  request: ProviderTurnRequest,
  model: WorkbenchModel,
): { input: number; output: number; cost: number } {
  const input = finiteNonnegativeTokenCount(read.usage?.input) ??
    estimateTextTokens(estimateParamsInputText(request));
  const output = finiteNonnegativeTokenCount(read.usage?.output) ??
    estimateTextTokens(read.text);
  return {
    input,
    output,
    cost: (input / 1_000_000) * model.costInput +
      (output / 1_000_000) * model.costOutput,
  };
}
