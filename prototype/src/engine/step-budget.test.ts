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
  // Inside the granted chunk there is nothing to decide: the extension is
  // asked once per chunk, at the limit the turn is running under.
  assert.deepStrictEqual(budget.decide(outcome(5)), { kind: "continue" });
  assert.deepStrictEqual(budget.decide(outcome(6)), {
    kind: "extended",
    from: 6,
    to: 8,
  });
  // Extension repeats while progress continues, and never passes the ceiling.
  for (let step = 7; step < 20; step++) budget.decide(outcome(step));
  assert.strictEqual(budget.effectiveLimit, 12);
});

test("an extension is asked once per chunk, and never re-records the same bound", () => {
  const budget = new StepBudget({
    softLimit: 32,
    ceiling: 128,
    extension: true,
  });
  const extensions: Array<{ from: number; to: number }> = [];
  for (let step = 1; step <= 128; step++) {
    const decision = budget.decide(outcome(step));
    if (decision.kind === "extended") {
      extensions.push({ from: decision.from, to: decision.to });
    }
  }
  // A no-op extension (from === to) would be a decision that changed nothing,
  // so the log would carry rows that say nothing happened.
  for (const extension of extensions) {
    assert.ok(
      extension.to > extension.from,
      `extension ${extension.from} -> ${extension.to} changed nothing`,
    );
  }
  // 32 -> 128 in chunks of 16 is six extensions, one per chunk reached.
  assert.deepStrictEqual(extensions, [
    { from: 32, to: 48 },
    { from: 48, to: 64 },
    { from: 64, to: 80 },
    { from: 80, to: 96 },
    { from: 96, to: 112 },
    { from: 112, to: 128 },
  ]);
  assert.strictEqual(budget.effectiveLimit, 128);
});

test("a productive turn runs past 64 steps toward the 128 default ceiling", () => {
  const budget = new StepBudget({
    softLimit: 32,
    ceiling: 128,
    extension: true,
  });
  for (let step = 1; step <= 64; step++) budget.decide(outcome(step));
  // The bound the issue is about: a turn making progress at step 64 is not
  // interrupted there.
  assert.strictEqual(budget.stopped, false);
  assert.strictEqual(budget.allowsAnotherStep(64), true);
  assert.strictEqual(budget.effectiveLimit, 80);
});

test("a turn with extension off reaches its limit and records nothing", () => {
  const budget = new StepBudget({ ...POLICY, extension: false });
  // A fixed-limit turn has no decision to record and no stop of its own: it
  // ends where it always did, and the loop reads that from `atLimit`.
  assert.deepStrictEqual(budget.decide(outcome(4)), { kind: "continue" });
  assert.strictEqual(budget.effectiveLimit, 4);
  assert.strictEqual(budget.stalledSteps, 0);
  assert.strictEqual(budget.stopReason, undefined);
  assert.strictEqual(budget.atLimit(4), true);
  assert.strictEqual(budget.allowsAnotherStep(4), false);
});

test("a turn at its safety ceiling stops even while productive", () => {
  const budget = new StepBudget({ ...POLICY, softLimit: 12 });
  assert.deepStrictEqual(budget.decide(outcome(12)), {
    kind: "stop",
    reason: "ceiling",
    effectiveLimit: 12,
  });
});

test("an unproductive step at the limit ends tool use there, with no chunk", () => {
  const budget = new StepBudget(POLICY);
  // Nothing was earned, so the limit does not move and there is no room for
  // the next step: the turn ends on the stall rather than burning a step.
  assert.deepStrictEqual(budget.decide(outcome(4, false)), {
    kind: "stop",
    reason: "stall",
    effectiveLimit: 4,
  });
  assert.strictEqual(budget.stalledSteps, 1);
  assert.strictEqual(STALL_STEPS, 2);
});

test("inside a granted chunk, one unproductive step is tolerated", () => {
  const budget = new StepBudget(POLICY);
  assert.strictEqual(budget.decide(outcome(4)).kind, "extended");
  assert.deepStrictEqual(budget.decide(outcome(5, false)), {
    kind: "continue",
  });
  assert.strictEqual(budget.stalledSteps, 1);
  // The second in a row ends the turn, at the limit it was running under.
  assert.deepStrictEqual(budget.decide(outcome(6, false)), {
    kind: "stop",
    reason: "stall",
    effectiveLimit: 6,
  });
});

test("an unproductive step never extends the limit", () => {
  for (const soft of [4, 32]) {
    const budget = new StepBudget({
      softLimit: soft,
      ceiling: 128,
      extension: true,
    });
    const before = budget.effectiveLimit;
    const decision = budget.decide(outcome(soft, false));
    assert.strictEqual(
      decision.kind === "extended",
      false,
      `soft ${soft}: an unproductive step extended ${JSON.stringify(decision)}`,
    );
    assert.strictEqual(budget.effectiveLimit, before);
  }
});

test("one productive step clears the stall streak", () => {
  const budget = new StepBudget(POLICY);
  budget.decide(outcome(4));
  budget.decide(outcome(5, false));
  assert.strictEqual(budget.stalledSteps, 1);
  budget.decide(outcome(6, true));
  assert.strictEqual(budget.stalledSteps, 0);
});

test("the stall streak keeps counting past the soft limit, not only at it", () => {
  const budget = new StepBudget(POLICY);
  // A productive step at the soft limit extends to 6 and clears the streak.
  assert.strictEqual(budget.decide(outcome(4)).kind, "extended");
  // An unproductive step inside the granted chunk counts, without deciding.
  assert.deepStrictEqual(budget.decide(outcome(5, false)), {
    kind: "continue",
  });
  assert.strictEqual(budget.stalledSteps, 1);
  assert.strictEqual(budget.effectiveLimit, 6);
  // The next unproductive step ends the turn at the limit it had.
  assert.deepStrictEqual(budget.decide(outcome(6, false)), {
    kind: "stop",
    reason: "stall",
    effectiveLimit: 6,
  });
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
