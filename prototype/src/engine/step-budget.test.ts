/**
 * Unit tests for the progress-aware tool-step budget (BIT-992): the policy
 * that lets a productive turn run past its soft step budget up to a safety
 * ceiling, and stops a stalled one early.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extensionChunk,
  STALL_STEPS,
  StepBudget,
  type StepBudgetPolicy,
} from "./step-budget.ts";

const POLICY: StepBudgetPolicy = {
  softLimit: 4,
  ceiling: 12,
  extension: true,
};

/** One step's outcome; a productive step by default. */
function outcome(
  step: number,
  productive = true,
  overrides: Partial<{
    turnSpentUsd: number;
    stallSpentUsd: number;
    turnLimitUsd: number;
    runawayStallUsd: number;
  }> = {},
) {
  return {
    step,
    productive,
    turnSpentUsd: 0.01,
    stallSpentUsd: 0,
    turnLimitUsd: 4,
    runawayStallUsd: 0.5,
    ...overrides,
  };
}

test("a turn inside its soft budget continues without deciding anything", () => {
  const budget = new StepBudget(POLICY);
  assert.strictEqual(budget.effectiveLimit, 4);
  assert.strictEqual(budget.allowsAnotherStep(0), true);
  assert.strictEqual(budget.allowsAnotherStep(3), true);
  assert.strictEqual(budget.atLimit(3), false);
  assert.deepStrictEqual(budget.decide(outcome(3)), { kind: "continue" });
});

test("a productive turn past its soft budget extends toward the ceiling", () => {
  const budget = new StepBudget(POLICY);
  const decision = budget.decide(outcome(4));
  assert.deepStrictEqual(decision, {
    kind: "extended",
    from: 4,
    to: 4 + extensionChunk(4),
  });
  assert.strictEqual(budget.effectiveLimit, 4 + extensionChunk(4));
  assert.strictEqual(budget.allowsAnotherStep(4), true);
  // Extension repeats while progress continues, and never passes the ceiling.
  for (let step = 5; step < 20; step++) budget.decide(outcome(step));
  assert.strictEqual(budget.effectiveLimit, 12);
});

test("a turn with no extension policy stops at its soft budget", () => {
  const budget = new StepBudget({ ...POLICY, extension: false });
  assert.deepStrictEqual(budget.decide(outcome(4)), {
    kind: "stop",
    reason: "limit",
    effectiveLimit: 4,
  });
});

test("a turn at its safety ceiling stops even while productive", () => {
  const budget = new StepBudget({ ...POLICY, softLimit: 12 });
  assert.deepStrictEqual(budget.decide(outcome(12)), {
    kind: "stop",
    reason: "ceiling",
    effectiveLimit: 12,
  });
});

test("a stalled turn stops early, after the stall tolerance", () => {
  const budget = new StepBudget(POLICY);
  // The first unproductive step at the soft budget gets one more chance.
  assert.strictEqual(budget.decide(outcome(4, false)).kind, "extended");
  assert.strictEqual(budget.stalledSteps, 1);
  // The second consecutive one stops the turn.
  assert.deepStrictEqual(budget.decide(outcome(5, false)), {
    kind: "stop",
    reason: "stall",
    effectiveLimit: 4 + extensionChunk(4),
  });
  assert.strictEqual(STALL_STEPS, 2);
});

test("one productive step clears the stall streak", () => {
  const budget = new StepBudget(POLICY);
  budget.decide(outcome(4, false));
  assert.strictEqual(budget.stalledSteps, 1);
  budget.decide(outcome(5, true));
  assert.strictEqual(budget.stalledSteps, 0);
});

test("a turn with no spend headroom stops before extending", () => {
  const budget = new StepBudget(POLICY);
  // The turn limit is spent: no extension, whatever the progress.
  assert.deepStrictEqual(
    budget.decide(outcome(4, true, { turnSpentUsd: 4, turnLimitUsd: 4 })),
    { kind: "stop", reason: "budget", effectiveLimit: 4 },
  );
  // The runaway limit is spent: the same precedence.
  const stalled = new StepBudget(POLICY);
  assert.deepStrictEqual(
    stalled.decide(
      outcome(4, true, { stallSpentUsd: 0.5, runawayStallUsd: 0.5 }),
    ),
    { kind: "stop", reason: "budget", effectiveLimit: 4 },
  );
});

test("the ceiling is the hard stop even when the soft limit is above it", () => {
  const budget = new StepBudget({ softLimit: 20, ceiling: 8, extension: true });
  assert.strictEqual(budget.effectiveLimit, 8);
  assert.deepStrictEqual(budget.decide(outcome(8)), {
    kind: "stop",
    reason: "ceiling",
    effectiveLimit: 8,
  });
});

test("a ceiling below the soft limit is not a licence to run past the ceiling", () => {
  const budget = new StepBudget({ softLimit: 6, ceiling: 6, extension: true });
  assert.strictEqual(budget.effectiveLimit, 6);
  assert.strictEqual(budget.decide(outcome(6)).kind, "stop");
});

test("the extension chunk is a positive fraction of the soft budget", () => {
  for (const soft of [1, 2, 3, 32, 64]) {
    const chunk = extensionChunk(soft);
    assert.ok(Number.isInteger(chunk) && chunk >= 1, `chunk for ${soft}`);
    assert.ok(chunk <= soft, `chunk for ${soft}`);
  }
  assert.strictEqual(extensionChunk(32), 16);
});
