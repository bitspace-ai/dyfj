/**
 * Unit tests for budget/confirmations.ts: scope-persistent ceiling
 * confirmations keyed by session id and by the local day from the `Clock`.
 *
 * The confirmation maps are module-level, so every test resets them first and
 * uses its own session ids.
 */

import { assertSpyCalls, spy } from "@std/testing/mock";
import { ManualClock } from "../../testing/fakes/manual-clock.ts";
import {
  ceilingConfirmationStoreFor,
  resetCeilingConfirmations,
} from "./confirmations.ts";
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

function approving() {
  return spy(
    (_warning: BudgetCeilingWarning): Promise<BudgetCeilingVerdict> =>
      Promise.resolve({ decision: "approve" }),
  );
}

Deno.test("daily envelope: a confirmed overrun raises the envelope for its scope across turns", async () => {
  resetCeilingConfirmations();
  const july6 = clockOn(2026, 6, 6);
  const july7 = clockOn(2026, 6, 7);
  const confirm = approving();
  const overDaily: PreCallCheck = {
    allowed: false,
    estimatedCost: 0.05,
    sessionCostSoFar: 0,
    sessionLimitUsd: 5,
    perCallLimitUsd: 1,
    dailyCostSoFar: 24.99,
    dailyLimitUsd: 25,
    reason: "daily_limit",
  };
  // Turn 1, session A: confirm once.
  const gateA = createTurnBudgetCeilingGate(
    confirm,
    ceilingConfirmationStoreFor("CONF-DAILY-A", july6),
  );
  await gateA.ensureAllowed(overDaily);
  assertSpyCalls(confirm, 1);
  // Turn 2 — and even a DIFFERENT session — same day, same projection: the
  // daily raise holds, no re-prompt.
  const gateB = createTurnBudgetCeilingGate(
    confirm,
    ceilingConfirmationStoreFor("CONF-DAILY-B", july6),
  );
  await gateB.ensureAllowed({ ...overDaily });
  assertSpyCalls(confirm, 1);
  // A new day forgets the raise.
  const gateC = createTurnBudgetCeilingGate(
    confirm,
    ceilingConfirmationStoreFor("CONF-DAILY-B", july7),
  );
  await gateC.ensureAllowed({ ...overDaily });
  assertSpyCalls(confirm, 2);
  resetCeilingConfirmations();
});

Deno.test("daily envelope: session-scope raises persist per session id, not globally", async () => {
  resetCeilingConfirmations();
  const july6 = clockOn(2026, 6, 6);
  const confirm = approving();
  const overSession: PreCallCheck = {
    allowed: false,
    estimatedCost: 0.2,
    sessionCostSoFar: 4.9,
    sessionLimitUsd: 5,
    perCallLimitUsd: 1,
    dailyCostSoFar: 5,
    dailyLimitUsd: 25,
    reason: "session_limit",
  };
  const gate1 = createTurnBudgetCeilingGate(
    confirm,
    ceilingConfirmationStoreFor("CONF-SESSION-A", july6),
  );
  await gate1.ensureAllowed(overSession);
  // Next turn, same session: raise holds.
  const gate2 = createTurnBudgetCeilingGate(
    confirm,
    ceilingConfirmationStoreFor("CONF-SESSION-A", july6),
  );
  await gate2.ensureAllowed({ ...overSession });
  assertSpyCalls(confirm, 1);
  // Different session: its own envelope, re-prompts.
  const gate3 = createTurnBudgetCeilingGate(
    confirm,
    ceilingConfirmationStoreFor("CONF-SESSION-B", july6),
  );
  await gate3.ensureAllowed({ ...overSession });
  assertSpyCalls(confirm, 2);
  resetCeilingConfirmations();
});

Deno.test("scope-period ceiling confirmations: one daily confirm covers later larger projections in the same period", async () => {
  // An agent-loop turn's later calls project past the level recorded at
  // confirmation time; the confirmation must hold for the scope period.
  resetCeilingConfirmations();
  const july7 = clockOn(2026, 6, 7);
  const confirm = approving();
  const gate = createTurnBudgetCeilingGate(
    confirm,
    ceilingConfirmationStoreFor("CONF-PERIOD-A", july7),
  );
  const overDaily = (
    estimatedCost: number,
    dailyCostSoFar: number,
  ): PreCallCheck => ({
    allowed: false,
    estimatedCost,
    sessionCostSoFar: dailyCostSoFar,
    sessionLimitUsd: 5,
    perCallLimitUsd: 1,
    dailyCostSoFar,
    dailyLimitUsd: 0.05,
    reason: "daily_limit",
  });
  await gate.ensureAllowed(overDaily(0.038, 0.082));
  assertSpyCalls(confirm, 1);
  // Later call in the same turn, larger projection: covered.
  await gate.ensureAllowed(overDaily(0.074, 0.091));
  // Next turn, same day, even bigger: still covered.
  const nextTurnGate = createTurnBudgetCeilingGate(
    confirm,
    ceilingConfirmationStoreFor("CONF-PERIOD-A", july7),
  );
  await nextTurnGate.ensureAllowed(overDaily(0.9, 3.0));
  assertSpyCalls(confirm, 1);
  resetCeilingConfirmations();
});

Deno.test("scope-period ceiling confirmations: per-call stays a per-event high-water: a bigger single call re-prompts", async () => {
  resetCeilingConfirmations();
  const july7 = clockOn(2026, 6, 7);
  const confirm = approving();
  const gate = createTurnBudgetCeilingGate(
    confirm,
    ceilingConfirmationStoreFor("CONF-PERCALL-A", july7),
  );
  const overPerCall = (estimatedCost: number): PreCallCheck => ({
    allowed: false,
    estimatedCost,
    sessionCostSoFar: 0,
    sessionLimitUsd: 5,
    perCallLimitUsd: 1,
    dailyCostSoFar: 0,
    dailyLimitUsd: 25,
    reason: "per_call_limit",
  });
  await gate.ensureAllowed(overPerCall(1.2));
  await gate.ensureAllowed(overPerCall(1.1)); // smaller: covered
  assertSpyCalls(confirm, 1);
  await gate.ensureAllowed(overPerCall(2.5)); // bigger single call: fresh check
  assertSpyCalls(confirm, 2);
  resetCeilingConfirmations();
});
