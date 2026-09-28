// Mapping a client's answer to a server-initiated `approval` request into the
// verdict the caller acts on. Fail-closed: only an explicit approval approves.

import type { BudgetCeilingVerdict } from "../../budget/mod.ts";
import type {
  AcpPermissionPrompt,
  AcpPermissionSelection,
} from "../../contract/mod.ts";
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

// Shared by the budget-ceiling and runaway-anomaly approvals: same verdict
// shape, but a reasonless denial must name the gate that was declined.
export function toBudgetCeilingVerdict(
  response: unknown,
  fallbackReason = "operator declined the budget ceiling",
): BudgetCeilingVerdict {
  const r = typeof response === "object" && response !== null
    ? response as Record<string, unknown>
    : {};
  if (r.decision === "approve") return { decision: "approve" };
  return {
    decision: "deny",
    reason: typeof r.reason === "string" ? r.reason : fallbackReason,
  };
}

export function approvalWasAborted(response: unknown): boolean {
  return typeof response === "object" &&
    response !== null &&
    (response as Record<string, unknown>).decision === "abort";
}

const ACP_TOOL_KINDS = new Set([
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
  "other",
]);

export function terminalAcpToolKind(value: string | undefined): string {
  return value !== undefined && ACP_TOOL_KINDS.has(value)
    ? value
    : "(not supplied)";
}

export function rejectedAcpPermissionSelection(
  prompt: AcpPermissionPrompt,
): AcpPermissionSelection {
  const rejection =
    prompt.options.find((option) =>
      option.kind === "reject_once" && option.optionId.length > 0
    ) ?? prompt.options.find((option) =>
      option.kind === "reject_always" && option.optionId.length > 0
    );
  return { optionId: rejection?.optionId ?? null, source: "policy" };
}

export function toAcpPermissionSelection(
  response: unknown,
  prompt: AcpPermissionPrompt,
): AcpPermissionSelection {
  const record = typeof response === "object" && response !== null
    ? response as Record<string, unknown>
    : {};
  if (
    record.decision === "select" && typeof record.optionId === "string" &&
    record.optionId.length > 0
  ) {
    return { optionId: record.optionId, source: "operator" };
  }
  return rejectedAcpPermissionSelection(prompt);
}
