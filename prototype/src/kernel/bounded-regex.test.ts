import { assertEquals, assertRejects, assertThrows } from "@std/assert";
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
    assertEquals(await matcher.matchLines(["a", "b1", "c", "b2"]), [1, 3]);
    // A second call reuses the same compiled pattern and worker.
    assertEquals(await matcher.matchLines(["bb"]), [0]);
  } finally {
    matcher.close();
  }
});

Deno.test("BoundedMatcher answers an empty batch without a worker", async () => {
  const matcher = new BoundedMatcher("x", { specifier: "data:," });
  assertEquals(await matcher.matchLines([]), []);
  matcher.close();
});

Deno.test("BoundedMatcher rejects an invalid or overlong pattern synchronously", () => {
  assertThrows(() => new BoundedMatcher("("), SyntaxError);
  assertThrows(
    () => new BoundedMatcher("a".repeat(MAX_PATTERN_LENGTH + 1)),
    Error,
    `longer than ${MAX_PATTERN_LENGTH} characters`,
  );
});

Deno.test("BoundedMatcher starts with the full default budget", () => {
  const matcher = new BoundedMatcher("a");
  assertEquals(matcher.remainingMs, DEFAULT_REGEX_BUDGET_MS);
  matcher.close();
});

// A pattern that actually runs out its budget mid-match is exercised through
// grep_files in file-tools.test.ts ("a catastrophic pattern is cut off instead
// of hanging"). Here an exhausted budget is reached deterministically.
Deno.test("BoundedMatcher with no budget left refuses to match and stays spent", async () => {
  const matcher = new BoundedMatcher("a", { budgetMs: 0 });
  try {
    assertEquals(matcher.remainingMs, 0);
    await assertRejects(() => matcher.matchLines(["a"]), RegexBudgetExceeded);
    await assertRejects(() => matcher.matchLines(["a"]), RegexBudgetExceeded);
  } finally {
    matcher.close();
  }
});

Deno.test("BoundedMatcher fails closed when the worker cannot start", async () => {
  const matcher = new BoundedMatcher("a", { specifier: "not a url" });
  try {
    await assertRejects(() => matcher.matchLines(["a"]), RegexUnavailable);
  } finally {
    matcher.close();
  }
});
