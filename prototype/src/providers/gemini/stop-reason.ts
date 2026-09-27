/**
 * Gemini `finishReason` to the runtime stop reason.
 */
import type { WorkbenchTurnResult } from "../types.ts";

export function normaliseGeminiStopReason(
  reason: string | undefined,
): WorkbenchTurnResult["stopReason"] {
  if (reason === "MAX_TOKENS") return "length";
  if (reason === "STOP" || reason === undefined) return "stop";
  // SAFETY, RECITATION, PROHIBITED_CONTENT, OTHER, etc.
  return "error";
}
