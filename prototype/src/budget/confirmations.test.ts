/**
 * Unit tests for budget/confirmations.ts: scope-persistent ceiling
 * confirmations keyed by session id and by the local day from the `Clock`.
 *
 * Each test builds its own `CeilingConfirmationStore`, so no state is shared
 * between tests.
 */

import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { ManualClock } from "../../testing/fakes/manual-clock.ts";
import { CeilingConfirmationStore } from "./confirmations.ts";
import {
  type BudgetCeilingVerdict,
  type BudgetCeilingWarning,
  createTurnBudgetCeilingGate,
} from "./envelope-gate.ts";
import type { PreCallCheck } from "./tracker.ts";

/** A clock pinned to local noon on the given day (month is 0-based). */
function clockOn(year: number, month: number, day: number): ManualClock {
  return new ManualClock({ start: new Date(year, month, day, 12).getTime() });
}

/** Turn and runaway figures far from their limits: these tests are about
 * the stored scopes. */
const turnBudget = {
  turnCostSoFar: 0,
  turnLimitUsd: 1000,
  stallCostSoFar: 0,
  runawayStallUsd: 1000,
};

function approving() {
  return mock.fn(
    (_warning: BudgetCeilingWarning): Promise<BudgetCeilingVerdict> =>
      Promise.resolve({ decision: "approve" }),
  );
}

test("daily envelope: a confirmed overrun raises the envelope for its scope across turns", async () => {
  const clock = clockOn(2026, 6, 6);
  const store = new CeilingConfirmationStore(clock);
  const confirm = approving();
  const overDaily: PreCallCheck = {
    allowed: false,
    estimatedCost: 0.05,
    sessionCostSoFar: 0,
    sessionLimitUsd: 5,
    perCallLimitUsd: 1,
    dailyCostSoFar: 24.99,
    dailyLimitUsd: 25,
    ...turnBudget,
    reason: "daily_limit",
  };
  // Turn 1, session A: confirm once.
  const gateA = createTurnBudgetCeilingGate(
    confirm,
    store.for("CONF-DAILY-A"),
  );
  await gateA.ensureAllowed(overDaily);
  assert.equal(confirm.mock.callCount(), 1);
  // Turn 2 — and even a DIFFERENT session — same day, same projection: the
  // daily raise holds, no re-prompt.
  const gateB = createTurnBudgetCeilingGate(
    confirm,
    store.for("CONF-DAILY-B"),
  );
  await gateB.ensureAllowed({ ...overDaily });
  assert.equal(confirm.mock.callCount(), 1);
  // A new day forgets the raise.
  clock.set(new Date(2026, 6, 7, 12).getTime());
  const gateC = createTurnBudgetCeilingGate(
    confirm,
    store.for("CONF-DAILY-B"),
  );
  await gateC.ensureAllowed({ ...overDaily });
  assert.equal(confirm.mock.callCount(), 2);
});

test("daily envelope: session-scope raises persist per session id, not globally", async () => {
  const store = new CeilingConfirmationStore(clockOn(2026, 6, 6));
  const confirm = approving();
  const overSession: PreCallCheck = {
    allowed: false,
    estimatedCost: 0.2,
    sessionCostSoFar: 4.9,
    sessionLimitUsd: 5,
    perCallLimitUsd: 1,
    dailyCostSoFar: 5,
    dailyLimitUsd: 25,
    ...turnBudget,
    reason: "session_limit",
  };
  const gate1 = createTurnBudgetCeilingGate(
    confirm,
    store.for("CONF-SESSION-A"),
  );
  await gate1.ensureAllowed(overSession);
  // Next turn, same session: raise holds.
  const gate2 = createTurnBudgetCeilingGate(
    confirm,
    store.for("CONF-SESSION-A"),
  );
  await gate2.ensureAllowed({ ...overSession });
  assert.equal(confirm.mock.callCount(), 1);
  // Different session: its own envelope, re-prompts.
  const gate3 = createTurnBudgetCeilingGate(
    confirm,
    store.for("CONF-SESSION-B"),
  );
  await gate3.ensureAllowed({ ...overSession });
  assert.equal(confirm.mock.callCount(), 2);
});

test("scope-period ceiling confirmations: a daily confirm holds across turns up to the level it raised, then asks again", async () => {
  // A daily approval raises the daily limit to the projection plus one daily
  // limit, kept for the local day; it is a level, not cover for the whole day.
  const store = new CeilingConfirmationStore(clockOn(2026, 6, 7));
  const confirm = approving();
  const overDaily = (
    estimatedCost: number,
    dailyCostSoFar: number,
  ): PreCallCheck => ({
    allowed: false,
    estimatedCost,
    sessionCostSoFar: dailyCostSoFar,
    sessionLimitUsd: 1000,
    perCallLimitUsd: 1,
    dailyCostSoFar,
    dailyLimitUsd: 0.05,
    ...turnBudget,
    reason: "daily_limit",
  });
  const gate = createTurnBudgetCeilingGate(
    confirm,
    store.for("CONF-PERIOD-A"),
  );
  // Projection $0.12 crosses $0.05: the daily mark becomes $0.17.
  await gate.ensureAllowed(overDaily(0.038, 0.082));
  assert.equal(confirm.mock.callCount(), 1);
  // Later call in the same turn, larger projection ($0.165): covered.
  await gate.ensureAllowed(overDaily(0.074, 0.091));
  assert.equal(confirm.mock.callCount(), 1);
  // Next turn, same day, past the mark ($3.90 > $0.17): asks again.
  const nextTurnGate = createTurnBudgetCeilingGate(
    confirm,
    store.for("CONF-PERIOD-A"),
  );
  await nextTurnGate.ensureAllowed(overDaily(0.9, 3.0));
  assert.equal(confirm.mock.callCount(), 2);
});

test("scope-period ceiling confirmations: per-call stays a per-event high-water: a bigger single call re-prompts", async () => {
  const store = new CeilingConfirmationStore(clockOn(2026, 6, 7));
  const confirm = approving();
  const gate = createTurnBudgetCeilingGate(
    confirm,
    store.for("CONF-PERCALL-A"),
  );
  const overPerCall = (estimatedCost: number): PreCallCheck => ({
    allowed: false,
    estimatedCost,
    sessionCostSoFar: 0,
    sessionLimitUsd: 5,
    perCallLimitUsd: 1,
    dailyCostSoFar: 0,
    dailyLimitUsd: 25,
    ...turnBudget,
    reason: "per_call_limit",
  });
  await gate.ensureAllowed(overPerCall(1.2));
  await gate.ensureAllowed(overPerCall(1.1)); // smaller: covered
  assert.equal(confirm.mock.callCount(), 1);
  await gate.ensureAllowed(overPerCall(2.5)); // bigger single call: fresh check
  assert.equal(confirm.mock.callCount(), 2);
});

test("CeilingConfirmationStore: separate stores share no confirmations", async () => {
  const clock = clockOn(2026, 6, 6);
  const confirm = approving();
  const overSession: PreCallCheck = {
    allowed: false,
    estimatedCost: 0.2,
    sessionCostSoFar: 4.9,
    sessionLimitUsd: 5,
    perCallLimitUsd: 1,
    dailyCostSoFar: 5,
    dailyLimitUsd: 25,
    ...turnBudget,
    reason: "session_limit",
  };
  await createTurnBudgetCeilingGate(
    confirm,
    new CeilingConfirmationStore(clock).for("CONF-ISOLATED"),
  ).ensureAllowed(overSession);
  await createTurnBudgetCeilingGate(
    confirm,
    new CeilingConfirmationStore(clock).for("CONF-ISOLATED"),
  ).ensureAllowed({ ...overSession });
  assert.equal(confirm.mock.callCount(), 2);
});
