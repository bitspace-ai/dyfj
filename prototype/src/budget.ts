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

/** Structured warn payload for a budget-ceiling confirmation (telemetry-safe). */
export interface BudgetCeilingWarning {
  kind: "budget_ceiling";
  reason: "per_call_limit" | "session_limit";
  estimatedCostUsd: number;
  limitUsd: number;
  sessionCostSoFarUsd: number;
  sessionLimitUsd: number;
  perCallLimitUsd: number;
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
  overrideReason?: "per_call_limit" | "session_limit",
): BudgetCeilingWarning {
  const reason = overrideReason ?? preCall.reason ?? "session_limit";
  const limitUsd = reason === "per_call_limit"
    ? preCall.perCallLimitUsd
    : preCall.sessionLimitUsd;
  return {
    kind: "budget_ceiling",
    reason,
    estimatedCostUsd: preCall.estimatedCost,
    limitUsd,
    sessionCostSoFarUsd: preCall.sessionCostSoFar,
    sessionLimitUsd: preCall.sessionLimitUsd,
    perCallLimitUsd: preCall.perCallLimitUsd,
    authzBasis: "policy:allow:operator-confirmed-ceiling",
  };
}

export function formatBudgetCeilingWarning(warning: BudgetCeilingWarning): string {
  const limitLabel = warning.reason === "per_call_limit"
    ? "per-call limit"
    : "session limit";
  return [
    "Budget ceiling warning",
    `Reason:          ${limitLabel}`,
    `Estimated cost:  $${warning.estimatedCostUsd.toFixed(6)}`,
    `Limit:           $${warning.limitUsd.toFixed(6)}`,
    `Session spent:   $${warning.sessionCostSoFarUsd.toFixed(6)} / ${
      warning.sessionLimitUsd.toFixed(6)
    }`,
    `Projected total: $${
      (warning.sessionCostSoFarUsd + warning.estimatedCostUsd).toFixed(6)
    } / ${warning.sessionLimitUsd.toFixed(6)}`,
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
  promptReason?: "per_call_limit" | "session_limit",
): Promise<void> {
  if (preCall.allowed) return;
  if (!confirm) {
    // Fail closed on the original verdict, not the prompt-only override.
    const reason = preCall.reason ?? "session_limit";
    const limit = reason === "per_call_limit"
      ? preCall.perCallLimitUsd
      : preCall.sessionLimitUsd;
    throw new BudgetExceededError(
      reason,
      preCall.estimatedCost,
      limit,
      preCall.sessionCostSoFar,
    );
  }
  const warning = buildBudgetCeilingWarning(preCall, promptReason);
  const verdict = await confirm(warning);
  if (verdict.decision !== "approve") {
    throw new BudgetCeilingDeclinedError(verdict.reason);
  }
}

/** Per-turn high-water marks for operator-confirmed ceiling overruns. */
export interface TurnBudgetCeilingConfirmations {
  per_call_limit?: number;
  session_limit?: number;
}

function crossesPerCallLimit(preCall: PreCallCheck): boolean {
  return preCall.estimatedCost > preCall.perCallLimitUsd;
}

function crossesSessionLimit(preCall: PreCallCheck): boolean {
  return preCall.sessionCostSoFar + preCall.estimatedCost >
    preCall.sessionLimitUsd;
}

function projectedSessionSpend(preCall: PreCallCheck): number {
  return preCall.sessionCostSoFar + preCall.estimatedCost;
}

function ceilingAlreadyConfirmed(
  preCall: PreCallCheck,
  confirmed: TurnBudgetCeilingConfirmations,
): boolean {
  const perCallOk = !crossesPerCallLimit(preCall) ||
    (confirmed.per_call_limit !== undefined &&
      preCall.estimatedCost <= confirmed.per_call_limit);
  const sessionOk = !crossesSessionLimit(preCall) ||
    (confirmed.session_limit !== undefined &&
      projectedSessionSpend(preCall) <= confirmed.session_limit);
  return perCallOk && sessionOk;
}

/**
 * Pick the dimension to frame the prompt around: the one that is *newly* crossing
 * for this call (not yet confirmed this turn). `checkPreCall` always reports
 * `per_call_limit` when per-call is exceeded, so a re-prompt driven purely by
 * session accumulation would otherwise be mislabeled as a per-call overrun.
 * When both dimensions newly cross at once, keep `preCall.reason` (undefined here).
 */
function newlyExceededPromptReason(
  preCall: PreCallCheck,
  confirmed: TurnBudgetCeilingConfirmations,
): "per_call_limit" | "session_limit" | undefined {
  const perCallNew = crossesPerCallLimit(preCall) &&
    (confirmed.per_call_limit === undefined ||
      preCall.estimatedCost > confirmed.per_call_limit);
  const sessionNew = crossesSessionLimit(preCall) &&
    (confirmed.session_limit === undefined ||
      projectedSessionSpend(preCall) > confirmed.session_limit);
  if (sessionNew && !perCallNew) return "session_limit";
  if (perCallNew && !sessionNew) return "per_call_limit";
  return undefined;
}

function recordCeilingConfirmations(
  preCall: PreCallCheck,
  confirmed: TurnBudgetCeilingConfirmations,
): void {
  if (crossesPerCallLimit(preCall)) {
    confirmed.per_call_limit = Math.max(
      confirmed.per_call_limit ?? 0,
      preCall.estimatedCost,
    );
  }
  if (crossesSessionLimit(preCall)) {
    confirmed.session_limit = Math.max(
      confirmed.session_limit ?? 0,
      projectedSessionSpend(preCall),
    );
  }
}

export interface TurnBudgetCeilingGate {
  /** Enforce a ceiling once per turn for the same projected spend level. */
  ensureAllowed(preCall: PreCallCheck): Promise<void>;
}

/**
 * Wrap budget-ceiling confirmation so the operator is prompted at most once per
 * turn for the same projected spend level on each crossed dimension. Mirrors the
 * once-per-turn paid-consent preflight: a later agent-loop call re-prompts when
 * any crossed dimension (per-call or session) exceeds what was already confirmed
 * for that dimension — including when session accumulation crosses the session
 * ceiling even though per-call was already confirmed at the same estimate.
 */
export function createTurnBudgetCeilingGate(
  confirm?: ConfirmBudgetCeiling,
): TurnBudgetCeilingGate {
  const confirmed: TurnBudgetCeilingConfirmations = {};
  return {
    async ensureAllowed(preCall: PreCallCheck): Promise<void> {
      if (preCall.allowed) return;
      if (ceilingAlreadyConfirmed(preCall, confirmed)) return;
      const promptReason = newlyExceededPromptReason(preCall, confirmed);
      await ensureBudgetAllowed(preCall, confirm, promptReason);
      recordCeilingConfirmations(preCall, confirmed);
    },
  };
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
