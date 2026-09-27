// The synthetic family's `reason` to the runtime stop reason.

import type { WorkbenchTurnResult } from "../../../src/providers/mod.ts";

export function normaliseSyntheticStopReason(
  reason: string | undefined,
): WorkbenchTurnResult["stopReason"] {
  if (reason === "max_tokens") return "length";
  if (reason === "tool_calls") return "tool_use";
  if (reason === "refused") return "error";
  return "stop";
}
