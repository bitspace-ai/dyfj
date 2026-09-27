/**
 * Component test for budget/: the real tracker, spend baselines, confirmation
 * store, envelope gate and anomaly gate wired together over a `MemoryStore`
 * and a `ManualClock`. Prior spend is committed to the store as
 * `model_response` events; the store stamps them with the clock's time, and
 * the spend reader rolls them up against the clock's local day.
 *
 * Each test builds its own `CeilingConfirmationStore` on the test's clock.
 */

import {
  assertAlmostEquals,
  assertEquals,
  assertRejects,
  assertStrictEquals,
  assertStringIncludes,
} from "@std/assert";
import { assertSpyCalls, spy } from "@std/testing/mock";
import { ManualClock } from "../../testing/fakes/manual-clock.ts";
import { type EventInsert, MemoryStore } from "../store/mod.ts";
import {
  type AnomalyConfig,
  BudgetCeilingDeclinedError,
  type BudgetCeilingVerdict,
  type BudgetCeilingWarning,
  type BudgetConfig,
  BudgetExceededError,
  BudgetTracker,
  CeilingConfirmationStore,
  createRunawayAnomalyGate,
  createTurnBudgetCeilingGate,
  fetchSpendBaselines,
  localDayKey,
  RunawayAnomalyHaltError,
  type RunawayAnomalyWarning,
} from "./mod.ts";

const TRACE_ID = "aabbccddeeff00112233445566778899";
const DAY_MS = 24 * 60 * 60 * 1000;
/** 10:00 local time on 2026-07-06. */
const JULY_6_10AM = new Date(2026, 6, 6, 10).getTime();

const CONFIG: BudgetConfig = {
  sessionLimitUsd: 1.00,
  perCallLimitUsd: 0.10,
  dailyLimitUsd: 5.00,
};
const ANOMALY: AnomalyConfig = { turnMultiple: 3, scopeMultiple: 2 };

let eventSeq = 0;

/** One priced `model_response` row, stamped by the store with the clock. */
function modelResponse(sessionId: string, costTotal: number): EventInsert {
  eventSeq += 1;
  return {
    event_id: `01COMPONENTEVENT${String(eventSeq).padStart(10, "0")}`,
    session_id: sessionId,
    event_type: "model_response",
    trace_id: TRACE_ID,
    span_id: `span${eventSeq}`,
    principal_id: "operator",
    principal_type: "human",
    action: "respond",
    resource: "model",
    authz_basis: "test",
    cost_total: costTotal,
  };
}

function setup(): { clock: ManualClock; store: MemoryStore } {
  const clock = new ManualClock({ start: JULY_6_10AM });
  return { clock, store: new MemoryStore({}, { now: clock.date }) };
}

async function trackerFor(
  store: MemoryStore,
  clock: ManualClock,
  sessionId: string,
  config: BudgetConfig = CONFIG,
): Promise<BudgetTracker> {
  const baselines = await fetchSpendBaselines(store.spend, sessionId, clock);
  return new BudgetTracker(sessionId, TRACE_ID, config, "user", baselines);
}

function ceilingConfirm(verdict: BudgetCeilingVerdict) {
  return spy((_w: BudgetCeilingWarning) => Promise.resolve(verdict));
}

function anomalyConfirm(verdict: BudgetCeilingVerdict) {
  return spy((_w: RunawayAnomalyWarning) => Promise.resolve(verdict));
}

function usage(costTotal: number) {
  return { input: 20_000, output: 800, cost: { total: costTotal } };
}

// ── (a) envelope warn-then-confirm ────────────────────────────────────────────

/**
 * Session COMP-A-* has spent $0.95 in earlier turns; another session has
 * spent $4.00 today. A $0.06 estimate ($3/MTok × 20k input tokens) projects
 * the session to $1.01 > $1.00 and the day to $5.01 > $5.00, while staying
 * under the $0.10 per-call limit.
 */
async function nearLimit(sessionId: string) {
  const { clock, store } = setup();
  await store.journal.commit({
    events: [
      modelResponse(sessionId, 0.45),
      modelResponse(sessionId, 0.50),
      modelResponse(`${sessionId}-OTHER`, 4.00),
    ],
  });
  const tracker = await trackerFor(store, clock, sessionId);
  return { clock, store, tracker };
}

Deno.test("envelope: store-seeded spend crosses session and daily; one confirm covers the turn", async () => {
  const { clock, tracker } = await nearLimit("COMP-A-APPROVE");
  const confirmations = new CeilingConfirmationStore(clock);
  const preCall = tracker.checkPreCall(2, 3.0, 20_000);
  assertStrictEquals(preCall.allowed, false);
  assertStrictEquals(preCall.reason, "daily_limit");
  assertAlmostEquals(preCall.estimatedCost, 0.06);
  assertAlmostEquals(preCall.sessionCostSoFar, 0.95);
  assertAlmostEquals(preCall.dailyCostSoFar, 4.95);

  const confirm = ceilingConfirm({ decision: "approve" });
  const gate = createTurnBudgetCeilingGate(
    confirm,
    confirmations.for("COMP-A-APPROVE"),
  );
  await gate.ensureAllowed(preCall);
  assertSpyCalls(confirm, 1);
  const warning = confirm.calls[0].args[0];
  assertStrictEquals(warning.kind, "budget_ceiling");
  assertStrictEquals(warning.reason, "daily_limit");
  assertEquals(warning.crossedScopes, ["daily_limit", "session_limit"]);

  // The call ran and cost what it estimated; the next call crosses again but
  // both scopes are confirmed for their periods — no second prompt.
  tracker.record(usage(0.06), 2);
  const next = tracker.checkPreCall(2, 3.0, 20_000);
  assertStrictEquals(next.allowed, false);
  assertAlmostEquals(next.sessionCostSoFar, 1.01);
  await gate.ensureAllowed(next);
  // A later turn in the same session and day reuses the persistent store.
  await createTurnBudgetCeilingGate(
    confirm,
    confirmations.for("COMP-A-APPROVE"),
  ).ensureAllowed(next);
  assertSpyCalls(confirm, 1);
});

Deno.test("envelope: without a confirm handler the crossing fails closed", async () => {
  const { clock, tracker } = await nearLimit("COMP-A-CLOSED");
  const confirmations = new CeilingConfirmationStore(clock);
  const gate = createTurnBudgetCeilingGate(
    undefined,
    confirmations.for("COMP-A-CLOSED"),
  );
  const error = await assertRejects(
    () => gate.ensureAllowed(tracker.checkPreCall(2, 3.0, 20_000)),
    BudgetExceededError,
  );
  assertStrictEquals(error.reason, "daily_limit");
  assertStrictEquals(error.limitUsd, 5);
  assertAlmostEquals(error.scopeCostSoFar, 4.95);
});

Deno.test("envelope: a declined crossing throws and records no confirmation", async () => {
  const { clock, tracker } = await nearLimit("COMP-A-DECLINE");
  const confirmations = new CeilingConfirmationStore(clock);
  const confirm = ceilingConfirm({ decision: "deny", reason: "over budget" });
  const gate = createTurnBudgetCeilingGate(
    confirm,
    confirmations.for("COMP-A-DECLINE"),
  );
  const preCall = tracker.checkPreCall(2, 3.0, 20_000);
  const error = await assertRejects(
    () => gate.ensureAllowed(preCall),
    BudgetCeilingDeclinedError,
  );
  assertStrictEquals(error.reason, "over budget");
  await assertRejects(
    () => gate.ensureAllowed(preCall),
    BudgetCeilingDeclinedError,
  );
  assertSpyCalls(confirm, 2);
});

// ── (b) the daily confirmation follows the clock's local day ──────────────────

Deno.test("envelope: the daily confirmation and spend window roll over with the local day", async () => {
  const { clock, store } = setup();
  const confirmations = new CeilingConfirmationStore(clock);
  const config = { ...CONFIG, perCallLimitUsd: 0.50 };
  await store.journal.commit({
    events: [
      modelResponse("COMP-B-MAIN", 0.30),
      modelResponse("COMP-B-OTHER", 4.95),
    ],
  });
  assertStrictEquals(localDayKey(clock.date()), "2026-07-06");

  // Day 1: $4.95 + $0.30 + $0.06 = $5.31 crosses the $5 daily envelope only.
  const confirm = ceilingConfirm({ decision: "approve" });
  const day1 = await trackerFor(store, clock, "COMP-B-MAIN", config);
  const day1Call = day1.checkPreCall(2, 3.0, 20_000);
  assertStrictEquals(day1Call.reason, "daily_limit");
  await createTurnBudgetCeilingGate(
    confirm,
    confirmations.for("COMP-B-MAIN"),
  ).ensureAllowed(day1Call);
  assertSpyCalls(confirm, 1);
  assertEquals(confirm.calls[0].args[0].crossedScopes, ["daily_limit"]);
  // The daily mark is shared across sessions for the day: no re-prompt.
  const sibling = await trackerFor(store, clock, "COMP-B-SIBLING", config);
  await createTurnBudgetCeilingGate(
    confirm,
    confirmations.for("COMP-B-SIBLING"),
  ).ensureAllowed(sibling.checkPreCall(2, 3.0, 20_000));
  assertSpyCalls(confirm, 1);

  // Day 2: yesterday's events still count for the session, not for today.
  clock.advance(DAY_MS);
  assertStrictEquals(localDayKey(clock.date()), "2026-07-07");
  assertEquals(await fetchSpendBaselines(store.spend, "COMP-B-MAIN", clock), {
    sessionSpentUsd: 0.30,
    sessionSpentTodayUsd: 0,
    dailyOtherSessionsUsd: 0,
  });
  const quiet = await trackerFor(store, clock, "COMP-B-MAIN", config);
  assertStrictEquals(quiet.checkPreCall(2, 3.0, 20_000).allowed, true);

  // Fresh spend today crosses the daily envelope again, and yesterday's
  // confirmation no longer covers it.
  await store.journal.commit({ events: [modelResponse("COMP-B-OTHER", 4.97)] });
  const day2 = await trackerFor(store, clock, "COMP-B-MAIN", config);
  const day2Call = day2.checkPreCall(2, 3.0, 20_000);
  assertStrictEquals(day2Call.reason, "daily_limit");
  assertAlmostEquals(day2Call.dailyCostSoFar, 4.97);
  await createTurnBudgetCeilingGate(
    confirm,
    confirmations.for("COMP-B-MAIN"),
  ).ensureAllowed(day2Call);
  assertSpyCalls(confirm, 2);
});

// ── (c) runaway anomaly hard stop ─────────────────────────────────────────────

Deno.test("anomaly: turn spend past 3× the per-call limit halts; approvals are per level", async () => {
  const { clock, store } = setup();
  const tracker = await trackerFor(store, clock, "COMP-C-TURN");
  tracker.record(usage(0.09), 2);
  tracker.record(usage(0.09), 2);
  const under = tracker.checkAnomaly(2, ANOMALY);
  assertStrictEquals(under.halted, false); // $0.18 <= $0.30
  await createRunawayAnomalyGate().ensureAllowed(under);

  tracker.record(usage(0.15), 2);
  const tripped = tracker.checkAnomaly(2, ANOMALY);
  assertStrictEquals(tripped.trigger, "turn_spend");
  assertAlmostEquals(tripped.turnSpentUsd, 0.33);
  assertAlmostEquals(tripped.turnHaltUsd, 0.30);

  const halt = await assertRejects(
    () => createRunawayAnomalyGate().ensureAllowed(tripped),
    RunawayAnomalyHaltError,
  );
  assertStrictEquals(halt.trigger, "turn_spend");
  assertStrictEquals(halt.declined, false);

  const confirm = anomalyConfirm({ decision: "approve" });
  const gate = createRunawayAnomalyGate(confirm);
  await gate.ensureAllowed(tripped); // turn entry
  await gate.ensureAllowed(tracker.checkAnomaly(2, ANOMALY)); // same level
  assertSpyCalls(confirm, 1);
  const warning = confirm.calls[0].args[0];
  assertStrictEquals(warning.kind, "runaway_anomaly");
  assertAlmostEquals(warning.spentUsd, 0.33);
  assertAlmostEquals(warning.haltUsd, 0.30);

  tracker.record(usage(0.05), 2); // $0.38: past the approved level
  await gate.ensureAllowed(tracker.checkAnomaly(2, ANOMALY));
  assertSpyCalls(confirm, 2);
  assertAlmostEquals(confirm.calls[1].args[0].spentUsd, 0.38);
});

Deno.test("anomaly: store-seeded session spend past 2× the session envelope halts", async () => {
  const { clock, store } = setup();
  await store.journal.commit({
    events: [
      modelResponse("COMP-C-SCOPE", 1.00),
      modelResponse("COMP-C-SCOPE", 0.95),
    ],
  });
  const tracker = await trackerFor(store, clock, "COMP-C-SCOPE");
  assertStrictEquals(tracker.checkAnomaly(2, ANOMALY).halted, false); // $1.95
  tracker.record(usage(0.10), 2); // $2.05 > $2.00; turn $0.10 < $0.30
  const tripped = tracker.checkAnomaly(2, ANOMALY);
  assertStrictEquals(tripped.trigger, "session_scope");
  assertAlmostEquals(tripped.sessionSpentUsd, 2.05);
  assertAlmostEquals(tripped.sessionHaltUsd, 2.00);

  const halt = await assertRejects(
    () => createRunawayAnomalyGate().ensureAllowed(tripped),
    RunawayAnomalyHaltError,
  );
  assertStrictEquals(halt.trigger, "session_scope");
  assertAlmostEquals(halt.spentUsd, 2.05);
  assertAlmostEquals(halt.haltUsd, 2.00);

  const confirm = anomalyConfirm({ decision: "deny", reason: "stop here" });
  const declined = await assertRejects(
    () => createRunawayAnomalyGate(confirm).ensureAllowed(tripped),
    RunawayAnomalyHaltError,
  );
  assertSpyCalls(confirm, 1);
  assertStrictEquals(declined.declined, true);
  assertStrictEquals(declined.trigger, "session_scope");
  assertStringIncludes(declined.message, "stop here");
});

Deno.test("anomaly: tier 0 never halts, even past every threshold", async () => {
  const { clock, store } = setup();
  await store.journal.commit({
    events: [modelResponse("COMP-C-TIER0", 3.00)],
  });
  const tracker = await trackerFor(store, clock, "COMP-C-TIER0");
  tracker.record(usage(0.50), 2);
  assertStrictEquals(tracker.checkAnomaly(2, ANOMALY).halted, true);
  const free = tracker.checkAnomaly(0, ANOMALY);
  assertStrictEquals(free.halted, false);
  assertStrictEquals(free.trigger, undefined);
  const confirm = anomalyConfirm({ decision: "approve" });
  await createRunawayAnomalyGate(confirm).ensureAllowed(free);
  await createRunawayAnomalyGate().ensureAllowed(free);
  assertSpyCalls(confirm, 0);
});
