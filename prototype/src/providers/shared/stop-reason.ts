/**
 * The stop-reason rule every adapter applies last: a provider-reported error
 * outranks a concurrent cancellation.
 */
import type { WorkbenchTurnResult } from "../types.ts";

export function stopReasonWithAbort(
  aborted: boolean | undefined,
  providerStopReason: WorkbenchTurnResult["stopReason"],
): WorkbenchTurnResult["stopReason"] {
  if (providerStopReason === "error") return "error";
  return aborted === true ? "aborted" : providerStopReason;
}
