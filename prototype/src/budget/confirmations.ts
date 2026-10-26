// Scope-persistent budget marks, held by one `CeilingConfirmationStore`
// instance per engine (AGENTS.md rule 3: a single owner, no module-level
// state).

import { type Clock, systemClock } from "../kernel/mod.ts";
import { localDayKey } from "./spend.ts";

/**
 * Operator-approved budget levels. Each mark is a level, not a coverage
 * promise: a scope prompts again only when its projection passes the level
 * the last approval raised it to (BIT-715).
 *
 * - `per_call_limit`: the largest per-call estimate approved so far, raised
 *   to PER_CALL_HEADROOM (2×) that estimate by each approval; kept per session.
 * - `session_limit`: the projected session spend plus one session envelope,
 *   set by each session approval; kept per session.
 * - `daily_limit`: the projected spend today plus one daily envelope, set by
 *   each daily approval; kept per day across sessions.
 *
 * Each mark is kept with its basis: the limit in force when it was approved.
 * A mark applies only while the limit in force equals that basis, so a limit
 * the operator sets to a different value for a session is not overridden by
 * an approval given against the old one.
 *
 * The turn and runaway marks are not stored here: they last one turn and
 * live in the turn's spend gate (envelope-gate.ts).
 *
 * All of it lives in runtime-process memory, so a restart forgets the marks
 * (the safe direction).
 */
export interface BudgetCeilingConfirmations {
  per_call_limit?: number;
  session_limit?: number;
  daily_limit?: number;
  /** The limit each mark above was approved against. */
  per_call_limit_basis?: number;
  session_limit_basis?: number;
  daily_limit_basis?: number;
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
      get per_call_limit_basis() {
        return session.per_call_limit_basis;
      },
      set per_call_limit_basis(v: number | undefined) {
        session.per_call_limit_basis = v;
      },
      get session_limit_basis() {
        return session.session_limit_basis;
      },
      set session_limit_basis(v: number | undefined) {
        session.session_limit_basis = v;
      },
      get daily_limit() {
        return daily.daily_limit;
      },
      set daily_limit(v: number | undefined) {
        daily.daily_limit = v;
      },
      get daily_limit_basis() {
        return daily.daily_limit_basis;
      },
      set daily_limit_basis(v: number | undefined) {
        daily.daily_limit_basis = v;
      },
    };
  }
}
