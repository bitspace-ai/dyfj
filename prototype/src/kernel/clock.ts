// The `Clock` port (specs/01-architecture.md §5.6): the one way runtime code
// reads wall-clock time, so a test can hold time still or move it with the
// `ManualClock` fake (prototype/testing/fakes/manual-clock.ts). Both pass the
// conformance suite in prototype/testing/conformance/clock.ts.

export interface Clock {
  /**
   * Wall-clock milliseconds since the Unix epoch. Not monotonic: the reading
   * can step backwards when the system clock is adjusted.
   */
  now(): number;
}

/** The real adapter: the platform clock. */
export const systemClock: Clock = { now: () => Date.now() };
