// Spend baselines and the local-day boundary for the session and daily
// envelopes. Time comes through the `Clock` port so a test can pin the day.

import { type Clock, systemClock } from "../kernel/mod.ts";
import type { SpendReader } from "../store/mod.ts";
import type { SpendBaselines } from "./tracker.ts";

/** Start of the local day, in the clock the Dolt server stamps created_at with. */
export function localDayStart(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d} 00:00:00`;
}

/** Local-day key for scope-persistent ceiling confirmations. */
export function localDayKey(now: Date): string {
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
 * the README boundaries). The rollup is the store's spend reader, so it is
 * testable against the store fakes.
 */
export async function fetchSpendBaselines(
  spend: SpendReader,
  sessionId: string,
  clock: Clock = systemClock,
): Promise<SpendBaselines> {
  return await spend.baselines(sessionId, localDayStart(new Date(clock.now())));
}
