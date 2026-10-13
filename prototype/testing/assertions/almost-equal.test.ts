import assert from "node:assert/strict";
import { test } from "node:test";
import { assertAlmostEqual } from "./almost-equal.ts";

function failureMessage(fn: () => void): string {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof assert.AssertionError, "expected a failure");
  return caught.message;
}

test("assertAlmostEqual passes on equal values", () => {
  assertAlmostEqual(0.25, 0.25);
  assertAlmostEqual(0, -0);
});

test("assertAlmostEqual's default tolerance is 1e-7 of the expected value", () => {
  assertAlmostEqual(0.1 + 0.2, 0.3);
  assertAlmostEqual(1.000000001e-8, 1.000000002e-8);
  assertAlmostEqual(100 + 9e-6, 100);
  assert.throws(() => assertAlmostEqual(100 + 1.1e-5, 100));
  assert.throws(() => assertAlmostEqual(1e-8, 1e-9));
  assert.throws(() => assertAlmostEqual(0.01, 0.02));
});

test("assertAlmostEqual's default tolerance is 1e-7 for a non-finite expected value", () => {
  assert.throws(() => assertAlmostEqual(0, Number.NaN));
  assert.throws(() => assertAlmostEqual(1e300, Infinity));
});

test("assertAlmostEqual uses an explicit tolerance", () => {
  assertAlmostEqual(0.01, 0.02, 0.1);
  assertAlmostEqual(0.1 + 0.2, 0.3, 1e-16);
  assertAlmostEqual(1, 1.5, 0.5);
  assert.throws(() => assertAlmostEqual(0.1 + 0.2, 0.3, 1e-17));
  assert.throws(() => assertAlmostEqual(1, 1.5, 0.49));
});

test("assertAlmostEqual takes an undefined tolerance as the default", () => {
  assertAlmostEqual(0.1 + 0.2, 0.3, undefined, "sum");
  assert.throws(() => assertAlmostEqual(0.01, 0.02, undefined, "sum"));
});

test("assertAlmostEqual passes NaN against NaN and fails it against a number", () => {
  assertAlmostEqual(Number.NaN, Number.NaN);
  assert.throws(() => assertAlmostEqual(Number.NaN, 1));
  assert.throws(() => assertAlmostEqual(1, Number.NaN));
  assert.throws(() => assertAlmostEqual(Number.NaN, 1, Infinity));
});

test("assertAlmostEqual passes an infinity only against itself", () => {
  assertAlmostEqual(Infinity, Infinity);
  assertAlmostEqual(-Infinity, -Infinity);
  assert.throws(() => assertAlmostEqual(Infinity, -Infinity));
  assert.throws(() => assertAlmostEqual(-Infinity, Infinity));
  assert.throws(() => assertAlmostEqual(Infinity, 1e308));
  assert.throws(() => assertAlmostEqual(Infinity, 1, Number.MAX_VALUE));
});

test("assertAlmostEqual's failure message names both values, the delta and the tolerance", () => {
  assert.equal(
    failureMessage(() => assertAlmostEqual(0.01, 0.02)),
    'Expected actual: "1e-2" to be close to "2e-2": delta "1e-2" is ' +
      'greater than "2e-9".',
  );
  assert.equal(
    failureMessage(() => assertAlmostEqual(3, 5, 1)),
    'Expected actual: "3" to be close to "5": delta "2" is greater than "1".',
  );
});

test("assertAlmostEqual appends its message after a colon", () => {
  assert.equal(
    failureMessage(() => assertAlmostEqual(3, 5, 1, "cost total")),
    'Expected actual: "3" to be close to "5": delta "2" is greater than ' +
      '"1": cost total',
  );
  assert.equal(
    failureMessage(() => assertAlmostEqual(3, 5, 1, "")),
    'Expected actual: "3" to be close to "5": delta "2" is greater than "1".',
  );
});

test("assertAlmostEqual names infinities and NaN in its message", () => {
  assert.equal(
    failureMessage(() => assertAlmostEqual(Infinity, -Infinity)),
    'Expected actual: "Infinity" to be close to "-Infinity": delta ' +
      '"Infinity" is greater than "1e-7".',
  );
  assert.equal(
    failureMessage(() => assertAlmostEqual(Number.NaN, 1)),
    'Expected actual: "NaN" to be close to "1": delta "NaN" is greater ' +
      'than "1e-7".',
  );
});
