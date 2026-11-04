/**
 * Per-call ACP tool evidence: turn the bounded calls the ACP client captured
 * into what Workbench persists. Each call is judged on its own and ends
 * `recorded` (a replayable request/result pair), `partial` or `rejected` with a
 * fixed reason code, so a problem with one call never drops calls with other
 * ids.
 */
import { clipToUtf8Bytes } from "./kernel/mod.ts";
import type {
  AcpToolCallEvidence,
  AcpToolCallStatus,
  AcpToolEvidence,
} from "./acp-tool-evidence.ts";
import {
  ACP_TOOL_EVIDENCE_REASONS,
  ACP_TOOL_EVIDENCE_REJECTING_REASONS,
  ACP_TOOL_HISTORY_UNAVAILABLE_NAME,
  type AcpToolEvidenceReason,
  type AcpToolEvidenceReasonCounts,
  type ExternalAgentWorkbenchRuntimeResult,
} from "./contract/mod.ts";
import {
  boundedHistoryArguments,
  boundedHistoryField,
  boundedHistoryMetadata,
  HistoryLimitError,
  historyContainsSecretShape,
  MAX_HISTORY_TOOL_CALL_ID_BYTES,
  MAX_HISTORY_TOOL_NAME_BYTES,
  MAX_HISTORY_TOOL_RESULT_BYTES,
  sanitizeHistoryText,
} from "./acp-history-bounds.ts";

export interface PersistableAcpToolCall {
  toolCallId: string;
  toolName: string;
  toolArguments: string;
  toolResult: string;
  toolIsError: boolean;
}

/**
 * An ACP tool call Workbench could not record in full. It keeps the safe
 * fields that passed every check and one fixed reason code. A `partial` call
 * also keeps its checked input and, when present, its checked output (cut to
 * the bound with a marker when oversized). A `rejected` call keeps no raw value.
 */
export interface AcpToolCallGap {
  outcome: "partial" | "rejected";
  reason: AcpToolEvidenceReason;
  toolCallId?: string;
  toolName?: string;
  title?: string;
  kind?: string;
  status?: AcpToolCallStatus;
  input?: unknown;
  toolResult?: string;
}

export type PreparedAcpToolCall =
  | ({ outcome: "recorded" } & PersistableAcpToolCall)
  | AcpToolCallGap;

export interface PreparedAcpToolEvidence {
  status: "complete" | "partial" | "unavailable";
  observedCalls: number;
  /**
   * One entry per distinct usable call id, plus at most one entry for all
   * updates that carried no usable id, in the order each first appeared.
   */
  calls: PreparedAcpToolCall[];
}

/** Display bound for a not-recorded call's title; the title is a label. */
const MAX_ACP_TOOL_GAP_TITLE_BYTES = 1_024;
const MAX_ACP_TOOL_GAP_KIND_BYTES = 128;

function prepareAcpToolCall(call: AcpToolCallEvidence): PreparedAcpToolCall {
  const problems = new Set<AcpToolEvidenceReason>(call.problems);
  const metadata = (
    value: string | undefined,
    maxBytes: number,
    field: string,
  ): string | undefined => {
    if (value === undefined) return undefined;
    if (historyContainsSecretShape(value)) {
      problems.add("credential_shaped");
      return undefined;
    }
    try {
      const bounded = boundedHistoryMetadata(value, maxBytes, field);
      // Sanitizing must not change an identity: `call-a` and a control-
      // character variant of it are distinct calls and must stay distinct.
      if (bounded !== value) {
        problems.add("malformed");
        return undefined;
      }
      return bounded;
    } catch {
      problems.add("malformed");
      return undefined;
    }
  };
  const label = (
    value: string | undefined,
    maxBytes: number,
  ): string | undefined => {
    if (value === undefined) return undefined;
    if (historyContainsSecretShape(value)) {
      problems.add("credential_shaped");
      return undefined;
    }
    return sanitizeHistoryText(clipToUtf8Bytes(value, maxBytes) ?? value);
  };

  const toolCallId = metadata(
    call.toolCallId,
    MAX_HISTORY_TOOL_CALL_ID_BYTES,
    "tool call id",
  );
  if (toolCallId === undefined) problems.add("malformed");
  const sourceName = call.name ?? call.kind;
  let toolName = metadata(
    sourceName === undefined ? undefined : `acp.${sourceName}`,
    MAX_HISTORY_TOOL_NAME_BYTES,
    "tool name",
  );
  if (toolName === ACP_TOOL_HISTORY_UNAVAILABLE_NAME) toolName = undefined;
  if (toolName === undefined) problems.add("malformed");
  const title = label(call.title, MAX_ACP_TOOL_GAP_TITLE_BYTES);
  const kind = label(call.kind, MAX_ACP_TOOL_GAP_KIND_BYTES);

  let input: unknown;
  let toolArguments: string | undefined;
  if (call.rawInputJson !== undefined) {
    try {
      input = JSON.parse(call.rawInputJson) as unknown;
      toolArguments = boundedHistoryArguments({
        ...(call.title === undefined ? {} : { title: call.title }),
        ...(call.kind === undefined ? {} : { kind: call.kind }),
        input,
      });
      if (historyContainsSecretShape(toolArguments)) {
        problems.add("credential_shaped");
        toolArguments = undefined;
      }
    } catch (error) {
      problems.add(
        error instanceof HistoryLimitError ? "oversized_input" : "malformed",
      );
      toolArguments = undefined;
    }
  }
  let toolResult: string | undefined;
  if (call.rawOutputJson !== undefined) {
    try {
      toolResult = boundedHistoryField(
        call.rawOutputJson,
        MAX_HISTORY_TOOL_RESULT_BYTES,
        "tool result",
      );
      if (historyContainsSecretShape(toolResult)) {
        problems.add("credential_shaped");
        toolResult = undefined;
      }
    } catch {
      problems.add("oversized_output");
    }
  }

  const reason = ACP_TOOL_EVIDENCE_REASONS.find((code) => problems.has(code));
  if (
    reason === undefined && toolCallId !== undefined &&
    toolName !== undefined && toolArguments !== undefined &&
    toolResult !== undefined &&
    (call.status === "completed" || call.status === "failed")
  ) {
    return {
      outcome: "recorded",
      toolCallId,
      toolName,
      toolArguments,
      toolResult,
      toolIsError: call.status === "failed",
    };
  }
  const gapReason = reason ?? "malformed";
  const rejected = ACP_TOOL_EVIDENCE_REJECTING_REASONS.has(gapReason);
  return {
    outcome: rejected ? "rejected" : "partial",
    reason: gapReason,
    ...(toolCallId === undefined ? {} : { toolCallId }),
    ...(toolName === undefined ? {} : { toolName }),
    ...(title === undefined ? {} : { title }),
    ...(kind === undefined ? {} : { kind }),
    ...(call.status === undefined ? {} : { status: call.status }),
    ...(rejected || toolArguments === undefined ? {} : { input }),
    ...(rejected || toolResult === undefined ? {} : { toolResult }),
  };
}

/**
 * Convert ACP's bounded in-memory snapshots into the exact fields the durable
 * event schema can replay, one call at a time. A call that fails a rule is
 * recorded as partial or rejected with a fixed reason; it never stops the
 * other calls in the turn from being recorded.
 */
export function prepareAcpToolEvidence(
  evidence: AcpToolEvidence | undefined,
): PreparedAcpToolEvidence {
  if (evidence === undefined) {
    // Dependency-injected test runners predate the producer field. Production
    // ACP sessions always return it.
    return { status: "complete", observedCalls: 0, calls: [] };
  }
  if (evidence.status === "unavailable") {
    return {
      status: "unavailable",
      observedCalls: evidence.observedCalls,
      calls: [],
    };
  }
  const calls = evidence.calls.map(prepareAcpToolCall);
  return {
    status: calls.every((call) => call.outcome === "recorded")
      ? "complete"
      : "partial",
    observedCalls: calls.length,
    calls,
  };
}

/** Counts by outcome and reason, as the turn result and receipt report them. */
export function summarizeAcpToolEvidence(
  evidence: PreparedAcpToolEvidence,
): ExternalAgentWorkbenchRuntimeResult["runner"]["toolEvidence"] {
  const partialReasons: AcpToolEvidenceReasonCounts = {};
  const rejectedReasons: AcpToolEvidenceReasonCounts = {};
  let recordedCalls = 0;
  for (const call of evidence.calls) {
    if (call.outcome === "recorded") {
      recordedCalls += 1;
      continue;
    }
    const counts = call.outcome === "partial" ? partialReasons : rejectedReasons;
    counts[call.reason] = (counts[call.reason] ?? 0) + 1;
  }
  const total = (counts: AcpToolEvidenceReasonCounts) =>
    Object.values(counts).reduce((sum, count) => sum + (count ?? 0), 0);
  return {
    status: evidence.status,
    observedCalls: evidence.observedCalls,
    recordedCalls,
    partialCalls: total(partialReasons),
    rejectedCalls: total(rejectedReasons),
    partialReasons,
    rejectedReasons,
  };
}

function formatReasonCounts(counts: AcpToolEvidenceReasonCounts): string {
  const present = ACP_TOOL_EVIDENCE_REASONS.filter((code) =>
    (counts[code] ?? 0) > 0
  );
  if (present.length === 0) return "";
  if (present.length === 1) return ` (${present[0]})`;
  return ` (${present.map((code) => `${code} ${counts[code]}`).join(", ")})`;
}

/** The receipt's tool-evidence line: counts by outcome, reasons by code. */
export function formatAcpToolEvidenceLine(
  summary: ExternalAgentWorkbenchRuntimeResult["runner"]["toolEvidence"],
): string {
  if (summary.status === "unavailable") {
    return `ACP tool evidence: unavailable (${summary.observedCalls} observed, none recorded)`;
  }
  return `ACP tool evidence: ${summary.recordedCalls} recorded, ${summary.partialCalls} partial${
    formatReasonCounts(summary.partialReasons)
  }, ${summary.rejectedCalls} rejected${
    formatReasonCounts(summary.rejectedReasons)
  } of ${summary.observedCalls}`;
}

/** The durable, value-checked record a gap-marker event carries for one call. */
export function acpToolGapArguments(gap: AcpToolCallGap): string {
  return JSON.stringify({
    outcome: gap.outcome,
    reason: gap.reason,
    ...(gap.toolCallId === undefined ? {} : { toolCallId: gap.toolCallId }),
    ...(gap.toolName === undefined ? {} : { toolName: gap.toolName }),
    ...(gap.title === undefined ? {} : { title: gap.title }),
    ...(gap.kind === undefined ? {} : { kind: gap.kind }),
    ...(gap.status === undefined ? {} : { status: gap.status }),
    ...(gap.input === undefined ? {} : { input: gap.input }),
  });
}
