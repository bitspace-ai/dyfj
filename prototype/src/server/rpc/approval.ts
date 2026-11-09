// Mapping a client's answer to a server-initiated `approval` request into the
// verdict the caller acts on. Fail-closed: only an explicit approval approves.

import {
  budgetCeilingApprovalRequest,
  type BudgetCeilingVerdict,
} from "../../budget/mod.ts";
import type {
  AcpPermissionPrompt,
  AcpPermissionSelection,
} from "../../contract/mod.ts";
import type { ExecuteTurnDeps, TurnTicket } from "../../engine/mod.ts";
import type { ToolApprovalVerdict } from "../../tools/mod.ts";

// Parse the client's response to an `approval` request into a verdict. Anything
// that is not an explicit approve denies — fail-closed.
export function toApprovalVerdict(response: unknown): ToolApprovalVerdict {
  const r = typeof response === "object" && response !== null
    ? response as Record<string, unknown>
    : {};
  if (r.decision === "approve") {
    // Only the exact `scope: "session"` widens an approval; anything else
    // approves this call once.
    return r.scope === "session"
      ? { decision: "approve", scope: "session" }
      : { decision: "approve" };
  }
  return {
    decision: "deny",
    reason: typeof r.reason === "string"
      ? r.reason
      : "operator denied the tool call",
  };
}

// The spend-check verdict; a reasonless denial names the gate that was
// declined.
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

/** The decisions a turn asks its caller for: tool, ACP permission, spend. */
export type TurnApprover = NonNullable<ExecuteTurnDeps["approver"]>;

/**
 * Ask one approval request and wait for the answer. A rejection is a request
 * that could not be asked or answered; the approver denies it.
 */
export type RequestApproval = (
  request: unknown,
  signal: AbortSignal,
) => Promise<unknown>;

/** The denial reasons an approver gives when a request cannot be asked. */
export interface ApprovalUnavailable {
  tool: string;
  budget: string;
}

/**
 * A turn's approver over one way of asking: the connected client (`turn`) or
 * the operator, through a parked approval (a headless turn). Every answer goes
 * through the same fail-closed parsing, whoever gave it. Each request is
 * bounded by the turn's cancel signal; an answer of `abort` ends the turn, and
 * an answer that arrives after the turn was cancelled cannot start work.
 */
export function approverOver(
  requestApproval: RequestApproval,
  turn: TurnTicket,
  unavailable: ApprovalUnavailable,
): TurnApprover {
  const abortIfApprovalWasInterrupted = (response: unknown): void => {
    if (!approvalWasAborted(response)) return;
    turn.abort();
    throw turn.signal.reason;
  };
  const rejectStaleApprovalAfterCancellation = (): void => {
    if (turn.signal.aborted) {
      throw turn.signal.reason;
    }
  };
  const ask = (request: unknown, signal?: AbortSignal): Promise<unknown> =>
    requestApproval(
      request,
      signal === undefined
        ? turn.signal
        : AbortSignal.any([turn.signal, signal]),
    );
  return {
    confirmToolApproval: (request, signal) =>
      ask(request, signal).then(
        (response) => {
          abortIfApprovalWasInterrupted(response);
          rejectStaleApprovalAfterCancellation();
          return toApprovalVerdict(response);
        },
        (): ToolApprovalVerdict => {
          rejectStaleApprovalAfterCancellation();
          return { decision: "deny", reason: unavailable.tool };
        },
      ),
    confirmExternalAgentPermission: (prompt, signal) =>
      ask({
        kind: "external_agent_permission",
        title: prompt.toolCall.title,
        arguments: {
          "ACP tool": prompt.toolCall.name ?? "(not supplied)",
          "ACP kind": terminalAcpToolKind(prompt.toolCall.kind),
          "Requested input": prompt.toolCall.inputSummary,
        },
        options: prompt.options,
      }, signal).then(
        (response) => {
          abortIfApprovalWasInterrupted(response);
          rejectStaleApprovalAfterCancellation();
          return toAcpPermissionSelection(response, prompt);
        },
        (): AcpPermissionSelection => {
          rejectStaleApprovalAfterCancellation();
          return rejectedAcpPermissionSelection(prompt);
        },
      ),
    confirmBudgetCeiling: (warning) =>
      ask(budgetCeilingApprovalRequest(warning)).then(
        (response) => {
          abortIfApprovalWasInterrupted(response);
          rejectStaleApprovalAfterCancellation();
          return toBudgetCeilingVerdict(response);
        },
        (): BudgetCeilingVerdict => {
          rejectStaleApprovalAfterCancellation();
          return { decision: "deny", reason: unavailable.budget };
        },
      ),
  };
}
