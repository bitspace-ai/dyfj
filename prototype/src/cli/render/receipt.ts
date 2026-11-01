/** The per-turn receipt line printed to stderr after a turn. */

import {
  formatAutoApprovals,
  formatHistoryOmissionSummary,
} from "../../contract/mod.ts";
import type { TurnStepUsage } from "../../contract/mod.ts";
import type { TurnResult } from "../turn-client.ts";

function formatUsdShort(usd: number): string {
  return usd > 0 ? `$${usd.toFixed(4)}` : "$0";
}

function formatTokenCount(count: number): string {
  return new Intl.NumberFormat("en-US").format(count);
}

/**
 * The per-turn receipt line. In a REPL, which passes `replTotalUsd` (its
 * running sum of per-turn costs), the line adds the session's spend so it is
 * visible as it accumulates: the runtime's `cost.sessionUsd` when sent,
 * otherwise `repl total $…`. One-shot exec passes none. Reasoning tokens
 * appear only when the provider reported some — most report none.
 */
export function formatReceipt(
  result: TurnResult,
  color: boolean,
  replTotalUsd?: number,
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
      `— ${result.runner.modelSlug ?? result.runner.profile} · ${result.runner.protocol}${
        result.runner.protocolVersion === undefined
          ? " (not negotiated)"
          : ` v${result.runner.protocolVersion}`
      } · ${result.runner.transport} · ${
        result.runner.accessRoute ?? "unverified"
      } · ${cost}${usage}${context} · ${continuityEvidence} · ${nativeSession} · ${tools}${history} · ${result.runner.elapsedMs}ms · ${result.route.reason}`,
    );
  }
  // A catalog estimate is marked `~`; a billed cost, a free turn and a
  // runtime that reports no basis are not.
  const cost = (result.cost.basis === "catalog_estimate" &&
      result.cost.totalUsd > 0
    ? "~"
    : "") + formatUsdShort(result.cost.totalUsd);
  // In a REPL: the runtime's session figure, the one its spending envelope
  // checks, which counts turns this REPL never saw complete. A runtime that
  // sends none gets this REPL's own sum, labelled as such.
  const runtimeSession = result.cost.sessionUsd;
  const session = replTotalUsd === undefined
    ? ""
    : typeof runtimeSession === "number" && Number.isFinite(runtimeSession)
    ? ` · session ${formatUsdShort(runtimeSession)}`
    : ` · repl total ${formatUsdShort(replTotalUsd)}`;
  const reasoning = (result.tokens.reasoning ?? 0) > 0
    ? ` (+${result.tokens.reasoning} reasoning)`
    : "";
  // `input` excludes cache traffic, so the cached share is shown beside it
  // whenever a provider reported any.
  const { cacheRead, cacheWrite } = result.tokens;
  const cache = cacheRead > 0 || cacheWrite > 0
    ? ` · cache ${formatTokenCount(cacheRead)} read${
      cacheWrite > 0 ? `, ${formatTokenCount(cacheWrite)} write` : ""
    } · cached ${
      cachedPercent(result.tokens.input, cacheRead, cacheWrite)
    }%`
    : "";
  const tokens = `${formatTokenCount(result.tokens.input)}→${
    formatTokenCount(result.tokens.output)
  } tok${reasoning}${cache}`;
  const autoApproved = formatAutoApprovals(result.agent.autoApprovals);
  const toolSteps =
    `tools ${result.agent.toolStepsUsed}/${result.agent.maxToolSteps}` +
    (result.agent.limitReached
      ? result.agent.handoff === "model"
        ? " (limit reached · handoff)"
        : result.agent.handoff === "notice"
        ? " (limit reached · handoff failed)"
        : " (limit reached)"
      : "") +
    (autoApproved === undefined ? "" : ` · ${autoApproved}`);
  const history = result.historyOmission === undefined
    ? ""
    : ` · ${formatHistoryOmissionSummary(result.historyOmission)}`;
  return dim(
    `— ${result.model.displayName} · ${cost}${session} · ${tokens} · ${toolSteps}${history} · ${result.route.reason}`,
  );
}

/**
 * The one-line notice for a turn that ended at the output cap with an empty
 * reply — a reasoning model spent its whole output budget on reasoning.
 * Returns `undefined` when there is nothing to say.
 */
export function lengthStopEmptyNotice(
  result: TurnResult,
): string | undefined {
  if (result.stopReason !== "length" || result.text.length > 0) {
    return undefined;
  }
  return "turn stopped at the output limit";
}

/** Write `lengthStopEmptyNotice` for `result`, when it has one. */
export function writeLengthStopNotice(
  result: TurnResult,
  write: (line: string) => void,
): void {
  const notice = lengthStopEmptyNotice(result);
  if (notice !== undefined) write(notice);
}

/** The share of the turn's input served from cache, in whole percent. */
function cachedPercent(
  input: number,
  cacheRead: number,
  cacheWrite: number,
): number {
  const prompt = input + cacheRead + cacheWrite;
  return prompt > 0 ? Math.round((cacheRead / prompt) * 100) : 0;
}

/**
 * `/receipt steps`: one line per recorded agent-loop provider call of the
 * last turn, in call order. `in` excludes cache traffic, as on the receipt line.
 * The line ends with the upstream that served the call, when the provider
 * named one — two calls of one turn can be served by different upstreams, and
 * a prompt cache belongs to one of them. The Rust REPL prints the same lines
 * (`core/dyfj-repl/src/receipt.rs`).
 */
export function formatStepLines(steps: readonly TurnStepUsage[]): string[] {
  return steps.map((step) =>
    `  #${step.order} ${step.purpose} · ${formatTokenCount(step.input)} in · ${
      formatTokenCount(step.cacheRead)
    } read · ${formatTokenCount(step.cacheWrite)} write · ${
      formatTokenCount(step.output)
    } out · ${formatUsdShort(step.costUsd)}${
      step.upstream === undefined ? "" : ` · ${step.upstream}`
    }`
  );
}
