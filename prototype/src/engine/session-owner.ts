/**
 * Session ownership (specs/01-architecture.md §5.7): the single writer for a
 * session's turn lock, its budget scope, and the cancel signal of each turn
 * it runs.
 *
 * - `SessionOwners` is the engine's registry, built once by the composition
 *   root. It holds one `SessionOwner` per session that has a turn queued or
 *   running, and drops it when its last turn settles.
 * - A `SessionOwner` serializes its session's turns: two concurrent turns on
 *   one session would each read the prior events and append their own,
 *   splitting the append-only log. A second turn runs after the first rather
 *   than being dropped. A turn with no session id starts a new session: its id
 *   is allocated when the turn is admitted, and its owner is registered under
 *   that id before the turn runs, so a later turn naming it queues behind it.
 * - The budget scope is the session's budget-ceiling confirmations: an
 *   operator-confirmed overrun raises the envelope for its scope period
 *   instead of re-prompting every turn. The owners hold the confirmation
 *   store; a turn reaches its session's scope only through `budgetScope`.
 * - A `TurnTicket` is one admitted turn's cancel signal. It exists from
 *   admission, before the turn holds the lock, so a cancel that arrives while
 *   the turn waits still lands. Other code changes it only by sending it a
 *   message: `cancel`, `abort`, or `closeCancellation`.
 */
import {
  type BudgetCeilingConfirmations,
  CeilingConfirmationStore,
} from "../budget/mod.ts";
import { generateULID } from "../kernel/mod.ts";

/** One admitted turn's cancel signal and its cancellation window. */
export class TurnTicket {
  readonly #controller = new AbortController();
  #acceptingCancellation = true;

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  /**
   * A client's cancel request. Honored only while the cancellation window is
   * open, and closes it: a second cancel of the same turn is declined.
   */
  cancel(): boolean {
    if (!this.#acceptingCancellation) return false;
    this.#acceptingCancellation = false;
    this.#controller.abort();
    return true;
  }

  /**
   * Abort the turn regardless of the cancellation window: an approval that
   * the client reports as interrupted ends the turn it belongs to.
   */
  abort(): void {
    this.#controller.abort();
  }

  /** The runtime has begun finalizing; later cancel requests are declined. */
  closeCancellation(): void {
    this.#acceptingCancellation = false;
  }
}

/** The turn lock of one session: its turns run one at a time, in order. */
class SessionOwner {
  #tail: Promise<void> = Promise.resolve();

  /**
   * Queue `run` behind every turn already queued on this session. It starts
   * once the prior turn settles, whether that turn resolved or rejected.
   */
  enqueue<T>(
    run: () => Promise<T>,
  ): { result: Promise<T>; settled: Promise<void> } {
    const result = this.#tail.then(run, run);
    const settled = result.then(() => {}, () => {});
    this.#tail = settled;
    return { result, settled };
  }

  /** Whether `settled` is the last turn queued, so the session is now idle. */
  isTail(settled: Promise<void>): boolean {
    return this.#tail === settled;
  }
}

/** Where a turn finds its session's budget scope. */
export interface BudgetScopes {
  budgetScope(sessionId: string): BudgetCeilingConfirmations;
}

/** The engine's session owners, one per session with a turn in flight. */
export class SessionOwners implements BudgetScopes {
  readonly #owners = new Map<string, SessionOwner>();
  readonly #confirmations: CeilingConfirmationStore;

  /**
   * One per engine, so ceiling confirmations persist for their scope periods
   * across the engine's turns.
   */
  constructor(
    confirmations: CeilingConfirmationStore = new CeilingConfirmationStore(),
  ) {
    this.#confirmations = confirmations;
  }

  /**
   * The session's budget-ceiling confirmations: its per-call and session
   * marks, and the current local day's mark, which every session shares.
   */
  budgetScope(sessionId: string): BudgetCeilingConfirmations {
    return this.#confirmations.for(sessionId);
  }

  /** Admit a turn: issue its cancel signal before it takes the lock. */
  admit(): TurnTicket {
    return new TurnTicket();
  }

  /**
   * Run a turn under its session's lock. The owner is looked up and the turn
   * queued in the same synchronous step, so no two owners ever exist for one
   * session. A turn with no session id starts a new session: its id is
   * allocated here and its owner registered in that same step, and `run`
   * receives the id the turn must use.
   */
  runTurn<T>(
    sessionId: string | undefined,
    run: (sessionId: string) => Promise<T>,
  ): Promise<T> {
    const id = sessionId ?? generateULID();
    let owner = this.#owners.get(id);
    if (owner === undefined) {
      owner = new SessionOwner();
      this.#owners.set(id, owner);
    }
    const queued = owner.enqueue(() => run(id));
    const current = owner;
    void queued.settled.finally(() => {
      // Drop the owner once this turn is its last, so the registry does not
      // grow with every session ever served.
      if (
        this.#owners.get(id) === current &&
        current.isTail(queued.settled)
      ) {
        this.#owners.delete(id);
      }
    });
    return queued.result;
  }

  /** How many sessions have a turn queued or running. */
  get activeSessions(): number {
    return this.#owners.size;
  }
}
