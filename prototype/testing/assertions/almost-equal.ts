// An approximate equality assertion for numbers. `node:assert` has none; this
// reproduces `@std/assert`'s `assertAlmostEquals` (1.0.19): equal values
// (by `Object.is`, so NaN matches NaN) pass, and otherwise the difference must
// be within the tolerance, by default one ten-millionth of the expected value
// (1e-7 when the expected value is not finite). The failure message is std's.
import assert from "node:assert/strict";

/** Fails unless `actual` is within `tolerance` of `expected`. */
export function assertAlmostEqual(
  actual: number,
  expected: number,
  tolerance?: number,
  msg?: string,
): void {
  if (Object.is(actual, expected)) return;
  const delta = Math.abs(expected - actual);
  const limit = tolerance === undefined
    ? Number.isFinite(expected) ? Math.abs(expected * 1e-7) : 1e-7
    : tolerance;
  if (delta <= limit) return;
  const f = (n: number) => Number.isInteger(n) ? n : n.toExponential();
  assert.fail(
    `Expected actual: "${f(actual)}" to be close to "${f(expected)}": ` +
      `delta "${f(delta)}" is greater than "${f(limit)}"${
        msg ? `: ${msg}` : "."
      }`,
  );
}
