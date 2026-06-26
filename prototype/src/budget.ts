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

import { generateSpanId, generateULID, writeEvent } from "./utils";
import { resolveBudgetDefaultsFromEnv } from "./config";
import process from "node:process";

// ── Config ────────────────────────────────────────────────────────────────────

export interface BudgetConfig {
  /** Maximum total USD spend across all API calls in a session. */
  sessionLimitUsd: number;
  /** Maximum USD spend for a single API call (estimated from input tokens). */
  perCallLimitUsd: number;
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
  /** Only present when allowed === false */
  reason?: "per_call_limit" | "session_limit";
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
    public readonly reason: "per_call_limit" | "session_limit",
    public readonly estimatedCost: number,
    public readonly limitUsd: number,
    public readonly sessionCostSoFar: number,
  ) {
    super(
      `Budget exceeded [${reason}]: ` +
        `estimated $${estimatedCost.toFixed(6)}, ` +
        `limit $${limitUsd.toFixed(6)}, ` +
        `session total so far $${sessionCostSoFar.toFixed(6)}`,
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
  ) {}

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
    const base: Omit<PreCallCheck, "allowed" | "estimatedCost" | "reason"> = {
      sessionCostSoFar: this._totalCost,
      sessionLimitUsd: this.config.sessionLimitUsd,
      perCallLimitUsd: this.config.perCallLimitUsd,
    };

    if (tier === 0) {
      return { ...base, allowed: true, estimatedCost: 0 };
    }

    const estimatedCost = (estimatedInputTokens / 1_000_000) * costInputPerMTok;

    if (estimatedCost > this.config.perCallLimitUsd) {
      return {
        ...base,
        allowed: false,
        estimatedCost,
        reason: "per_call_limit",
      };
    }

    if (this._totalCost + estimatedCost > this.config.sessionLimitUsd) {
      return {
        ...base,
        allowed: false,
        estimatedCost,
        reason: "session_limit",
      };
    }

    return { ...base, allowed: true, estimatedCost };
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
