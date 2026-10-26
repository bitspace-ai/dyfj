// The spend check (BIT-785): every spend limit, checked before each paid call.
//
// One check measures five limits against one projection, actual spend so far
// in the limit's scope plus this call's estimate:
//
//   - per call: this call's estimate;
//   - runaway: the turn's spend since its last tool step that made progress;
//   - turn: the turn's spend;
//   - session: the session's spend, its earlier turns included;
//   - day: today's spend across every session.
//
// Under every limit the call proceeds silently. Past one or more, a single
// prompt names every crossed limit with one set of figures, and an approval
// raises exactly those limits, each to the level the prompt states (BIT-715):
// per call to PER_CALL_HEADROOM × the estimate, the turn and runaway limits to
// TURN_APPROVAL_MULTIPLE × the projection, the session and day limits to the
// projection plus one more envelope. A crossed limit prompts again only when
// its projection passes the level it was raised to. Without a handler the
// check fails closed.

import { sanitizeBoundaryText } from "../kernel/mod.ts";
import { DomainError, MAX_REASON_FIELD_BYTES } from "../contract/mod.ts";
import type { BudgetCeilingConfirmations } from "./confirmations.ts";
import type { BudgetLimitReason, PreCallCheck } from "./tracker.ts";

/** Structured warn payload for a spend-check confirmation (telemetry-safe). */
export interface BudgetCeilingWarning {
  kind: "budget_ceiling";
  reason: BudgetLimitReason;
  /**
   * Every limit this approval covers. One confirmation raises exactly these
   * limits — never one that was not presented: a per-call-framed prompt must
   * not silently raise the session or daily limit.
   */
  crossedScopes: BudgetLimitReason[];
  /** The level each presented limit is raised to if the operator approves. */
  raisesToUsd: Partial<Record<BudgetLimitReason, number>>;
  /**
   * The level an earlier approval raised each limit to, where one applies:
   * a crossed limit with an entry here is crossing that level, not the
   * configured one.
   */
  approvedToUsd: Partial<Record<BudgetLimitReason, number>>;
  estimatedCostUsd: number;
  limitUsd: number;
  sessionCostSoFarUsd: number;
  sessionLimitUsd: number;
  perCallLimitUsd: number;
  dailyCostSoFarUsd: number;
  dailyLimitUsd: number;
  turnCostSoFarUsd: number;
  turnLimitUsd: number;
  stallCostSoFarUsd: number;
  runawayStallUsd: number;
  /** Audit basis for an operator-confirmed overrun; carried in the
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
 * A turn or runaway approval raises that limit to this multiple of the
 * projected spend at approval, for the rest of the turn (BIT-715).
 */
const TURN_APPROVAL_MULTIPLE = 2;

/** Outermost first: the first crossed limit frames the prompt. */
const SCOPE_ORDER: BudgetLimitReason[] = [
  "daily_limit",
  "session_limit",
  "turn_limit",
  "runaway_stall",
  "per_call_limit",
];

/** The projection a limit measures for this call. */
function projected(preCall: PreCallCheck, scope: BudgetLimitReason): number {
  switch (scope) {
    case "per_call_limit":
      return preCall.estimatedCost;
    case "runaway_stall":
      return preCall.stallCostSoFar + preCall.estimatedCost;
    case "turn_limit":
      return preCall.turnCostSoFar + preCall.estimatedCost;
    case "session_limit":
      return preCall.sessionCostSoFar + preCall.estimatedCost;
    case "daily_limit":
      return preCall.dailyCostSoFar + preCall.estimatedCost;
  }
}

function limitOf(preCall: PreCallCheck, scope: BudgetLimitReason): number {
  switch (scope) {
    case "per_call_limit":
      return preCall.perCallLimitUsd;
    case "runaway_stall":
      return preCall.runawayStallUsd;
    case "turn_limit":
      return preCall.turnLimitUsd;
    case "session_limit":
      return preCall.sessionLimitUsd;
    case "daily_limit":
      return preCall.dailyLimitUsd;
  }
}

/** The level each scope in `scopes` is raised to by approving it. */
function approvalRaises(
  preCall: PreCallCheck,
  scopes: BudgetLimitReason[],
): Partial<Record<BudgetLimitReason, number>> {
  const raises: Partial<Record<BudgetLimitReason, number>> = {};
  for (const scope of scopes) {
    const p = projected(preCall, scope);
    raises[scope] = scope === "per_call_limit"
      ? p * PER_CALL_HEADROOM
      : scope === "turn_limit" || scope === "runaway_stall"
      ? p * TURN_APPROVAL_MULTIPLE
      : p + limitOf(preCall, scope);
  }
  return raises;
}

export function buildBudgetCeilingWarning(
  preCall: PreCallCheck,
  overrideReason?: BudgetLimitReason,
  crossedScopes?: BudgetLimitReason[],
  approvedToUsd: Partial<Record<BudgetLimitReason, number>> = {},
): BudgetCeilingWarning {
  const reason = overrideReason ?? preCall.reason ?? "session_limit";
  const scopes = crossedScopes && crossedScopes.length > 0
    ? crossedScopes
    : [reason];
  return {
    kind: "budget_ceiling",
    reason,
    crossedScopes: scopes,
    raisesToUsd: approvalRaises(preCall, scopes),
    approvedToUsd,
    estimatedCostUsd: preCall.estimatedCost,
    limitUsd: limitOf(preCall, reason),
    sessionCostSoFarUsd: preCall.sessionCostSoFar,
    sessionLimitUsd: preCall.sessionLimitUsd,
    perCallLimitUsd: preCall.perCallLimitUsd,
    dailyCostSoFarUsd: preCall.dailyCostSoFar,
    dailyLimitUsd: preCall.dailyLimitUsd,
    turnCostSoFarUsd: preCall.turnCostSoFar,
    turnLimitUsd: preCall.turnLimitUsd,
    stallCostSoFarUsd: preCall.stallCostSoFar,
    runawayStallUsd: preCall.runawayStallUsd,
    authzBasis: "policy:allow:operator-confirmed-ceiling",
  };
}

/**
 * A dollar figure: whole cents print with two decimals ($4.00), smaller
 * amounts with four ($0.0123), as the receipt line does.
 */
export function formatUsd(usd: number): string {
  const cents = usd * 100;
  return Math.abs(cents - Math.round(cents)) < 1e-9
    ? `$${usd.toFixed(2)}`
    : `$${usd.toFixed(4)}`;
}

/** The operator-facing name of each limit. */
export function spendLimitLabel(scope: BudgetLimitReason): string {
  switch (scope) {
    case "per_call_limit":
      return "per-call limit";
    case "runaway_stall":
      return "runaway limit";
    case "turn_limit":
      return "turn limit";
    case "session_limit":
      return "session limit";
    case "daily_limit":
      return "daily limit";
  }
}

export function formatBudgetCeilingWarning(
  warning: BudgetCeilingWarning,
): string {
  const scopes = warning.crossedScopes.length > 0
    ? warning.crossedScopes
    : [warning.reason];
  const est = `~${formatUsd(warning.estimatedCostUsd)} this call`;
  const raiseLine = (scope: BudgetLimitReason): string => {
    const to = formatUsd(warning.raisesToUsd[scope] ?? 0);
    switch (scope) {
      case "per_call_limit":
        return `  per-call limit to ${to} (${PER_CALL_HEADROOM}× this estimate), for this session`;
      case "runaway_stall":
        return `  runaway limit to ${to} (${TURN_APPROVAL_MULTIPLE}× the spend with this call), for this turn`;
      case "turn_limit":
        return `  turn limit to ${to} (${TURN_APPROVAL_MULTIPLE}× the spend with this call), for this turn`;
      case "session_limit":
        return `  session limit to ${to} (+${
          formatUsd(warning.sessionLimitUsd)
        }), for this session`;
      case "daily_limit":
        return `  daily limit to ${to} (+${
          formatUsd(warning.dailyLimitUsd)
        }), for today`;
    }
  };
  const approved = (scope: BudgetLimitReason): string => {
    const level = warning.approvedToUsd?.[scope];
    return level === undefined ? "" : ` (approved to ${formatUsd(level)})`;
  };
  const line = (
    spent: number,
    limit: number,
    scope: BudgetLimitReason,
  ): string =>
    `${formatUsd(spent)} spent, ${
      formatUsd(spent + warning.estimatedCostUsd)
    } with this call, limit ${formatUsd(limit)}${approved(scope)}`;
  return [
    "Spend check",
    `Crossed:   ${scopes.map(spendLimitLabel).join(" + ")}`,
    `Turn:      ${
      line(warning.turnCostSoFarUsd, warning.turnLimitUsd, "turn_limit")
    }`,
    `Session:   ${
      line(warning.sessionCostSoFarUsd, warning.sessionLimitUsd, "session_limit")
    }`,
    `Today:     ${
      line(warning.dailyCostSoFarUsd, warning.dailyLimitUsd, "daily_limit")
    }`,
    `Runaway:   ${
      line(warning.stallCostSoFarUsd, warning.runawayStallUsd, "runaway_stall")
    } (since the last tool progress)`,
    `Per call:  ${est}, limit ${formatUsd(warning.perCallLimitUsd)}${
      approved("per_call_limit")
    }`,
    "Approving raises:",
    ...scopes.map(raiseLine),
  ].join("\n");
}

/** Wire shape for the UDS mid-turn approval channel. */
export function budgetCeilingApprovalRequest(
  warning: BudgetCeilingWarning,
): Record<string, unknown> {
  return {
    kind: warning.kind,
    title: "Spend check",
    reason: warning.reason,
    estimatedCostUsd: warning.estimatedCostUsd,
    limitUsd: warning.limitUsd,
    sessionCostSoFarUsd: warning.sessionCostSoFarUsd,
    sessionLimitUsd: warning.sessionLimitUsd,
    perCallLimitUsd: warning.perCallLimitUsd,
    dailyCostSoFarUsd: warning.dailyCostSoFarUsd,
    dailyLimitUsd: warning.dailyLimitUsd,
    turnCostSoFarUsd: warning.turnCostSoFarUsd,
    turnLimitUsd: warning.turnLimitUsd,
    stallCostSoFarUsd: warning.stallCostSoFarUsd,
    runawayStallUsd: warning.runawayStallUsd,
    crossedScopes: warning.crossedScopes,
    raisesToUsd: warning.raisesToUsd,
    approvedToUsd: warning.approvedToUsd,
    authzBasis: warning.authzBasis,
    message: formatBudgetCeilingWarning(warning),
  };
}

export class BudgetCeilingDeclinedError extends DomainError {
  readonly reason?: string;
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
 * Enforce the spend check: under every limit proceeds silently; past one it
 * warns and requires explicit operator confirmation when a handler is
 * supplied. Without a handler (non-interactive / no round-trip), fails closed.
 */
export async function ensureBudgetAllowed(
  preCall: PreCallCheck,
  confirm?: ConfirmBudgetCeiling,
  promptReason?: BudgetLimitReason,
  crossedScopes?: BudgetLimitReason[],
  approvedToUsd: Partial<Record<BudgetLimitReason, number>> = {},
): Promise<void> {
  if (preCall.allowed) return;
  const reason = promptReason ?? preCall.reason ?? "session_limit";
  if (!confirm) {
    throw new BudgetExceededError(
      reason,
      preCall.estimatedCost,
      limitOf(preCall, reason),
      reason === "per_call_limit"
        ? preCall.estimatedCost
        : projected(preCall, reason) - preCall.estimatedCost,
    );
  }
  const warning = buildBudgetCeilingWarning(
    preCall,
    reason,
    crossedScopes,
    approvedToUsd,
  );
  const verdict = await confirm(warning);
  if (verdict.decision !== "approve") {
    throw new BudgetCeilingDeclinedError(verdict.reason);
  }
}

interface TurnMarks {
  turn_limit?: number;
  runaway_stall?: number;
  turn_limit_basis?: number;
  runaway_stall_basis?: number;
}

/** The approved levels a gate reads: scope-persistent marks and turn marks. */
type Marks = BudgetCeilingConfirmations & TurnMarks;

/**
 * The approved level for a scope, or undefined when there is none or it was
 * approved against a different limit than the one in force now.
 */
function approvedLevel(
  preCall: PreCallCheck,
  marks: Marks,
  scope: BudgetLimitReason,
): number | undefined {
  return marks[`${scope}_basis`] === limitOf(preCall, scope)
    ? marks[scope]
    : undefined;
}

/**
 * Every limit this call newly crosses — crossed, and not already approved at
 * or above this projection against the limit in force — outermost first.
 */
function newlyExceededScopes(
  preCall: PreCallCheck,
  marks: Marks,
): BudgetLimitReason[] {
  return SCOPE_ORDER.filter((scope) => {
    const p = projected(preCall, scope);
    if (p <= limitOf(preCall, scope)) return false;
    const mark = approvedLevel(preCall, marks, scope);
    return mark === undefined || p > mark;
  });
}

function recordApprovals(
  preCall: PreCallCheck,
  marks: Marks,
  approvedScopes: BudgetLimitReason[],
): void {
  const raises = approvalRaises(preCall, approvedScopes);
  for (const scope of approvedScopes) {
    // Math.max keeps a level from dropping when an approval computed from an
    // older projection lands after a higher one against the same limit.
    marks[scope] = Math.max(
      approvedLevel(preCall, marks, scope) ?? 0,
      raises[scope] ?? 0,
    );
    marks[`${scope}_basis`] = limitOf(preCall, scope);
  }
}

export interface TurnBudgetCeilingGate {
  /**
   * Enforce every spend limit; a crossed limit prompts only when its
   * projection passes the level it was last raised to, and the approval
   * raises that limit to the level the prompt stated.
   */
  ensureAllowed(preCall: PreCallCheck): Promise<void>;
}

/**
 * The spend check for one turn. One prompt names every newly crossed limit,
 * and the approval raises exactly those limits. The turn and runaway marks
 * live in this gate instance, so they last the turn. The per-call, session
 * and daily marks live in `confirmed`: pass `confirmationStore.for(sessionId)`
 * (a `CeilingConfirmationStore`) to keep the per-call and session marks for
 * the session and the daily mark for the local day; the default fresh object
 * keeps them for this gate instance only.
 */
export function createTurnBudgetCeilingGate(
  confirm?: ConfirmBudgetCeiling,
  confirmed: BudgetCeilingConfirmations = {},
): TurnBudgetCeilingGate {
  const turn: TurnMarks = {};
  const marks: Marks = {
    get per_call_limit() {
      return confirmed.per_call_limit;
    },
    set per_call_limit(v: number | undefined) {
      confirmed.per_call_limit = v;
    },
    get session_limit() {
      return confirmed.session_limit;
    },
    set session_limit(v: number | undefined) {
      confirmed.session_limit = v;
    },
    get daily_limit() {
      return confirmed.daily_limit;
    },
    set daily_limit(v: number | undefined) {
      confirmed.daily_limit = v;
    },
    get per_call_limit_basis() {
      return confirmed.per_call_limit_basis;
    },
    set per_call_limit_basis(v: number | undefined) {
      confirmed.per_call_limit_basis = v;
    },
    get session_limit_basis() {
      return confirmed.session_limit_basis;
    },
    set session_limit_basis(v: number | undefined) {
      confirmed.session_limit_basis = v;
    },
    get daily_limit_basis() {
      return confirmed.daily_limit_basis;
    },
    set daily_limit_basis(v: number | undefined) {
      confirmed.daily_limit_basis = v;
    },
    get turn_limit_basis() {
      return turn.turn_limit_basis;
    },
    set turn_limit_basis(v: number | undefined) {
      turn.turn_limit_basis = v;
    },
    get runaway_stall_basis() {
      return turn.runaway_stall_basis;
    },
    set runaway_stall_basis(v: number | undefined) {
      turn.runaway_stall_basis = v;
    },
    get turn_limit() {
      return turn.turn_limit;
    },
    set turn_limit(v: number | undefined) {
      turn.turn_limit = v;
    },
    get runaway_stall() {
      return turn.runaway_stall;
    },
    set runaway_stall(v: number | undefined) {
      turn.runaway_stall = v;
    },
  };
  return {
    async ensureAllowed(preCall: PreCallCheck): Promise<void> {
      if (preCall.allowed) return;
      const scopes = newlyExceededScopes(preCall, marks);
      if (scopes.length === 0) return;
      // First (outermost) scope frames the prompt; the warning lists them all,
      // with the level an earlier approval raised each to, where one applies.
      const approvedTo: Partial<Record<BudgetLimitReason, number>> = {};
      for (const scope of SCOPE_ORDER) {
        const level = approvedLevel(preCall, marks, scope);
        if (level !== undefined) approvedTo[scope] = level;
      }
      await ensureBudgetAllowed(preCall, confirm, scopes[0], scopes, approvedTo);
      recordApprovals(preCall, marks, scopes);
    },
  };
}

// ── Error ─────────────────────────────────────────────────────────────────────

export class BudgetExceededError extends DomainError {
  public readonly reason: BudgetLimitReason;
  public readonly estimatedCost: number;
  public readonly limitUsd: number;
  /** Spend so far in the scope named by `reason` (for per-call this is the call estimate). */
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
        `${scopeSoFarLabel(reason)} $${scopeCostSoFar.toFixed(6)}`,
    );
    this.reason = reason;
    this.estimatedCost = estimatedCost;
    this.limitUsd = limitUsd;
    this.scopeCostSoFar = scopeCostSoFar;
    this.name = "BudgetExceededError";
  }
}

function scopeSoFarLabel(reason: BudgetLimitReason): string {
  switch (reason) {
    case "per_call_limit":
      return "call estimate";
    case "runaway_stall":
      return "spend since the last tool progress";
    case "turn_limit":
      return "turn total so far";
    case "session_limit":
      return "session total so far";
    case "daily_limit":
      return "today's total so far";
  }
}
