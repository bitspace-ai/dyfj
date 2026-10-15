import assert from "node:assert/strict";
import { test } from "node:test";
import { ManualClock } from "./manual-clock.ts";

test("ManualClock starts at zero and moves only when told", () => {
  const clock = new ManualClock();
  assert.deepStrictEqual(clock.now(), 0);
  assert.deepStrictEqual(clock.now(), 0);
  clock.advance(250);
  assert.deepStrictEqual(clock.now(), 250);
  clock.set(1_000);
  assert.deepStrictEqual(clock.now(), 1_000);
});

test("ManualClock honours a start time", () => {
  assert.deepStrictEqual(new ManualClock({ start: 42 }).now(), 42);
});

test("ManualClock replays readings, then holds the last one", () => {
  const readings = [0, 10, 30];
  const clock = new ManualClock({ readings });
  assert.deepStrictEqual(clock.pendingReadings, 3);
  assert.deepStrictEqual([clock.now(), clock.now(), clock.now()], [0, 10, 30]);
  assert.deepStrictEqual(clock.pendingReadings, 0);
  assert.deepStrictEqual(clock.now(), 30);
  // The caller's array is copied, not consumed.
  assert.deepStrictEqual(readings, [0, 10, 30]);
});

test("ManualClock advances from the last replayed reading", () => {
  const clock = new ManualClock({ readings: [100] });
  assert.deepStrictEqual(clock.now(), 100);
  clock.advance(5);
  assert.deepStrictEqual(clock.now(), 105);
});

test("ManualClock.now and date are bound for injection", () => {
  const clock = new ManualClock({ start: Date.UTC(2026, 0, 1) });
  const now: () => number = clock.now;
  const date: () => Date = clock.date;
  assert.deepStrictEqual(now(), Date.UTC(2026, 0, 1));
  assert.deepStrictEqual(date().toISOString(), "2026-01-01T00:00:00.000Z");
});

test("ManualClock rejects backward or non-finite steps", () => {
  const clock = new ManualClock();
  assert.throws(() => clock.advance(-1), RangeError);
  assert.throws(() => clock.advance(Number.NaN), RangeError);
  assert.throws(() => clock.set(Number.POSITIVE_INFINITY), RangeError);
  assert.deepStrictEqual(clock.now(), 0);
});

test("ManualClock rejects non-finite start or readings", () => {
  assert.throws(() => new ManualClock({ start: Number.NaN }), RangeError);
  assert.throws(
    () => new ManualClock({ readings: [0, Number.POSITIVE_INFINITY] }),
    RangeError,
  );
});

test("ManualClock.advance cannot overflow to Infinity", () => {
  const clock = new ManualClock({ start: Number.MAX_VALUE });
  assert.throws(() => clock.advance(Number.MAX_VALUE), RangeError);
  assert.deepStrictEqual(clock.now(), Number.MAX_VALUE);
});

test("ManualClock.date rejects a reading outside the Date range", () => {
  const clock = new ManualClock({ start: Number.MAX_VALUE });
  assert.deepStrictEqual(clock.now(), Number.MAX_VALUE);
  assert.throws(() => clock.date(), RangeError);
});
