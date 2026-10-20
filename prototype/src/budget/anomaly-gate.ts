// ── Runaway anomaly gate ──────────────────────────────────────────────────────
//
// The runaway hard stop in the cost posture. The envelopes (envelope-gate.ts)
// are soft by design: estimate-based and confirmable. The anomaly gate closes
// two blind spots, both checked against ACTUAL recorded spend
// (BudgetTracker.record), never pre-call estimates:
//
//   - Turn accumulation: the agent loop can make many calls in one turn, each
//     under the per-call estimate, while the turn's real spend piles up.
//     Halt before the next call once the turn's actual spend exceeds
//     turnMultiple × the per-call limit.
//   - Scope hard-multiple: a confirmed envelope overrun raises the envelope,
//     so spend can still grow without bound. Halt once actual session/daily
//     spend exceeds scopeMultiple × the envelope.
//
// An approval raises the tripped trigger's halt to APPROVAL_HALT_MULTIPLE (2×)
// the actual spend at approval (BIT-715). Each trigger keeps its own raised
// halt for its scope: the turn halt lasts the turn; the session and daily halts
// are stored in the scope store (confirmations.ts) and last the session and
// the local day. Spend that passes the raised halt prompts again with the
// next level. Non-interactive callers fail closed. Statistical
// trailing-pattern detection is deferred until the receipt corpus can support
// it; this gate claims only what it does.

import { sanitizeBoundaryText } from "../kernel/mod.ts";
import { DomainError, MAX_REASON_FIELD_BYTES } from "../contract/mod.ts";
import type { BudgetCeilingConfirmations } from "./confirmations.ts";
import type { BudgetCeilingVerdict } from "./envelope-gate.ts";
import type { AnomalyCheck, AnomalyTrigger } from "./tracker.ts";

/**
 * An approval raises the tripped trigger's halt to this multiple of the
 * actual spend at approval (BIT-715).
 */
const APPROVAL_HALT_MULTIPLE = 2;

/** Structured warn payload for a runaway-anomaly halt (telemetry-safe). */
export interface RunawayAnomalyWarning {
  kind: "runaway_anomaly";
  trigger: AnomalyTrigger;
  /** Actual spend in the triggering scope. */
  spentUsd: number;
  /** The hard-stop threshold that spend crossed. */
  haltUsd: number;
  /** The halt this trigger is raised to if the operator approves: 2× spentUsd. */
  raisesHaltToUsd: number;
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
    raisesHaltToUsd: spentUsd * APPROVAL_HALT_MULTIPLE,
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
  const scopeName = warning.trigger === "daily_scope"
    ? "daily halt, for today"
    : warning.trigger === "session_scope"
    ? "session halt, for this session"
    : "turn halt, for this turn";
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
    `Approving raises the ${scopeName} to $${
      warning.raisesHaltToUsd.toFixed(6)
    } (${APPROVAL_HALT_MULTIPLE}× the spend at approval).`,
    "Spend past that halt prompts again.",
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
    raisesHaltToUsd: warning.raisesHaltToUsd,
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
  public readonly trigger: AnomalyTrigger;
  public readonly spentUsd: number;
  public readonly haltUsd: number;
  public readonly declined: boolean;
  constructor(
    trigger: AnomalyTrigger,
    spentUsd: number,
    haltUsd: number,
    declined: boolean = false,
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
    this.trigger = trigger;
    this.spentUsd = spentUsd;
    this.haltUsd = haltUsd;
    this.declined = declined;
    this.name = "RunawayAnomalyHaltError";
  }
}

/**
 * Enforce the runaway-anomaly hard stop: a tripped check prompts when a
 * handler is supplied and fails closed otherwise. This function records
 * nothing; the turn-scoped gate (createRunawayAnomalyGate) stores the raised
 * halt after an approval.
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
 * The raised halts that scope-persistent approvals keep. The session and daily
 * halts live in the scope store (the same object the ceiling gate uses); the
 * turn halt is local to one gate instance, so it lasts one turn.
 */
export type AnomalyScopeHalts = Pick<
  BudgetCeilingConfirmations,
  "anomaly_session_halt" | "anomaly_daily_halt"
>;

/** The check with each halt replaced by its raised level, where one exists. */
function withRaisedHalts(
  check: AnomalyCheck,
  turnHaltUsd: number | undefined,
  scoped: AnomalyScopeHalts,
): AnomalyCheck {
  return {
    ...check,
    turnHaltUsd: turnHaltUsd ?? check.turnHaltUsd,
    sessionHaltUsd: scoped.anomaly_session_halt ?? check.sessionHaltUsd,
    dailyHaltUsd: scoped.anomaly_daily_halt ?? check.dailyHaltUsd,
  };
}

/** The outermost trigger whose actual spend exceeds its (raised) halt. */
function outermostTrip(check: AnomalyCheck): AnomalyTrigger | undefined {
  return check.dailySpentUsd > check.dailyHaltUsd
    ? "daily_scope"
    : check.sessionSpentUsd > check.sessionHaltUsd
    ? "session_scope"
    : check.turnSpentUsd > check.turnHaltUsd
    ? "turn_spend"
    : undefined;
}

/**
 * Turn-scoped wrapper over ensureAnomalyAllowed (BIT-715). Each trigger is
 * checked against its raised halt. An approval at spend S raises that trigger's
 * halt to 2S, so spend up to 2S does not prompt again; spend past 2S prompts
 * with the next level. The turn halt lasts this gate instance (one turn). The
 * session and daily halts are written to `scopeHalts`, which the caller
 * passes from the scope store, so they last the session and the local day.
 * Non-interactive callers fail closed, as before.
 */
export function createRunawayAnomalyGate(
  confirm?: ConfirmRunawayAnomaly,
  scopeHalts: AnomalyScopeHalts = {},
): RunawayAnomalyGate {
  let turnHaltUsd: number | undefined;
  return {
    async ensureAllowed(check: AnomalyCheck): Promise<void> {
      if (!check.halted) return;
      const effective = withRaisedHalts(check, turnHaltUsd, scopeHalts);
      const trigger = outermostTrip(effective);
      if (trigger === undefined) return;
      const spent = trigger === "daily_scope"
        ? effective.dailySpentUsd
        : trigger === "session_scope"
        ? effective.sessionSpentUsd
        : effective.turnSpentUsd;
      await ensureAnomalyAllowed({ ...effective, trigger }, confirm);
      // Approved: raise this trigger's halt to APPROVAL_HALT_MULTIPLE × spend.
      // Only reached past the halt in force, so the level never drops.
      const raised = spent * APPROVAL_HALT_MULTIPLE;
      if (trigger === "turn_spend") {
        turnHaltUsd = raised;
      } else if (trigger === "session_scope") {
        scopeHalts.anomaly_session_halt = raised;
      } else {
        scopeHalts.anomaly_daily_halt = raised;
      }
    },
  };
}
