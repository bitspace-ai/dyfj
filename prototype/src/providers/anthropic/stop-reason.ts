/**
 * Anthropic `stop_reason` to the runtime stop reason.
 */
import type { WorkbenchTurnResult } from "../types.ts";

export function normaliseAnthropicStopReason(
  reason: string | undefined,
): WorkbenchTurnResult["stopReason"] {
  if (reason === "max_tokens") return "length";
  if (reason === "tool_use") return "tool_use";
  if (reason === "refusal") return "error";
  return "stop";
}
