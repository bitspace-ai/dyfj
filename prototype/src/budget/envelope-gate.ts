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
  return {
    kind: "budget_ceiling",
    reason,
    crossedScopes: crossedScopes && crossedScopes.length > 0
      ? crossedScopes
      : [reason],
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
  return [
    "Budget ceiling warning",
    `Reason:          ${scopes.map(label).join(" + ")}`,
    `Approving raises: ${scopes.map(label).join(", ")}`,
    `Estimated cost:  $${warning.estimatedCostUsd.toFixed(6)}`,
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
  // directly by workbench.ts's log branch, not just via .message) can carry
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
  // operator was not shown.
  if (approvedScopes.includes("per_call_limit")) {
    confirmed.per_call_limit = Math.max(
      confirmed.per_call_limit ?? 0,
      preCall.estimatedCost,
    );
  }
  // Session and daily confirmations cover the whole scope period; recording
  // the projected level instead re-prompted on every later agent-loop call
  // as the projection grew — per-call ceremony under another name.
  if (approvedScopes.includes("session_limit")) {
    confirmed.session_limit = Number.POSITIVE_INFINITY;
  }
  if (approvedScopes.includes("daily_limit")) {
    confirmed.daily_limit = Number.POSITIVE_INFINITY;
  }
}

export interface TurnBudgetCeilingGate {
  /**
   * Enforce the per-call/session/daily ceilings; a crossed, unconfirmed scope
   * prompts once and the confirmation covers that scope per the injected
   * confirmation store's lifetime.
   */
  ensureAllowed(preCall: PreCallCheck): Promise<void>;
}

/**
 * Wrap budget-ceiling confirmation over the per-call, session, and daily
 * scopes. One prompt names every newly-crossed scope and the approval covers
 * exactly those scopes. With the default fresh store, coverage lasts the
 * turn; pass `confirmationStore.for(sessionId)` (a `CeilingConfirmationStore`)
 * to persist confirmations for their scope periods — the rest of the session for
 * per-call/session marks, the rest of the local day for the daily mark.
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
  constructor(
    public readonly reason: BudgetLimitReason,
    public readonly estimatedCost: number,
    public readonly limitUsd: number,
    /** Spend so far in the scope named by `reason` (session/day so far; for per-call this is the call estimate). */
    public readonly scopeCostSoFar: number,
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
    this.name = "BudgetExceededError";
  }
}
