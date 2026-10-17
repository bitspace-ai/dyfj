/**
 * The runtime's lifetime: the one owner of how many clients are connected,
 * and, for a runtime `dyfj` autostarted, when it stops.
 *
 * An autostarted runtime belongs to the `dyfj` invocations that use it. It
 * stops through `onIdle` once no client has been connected for the grace
 * (10 s), so back-to-back calls share one runtime and nothing is left
 * running after the last one. A client connecting inside the grace cancels
 * the stop, and the next disconnect starts a full grace again. A runtime
 * started with `dyfj start` is the operator's: it counts its clients for
 * `runtime/status` and stays up until `dyfj stop`.
 *
 * The transport reports each change in the connection count
 * (`clientsChanged`); nothing else writes it. The grace starts at `start()`
 * as well as at each last disconnect, so a runtime that no client ever
 * reaches stops too. A turn still in flight when the grace ends (its client
 * gone) holds the runtime for another grace rather than being cut off.
 */

/** How long an autostarted runtime waits after its last client leaves. */
export const AUTOSTARTED_IDLE_GRACE_MS = 10_000;

/** The timer port, so a test can run the grace without waiting it out. */
export interface LifetimeTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemTimers: LifetimeTimers = {
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    // The listener keeps the process alive while it serves; the grace timer
    // must not keep it alive on its own.
    handle.unref();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface RuntimeLifetimeOptions {
  /** Started by the launcher's autostart (`--launcher-autostarted`). */
  autostarted: boolean;
  /** The engine's count of turns not yet settled. */
  inFlightTurns: () => number;
  /** Stop the runtime; called at most once. */
  onIdle: () => void;
  graceMs?: number;
  timers?: LifetimeTimers;
}

export class RuntimeLifetime {
  readonly #autostarted: boolean;
  readonly #inFlightTurns: () => number;
  readonly #onIdle: () => void;
  readonly #graceMs: number;
  readonly #timers: LifetimeTimers;
  #clients = 0;
  #timer: unknown;
  #stopped = false;

  constructor(options: RuntimeLifetimeOptions) {
    this.#autostarted = options.autostarted;
    this.#inFlightTurns = options.inFlightTurns;
    this.#onIdle = options.onIdle;
    this.#graceMs = options.graceMs ?? AUTOSTARTED_IDLE_GRACE_MS;
    this.#timers = options.timers ?? systemTimers;
  }

  /** Connected clients, as the transport last reported. */
  get clients(): number {
    return this.#clients;
  }

  /** The runtime is serving; with no client yet, the grace starts now. */
  start(): void {
    if (this.#clients === 0) this.#arm();
  }

  clientsChanged(count: number): void {
    this.#clients = count;
    if (count > 0) this.#disarm();
    else this.#arm();
  }

  /** Cancels a pending stop; the runtime is closing some other way. */
  dispose(): void {
    this.#disarm();
    this.#stopped = true;
  }

  #arm(): void {
    if (!this.#autostarted || this.#stopped) return;
    this.#disarm();
    this.#timer = this.#timers.setTimeout(() => this.#expire(), this.#graceMs);
  }

  #disarm(): void {
    if (this.#timer === undefined) return;
    this.#timers.clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #expire(): void {
    this.#timer = undefined;
    if (this.#clients > 0 || this.#stopped) return;
    if (this.#inFlightTurns() > 0) {
      this.#arm();
      return;
    }
    this.#stopped = true;
    this.#onIdle();
  }
}
