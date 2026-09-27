// ── Runaway anomaly gate ──────────────────────────────────────────────────────
//
// The one HARD stop in the cost posture. The envelopes (envelope-gate.ts) are
// soft by design: estimate-based, confirmable, and a session/daily confirmation
// covers its whole scope period. That leaves two blind spots the anomaly gate closes,
// both checked against ACTUAL recorded spend (BudgetTracker.record), never
// pre-call estimates:
//
//   - Turn accumulation: the agent loop can make many calls in one turn, each
//     under the per-call estimate, while the turn's real spend piles up.
//     Halt before the next call once the turn's actual spend exceeds
//     turnMultiple × the per-call limit.
//   - Scope hard-multiple: a confirmed envelope overrun covers its scope
//     period, so one small confirmation can license unbounded further spend.
//     Halt once actual session/daily spend exceeds scopeMultiple × the
//     envelope, even after a ceiling confirmation.
//
// Halt semantics are deliberately harder than the ceiling gate: an approval
// never raises anything — every anomalous increment re-prompts fresh (no
// scope-period coverage, no high-water marks) — and non-interactive callers
// fail closed. Statistical trailing-pattern detection is deferred until the
// receipt corpus can support it; this gate claims only what it does.

import { sanitizeBoundaryText } from "../kernel/mod.ts";
import { DomainError, MAX_REASON_FIELD_BYTES } from "../contract/mod.ts";
import type { BudgetCeilingVerdict } from "./envelope-gate.ts";
import type { AnomalyCheck, AnomalyTrigger } from "./tracker.ts";

/** Structured warn payload for a runaway-anomaly halt (telemetry-safe). */
export interface RunawayAnomalyWarning {
  kind: "runaway_anomaly";
  trigger: AnomalyTrigger;
  /** Actual spend in the triggering scope. */
  spentUsd: number;
  /** The hard-stop threshold that spend crossed. */
  haltUsd: number;
  turnSpentUsd: number;
  turnHaltUsd: number;
  sessionSpentUsd: number;
  sessionHaltUsd: number;
  dailySpentUsd: number;
  dailyHaltUsd: number;
  turnMultiple: number;
  scopeMultiple: number;
  /** Audit basis for the halt itself. */
  authzBasis: "policy:halt:runaway-anomaly";
  /** Audit basis an operator approval carries; carried in the payload for
   *  downstream audit logging — approvals never persist. */
  approvalAuthzBasis: "policy:allow:operator-confirmed-anomaly";
}

export type ConfirmRunawayAnomaly = (
  warning: RunawayAnomalyWarning,
) => Promise<BudgetCeilingVerdict>;

export function buildRunawayAnomalyWarning(
  check: AnomalyCheck,
): RunawayAnomalyWarning {
  const trigger = check.trigger ?? "turn_spend";
  const [spentUsd, haltUsd] = trigger === "daily_scope"
    ? [check.dailySpentUsd, check.dailyHaltUsd]
    : trigger === "session_scope"
    ? [check.sessionSpentUsd, check.sessionHaltUsd]
    : [check.turnSpentUsd, check.turnHaltUsd];
  return {
    kind: "runaway_anomaly",
    trigger,
    spentUsd,
    haltUsd,
    turnSpentUsd: check.turnSpentUsd,
    turnHaltUsd: check.turnHaltUsd,
    sessionSpentUsd: check.sessionSpentUsd,
    sessionHaltUsd: check.sessionHaltUsd,
    dailySpentUsd: check.dailySpentUsd,
    dailyHaltUsd: check.dailyHaltUsd,
    turnMultiple: check.config.turnMultiple,
    scopeMultiple: check.config.scopeMultiple,
    authzBasis: "policy:halt:runaway-anomaly",
    approvalAuthzBasis: "policy:allow:operator-confirmed-anomaly",
  };
}

export function formatRunawayAnomalyWarning(
  warning: RunawayAnomalyWarning,
): string {
  const label = warning.trigger === "daily_scope"
    ? `today's spend at ${warning.scopeMultiple}× the daily envelope`
    : warning.trigger === "session_scope"
    ? `session spend at ${warning.scopeMultiple}× the session envelope`
    : `turn spend at ${warning.turnMultiple}× the per-call limit`;
  return [
    "Runaway spend anomaly — hard stop",
    `Trigger:        ${label}`,
    `Scope spent:    $${warning.spentUsd.toFixed(6)} (halt at $${
      warning.haltUsd.toFixed(6)
    })`,
    `Turn spent:     $${warning.turnSpentUsd.toFixed(6)} / halt $${
      warning.turnHaltUsd.toFixed(6)
    }`,
    `Session spent:  $${warning.sessionSpentUsd.toFixed(6)} / halt $${
      warning.sessionHaltUsd.toFixed(6)
    }`,
    `Today spent:    $${warning.dailySpentUsd.toFixed(6)} / halt $${
      warning.dailyHaltUsd.toFixed(6)
    }`,
    "Approving allows the next call only; nothing is raised and further",
    "anomalous spend will halt again.",
  ].join("\n");
}

/** Wire shape for the UDS mid-turn approval channel. */
export function runawayAnomalyApprovalRequest(
  warning: RunawayAnomalyWarning,
): Record<string, unknown> {
  return {
    kind: warning.kind,
    title: "Runaway spend anomaly",
    trigger: warning.trigger,
    spentUsd: warning.spentUsd,
    haltUsd: warning.haltUsd,
    turnSpentUsd: warning.turnSpentUsd,
    turnHaltUsd: warning.turnHaltUsd,
    sessionSpentUsd: warning.sessionSpentUsd,
    sessionHaltUsd: warning.sessionHaltUsd,
    dailySpentUsd: warning.dailySpentUsd,
    dailyHaltUsd: warning.dailyHaltUsd,
    authzBasis: warning.authzBasis,
    approvalAuthzBasis: warning.approvalAuthzBasis,
    message: formatRunawayAnomalyWarning(warning),
  };
}

export class RunawayAnomalyHaltError extends DomainError {
  constructor(
    public readonly trigger: AnomalyTrigger,
    public readonly spentUsd: number,
    public readonly haltUsd: number,
    public readonly declined: boolean = false,
    // Approval-peer-supplied decline comment, not authored by this codebase
    // — capped and control-char-stripped before it reaches the message
    // (not stored on the instance, so this is the only sanitizing point).
    declineReason?: string,
  ) {
    const safeDeclineReason = declineReason === undefined
      ? undefined
      : sanitizeBoundaryText(declineReason, MAX_REASON_FIELD_BYTES);
    super(
      declined
        ? `Runaway spend anomaly halt declined [${trigger}]: ` +
          `actual $${spentUsd.toFixed(6)} past halt $${haltUsd.toFixed(6)}` +
          (safeDeclineReason ? ` (${safeDeclineReason})` : "")
        : `Runaway spend anomaly [${trigger}]: ` +
          `actual $${spentUsd.toFixed(6)} past halt $${haltUsd.toFixed(6)}` +
          " (no confirmation channel; failing closed)",
    );
    this.name = "RunawayAnomalyHaltError";
  }
}

/**
 * Enforce the runaway-anomaly hard stop: a tripped check prompts when a
 * handler is supplied and fails closed otherwise. An approval admits the next
 * call only — the caller re-checks before every subsequent call and nothing
 * here records or raises anything.
 */
export async function ensureAnomalyAllowed(
  check: AnomalyCheck,
  confirm?: ConfirmRunawayAnomaly,
): Promise<void> {
  if (!check.halted) return;
  const warning = buildRunawayAnomalyWarning(check);
  if (!confirm) {
    throw new RunawayAnomalyHaltError(
      warning.trigger,
      warning.spentUsd,
      warning.haltUsd,
    );
  }
  const verdict = await confirm(warning);
  if (verdict.decision !== "approve") {
    throw new RunawayAnomalyHaltError(
      warning.trigger,
      warning.spentUsd,
      warning.haltUsd,
      true,
      verdict.decision === "deny" ? verdict.reason : undefined,
    );
  }
}

export interface RunawayAnomalyGate {
  /** Enforce the hard stop for one check; see createRunawayAnomalyGate. */
  ensureAllowed(check: AnomalyCheck): Promise<void>;
}

/**
 * Turn-scoped wrapper over ensureAnomalyAllowed. An approval covers exactly
 * the actual-spend level it was shown — the turn-entry check and the first
 * call's check see identical actuals, and one anomalous state should prompt
 * once, not twice. Any recorded spend after an approval raises the level past
 * what was approved, so every anomalous INCREMENT still re-prompts fresh, and
 * nothing survives the gate instance (one turn): no scope-period coverage,
 * unlike the ceiling gate's persistent store.
 */
export function createRunawayAnomalyGate(
  confirm?: ConfirmRunawayAnomaly,
): RunawayAnomalyGate {
  const approvedLevel: Partial<Record<AnomalyTrigger, number>> = {};
  return {
    async ensureAllowed(check: AnomalyCheck): Promise<void> {
      if (!check.halted || check.trigger === undefined) return;
      const spent = check.trigger === "daily_scope"
        ? check.dailySpentUsd
        : check.trigger === "session_scope"
        ? check.sessionSpentUsd
        : check.turnSpentUsd;
      const prior = approvedLevel[check.trigger];
      if (prior !== undefined && spent <= prior) return;
      await ensureAnomalyAllowed(check, confirm);
      approvedLevel[check.trigger] = spent;
    },
  };
}
