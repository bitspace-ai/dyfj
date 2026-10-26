/**
 * The session's spend limits (BIT-785): `--budget-turn`, `--budget-session`,
 * `--budget-day`, `--budget-per-call` and `--budget-runaway` at launch, and
 * `/budget` in the REPL. A limit the session sets rides every native turn as
 * the request's `budget` override; the others are the runtime's configured
 * defaults.
 */

/** The session's own spend limits, in USD; an absent one is the runtime's. */
export interface SessionBudget {
  turn?: number;
  session?: number;
  day?: number;
  perCall?: number;
  runaway?: number;
}

export type BudgetLimitName = keyof SessionBudget;

/** The launch flag for each limit. */
export const BUDGET_FLAGS: Record<string, BudgetLimitName> = {
  "--budget-turn": "turn",
  "--budget-session": "session",
  "--budget-day": "day",
  "--budget-per-call": "perCall",
  "--budget-runaway": "runaway",
};

/** The runtime refuses a limit above this (a fat-finger guard). */
export const MAX_BUDGET_USD = 1000;

/** A positive dollar amount no larger than MAX_BUDGET_USD, else undefined. */
export function parseBudgetUsd(raw: string): number | undefined {
  const value = Number(raw.trim().replace(/^\$/, ""));
  return Number.isFinite(value) && value > 0 && value <= MAX_BUDGET_USD
    ? value
    : undefined;
}

/** The request's `budget` override for the limits the session set. */
export function budgetOverride(
  budget: SessionBudget | undefined,
): Record<string, number> | undefined {
  if (budget === undefined) return undefined;
  const out: Record<string, number> = {};
  if (budget.turn !== undefined) out.turnLimitUsd = budget.turn;
  if (budget.session !== undefined) out.sessionLimitUsd = budget.session;
  if (budget.day !== undefined) out.dailyLimitUsd = budget.day;
  if (budget.perCall !== undefined) out.perCallLimitUsd = budget.perCall;
  if (budget.runaway !== undefined) out.runawayStallUsd = budget.runaway;
  return Object.keys(out).length > 0 ? out : undefined;
}

const usd = (value: number | undefined): string =>
  value === undefined ? "unknown" : `$${value.toFixed(2)}`;

/**
 * The one budget line every surface prints: the REPLs at start and on
 * `/budget`, `dyfj status`, and `dyfj-l8 work`. The Rust REPL prints the same
 * text (`core/dyfj-repl/src/budget.rs`).
 */
export function formatBudgetLine(limits: SessionBudget): string {
  return `budget: turn ${usd(limits.turn)} · session ${
    usd(limits.session)
  } · today ${usd(limits.day)} · per call ${usd(limits.perCall)} · ` +
    `runaway ${usd(limits.runaway)} without tool progress`;
}
