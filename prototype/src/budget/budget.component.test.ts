/**
 * Component test for budget/: the real tracker, spend baselines, confirmation
 * store, envelope gate and anomaly gate wired together over a `MemoryStore`
 * and a `ManualClock`. Prior spend is committed to the store as
 * `provider_call` events; the store stamps them with the clock's time, and
 * the spend reader rolls them up against the clock's local day.
 *
 * Each test builds its own `CeilingConfirmationStore` on the test's clock.
 */

import { assertAlmostEqual } from "../../testing/assertions/almost-equal.ts";
import { captureRejection } from "../../testing/assertions/captured.ts";
import assert from "node:assert/strict";
import { mock, test } from "node:test";
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

/** One priced `provider_call` row, stamped by the store with the clock. */
function paidCall(sessionId: string, costTotal: number): EventInsert {
  eventSeq += 1;
  return {
    event_id: `01COMPONENTEVENT${String(eventSeq).padStart(10, "0")}`,
    session_id: sessionId,
    event_type: "provider_call",
    trace_id: TRACE_ID,
    span_id: `span${eventSeq}`,
    principal_id: "operator",
    principal_type: "human",
    action: "invoke",
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
  return mock.fn((_w: BudgetCeilingWarning) => Promise.resolve(verdict));
}

function anomalyConfirm(verdict: BudgetCeilingVerdict) {
  return mock.fn((_w: RunawayAnomalyWarning) => Promise.resolve(verdict));
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
      paidCall(sessionId, 0.45),
      paidCall(sessionId, 0.50),
      paidCall(`${sessionId}-OTHER`, 4.00),
    ],
  });
  const tracker = await trackerFor(store, clock, sessionId);
  return { clock, store, tracker };
}

test("envelope: store-seeded spend crosses session and daily; one confirm covers the turn", async () => {
  const { clock, tracker } = await nearLimit("COMP-A-APPROVE");
  const confirmations = new CeilingConfirmationStore(clock);
  const preCall = tracker.checkPreCall(2, 3.0, 20_000);
  assert.strictEqual(preCall.allowed, false);
  assert.strictEqual(preCall.reason, "daily_limit");
  assertAlmostEqual(preCall.estimatedCost, 0.06);
  assertAlmostEqual(preCall.sessionCostSoFar, 0.95);
  assertAlmostEqual(preCall.dailyCostSoFar, 4.95);

  const confirm = ceilingConfirm({ decision: "approve" });
  const gate = createTurnBudgetCeilingGate(
    confirm,
    confirmations.for("COMP-A-APPROVE"),
  );
  await gate.ensureAllowed(preCall);
  assert.equal(confirm.mock.callCount(), 1);
  const warning = confirm.mock.calls[0].arguments[0];
  assert.strictEqual(warning.kind, "budget_ceiling");
  assert.strictEqual(warning.reason, "daily_limit");
  assert.deepStrictEqual(warning.crossedScopes, [
    "daily_limit",
    "session_limit",
  ]);

  // The call ran and cost what it estimated; the next call crosses again but
  // both scopes are confirmed for their periods — no second prompt.
  tracker.record(usage(0.06), 2);
  const next = tracker.checkPreCall(2, 3.0, 20_000);
  assert.strictEqual(next.allowed, false);
  assertAlmostEqual(next.sessionCostSoFar, 1.01);
  await gate.ensureAllowed(next);
  // A later turn in the same session and day reuses the persistent store.
  await createTurnBudgetCeilingGate(
    confirm,
    confirmations.for("COMP-A-APPROVE"),
  ).ensureAllowed(next);
  assert.equal(confirm.mock.callCount(), 1);
});

test("envelope: without a confirm handler the crossing fails closed", async () => {
  const { clock, tracker } = await nearLimit("COMP-A-CLOSED");
  const confirmations = new CeilingConfirmationStore(clock);
  const gate = createTurnBudgetCeilingGate(
    undefined,
    confirmations.for("COMP-A-CLOSED"),
  );
  const error = await captureRejection(
    () => gate.ensureAllowed(tracker.checkPreCall(2, 3.0, 20_000)),
    BudgetExceededError,
  );
  assert.strictEqual(error.reason, "daily_limit");
  assert.strictEqual(error.limitUsd, 5);
  assertAlmostEqual(error.scopeCostSoFar, 4.95);
});

test("envelope: a declined crossing throws and records no confirmation", async () => {
  const { clock, tracker } = await nearLimit("COMP-A-DECLINE");
  const confirmations = new CeilingConfirmationStore(clock);
  const confirm = ceilingConfirm({ decision: "deny", reason: "over budget" });
  const gate = createTurnBudgetCeilingGate(
    confirm,
    confirmations.for("COMP-A-DECLINE"),
  );
  const preCall = tracker.checkPreCall(2, 3.0, 20_000);
  const error = await captureRejection(
    () => gate.ensureAllowed(preCall),
    BudgetCeilingDeclinedError,
  );
  assert.strictEqual(error.reason, "over budget");
  await assert.rejects(
    () => gate.ensureAllowed(preCall),
    BudgetCeilingDeclinedError,
  );
  assert.equal(confirm.mock.callCount(), 2);
});

// ── (b) the daily confirmation follows the clock's local day ──────────────────

test("envelope: the daily confirmation and spend window roll over with the local day", async () => {
  const { clock, store } = setup();
  const confirmations = new CeilingConfirmationStore(clock);
  const config = { ...CONFIG, perCallLimitUsd: 0.50 };
  await store.journal.commit({
    events: [
      paidCall("COMP-B-MAIN", 0.30),
      paidCall("COMP-B-OTHER", 4.95),
    ],
  });
  assert.strictEqual(localDayKey(clock.date()), "2026-07-06");

  // Day 1: $4.95 + $0.30 + $0.06 = $5.31 crosses the $5 daily envelope only.
  const confirm = ceilingConfirm({ decision: "approve" });
  const day1 = await trackerFor(store, clock, "COMP-B-MAIN", config);
  const day1Call = day1.checkPreCall(2, 3.0, 20_000);
  assert.strictEqual(day1Call.reason, "daily_limit");
  await createTurnBudgetCeilingGate(
    confirm,
    confirmations.for("COMP-B-MAIN"),
  ).ensureAllowed(day1Call);
  assert.equal(confirm.mock.callCount(), 1);
  assert.deepStrictEqual(confirm.mock.calls[0].arguments[0].crossedScopes, [
    "daily_limit",
  ]);
  // The daily mark is shared across sessions for the day: no re-prompt.
  const sibling = await trackerFor(store, clock, "COMP-B-SIBLING", config);
  await createTurnBudgetCeilingGate(
    confirm,
    confirmations.for("COMP-B-SIBLING"),
  ).ensureAllowed(sibling.checkPreCall(2, 3.0, 20_000));
  assert.equal(confirm.mock.callCount(), 1);

  // Day 2: yesterday's events still count for the session, not for today.
  clock.advance(DAY_MS);
  assert.strictEqual(localDayKey(clock.date()), "2026-07-07");
  assert.deepStrictEqual(
    await fetchSpendBaselines(store.spend, "COMP-B-MAIN", clock),
    {
      sessionSpentUsd: 0.30,
      sessionSpentTodayUsd: 0,
      dailyOtherSessionsUsd: 0,
    },
  );
  const quiet = await trackerFor(store, clock, "COMP-B-MAIN", config);
  assert.strictEqual(quiet.checkPreCall(2, 3.0, 20_000).allowed, true);

  // Fresh spend today crosses the daily envelope again, and yesterday's
  // confirmation no longer covers it.
  await store.journal.commit({ events: [paidCall("COMP-B-OTHER", 4.97)] });
  const day2 = await trackerFor(store, clock, "COMP-B-MAIN", config);
  const day2Call = day2.checkPreCall(2, 3.0, 20_000);
  assert.strictEqual(day2Call.reason, "daily_limit");
  assertAlmostEqual(day2Call.dailyCostSoFar, 4.97);
  await createTurnBudgetCeilingGate(
    confirm,
    confirmations.for("COMP-B-MAIN"),
  ).ensureAllowed(day2Call);
  assert.equal(confirm.mock.callCount(), 2);
});

// ── (c) runaway anomaly hard stop ─────────────────────────────────────────────

test("anomaly: turn spend past 3× the per-call limit halts; approvals are per level", async () => {
  const { clock, store } = setup();
  const tracker = await trackerFor(store, clock, "COMP-C-TURN");
  tracker.record(usage(0.09), 2);
  tracker.record(usage(0.09), 2);
  const under = tracker.checkAnomaly(2, ANOMALY);
  assert.strictEqual(under.halted, false); // $0.18 <= $0.30
  await createRunawayAnomalyGate().ensureAllowed(under);

  tracker.record(usage(0.15), 2);
  const tripped = tracker.checkAnomaly(2, ANOMALY);
  assert.strictEqual(tripped.trigger, "turn_spend");
  assertAlmostEqual(tripped.turnSpentUsd, 0.33);
  assertAlmostEqual(tripped.turnHaltUsd, 0.30);

  const halt = await captureRejection(
    () => createRunawayAnomalyGate().ensureAllowed(tripped),
    RunawayAnomalyHaltError,
  );
  assert.strictEqual(halt.trigger, "turn_spend");
  assert.strictEqual(halt.declined, false);

  const confirm = anomalyConfirm({ decision: "approve" });
  const gate = createRunawayAnomalyGate(confirm);
  await gate.ensureAllowed(tripped); // turn entry
  await gate.ensureAllowed(tracker.checkAnomaly(2, ANOMALY)); // same level
  assert.equal(confirm.mock.callCount(), 1);
  const warning = confirm.mock.calls[0].arguments[0];
  assert.strictEqual(warning.kind, "runaway_anomaly");
  assertAlmostEqual(warning.spentUsd, 0.33);
  assertAlmostEqual(warning.haltUsd, 0.30);

  tracker.record(usage(0.05), 2); // $0.38: past the approved level
  await gate.ensureAllowed(tracker.checkAnomaly(2, ANOMALY));
  assert.equal(confirm.mock.callCount(), 2);
  assertAlmostEqual(confirm.mock.calls[1].arguments[0].spentUsd, 0.38);
});

test("anomaly: store-seeded session spend past 2× the session envelope halts", async () => {
  const { clock, store } = setup();
  await store.journal.commit({
    events: [
      paidCall("COMP-C-SCOPE", 1.00),
      paidCall("COMP-C-SCOPE", 0.95),
    ],
  });
  const tracker = await trackerFor(store, clock, "COMP-C-SCOPE");
  assert.strictEqual(tracker.checkAnomaly(2, ANOMALY).halted, false); // $1.95
  tracker.record(usage(0.10), 2); // $2.05 > $2.00; turn $0.10 < $0.30
  const tripped = tracker.checkAnomaly(2, ANOMALY);
  assert.strictEqual(tripped.trigger, "session_scope");
  assertAlmostEqual(tripped.sessionSpentUsd, 2.05);
  assertAlmostEqual(tripped.sessionHaltUsd, 2.00);

  const halt = await captureRejection(
    () => createRunawayAnomalyGate().ensureAllowed(tripped),
    RunawayAnomalyHaltError,
  );
  assert.strictEqual(halt.trigger, "session_scope");
  assertAlmostEqual(halt.spentUsd, 2.05);
  assertAlmostEqual(halt.haltUsd, 2.00);

  const confirm = anomalyConfirm({ decision: "deny", reason: "stop here" });
  const declined = await captureRejection(
    () => createRunawayAnomalyGate(confirm).ensureAllowed(tripped),
    RunawayAnomalyHaltError,
  );
  assert.equal(confirm.mock.callCount(), 1);
  assert.strictEqual(declined.declined, true);
  assert.strictEqual(declined.trigger, "session_scope");
  assert.ok(
    declined.message.includes("stop here"),
    `expected declined.message to include "stop here"`,
  );
});

test("anomaly: tier 0 never halts, even past every threshold", async () => {
  const { clock, store } = setup();
  await store.journal.commit({
    events: [paidCall("COMP-C-TIER0", 3.00)],
  });
  const tracker = await trackerFor(store, clock, "COMP-C-TIER0");
  tracker.record(usage(0.50), 2);
  assert.strictEqual(tracker.checkAnomaly(2, ANOMALY).halted, true);
  const free = tracker.checkAnomaly(0, ANOMALY);
  assert.strictEqual(free.halted, false);
  assert.strictEqual(free.trigger, undefined);
  const confirm = anomalyConfirm({ decision: "approve" });
  await createRunawayAnomalyGate(confirm).ensureAllowed(free);
  await createRunawayAnomalyGate().ensureAllowed(free);
  assert.equal(confirm.mock.callCount(), 0);
});
