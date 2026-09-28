// Mapping a client's answer to a server-initiated `approval` request into the
// verdict the caller acts on. Fail-closed: only an explicit approval approves.

import type { ToolApprovalVerdict } from "../../tools/mod.ts";

// Parse the client's response to an `approval` request into a verdict. Anything
// that is not an explicit approve denies — fail-closed.
export function toApprovalVerdict(response: unknown): ToolApprovalVerdict {
  const r = typeof response === "object" && response !== null
    ? response as Record<string, unknown>
    : {};
  if (r.decision === "approve") return { decision: "approve" };
  return {
    decision: "deny",
    reason: typeof r.reason === "string"
      ? r.reason
      : "operator denied the tool call",
  };
}
