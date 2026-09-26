import { assertEquals, assertThrows } from "@std/assert";
import { ManualClock } from "./manual-clock.ts";

Deno.test("ManualClock starts at zero and moves only when told", () => {
  const clock = new ManualClock();
  assertEquals(clock.now(), 0);
  assertEquals(clock.now(), 0);
  clock.advance(250);
  assertEquals(clock.now(), 250);
  clock.set(1_000);
  assertEquals(clock.now(), 1_000);
});

Deno.test("ManualClock honours a start time", () => {
  assertEquals(new ManualClock({ start: 42 }).now(), 42);
});

Deno.test("ManualClock replays readings, then holds the last one", () => {
  const readings = [0, 10, 30];
  const clock = new ManualClock({ readings });
  assertEquals(clock.pendingReadings, 3);
  assertEquals([clock.now(), clock.now(), clock.now()], [0, 10, 30]);
  assertEquals(clock.pendingReadings, 0);
  assertEquals(clock.now(), 30);
  // The caller's array is copied, not consumed.
  assertEquals(readings, [0, 10, 30]);
});

Deno.test("ManualClock advances from the last replayed reading", () => {
  const clock = new ManualClock({ readings: [100] });
  assertEquals(clock.now(), 100);
  clock.advance(5);
  assertEquals(clock.now(), 105);
});

Deno.test("ManualClock.now and date are bound for injection", () => {
  const clock = new ManualClock({ start: Date.UTC(2026, 0, 1) });
  const now: () => number = clock.now;
  const date: () => Date = clock.date;
  assertEquals(now(), Date.UTC(2026, 0, 1));
  assertEquals(date().toISOString(), "2026-01-01T00:00:00.000Z");
});

Deno.test("ManualClock rejects backward or non-finite steps", () => {
  const clock = new ManualClock();
  assertThrows(() => clock.advance(-1), RangeError);
  assertThrows(() => clock.advance(Number.NaN), RangeError);
  assertThrows(() => clock.set(Number.POSITIVE_INFINITY), RangeError);
  assertEquals(clock.now(), 0);
});

Deno.test("ManualClock rejects non-finite start or readings", () => {
  assertThrows(() => new ManualClock({ start: Number.NaN }), RangeError);
  assertThrows(
    () => new ManualClock({ readings: [0, Number.POSITIVE_INFINITY] }),
    RangeError,
  );
});

Deno.test("ManualClock.advance cannot overflow to Infinity", () => {
  const clock = new ManualClock({ start: Number.MAX_VALUE });
  assertThrows(() => clock.advance(Number.MAX_VALUE), RangeError);
  assertEquals(clock.now(), Number.MAX_VALUE);
});
