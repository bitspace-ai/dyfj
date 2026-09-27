// Scope-persistent budget-ceiling confirmations.
//
// The marks live in runtime-process memory for the life of the engine process;
// the session owner takes over as their single writer when the engine grows
// one (specs/01-architecture.md §5.7).

import { type Clock, systemClock } from "../kernel/mod.ts";
import { localDayKey } from "./spend.ts";

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
  clock: Clock = systemClock,
): BudgetCeilingConfirmations {
  const dayKey = localDayKey(new Date(clock.now()));
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
