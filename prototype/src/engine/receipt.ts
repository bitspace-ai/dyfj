/**
 * Turn receipts and the budget tally: the operator-facing summary lines a
 * native turn prints and persists. Pure formatting, no I/O.
 */

import type { WorkbenchCallTimings } from "../providers/mod.ts";
import type {
  AskContextProfile,
  PackedContextSummary,
} from "../context/mod.ts";
import type { BudgetTallyMode } from "../config/mod.ts";
import {
  formatHistoryOmissionSummary,
  type HistoryOmissionReceipt,
} from "../contract/mod.ts";
import { formatMoney } from "./route.ts";
import type { WorkbenchValidationSummary } from "./runtime-types.ts";

export interface WorkbenchReceiptInput {
  sessionId: string;
  traceId: string;
  modelName: string;
  modelSlug: string;
  provider?: string;
  api?: string;
  tier: 0 | 1 | 2;
  routingReason: string;
  totalCostUsd: number;
  totalTokensInput: number;
  totalTokensOutput: number;
  totalCacheReadTokens?: number;
  totalCacheWriteTokens?: number;
  /** Reported or abort-estimated reasoning/thinking tokens (else 0). */
  totalReasoningTokens?: number;
  totalCalls: number;
  contextBudget?: PackedContextSummary;
  contextProfile?: AskContextProfile;
  timings?: WorkbenchCallTimings;
  contextSources?: string[];
  paidInferenceUsed?: boolean;
  estimatedCostUsd?: number;
  workletId?: string;
  totalElapsedMs?: number;
  validation?: WorkbenchValidationSummary;
  agent: {
    toolStepsUsed: number;
    maxToolSteps: number;
    limitReached: boolean;
  };
  /**
   * Best-effort event writes that failed this session. Zero renders nothing;
   * any other value renders a warning line — an audit-log gap must be
   * visible on the receipt, not discoverable only by inspecting the event
   * log.
   */
  skippedEventWrites?: number;
  historyOmission?: HistoryOmissionReceipt;
}

export interface BudgetTallyInput {
  turn: {
    tokensInput: number;
    tokensOutput: number;
    costUsd: number;
    tier: 0 | 1 | 2;
  };
  session: {
    totalCostUsd: number;
    totalTokensInput: number;
    totalTokensOutput: number;
    paidCalls: number;
    sessionLimitUsd: number;
  };
}

export function buildWorkbenchReceipt(input: WorkbenchReceiptInput): string {
  const lines = [
    "Workbench receipt",
    `Session: ${input.sessionId}`,
    `Trace:   ${input.traceId}`,
  ];
  if (input.workletId) {
    lines.push(`Worklet: ${input.workletId}`);
  }
  if (input.provider || input.api) {
    lines.push(
      `Provider: ${input.provider ?? "unknown"} / ${input.api ?? "unknown"}`,
    );
  }
  lines.push(
    `Model:   ${input.modelName} (${input.modelSlug}, tier ${input.tier})`,
    `Route:   ${input.routingReason}`,
    `Paid inference used: ${input.paidInferenceUsed ? "yes" : "no"}`,
    `Estimated cost: ${formatMoney(input.estimatedCostUsd ?? 0)}`,
    `Actual cost:    ${formatMoney(input.totalCostUsd)}`,
    `Tokens:  ${input.totalTokensInput} in, ${input.totalTokensOutput} out` +
      ((input.totalReasoningTokens ?? 0) > 0
        ? `, ${input.totalReasoningTokens} reasoning`
        : ""),
    `Cache:   ${input.totalCacheReadTokens ?? 0} read, ${
      input.totalCacheWriteTokens ?? 0
    } written`,
    `Calls:   ${input.totalCalls}`,
    `Tool steps: ${input.agent.toolStepsUsed}/${input.agent.maxToolSteps}` +
      (input.agent.limitReached ? " (limit reached)" : ""),
  );
  if ((input.skippedEventWrites ?? 0) > 0) {
    lines.push(
      `WARNING: ${input.skippedEventWrites} event write(s) failed — ` +
        `the session's audit log has gaps`,
    );
  }
  if (input.historyOmission !== undefined) {
    lines.push(formatHistoryOmissionSummary(input.historyOmission));
  }
  if (input.totalElapsedMs !== undefined) {
    lines.push(`Total elapsed: ${input.totalElapsedMs}ms`);
  }
  if (input.validation) {
    lines.push(`Validation: ${input.validation.ok ? "passed" : "failed"}`);
    for (const error of input.validation.errors) {
      lines.push(`- ${error}`);
    }
  }
  if (input.timings) {
    lines.push(formatTimingLine(input.timings));
  }
  if (input.contextBudget) {
    if (input.contextProfile) {
      lines.push(`Context profile: ${input.contextProfile}`);
    }
    lines.push(formatContextBudgetLine(input.contextBudget));
  }
  if (input.contextSources && input.contextSources.length > 0) {
    lines.push("Context sources:");
    for (const source of input.contextSources) {
      lines.push(`- ${source}`);
    }
  }
  return lines.join("\n");
}

export function formatTimingLine(timings: WorkbenchCallTimings): string {
  const parts = [
    `headers ${timings.responseHeadersMs}ms`,
  ];
  if (timings.timeToFirstTokenMs !== undefined) {
    parts.push(`TTFT ${timings.timeToFirstTokenMs}ms`);
  }
  if (timings.generationMs !== undefined) {
    parts.push(`generation ${timings.generationMs}ms`);
  }
  if (timings.timePerOutputTokenMs !== undefined) {
    parts.push(`TPOT ${timings.timePerOutputTokenMs}ms/token`);
  }
  parts.push(`total ${timings.totalMs}ms`);
  return `Timings: ${parts.join(", ")}`;
}

export function formatContextBudgetLine(budget: PackedContextSummary): string {
  return "Context budget: " +
    `${budget.usedTokens}/${budget.totalTokens} tokens; ` +
    `system ${budget.byBucket.system.usedTokens}/${budget.byBucket.system.limitTokens}, ` +
    `active ${budget.byBucket.active_repo.usedTokens}/${budget.byBucket.active_repo.limitTokens}, ` +
    `memory ${budget.byBucket.derived_memory.usedTokens}/${budget.byBucket.derived_memory.limitTokens}, ` +
    `headroom ${budget.headroomTokens}`;
}

export function shouldPrintBudgetTally(
  mode: BudgetTallyMode,
  session: { paidCalls: number },
): boolean {
  if (mode === "off") return false;
  if (mode === "on") return true;
  return session.paidCalls > 0;
}

export function buildBudgetTallyLine(input: BudgetTallyInput): string {
  const percentUsed = input.session.sessionLimitUsd > 0
    ? (input.session.totalCostUsd / input.session.sessionLimitUsd) * 100
    : 0;
  return [
    "Budget tally:",
    `${
      formatMoney(input.turn.costUsd)
    } this turn (${input.turn.tokensInput} in, ${input.turn.tokensOutput} out)`,
    "·",
    `${formatMoney(input.session.totalCostUsd)} session ` +
    `(${input.session.totalTokensInput} in, ${input.session.totalTokensOutput} out, ` +
    `${percentUsed.toFixed(1)}% of ${
      formatMoney(input.session.sessionLimitUsd)
    })`,
  ].join(" ");
}
