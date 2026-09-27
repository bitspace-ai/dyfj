/**
 * Session budget tracker.
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
 *   - checkAnomaly() checks the runaway hard stops against actual spend
 *   - buildSummaryEventPayload() is a pure function — testable without Dolt
 *   - writeSummaryEvent() commits it through the journal; call once at session end
 *
 * Budget defaults are a declared engine config key (`CONFIG_SCHEMA` in
 * config/): the env-var bindings and the limit numbers live on the declared
 * surface, not inline here, so the permission allowlist derives from one source.
 *   DYFJ_BUDGET_SESSION_USD  — max total spend per session  (default $1.00)
 *   DYFJ_BUDGET_PER_CALL_USD — max spend per individual call (default $0.10)
 *
 * Pre-call cost estimate uses input tokens only (output is unknown pre-call).
 * This is a lower-bound estimate; the actual call may cost more. The session
 * limit check post-call (via record()) catches overruns if they occur.
 */

import { generateSpanId, generateULID } from "../kernel/mod.ts";
import type { Journal } from "../store/mod.ts";
import {
  type Env,
  processEnv,
  resolveBudgetDefaultsFromEnv,
} from "../config/mod.ts";

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

/**
 * Resolve the default budget limits from the environment, against the declared
 * config surface (defaults → env). Kept as the convenience default for
 * `BudgetTracker` and the not-yet-config-wired entrypoints; the runtime boundary
 * resolves these once and threads them in (see resolveRuntimeEnvDefaults).
 */
export function defaultBudgetConfig(env: Env = processEnv): BudgetConfig {
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

export type BudgetLimitReason =
  | "per_call_limit"
  | "session_limit"
  | "daily_limit";

// ── Runaway anomaly check types ───────────────────────────────────────────────
//
// The tracker computes the anomaly check from actual recorded spend; the
// hard-stop gate that acts on it lives in anomaly-gate.ts.

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

export interface BudgetSummary {
  totalCostUsd: number;
  totalTokensInput: number;
  totalTokensOutput: number;
  totalCalls: number;
  config: BudgetConfig;
  /** Keyed by tier number as string: "0", "1", "2" */
  byTier: Record<string, TierSpend>;
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
   * Pure function — accepts optional span identifiers for testing and trace
   * parentage.
   */
  buildSummaryEventPayload(
    overrides: { eventId?: string; spanId?: string; parentSpanId?: string } =
      {},
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    const summary = this.getSummary();
    return {
      event_id: overrides.eventId ?? generateULID(),
      session_id: this.sessionId,
      event_type: "budget_summary",
      trace_id: this.traceId,
      span_id: overrides.spanId ?? generateSpanId(),
      parent_span_id: overrides.parentSpanId ?? null,
      principal_id: this.principalId,
      principal_type: "human",
      action: "summarise",
      resource: "session_budget",
      authz_basis: "system",
      tokens_input: summary.totalTokensInput || null,
      tokens_output: summary.totalTokensOutput || null,
      cost_total: summary.totalCostUsd || null,
      // `extra` carries session-level operational counters that belong in
      // the durable summary but are not the budget's own (e.g.
      // skippedEventWrites — the count of best-effort event writes that
      // failed, so an audit-log gap is durably on record, not just a
      // scrolled-away console line).
      content: JSON.stringify({ ...summary, ...extra }),
    };
  }

  /**
   * Commit the budget_summary event through the journal.
   * Call once at session end, after the session_end lifecycle event.
   */
  async writeSummaryEvent(
    journal: Journal,
    extra: Record<string, unknown> = {},
    overrides: { eventId?: string; spanId?: string; parentSpanId?: string } =
      {},
  ): Promise<void> {
    await journal.commit({
      events: [this.buildSummaryEventPayload(overrides, extra)],
    });
  }
}
