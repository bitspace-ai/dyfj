/**
 * OpenAI-compatible `finish_reason` to the runtime stop reason.
 */
import type { WorkbenchTurnResult } from "../types.ts";

export function normaliseFinishReason(
  reason: string | undefined,
): WorkbenchTurnResult["stopReason"] {
  if (reason === "length") return "length";
  if (reason === "tool_calls") return "tool_use";
  if (reason === "error") return "error";
  return "stop";
}
