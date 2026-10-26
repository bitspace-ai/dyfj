/**
 * Component test for budget/: the real tracker, spend baselines, confirmation
 * store and spend check wired together over a `MemoryStore`
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
  BudgetCeilingDeclinedError,
  type BudgetCeilingVerdict,
  type BudgetCeilingWarning,
  type BudgetConfig,
  BudgetExceededError,
  BudgetTracker,
  CeilingConfirmationStore,
  createTurnBudgetCeilingGate,
  fetchSpendBaselines,
  localDayKey,
} from "./mod.ts";

const TRACE_ID = "aabbccddeeff00112233445566778899";
const DAY_MS = 24 * 60 * 60 * 1000;
/** 10:00 local time on 2026-07-06. */
const JULY_6_10AM = new Date(2026, 6, 6, 10).getTime();

const CONFIG: BudgetConfig = {
  sessionLimitUsd: 1.00,
  perCallLimitUsd: 0.10,
  dailyLimitUsd: 5.00,
  // Out of reach: the envelope tests are about the session and daily limits.
  turnLimitUsd: 1000,
  runawayStallUsd: 1000,
};

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

// ── (c) turn and runaway limits ───────────────────────────────────────────────

/**
 * Turn and runaway limits only: session, daily and per-call sit out of reach.
 * Each call estimates $0.06 ($3/MTok × 20k input tokens).
 */
const TURN_CONFIG: BudgetConfig = {
  sessionLimitUsd: 100,
  perCallLimitUsd: 0.50,
  dailyLimitUsd: 100,
  turnLimitUsd: 1.00,
  runawayStallUsd: 0.20,
};

test("turn and runaway: a stalled loop asks at the runaway limit, progress clears it, and the turn limit asks once per raised level", async () => {
  const { clock, store } = setup();
  // $0.40 from earlier turns counts for the session, not for this turn.
  await store.journal.commit({ events: [paidCall("COMP-C-TURN", 0.40)] });
  const tracker = await trackerFor(store, clock, "COMP-C-TURN", TURN_CONFIG);
  const confirmations = new CeilingConfirmationStore(clock);
  const confirm = ceilingConfirm({ decision: "approve" });
  const gate = createTurnBudgetCeilingGate(
    confirm,
    confirmations.for("COMP-C-TURN"),
  );
  const next = () => tracker.checkPreCall(2, 3.0, 20_000);

  // Three calls with no tool progress: $0.18 spent since the last progress.
  for (let i = 0; i < 3; i++) {
    const preCall = next();
    assert.strictEqual(preCall.allowed, true);
    await gate.ensureAllowed(preCall);
    tracker.record(usage(0.06), 2);
  }
  // The fourth projects $0.24 past the $0.20 runaway limit.
  const stalled = next();
  assert.strictEqual(stalled.reason, "runaway_stall");
  assertAlmostEqual(stalled.stallCostSoFar, 0.18);
  assertAlmostEqual(stalled.sessionCostSoFar, 0.58);
  assertAlmostEqual(stalled.turnCostSoFar, 0.18);
  await gate.ensureAllowed(stalled);
  assert.equal(confirm.mock.callCount(), 1);
  const runawayWarning = confirm.mock.calls[0].arguments[0];
  assert.deepStrictEqual(runawayWarning.crossedScopes, ["runaway_stall"]);
  assertAlmostEqual(
    runawayWarning.raisesToUsd.runaway_stall ?? Number.NaN,
    0.48,
  );

  // Approved up to $0.48: the next stalled call ($0.30) does not ask.
  tracker.record(usage(0.06), 2);
  await gate.ensureAllowed(next());
  assert.equal(confirm.mock.callCount(), 1);
  // A tool step makes progress: the runaway figure starts again from zero.
  tracker.record(usage(0.06), 2);
  tracker.noteToolProgress();
  assert.strictEqual(tracker.stallSpentUsd, 0);
  assert.strictEqual(next().allowed, true);

  // One large call, then progress: turn spend $0.90, projection $0.96.
  tracker.record(usage(0.60), 2);
  tracker.noteToolProgress();
  assert.strictEqual(next().allowed, true);
  // Turn spend $0.96: projection $1.02 crosses the $1.00 turn limit.
  tracker.record(usage(0.06), 2);
  tracker.noteToolProgress();
  const overTurn = next();
  assert.strictEqual(overTurn.reason, "turn_limit");
  assertAlmostEqual(overTurn.turnCostSoFar, 0.96);
  assertAlmostEqual(overTurn.sessionCostSoFar, 1.36);
  await gate.ensureAllowed(overTurn);
  assert.equal(confirm.mock.callCount(), 2);
  const turnWarning = confirm.mock.calls[1].arguments[0];
  assert.deepStrictEqual(turnWarning.crossedScopes, ["turn_limit"]);
  assertAlmostEqual(turnWarning.raisesToUsd.turn_limit ?? Number.NaN, 2.04);

  // Approved up to $2.04: the next call ($1.08) does not ask.
  tracker.record(usage(0.06), 2);
  tracker.noteToolProgress();
  const inside = next();
  assert.strictEqual(inside.reason, "turn_limit");
  await gate.ensureAllowed(inside);
  assert.equal(confirm.mock.callCount(), 2);

  // The turn mark is the gate's own: another gate over the same confirmation
  // store asks again, and one without a handler fails closed on the turn.
  await createTurnBudgetCeilingGate(
    confirm,
    confirmations.for("COMP-C-TURN"),
  ).ensureAllowed(inside);
  assert.equal(confirm.mock.callCount(), 3);
  const closed = await captureRejection(
    () =>
      createTurnBudgetCeilingGate(
        undefined,
        confirmations.for("COMP-C-TURN"),
      ).ensureAllowed(inside),
    BudgetExceededError,
  );
  assert.strictEqual(closed.reason, "turn_limit");
  assert.strictEqual(closed.limitUsd, 1);
  assertAlmostEqual(closed.scopeCostSoFar, 1.02);
});

test("turn and runaway: tier 0 is allowed past both limits", async () => {
  const { clock, store } = setup();
  const tracker = await trackerFor(store, clock, "COMP-C-TIER0", TURN_CONFIG);
  tracker.record(usage(1.50), 2); // past the turn and runaway limits
  assert.strictEqual(tracker.checkPreCall(2, 3.0, 20_000).allowed, false);
  const free = tracker.checkPreCall(0, 3.0, 20_000);
  assert.strictEqual(free.allowed, true);
  assert.strictEqual(free.reason, undefined);
  const confirm = ceilingConfirm({ decision: "approve" });
  await createTurnBudgetCeilingGate(confirm).ensureAllowed(free);
  assert.equal(confirm.mock.callCount(), 0);
});
