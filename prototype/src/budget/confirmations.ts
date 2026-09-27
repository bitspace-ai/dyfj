// Scope-persistent budget-ceiling confirmations, held by one
// `CeilingConfirmationStore` instance per engine (AGENTS.md rule 3: a single
// owner, no module-level state).

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

/**
 * The ceiling confirmation store: the single owner of the scope-persistent
 * confirmation marks. The composition root builds one per engine and hands it
 * to the runtime through its services, so the marks live as long as the
 * engine process and a restart forgets them (the safe direction).
 */
export class CeilingConfirmationStore {
  readonly #session = new Map<string, BudgetCeilingConfirmations>();
  readonly #daily = new Map<string, BudgetCeilingConfirmations>();
  readonly #clock: Clock;

  constructor(clock: Clock = systemClock) {
    this.#clock = clock;
  }

  /**
   * The confirmations for a turn: per-call/session marks live under the
   * session id; the daily mark lives under the local-day key (from the clock),
   * shared across sessions, so one confirmed daily overrun does not re-prompt
   * every session.
   */
  for(sessionId: string): BudgetCeilingConfirmations {
    const dayKey = localDayKey(new Date(this.#clock.now()));
    const session = boundedGet(this.#session, sessionId);
    const daily = boundedGet(this.#daily, dayKey);
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
}
