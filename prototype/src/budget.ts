/**
 * DYFJ Workbench — Session budget tracker
 *
 * Tracks per-session token usage and cost across all model calls. Enforces
 * configurable spend limits before each API call (Tier 1/2 only — Tier 0 is
 * always free). Writes a budget_summary event at session end so scorecard
 * views get a single pre-aggregated row rather than scanning every event.
 *
 * Design:
 *   - BudgetTracker is instantiated once per session by the caller
 *   - record()    called after each done event with the message's usage
 *   - checkPreCall() called before starting a Tier 1/2 model call
 *   - buildSummaryEventPayload() is a pure function — testable without Dolt
 *   - writeSummaryEvent() calls writeEvent(); call once at session end
 *
 * Budget defaults are a declared engine config key (`CONFIG_SCHEMA` in
 * config.ts): the env-var bindings and the limit numbers live on the declared
 * surface, not inline here, so the permission allowlist derives from one source.
 *   DYFJ_BUDGET_SESSION_USD  — max total spend per session  (default $1.00)
 *   DYFJ_BUDGET_PER_CALL_USD — max spend per individual call (default $0.10)
 *
 * Pre-call cost estimate uses input tokens only (output is unknown pre-call).
 * This is a lower-bound estimate; the actual call may cost more. The session
 * limit check post-call (via record()) catches overruns if they occur.
 */

import { doltQuery, generateSpanId, generateULID, writeEvent } from "./utils";
import { resolveBudgetDefaultsFromEnv } from "./config";
import process from "node:process";

// ── Config ────────────────────────────────────────────────────────────────────

export interface BudgetConfig {
  /** Maximum total USD spend across all API calls in a session. */
  sessionLimitUsd: number;
  /** Maximum USD spend for a single API call (estimated from input tokens). */
  perCallLimitUsd: number;
  /** Maximum total USD spend across ALL sessions in a local day. */
  dailyLimitUsd: number;
}

/**
 * Spend already on the books before this turn starts, from the events table:
 * the session's own prior turns and today's spend across all sessions. The
 * tracker itself only accumulates the current turn, so without these baselines
 * the "session" and "daily" envelopes would silently reset every turn.
 */
export interface SpendBaselines {
  /** This session's lifetime spend from earlier turns (static under the session lock). */
  sessionSpentUsd: number;
  /** This session's spend from earlier turns TODAY — a resumed session may span
   * days, and only today's share counts toward the daily envelope. */
  sessionSpentTodayUsd: number;
  /** Today's spend across OTHER sessions; refreshed before each paid call. */
  dailyOtherSessionsUsd: number;
}

/** Start of the local day, in the clock the Dolt server stamps created_at with. */
export function localDayStart(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d} 00:00:00`;
}

/** Local-day key for scope-persistent ceiling confirmations. */
export function localDayKey(now: Date = new Date()): string {
  return localDayStart(now).slice(0, 10);
}

/**
 * Roll up prior spend from the events table: this session's earlier turns,
 * and today's spend across OTHER sessions (this session's contribution is the
 * session baseline plus the live turn tracker, so the two never double
 * count). Only atomic `model_response` costs are summed — `budget_summary`
 * rows carry the session AGGREGATE and would double count every session that
 * already ended. `created_at` is stamped by the Dolt server's clock (local
 * time), so the day boundary is computed in local time.
 *
 * Enforcement freshness: the daily figure is re-fetched before EVERY paid
 * call, so concurrent sessions see each other's completed calls; calls still
 * in flight are invisible, so simultaneous turns can overshoot the daily
 * envelope by at most the sum of in-flight call costs, visible afterward in
 * receipts — this is a
 * single-operator cost envelope, not an adversarial control, and it is
 * deliberately global rather than per-principal (single-operator system per
 * the README boundaries). Query is injectable so the rollup logic is
 * testable without Dolt.
 */
export async function fetchSpendBaselines(
  sessionId: string,
  dayStart: string = localDayStart(),
  query: typeof doltQuery = doltQuery,
): Promise<SpendBaselines> {
  const rows = await query(
    "SELECT " +
      "COALESCE(SUM(CASE WHEN session_id = ? THEN cost_total ELSE 0 END), 0) AS session_spent, " +
      "COALESCE(SUM(CASE WHEN session_id = ? AND created_at >= ? THEN cost_total ELSE 0 END), 0) AS session_today, " +
      "COALESCE(SUM(CASE WHEN created_at >= ? AND session_id <> ? THEN cost_total ELSE 0 END), 0) AS daily_others " +
      "FROM events WHERE event_type = 'model_response' AND cost_total IS NOT NULL AND cost_total > 0",
    [sessionId, sessionId, dayStart, dayStart, sessionId],
  );
  return {
    sessionSpentUsd: Number(rows[0]?.session_spent ?? 0) || 0,
    sessionSpentTodayUsd: Number(rows[0]?.session_today ?? 0) || 0,
    dailyOtherSessionsUsd: Number(rows[0]?.daily_others ?? 0) || 0,
  };
}

/**
 * Resolve the default budget limits from the environment, against the declared
 * config surface (defaults → env). Kept as the convenience default for
 * `BudgetTracker` and the not-yet-config-wired entrypoints; the runtime boundary
 * resolves these once and threads them in (see resolveRuntimeEnvDefaults).
 */
export function defaultBudgetConfig(): BudgetConfig {
  const env = { get: (key: string): string | undefined => process.env[key] };
  return resolveBudgetDefaultsFromEnv(env);
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TierSpend {
  calls: number;
  tokensInput: number;
  tokensOutput: number;
  costUsd: number;
}

export interface PreCallCheck {
  allowed: boolean;
  estimatedCost: number;
  sessionCostSoFar: number;
  sessionLimitUsd: number;
  perCallLimitUsd: number;
  dailyCostSoFar: number;
  dailyLimitUsd: number;
  /** Only present when allowed === false */
  reason?: BudgetLimitReason;
}

export type BudgetLimitReason = "per_call_limit" | "session_limit" | "daily_limit";

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

export function formatBudgetCeilingWarning(warning: BudgetCeilingWarning): string {
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

export class BudgetCeilingDeclinedError extends Error {
  constructor(public readonly reason?: string) {
    super(
      reason
        ? `Budget ceiling confirmation declined: ${reason}`
        : "Budget ceiling confirmation declined",
    );
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
  const warning = buildBudgetCeilingWarning(preCall, promptReason, crossedScopes);
  const verdict = await confirm(warning);
  if (verdict.decision !== "approve") {
    throw new BudgetCeilingDeclinedError(verdict.reason);
  }
}

/**
 * Operator-confirmed ceiling overruns. Confirming a ceiling covers its scope
 * for the scope's period: a confirmed session or daily overrun does not
 * re-prompt for the rest of that session or local day — crossing an envelope
 * soft-confirms ONCE. After confirmation, spend in that scope is bounded only
 * by the per-call check, per-turn paid consent, and the agent-loop step cap
 * until the period ends. Per-call stays a
 * per-event high-water mark: a single call larger than any previously
 * confirmed one is a fresh fat-finger check. All of it lives in
 * runtime-process memory, so a restart forgets confirmations (the safe
 * direction).
 */
export interface BudgetCeilingConfirmations {
  per_call_limit?: number;
  session_limit?: number;
  daily_limit?: number;
}

/** @deprecated alias for the pre-daily-envelope name; kept for tests. */
export type TurnBudgetCeilingConfirmations = BudgetCeilingConfirmations;

const MAX_TRACKED_SCOPES = 512;

function boundedGet(
  store: Map<string, BudgetCeilingConfirmations>,
  key: string,
): BudgetCeilingConfirmations {
  let entry = store.get(key);
  if (!entry) {
    if (store.size >= MAX_TRACKED_SCOPES) {
      const oldest = store.keys().next().value;
      if (oldest !== undefined) store.delete(oldest);
    }
    entry = {};
    store.set(key, entry);
  }
  return entry;
}

const sessionScopeConfirmations = new Map<string, BudgetCeilingConfirmations>();
const dailyScopeConfirmations = new Map<string, BudgetCeilingConfirmations>();

/**
 * The confirmation store for a turn: per-call/session marks live under the
 * session id; the daily mark lives under the local-day key, shared across
 * sessions, so one confirmed daily overrun does not re-prompt every session.
 */
export function ceilingConfirmationStoreFor(
  sessionId: string,
  dayKey: string = localDayKey(),
): BudgetCeilingConfirmations {
  const session = boundedGet(sessionScopeConfirmations, sessionId);
  const daily = boundedGet(dailyScopeConfirmations, dayKey);
  return {
    get per_call_limit() {
      return session.per_call_limit;
    },
    set per_call_limit(v: number | undefined) {
      session.per_call_limit = v;
    },
    get session_limit() {
      return session.session_limit;
    },
    set session_limit(v: number | undefined) {
      session.session_limit = v;
    },
    get daily_limit() {
      return daily.daily_limit;
    },
    set daily_limit(v: number | undefined) {
      daily.daily_limit = v;
    },
  };
}

/** Test seam: forget all scope-persistent confirmations. */
export function resetCeilingConfirmations(): void {
  sessionScopeConfirmations.clear();
  dailyScopeConfirmations.clear();
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
 * turn; pass `ceilingConfirmationStoreFor(sessionId, dayKey)` to persist
 * confirmations for their scope periods — the rest of the session for
 * per-call/session marks, the rest of the local day for the daily mark.
 */
export function createTurnBudgetCeilingGate(
  confirm?: ConfirmBudgetCeiling,
  // Scope-persistent store (ceilingConfirmationStoreFor) makes a confirmation
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

// ── Runaway anomaly gate ──────────────────────────────────────────────────────
//
// The one HARD stop in the cost posture. The envelopes above are soft by
// design: estimate-based, confirmable, and a session/daily confirmation covers
// its whole scope period. That leaves two blind spots the anomaly gate closes,
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

export interface AnomalyConfig {
  /** Halt when a turn's actual spend exceeds this × the per-call limit. */
  turnMultiple: number;
  /** Halt when actual session/daily spend exceeds this × the envelope. */
  scopeMultiple: number;
}

export type AnomalyTrigger = "turn_spend" | "session_scope" | "daily_scope";

export interface AnomalyCheck {
  halted: boolean;
  /** Outermost tripped trigger (daily > session > turn); set iff halted. */
  trigger?: AnomalyTrigger;
  turnSpentUsd: number;
  turnHaltUsd: number;
  sessionSpentUsd: number;
  sessionHaltUsd: number;
  dailySpentUsd: number;
  dailyHaltUsd: number;
  config: AnomalyConfig;
}

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

export class RunawayAnomalyHaltError extends Error {
  constructor(
    public readonly trigger: AnomalyTrigger,
    public readonly spentUsd: number,
    public readonly haltUsd: number,
    public readonly declined: boolean = false,
    declineReason?: string,
  ) {
    super(
      declined
        ? `Runaway spend anomaly halt declined [${trigger}]: ` +
          `actual $${spentUsd.toFixed(6)} past halt $${haltUsd.toFixed(6)}` +
          (declineReason ? ` (${declineReason})` : "")
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

export interface BudgetSummary {
  totalCostUsd: number;
  totalTokensInput: number;
  totalTokensOutput: number;
  totalCalls: number;
  config: BudgetConfig;
  /** Keyed by tier number as string: "0", "1", "2" */
  byTier: Record<string, TierSpend>;
}

// ── Error ─────────────────────────────────────────────────────────────────────

export class BudgetExceededError extends Error {
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

// ── BudgetTracker ─────────────────────────────────────────────────────────────

export class BudgetTracker {
  private readonly _byTier = new Map<0 | 1 | 2, TierSpend>();
  private _totalCost = 0;
  private _totalTokensInput = 0;
  private _totalTokensOutput = 0;

  constructor(
    private readonly sessionId: string,
    private readonly traceId: string,
    public readonly config: BudgetConfig = defaultBudgetConfig(),
    // principal is resolved at the boundary and passed in, so the
    // budget_summary event no longer reads DYFJ_PRINCIPAL_ID / USER from env.
    private readonly principalId: string = "user",
    // Prior spend from the events table (fetchSpendBaselines): the session's
    // earlier turns and today's spend across sessions. Without these the
    // session and daily envelopes silently reset every turn.
    private baselines: SpendBaselines = {
      sessionSpentUsd: 0,
      sessionSpentTodayUsd: 0,
      dailyOtherSessionsUsd: 0,
    },
  ) {}

  /**
   * Refresh the cross-session daily figure (called before each paid call) so
   * concurrent sessions see each other's completed spend.
   */
  refreshDailyOtherSessions(usd: number): void {
    this.baselines = { ...this.baselines, dailyOtherSessionsUsd: usd };
  }

  // ── Accumulators ───────────────────────────────────────────────────────────

  /**
   * Record actual usage from a completed model call.
   * Call this after each `done` event in the stream loop.
   *
   * @param usage  Model usage returned by the provider
   * @param tier   The tier of the model that produced this response (0 | 1 | 2)
   */
  record(
    usage: { input: number; output: number; cost: { total: number } },
    tier: 0 | 1 | 2,
  ): void {
    this._totalCost += usage.cost.total;
    this._totalTokensInput += usage.input;
    this._totalTokensOutput += usage.output;

    const prev = this._byTier.get(tier) ?? {
      calls: 0,
      tokensInput: 0,
      tokensOutput: 0,
      costUsd: 0,
    };
    this._byTier.set(tier, {
      calls: prev.calls + 1,
      tokensInput: prev.tokensInput + usage.input,
      tokensOutput: prev.tokensOutput + usage.output,
      costUsd: prev.costUsd + usage.cost.total,
    });
  }

  // ── Pre-call guard ──────────────────────────────────────────────────────────

  /**
   * Check whether a proposed API call is within budget before initiating it.
   * Tier 0 calls are always allowed (free). Tier 1/2 are checked against both
   * per-call and session limits.
   *
   * Cost estimate uses input tokens only — a lower bound. Callers should treat
   * "allowed" as a green light, not a guarantee the session limit won't be
   * breached once output tokens are added.
   *
   * @param tier               Model tier (0 = local, 1 = API light, 2 = API heavy)
   * @param costInputPerMTok   Model's input cost in USD per million tokens
   * @param estimatedInputTokens  Estimated input token count for the call
   */
  checkPreCall(
    tier: 0 | 1 | 2,
    costInputPerMTok: number,
    estimatedInputTokens: number,
  ): PreCallCheck {
    const sessionCostSoFar = this.baselines.sessionSpentUsd + this._totalCost;
    // Only today's share of this session counts toward the daily envelope —
    // a resumed session may span days; the live turn's spend is all today.
    const dailyCostSoFar = this.baselines.dailyOtherSessionsUsd +
      this.baselines.sessionSpentTodayUsd + this._totalCost;
    const base: Omit<PreCallCheck, "allowed" | "estimatedCost" | "reason"> = {
      sessionCostSoFar,
      sessionLimitUsd: this.config.sessionLimitUsd,
      perCallLimitUsd: this.config.perCallLimitUsd,
      dailyCostSoFar,
      dailyLimitUsd: this.config.dailyLimitUsd,
    };

    if (tier === 0) {
      return { ...base, allowed: true, estimatedCost: 0 };
    }

    const estimatedCost = (estimatedInputTokens / 1_000_000) * costInputPerMTok;

    // Reason reports the OUTERMOST crossed scope (daily > session > per-call)
    // so a fail-closed error names the broadest envelope that blocked the
    // call rather than masking a daily stop behind a session framing.
    const reason: BudgetLimitReason | undefined =
      dailyCostSoFar + estimatedCost > this.config.dailyLimitUsd
        ? "daily_limit"
        : sessionCostSoFar + estimatedCost > this.config.sessionLimitUsd
        ? "session_limit"
        : estimatedCost > this.config.perCallLimitUsd
        ? "per_call_limit"
        : undefined;

    if (reason !== undefined) {
      return { ...base, allowed: false, estimatedCost, reason };
    }

    return { ...base, allowed: true, estimatedCost };
  }

  // ── Runaway anomaly check ───────────────────────────────────────────────────

  /**
   * Check the runaway-anomaly hard stops against ACTUAL recorded spend — no
   * estimates anywhere in this path, so it holds even where the pre-call
   * estimate undercounts. Tier 0 never halts (free calls add no spend).
   * `_totalCost` is this tracker's lifetime (= the current turn: one tracker
   * per runtime invocation), so the turn trigger sees exactly the loop's
   * accumulated actuals; the scope figures reuse the envelope arithmetic from
   * checkPreCall.
   */
  checkAnomaly(tier: 0 | 1 | 2, anomaly: AnomalyConfig): AnomalyCheck {
    const turnSpentUsd = this._totalCost;
    const sessionSpentUsd = this.baselines.sessionSpentUsd + this._totalCost;
    const dailySpentUsd = this.baselines.dailyOtherSessionsUsd +
      this.baselines.sessionSpentTodayUsd + this._totalCost;
    const turnHaltUsd = anomaly.turnMultiple * this.config.perCallLimitUsd;
    const sessionHaltUsd = anomaly.scopeMultiple * this.config.sessionLimitUsd;
    const dailyHaltUsd = anomaly.scopeMultiple * this.config.dailyLimitUsd;
    // Outermost trigger frames the halt (daily > session > turn), mirroring
    // the ceiling gate's scope ordering.
    const trigger: AnomalyTrigger | undefined = tier === 0
      ? undefined
      : dailySpentUsd > dailyHaltUsd
      ? "daily_scope"
      : sessionSpentUsd > sessionHaltUsd
      ? "session_scope"
      : turnSpentUsd > turnHaltUsd
      ? "turn_spend"
      : undefined;
    return {
      halted: trigger !== undefined,
      ...(trigger !== undefined ? { trigger } : {}),
      turnSpentUsd,
      turnHaltUsd,
      sessionSpentUsd,
      sessionHaltUsd,
      dailySpentUsd,
      dailyHaltUsd,
      config: { ...anomaly },
    };
  }

  // ── Accessors ───────────────────────────────────────────────────────────────

  get totalCost(): number {
    return this._totalCost;
  }
  get totalTokensInput(): number {
    return this._totalTokensInput;
  }
  get totalTokensOutput(): number {
    return this._totalTokensOutput;
  }
  get totalCalls(): number {
    return [...this._byTier.values()].reduce((n, t) => n + t.calls, 0);
  }

  getSummary(): BudgetSummary {
    const byTier: Record<string, TierSpend> = {};
    for (const [tier, spend] of this._byTier) {
      byTier[String(tier)] = { ...spend };
    }
    return {
      totalCostUsd: this._totalCost,
      totalTokensInput: this._totalTokensInput,
      totalTokensOutput: this._totalTokensOutput,
      totalCalls: this.totalCalls,
      config: { ...this.config },
      byTier,
    };
  }

  // ── Summary event ───────────────────────────────────────────────────────────

  /**
   * Build the Dolt event payload for the budget_summary event.
   * Pure function — accepts an optional id/spanId override for testing.
   */
  buildSummaryEventPayload(
    overrides: { eventId?: string; spanId?: string } = {},
  ): Record<string, unknown> {
    const summary = this.getSummary();
    return {
      event_id: overrides.eventId ?? generateULID(),
      session_id: this.sessionId,
      event_type: "budget_summary",
      trace_id: this.traceId,
      span_id: overrides.spanId ?? generateSpanId(),
      principal_id: this.principalId,
      principal_type: "human",
      action: "summarise",
      resource: "session_budget",
      authz_basis: "system",
      tokens_input: summary.totalTokensInput || null,
      tokens_output: summary.totalTokensOutput || null,
      cost_total: summary.totalCostUsd || null,
      content: JSON.stringify(summary),
    };
  }

  /**
   * Write the budget_summary event to Dolt.
   * Call once at session end, after the session_end lifecycle event.
   */
  async writeSummaryEvent(): Promise<void> {
    await writeEvent(this.buildSummaryEventPayload());
  }
}
