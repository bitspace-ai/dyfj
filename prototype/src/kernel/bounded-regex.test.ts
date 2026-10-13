import assert from "node:assert/strict";
import {
  BoundedMatcher,
  DEFAULT_REGEX_BUDGET_MS,
  MAX_PATTERN_LENGTH,
  RegexBudgetExceeded,
  RegexUnavailable,
} from "./bounded-regex.ts";

Deno.test("BoundedMatcher returns the indices of matching lines", async () => {
  const matcher = new BoundedMatcher("^b");
  try {
    assert.deepStrictEqual(await matcher.matchLines(["a", "b1", "c", "b2"]), [
      1,
      3,
    ]);
    // A second call reuses the same compiled pattern and worker.
    assert.deepStrictEqual(await matcher.matchLines(["bb"]), [0]);
  } finally {
    matcher.close();
  }
});

Deno.test("BoundedMatcher answers an empty batch without a worker", async () => {
  const matcher = new BoundedMatcher("x", { specifier: "data:," });
  assert.deepStrictEqual(await matcher.matchLines([]), []);
  matcher.close();
});

Deno.test("BoundedMatcher rejects an invalid or overlong pattern synchronously", () => {
  assert.throws(() => new BoundedMatcher("("), SyntaxError);
  assert.throws(
    () => new BoundedMatcher("a".repeat(MAX_PATTERN_LENGTH + 1)),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes(`longer than ${MAX_PATTERN_LENGTH} characters`),
  );
});

Deno.test("BoundedMatcher starts with the full default budget", () => {
  const matcher = new BoundedMatcher("a");
  assert.deepStrictEqual(matcher.remainingMs, DEFAULT_REGEX_BUDGET_MS);
  matcher.close();
});

// A pattern that actually runs out its budget mid-match is exercised through
// grep_files in tools/builtin/file.test.ts ("a catastrophic pattern is cut off instead
// of hanging"). Here an exhausted budget is reached deterministically.
Deno.test("BoundedMatcher with no budget left refuses to match and stays spent", async () => {
  const matcher = new BoundedMatcher("a", { budgetMs: 0 });
  try {
    assert.deepStrictEqual(matcher.remainingMs, 0);
    await assert.rejects(() => matcher.matchLines(["a"]), RegexBudgetExceeded);
    await assert.rejects(() => matcher.matchLines(["a"]), RegexBudgetExceeded);
  } finally {
    matcher.close();
  }
});

Deno.test("BoundedMatcher fails closed when the worker cannot start", async () => {
  const matcher = new BoundedMatcher("a", { specifier: "not a url" });
  try {
    await assert.rejects(() => matcher.matchLines(["a"]), RegexUnavailable);
  } finally {
    matcher.close();
  }
});
