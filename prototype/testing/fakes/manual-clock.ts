// Test fake for the `Clock` port: time moves only when the test says so.
//
// A clock either advances explicitly (`advance`, `set`) or replays scripted
// readings: each `now()` call consumes the next reading and, once they run
// out, keeps returning the last one. `now` and `date` are bound, so they can
// be passed directly where code takes a `() => number` or `() => Date`.

export interface ManualClockOptions {
  /** The first reading when no scripted reading is queued. Default 0. */
  start?: number;
  /** Readings returned by successive `now()` calls, in order. */
  readings?: readonly number[];
}

export class ManualClock {
  #current: number;
  readonly #readings: number[];

  constructor(options: ManualClockOptions = {}) {
    const start = options.start ?? 0;
    const readings = [...(options.readings ?? [])];
    if (![start, ...readings].every(Number.isFinite)) {
      throw new RangeError("ManualClock start and readings must be finite ms");
    }
    this.#current = start;
    this.#readings = readings;
  }

  /** Milliseconds; consumes the next scripted reading if one is queued. */
  readonly now = (): number => {
    const next = this.#readings.shift();
    if (next !== undefined) this.#current = next;
    return this.#current;
  };

  /** `now()` as a `Date`, for code that takes a `() => Date` clock. */
  readonly date = (): Date => new Date(this.now());

  /** Moves the clock forward. Negative steps are rejected. */
  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new RangeError("ManualClock.advance requires a finite ms >= 0");
    }
    const next = this.#current + ms;
    if (!Number.isFinite(next)) {
      throw new RangeError("ManualClock.advance would leave the finite range");
    }
    this.#current = next;
  }

  set(ms: number): void {
    if (!Number.isFinite(ms)) {
      throw new RangeError("ManualClock.set requires a finite ms");
    }
    this.#current = ms;
  }

  /** Scripted readings not yet consumed. */
  get pendingReadings(): number {
    return this.#readings.length;
  }
}
