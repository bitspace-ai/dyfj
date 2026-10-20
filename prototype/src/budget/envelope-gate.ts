// Budget envelope gates: the per-call, session, and daily ceilings.
//
// Soft by design: estimate-based and confirmable. Under the limit proceeds
// silently; over the limit warns and requires explicit operator confirmation
// when a handler is supplied, and fails closed without one. The runaway hard
// stop that backs these envelopes lives in anomaly-gate.ts.

import { sanitizeBoundaryText } from "../kernel/mod.ts";
import { DomainError, MAX_REASON_FIELD_BYTES } from "../contract/mod.ts";
import type { BudgetCeilingConfirmations } from "./confirmations.ts";
import type { BudgetLimitReason, PreCallCheck } from "./tracker.ts";

/** Structured warn payload for a budget-ceiling confirmation (telemetry-safe). */
export interface BudgetCeilingWarning {
  kind: "budget_ceiling";
  reason: BudgetLimitReason;
  /**
   * Every scope this approval covers. One confirmation raises exactly these
   * envelopes — never a scope that was not presented: a per-call-framed
   * prompt must not silently raise the session or daily envelope.
   */
  crossedScopes: BudgetLimitReason[];
  /**
   * The limit each presented scope is raised to if the operator approves
   * (BIT-715): per-call to PER_CALL_HEADROOM × the estimate, session to the
   * projected session spend plus one session envelope. Daily has no entry:
   * it is unchanged and covers the local day.
   */
  raisesToUsd: Partial<Record<BudgetLimitReason, number>>;
  estimatedCostUsd: number;
  limitUsd: number;
  sessionCostSoFarUsd: number;
  sessionLimitUsd: number;
  perCallLimitUsd: number;
  dailyCostSoFarUsd: number;
  dailyLimitUsd: number;
  /** Audit basis for an operator-confirmed ceiling overrun; carried in the
   *  warning/approval payload for downstream audit logging — not persisted here. */
  authzBasis: "policy:allow:operator-confirmed-ceiling";
}

export type BudgetCeilingVerdict =
  | { decision: "approve" }
  | { decision: "deny"; reason?: string };

export type ConfirmBudgetCeiling = (
  warning: BudgetCeilingWarning,
) => Promise<BudgetCeilingVerdict>;

/**
 * A per-call approval covers estimates up to this multiple of the estimate
 * the operator was shown (BIT-715). A call past that mark prompts again.
 */
const PER_CALL_HEADROOM = 2;

/**
 * The limit each scope in `scopes` is raised to by approving it. Daily is
 * absent: its mark stays unbounded for the local day.
 */
function approvalRaises(
  preCall: PreCallCheck,
  scopes: BudgetLimitReason[],
): Partial<Record<BudgetLimitReason, number>> {
  const raises: Partial<Record<BudgetLimitReason, number>> = {};
  if (scopes.includes("per_call_limit")) {
    raises.per_call_limit = preCall.estimatedCost * PER_CALL_HEADROOM;
  }
  if (scopes.includes("session_limit")) {
    raises.session_limit = projectedSessionSpend(preCall) +
      preCall.sessionLimitUsd;
  }
  return raises;
}

export function buildBudgetCeilingWarning(
  preCall: PreCallCheck,
  overrideReason?: BudgetLimitReason,
  crossedScopes?: BudgetLimitReason[],
): BudgetCeilingWarning {
  const reason = overrideReason ?? preCall.reason ?? "session_limit";
  const limitUsd = reason === "per_call_limit"
    ? preCall.perCallLimitUsd
    : reason === "daily_limit"
    ? preCall.dailyLimitUsd
    : preCall.sessionLimitUsd;
  const scopes = crossedScopes && crossedScopes.length > 0
    ? crossedScopes
    : [reason];
  return {
    kind: "budget_ceiling",
    reason,
    crossedScopes: scopes,
    raisesToUsd: approvalRaises(preCall, scopes),
    estimatedCostUsd: preCall.estimatedCost,
    limitUsd,
    sessionCostSoFarUsd: preCall.sessionCostSoFar,
    sessionLimitUsd: preCall.sessionLimitUsd,
    perCallLimitUsd: preCall.perCallLimitUsd,
    dailyCostSoFarUsd: preCall.dailyCostSoFar,
    dailyLimitUsd: preCall.dailyLimitUsd,
    authzBasis: "policy:allow:operator-confirmed-ceiling",
  };
}

export function formatBudgetCeilingWarning(
  warning: BudgetCeilingWarning,
): string {
  const label = (scope: BudgetLimitReason): string =>
    scope === "per_call_limit"
      ? "per-call limit"
      : scope === "daily_limit"
      ? "daily limit"
      : "session limit";
  const scopes = warning.crossedScopes.length > 0
    ? warning.crossedScopes
    : [warning.reason];
  const raiseLine = (scope: BudgetLimitReason): string =>
    scope === "per_call_limit"
      ? `  per-call limit  to $${
        (warning.raisesToUsd.per_call_limit ?? 0).toFixed(6)
      } (covers calls up to ${PER_CALL_HEADROOM}x this estimate)`
      : scope === "session_limit"
      ? `  session limit   to $${
        (warning.raisesToUsd.session_limit ?? 0).toFixed(6)
      } (projected spend + $${warning.sessionLimitUsd.toFixed(6)})`
      : "  daily limit     unchanged; covers the rest of the local day";
  return [
    "Budget ceiling warning",
    `Reason:           ${scopes.map(label).join(" + ")}`,
    "Approving raises:",
    ...scopes.map(raiseLine),
    `Estimated cost:   $${warning.estimatedCostUsd.toFixed(6)}`,
    `Limit:           $${warning.limitUsd.toFixed(6)}`,
    `Session spent:   $${warning.sessionCostSoFarUsd.toFixed(6)} / ${
      warning.sessionLimitUsd.toFixed(6)
    }`,
    `Today spent:     $${warning.dailyCostSoFarUsd.toFixed(6)} / ${
      warning.dailyLimitUsd.toFixed(6)
    }`,
    `Projected session: $${
      (warning.sessionCostSoFarUsd + warning.estimatedCostUsd).toFixed(6)
    } / ${warning.sessionLimitUsd.toFixed(6)}`,
    `Projected today: $${
      (warning.dailyCostSoFarUsd + warning.estimatedCostUsd).toFixed(6)
    } / ${warning.dailyLimitUsd.toFixed(6)}`,
    `Per-call limit:  $${warning.perCallLimitUsd.toFixed(6)}`,
  ].join("\n");
}

/** Wire shape for the UDS mid-turn approval channel. */
export function budgetCeilingApprovalRequest(
  warning: BudgetCeilingWarning,
): Record<string, unknown> {
  return {
    kind: warning.kind,
    title: "Budget ceiling",
    reason: warning.reason,
    estimatedCostUsd: warning.estimatedCostUsd,
    limitUsd: warning.limitUsd,
    sessionCostSoFarUsd: warning.sessionCostSoFarUsd,
    sessionLimitUsd: warning.sessionLimitUsd,
    perCallLimitUsd: warning.perCallLimitUsd,
    dailyCostSoFarUsd: warning.dailyCostSoFarUsd,
    dailyLimitUsd: warning.dailyLimitUsd,
    crossedScopes: warning.crossedScopes,
    authzBasis: warning.authzBasis,
    message: formatBudgetCeilingWarning(warning),
  };
}

export class BudgetCeilingDeclinedError extends DomainError {
  readonly reason?: string;
  // DomainError only certifies the MESSAGE this constructor builds — reason
  // itself is an operator/approval-peer-supplied decline comment, not
  // authored by this codebase, so it's capped and control-char-stripped
  // before either the message or the public `.reason` property (read
  // directly by the native runner's log branch, not just via .message) can carry
  // it.
  constructor(reason?: string) {
    const safeReason = reason === undefined
      ? undefined
      : sanitizeBoundaryText(reason, MAX_REASON_FIELD_BYTES);
    super(
      safeReason
        ? `Budget ceiling confirmation declined: ${safeReason}`
        : "Budget ceiling confirmation declined",
    );
    this.reason = safeReason;
    this.name = "BudgetCeilingDeclinedError";
  }
}

/**
 * Enforce a budget ceiling: under the limit proceeds silently; over the limit
 * warns and requires explicit operator confirmation when a handler is supplied.
 * Without a handler (non-interactive / no round-trip), fails closed.
 */
export async function ensureBudgetAllowed(
  preCall: PreCallCheck,
  confirm?: ConfirmBudgetCeiling,
  promptReason?: BudgetLimitReason,
  crossedScopes?: BudgetLimitReason[],
): Promise<void> {
  if (preCall.allowed) return;
  if (!confirm) {
    // Fail closed on the original verdict, not the prompt-only override,
    // with the limit and the so-far figure of the scope that blocked.
    const reason = preCall.reason ?? "session_limit";
    const limit = reason === "per_call_limit"
      ? preCall.perCallLimitUsd
      : reason === "daily_limit"
      ? preCall.dailyLimitUsd
      : preCall.sessionLimitUsd;
    const scopeSoFar = reason === "per_call_limit"
      ? preCall.estimatedCost
      : reason === "daily_limit"
      ? preCall.dailyCostSoFar
      : preCall.sessionCostSoFar;
    throw new BudgetExceededError(
      reason,
      preCall.estimatedCost,
      limit,
      scopeSoFar,
    );
  }
  const warning = buildBudgetCeilingWarning(
    preCall,
    promptReason,
    crossedScopes,
  );
  const verdict = await confirm(warning);
  if (verdict.decision !== "approve") {
    throw new BudgetCeilingDeclinedError(verdict.reason);
  }
}

function crossesPerCallLimit(preCall: PreCallCheck): boolean {
  return preCall.estimatedCost > preCall.perCallLimitUsd;
}

function crossesSessionLimit(preCall: PreCallCheck): boolean {
  return preCall.sessionCostSoFar + preCall.estimatedCost >
    preCall.sessionLimitUsd;
}

function crossesDailyLimit(preCall: PreCallCheck): boolean {
  return preCall.dailyCostSoFar + preCall.estimatedCost >
    preCall.dailyLimitUsd;
}

function projectedSessionSpend(preCall: PreCallCheck): number {
  return preCall.sessionCostSoFar + preCall.estimatedCost;
}

function projectedDailySpend(preCall: PreCallCheck): number {
  return preCall.dailyCostSoFar + preCall.estimatedCost;
}

function ceilingAlreadyConfirmed(
  preCall: PreCallCheck,
  confirmed: BudgetCeilingConfirmations,
): boolean {
  const perCallOk = !crossesPerCallLimit(preCall) ||
    (confirmed.per_call_limit !== undefined &&
      preCall.estimatedCost <= confirmed.per_call_limit);
  const sessionOk = !crossesSessionLimit(preCall) ||
    (confirmed.session_limit !== undefined &&
      projectedSessionSpend(preCall) <= confirmed.session_limit);
  const dailyOk = !crossesDailyLimit(preCall) ||
    (confirmed.daily_limit !== undefined &&
      projectedDailySpend(preCall) <= confirmed.daily_limit);
  return perCallOk && sessionOk && dailyOk;
}

/**
 * Every scope that is newly crossing for this call — crossed, and not already
 * confirmed at or above this projection. Ordered outermost-first (daily,
 * session, per-call): the first entry frames the prompt, and the full list is
 * what one approval raises, so the operator is never shown one scope while
 * another is silently raised.
 */
function newlyExceededScopes(
  preCall: PreCallCheck,
  confirmed: BudgetCeilingConfirmations,
): BudgetLimitReason[] {
  const perCallNew = crossesPerCallLimit(preCall) &&
    (confirmed.per_call_limit === undefined ||
      preCall.estimatedCost > confirmed.per_call_limit);
  const sessionNew = crossesSessionLimit(preCall) &&
    (confirmed.session_limit === undefined ||
      projectedSessionSpend(preCall) > confirmed.session_limit);
  const dailyNew = crossesDailyLimit(preCall) &&
    (confirmed.daily_limit === undefined ||
      projectedDailySpend(preCall) > confirmed.daily_limit);
  return [
    dailyNew ? "daily_limit" : null,
    sessionNew ? "session_limit" : null,
    perCallNew ? "per_call_limit" : null,
  ].filter(Boolean) as BudgetLimitReason[];
}

function recordCeilingConfirmations(
  preCall: PreCallCheck,
  confirmed: BudgetCeilingConfirmations,
  approvedScopes: BudgetLimitReason[],
): void {
  // Raise exactly the scopes the approval presented — never a scope the
  // operator was not shown — and only to the level the prompt stated.
  const raises = approvalRaises(preCall, approvedScopes);
  if (raises.per_call_limit !== undefined) {
    confirmed.per_call_limit = Math.max(
      confirmed.per_call_limit ?? 0,
      raises.per_call_limit,
    );
  }
  // Session raises by one session envelope past the projection (BIT-715), so
  // a long turn re-prompts at each envelope of growth, not never and not at
  // every call. Daily is unchanged: unbounded for the local day, and bounded
  // only by the daily anomaly halt.
  if (raises.session_limit !== undefined) {
    confirmed.session_limit = Math.max(
      confirmed.session_limit ?? 0,
      raises.session_limit,
    );
  }
  if (approvedScopes.includes("daily_limit")) {
    confirmed.daily_limit = Number.POSITIVE_INFINITY;
  }
}

export interface TurnBudgetCeilingGate {
  /**
   * Enforce the per-call/session/daily ceilings; a crossed scope prompts only
   * when its projection passes the level it was last raised to, and the
   * approval raises that scope to the level the prompt stated.
   */
  ensureAllowed(preCall: PreCallCheck): Promise<void>;
}

/**
 * Wrap budget-ceiling confirmation over the per-call, session, and daily
 * scopes. One prompt names every newly-crossed scope and the approval raises
 * exactly those scopes, each to the level the prompt states: per-call to
 * PER_CALL_HEADROOM × the estimate, session to the projection plus one session
 * envelope, daily to unbounded for the day. With the default fresh store the
 * marks last the turn; pass `confirmationStore.for(sessionId)` (a
 * `CeilingConfirmationStore`) to persist them: per-call and session marks for
 * the session, the daily mark for the local day.
 */
export function createTurnBudgetCeilingGate(
  confirm?: ConfirmBudgetCeiling,
  // Scope-persistent marks (CeilingConfirmationStore.for) make a confirmation
  // cover its scope for the scope period; the default fresh object scopes
  // coverage to this gate instance (one turn) for callers and tests.
  confirmed: BudgetCeilingConfirmations = {},
): TurnBudgetCeilingGate {
  return {
    async ensureAllowed(preCall: PreCallCheck): Promise<void> {
      if (preCall.allowed) return;
      if (ceilingAlreadyConfirmed(preCall, confirmed)) return;
      const scopes = newlyExceededScopes(preCall, confirmed);
      // First (outermost) scope frames the prompt; the warning lists them all.
      await ensureBudgetAllowed(preCall, confirm, scopes[0], scopes);
      recordCeilingConfirmations(preCall, confirmed, scopes);
    },
  };
}

// ── Error ─────────────────────────────────────────────────────────────────────

export class BudgetExceededError extends DomainError {
  public readonly reason: BudgetLimitReason;
  public readonly estimatedCost: number;
  public readonly limitUsd: number;
  /** Spend so far in the scope named by `reason` (session/day so far; for per-call this is the call estimate). */
  public readonly scopeCostSoFar: number;
  constructor(
    reason: BudgetLimitReason,
    estimatedCost: number,
    limitUsd: number,
    scopeCostSoFar: number,
  ) {
    super(
      `Budget exceeded [${reason}]: ` +
        `estimated $${estimatedCost.toFixed(6)}, ` +
        `limit $${limitUsd.toFixed(6)}, ` +
        `${
          reason === "daily_limit"
            ? "today's total so far"
            : reason === "per_call_limit"
            ? "call estimate"
            : "session total so far"
        } $${scopeCostSoFar.toFixed(6)}`,
    );
    this.reason = reason;
    this.estimatedCost = estimatedCost;
    this.limitUsd = limitUsd;
    this.scopeCostSoFar = scopeCostSoFar;
    this.name = "BudgetExceededError";
  }
}
