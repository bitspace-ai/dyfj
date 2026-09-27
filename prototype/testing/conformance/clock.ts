// Conformance suite for the `Clock` port (`src/kernel/clock.ts`).
//
// The real `systemClock` and the `ManualClock` fake both run it in the unit
// lane: reading the platform clock needs no grant. Both must agree on what
// callers rely on: a reading is a finite whole number of epoch milliseconds
// that a `Date` can hold. It is a wall clock, so monotonicity is not part of
// the contract: the system clock can step backwards when it is adjusted, and a
// `ManualClock` can be set or scripted to any reading.
//
// The suite checks each subject as `make()` configures it. The system clock
// always meets the contract. `ManualClock` meets it for the readings a test
// gives it: it rejects non-finite readings itself, and its `date()` throws
// `RangeError` for a reading outside the `Date` range. A test that scripts a
// fractional or out-of-range reading is exercising that edge on purpose, so
// the fake does not refuse one (its own tests pin this).

import { assert, assertEquals } from "@std/assert";
import type { Clock } from "../../src/kernel/clock.ts";

export interface ClockConformanceSubject {
  name: string;
  /** A fresh clock with no scripted readings queued. */
  make(): Clock;
}

export function clockConformance(subject: ClockConformanceSubject): void {
  const run = (label: string, body: (clock: Clock) => void) => {
    Deno.test(`Clock conformance (${subject.name}): ${label}`, () => {
      body(subject.make());
    });
  };

  run("a reading is a finite whole number of milliseconds", (clock) => {
    const ms = clock.now();
    assert(Number.isFinite(ms), `reading ${ms} is not finite`);
    assert(Number.isInteger(ms), `reading ${ms} is not whole milliseconds`);
  });

  run("a reading converts to a valid Date at the same instant", (clock) => {
    const ms = clock.now();
    const date = new Date(ms);
    assert(!Number.isNaN(date.getTime()), `reading ${ms} is not a valid Date`);
    assertEquals(date.getTime(), ms);
  });
}
