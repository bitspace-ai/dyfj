/** The per-turn receipt line printed to stderr after a turn. */

import { formatHistoryOmissionSummary } from "../../contract/mod.ts";
import type { TurnResult } from "../turn-client.ts";

function formatUsdShort(usd: number): string {
  return usd > 0 ? `$${usd.toFixed(4)}` : "$0";
}

function formatTokenCount(count: number): string {
  return new Intl.NumberFormat("en-US").format(count);
}

/**
 * The per-turn receipt line. `sessionTotalUsd` (the REPL's running sum of
 * per-turn costs) adds a `session $…` figure so spend is visible as it
 * accumulates, not just per turn; one-shot exec passes none. Reasoning tokens
 * appear only when the provider reported some — most report none.
 */
export function formatReceipt(
  result: TurnResult,
  color: boolean,
  sessionTotalUsd?: number,
): string {
  const dim = (s: string) => (color ? `\x1b[2m${s}\x1b[0m` : s);
  if ("runner" in result) {
    const usage = result.runner.usage === undefined
      ? ""
      : ` · ${formatTokenCount(result.runner.usage.input)}→${
        formatTokenCount(result.runner.usage.output)
      } tok` +
        ((result.runner.usage.reasoning ?? 0) > 0
          ? ` (+${formatTokenCount(result.runner.usage.reasoning!)} reasoning)`
          : "");
    const context = result.runner.contextWindow === undefined
      ? ""
      : ` · ctx ${formatTokenCount(result.runner.contextWindow.used)}/${
        formatTokenCount(result.runner.contextWindow.size)
      }`;
    const reportedCost = result.runner.sessionCost;
    const cost = reportedCost !== undefined
      ? `session cost ${
        reportedCost.currency === "USD"
          ? formatUsdShort(reportedCost.amount)
          : `${reportedCost.amount} ${reportedCost.currency}`
      }`
      : result.runner.costBasis === "local_free"
      ? "$0"
      : result.runner.costBasis === "subscription_quota"
      ? "subscription quota (USD not reported)"
      : result.runner.costBasis === "metered_usd"
      ? "USD not reported"
      : "cost unknown";
    const continuity = result.runner.continuity;
    const continuityEvidence = continuity === undefined
      ? "continuity unestablished"
      : `continuity ${continuity.state}${
        continuity.state === "reconstructed"
          ? ` ${continuity.priorMessagesProjected ?? 0}msg/${
            continuity.toolExchangesProjected ?? 0
          }tool`
          : ""
      }`;
    const nativeSession = continuity === undefined
      ? "native session unverified"
      : continuity.state === "new"
      ? "native session new"
      : continuity.state === "warm-reused" ||
          continuity.state === "durably-resumed"
      ? "native session reused"
      : "native session replaced";
    const toolEvidence = result.runner.toolEvidence;
    const tools = toolEvidence === undefined
      ? "ACP tools unreported"
      : toolEvidence.status === "unavailable"
      ? `ACP tools unavailable (${toolEvidence.observedCalls} observed)`
      : `ACP tools ${toolEvidence.recordedCalls}/${toolEvidence.observedCalls} recorded`;
    const history = result.historyOmission === undefined
      ? ""
      : ` · ${formatHistoryOmissionSummary(result.historyOmission)}`;
    return dim(
      `— ${result.runner.profile} · ${result.runner.protocol}${
        result.runner.protocolVersion === undefined
          ? " (not negotiated)"
          : ` v${result.runner.protocolVersion}`
      } · ${result.runner.transport} · ${
        result.runner.accessRoute ?? "unverified"
      } · ${cost}${usage}${context} · ${continuityEvidence} · ${nativeSession} · ${tools}${history} · ${result.runner.elapsedMs}ms · ${result.route.reason}`,
    );
  }
  const cost = formatUsdShort(result.cost.totalUsd);
  const session = sessionTotalUsd !== undefined
    ? ` · session ${formatUsdShort(sessionTotalUsd)}`
    : "";
  const reasoning = (result.tokens.reasoning ?? 0) > 0
    ? ` (+${result.tokens.reasoning} reasoning)`
    : "";
  const tokens = `${formatTokenCount(result.tokens.input)}→${
    formatTokenCount(result.tokens.output)
  } tok${reasoning}`;
  const toolSteps =
    `tools ${result.agent.toolStepsUsed}/${result.agent.maxToolSteps}` +
    (result.agent.limitReached ? " (limit reached)" : "");
  const history = result.historyOmission === undefined
    ? ""
    : ` · ${formatHistoryOmissionSummary(result.historyOmission)}`;
  return dim(
    `— ${result.model.displayName} · ${cost}${session} · ${tokens} · ${toolSteps}${history} · ${result.route.reason}`,
  );
}
