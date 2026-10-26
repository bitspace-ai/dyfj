/**
 * Unit tests for budget/tracker.ts: default config, accumulation, the pre-call
 * spend check over every limit, the tool-progress mark, and the
 * budget_summary event.
 *
 * All tests are pure — no Dolt, no network. Most of the summary logic lives in
 * buildSummaryEventPayload(), which produces a deterministic, inspectable
 * result; writeSummaryEvent() commits it through a MemoryStore journal.
 */

import { assertAlmostEqual } from "../../testing/assertions/almost-equal.ts";
import assert from "node:assert/strict";
import { it, test } from "node:test";
import { MapEnv } from "../../testing/fakes/map-env.ts";
import { MemoryStore } from "../store/mod.ts";
import {
  type BudgetConfig,
  BudgetTracker,
  defaultBudgetConfig,
} from "./tracker.ts";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SESSION_ID = "01TEST0SESSION0000000000000";
const TRACE_ID = "aabbccddeeff00112233445566778899";

function makeTracker(
  config?: Partial<BudgetConfig>,
  baselines?: {
    sessionSpentUsd: number;
    sessionSpentTodayUsd: number;
    dailyOtherSessionsUsd: number;
  },
): BudgetTracker {
  return new BudgetTracker(
    SESSION_ID,
    TRACE_ID,
    {
      sessionLimitUsd: 1.00,
      perCallLimitUsd: 0.10,
      dailyLimitUsd: 25.00,
      // Turn and runaway limits sit far out of reach unless a test sets them,
      // so tests about the other limits are not framed by these two.
      turnLimitUsd: 1000,
      runawayStallUsd: 1000,
      ...config,
    },
    "user",
    baselines,
  );
}

function makeUsage(input: number, output: number, costTotal: number) {
  return { input, output, cost: { total: costTotal } };
}

// ── defaultBudgetConfig ───────────────────────────────────────────────────────

test("defaultBudgetConfig: returns $10.00 session limit by default", () => {
  assert.strictEqual(defaultBudgetConfig(new MapEnv()).sessionLimitUsd, 10.00);
});

test("defaultBudgetConfig: returns $0.50 per-call limit by default", () => {
  assert.strictEqual(defaultBudgetConfig(new MapEnv()).perCallLimitUsd, 0.50);
});

test("defaultBudgetConfig: returns $4.00 turn limit by default", () => {
  assert.strictEqual(defaultBudgetConfig(new MapEnv()).turnLimitUsd, 4.00);
});

test("defaultBudgetConfig: returns $0.50 runaway limit by default", () => {
  assert.strictEqual(defaultBudgetConfig(new MapEnv()).runawayStallUsd, 0.50);
});

test("defaultBudgetConfig: reads DYFJ_BUDGET_SESSION_USD from env", () => {
  const env = new MapEnv({ DYFJ_BUDGET_SESSION_USD: "5.00" });
  assert.strictEqual(defaultBudgetConfig(env).sessionLimitUsd, 5.00);
});

test("defaultBudgetConfig: reads DYFJ_BUDGET_PER_CALL_USD from env", () => {
  const env = new MapEnv({ DYFJ_BUDGET_PER_CALL_USD: "0.25" });
  assert.strictEqual(defaultBudgetConfig(env).perCallLimitUsd, 0.25);
});

test("defaultBudgetConfig: reads DYFJ_BUDGET_TURN_USD from env", () => {
  const env = new MapEnv({ DYFJ_BUDGET_TURN_USD: "6.00" });
  assert.strictEqual(defaultBudgetConfig(env).turnLimitUsd, 6.00);
});

test("defaultBudgetConfig: reads DYFJ_BUDGET_RUNAWAY_STALL_USD from env", () => {
  const env = new MapEnv({ DYFJ_BUDGET_RUNAWAY_STALL_USD: "0.75" });
  assert.strictEqual(defaultBudgetConfig(env).runawayStallUsd, 0.75);
});

// ── record() ─────────────────────────────────────────────────────────────────

test("BudgetTracker.record(): starts with zero totals", () => {
  const t = makeTracker();
  assert.strictEqual(t.totalCost, 0);
  assert.strictEqual(t.totalTokensInput, 0);
  assert.strictEqual(t.totalTokensOutput, 0);
  assert.strictEqual(t.totalCalls, 0);
});

test("BudgetTracker.record(): accumulates total cost", () => {
  const t = makeTracker();
  t.record(makeUsage(100, 50, 0.001), 1);
  t.record(makeUsage(200, 80, 0.002), 1);
  assertAlmostEqual(t.totalCost, 0.003);
});

test("BudgetTracker.record(): accumulates total input tokens", () => {
  const t = makeTracker();
  t.record(makeUsage(100, 50, 0.001), 1);
  t.record(makeUsage(200, 80, 0.002), 1);
  assert.strictEqual(t.totalTokensInput, 300);
});

test("BudgetTracker.record(): accumulates total output tokens", () => {
  const t = makeTracker();
  t.record(makeUsage(100, 50, 0.001), 1);
  t.record(makeUsage(200, 80, 0.002), 1);
  assert.strictEqual(t.totalTokensOutput, 130);
});

test("BudgetTracker.record(): tracks call count", () => {
  const t = makeTracker();
  t.record(makeUsage(100, 50, 0.001), 0);
  t.record(makeUsage(100, 50, 0.001), 1);
  t.record(makeUsage(100, 50, 0.001), 2);
  assert.strictEqual(t.totalCalls, 3);
});

test("BudgetTracker.record(): tracks per-tier breakdown separately", () => {
  const t = makeTracker();
  t.record(makeUsage(1000, 500, 0), 0); // Tier 0 free
  t.record(makeUsage(100, 50, 0.001), 1); // Tier 1
  t.record(makeUsage(200, 80, 0.010), 2); // Tier 2

  const summary = t.getSummary();
  assert.strictEqual(summary.byTier["0"].costUsd, 0);
  assertAlmostEqual(summary.byTier["1"].costUsd, 0.001);
  assertAlmostEqual(summary.byTier["2"].costUsd, 0.010);
});

test("BudgetTracker.record(): accumulates multiple calls within the same tier", () => {
  const t = makeTracker();
  t.record(makeUsage(100, 50, 0.001), 1);
  t.record(makeUsage(200, 60, 0.002), 1);

  const tier1 = t.getSummary().byTier["1"];
  assert.strictEqual(tier1.calls, 2);
  assert.strictEqual(tier1.tokensInput, 300);
  assert.strictEqual(tier1.tokensOutput, 110);
  assertAlmostEqual(tier1.costUsd, 0.003);
});

test("BudgetTracker.record(): Tier 0 calls appear in byTier['0'] with zero cost", () => {
  const t = makeTracker();
  t.record(makeUsage(500, 300, 0), 0);
  t.record(makeUsage(400, 200, 0), 0);

  const tier0 = t.getSummary().byTier["0"];
  assert.strictEqual(tier0.calls, 2);
  assert.strictEqual(tier0.tokensInput, 900);
  assert.strictEqual(tier0.costUsd, 0);
});

test("BudgetTracker.record(): tiers not called are absent from byTier", () => {
  const t = makeTracker();
  t.record(makeUsage(100, 50, 0), 0);

  const summary = t.getSummary();
  assert.strictEqual(summary.byTier["1"], undefined);
  assert.strictEqual(summary.byTier["2"], undefined);
});

// ── checkPreCall() ────────────────────────────────────────────────────────────

test("BudgetTracker.checkPreCall(): Tier 0 is always allowed regardless of cost", () => {
  // Every limit at $0 and paid spend already on the books: Tier 0 is free.
  const t = makeTracker({
    sessionLimitUsd: 0,
    perCallLimitUsd: 0,
    dailyLimitUsd: 0,
    turnLimitUsd: 0,
    runawayStallUsd: 0,
  });
  t.record(makeUsage(1000, 100, 0.5), 2);
  const check = t.checkPreCall(0, 999, 1_000_000);
  assert.strictEqual(check.allowed, true);
  assert.strictEqual(check.estimatedCost, 0);
  assert.strictEqual(check.reason, undefined);
});

test("BudgetTracker.checkPreCall(): Tier 1 within both limits → allowed", () => {
  const t = makeTracker({ sessionLimitUsd: 1.00, perCallLimitUsd: 0.10 });
  // $1/MTok × 1000 tokens = $0.001 — well within both limits
  const check = t.checkPreCall(1, 1.0, 1_000);
  assert.strictEqual(check.allowed, true);
  assertAlmostEqual(check.estimatedCost, 0.000001 * 1_000);
});

test("BudgetTracker.checkPreCall(): Tier 1 exceeds per-call limit → denied, reason: per_call_limit", () => {
  const t = makeTracker({ perCallLimitUsd: 0.05 });
  // $1/MTok × 100_000 tokens = $0.10 — exceeds $0.05 per-call limit
  const check = t.checkPreCall(1, 1.0, 100_000);
  assert.strictEqual(check.allowed, false);
  assert.strictEqual(check.reason, "per_call_limit");
  assertAlmostEqual(check.estimatedCost, 0.10);
  assert.strictEqual(check.perCallLimitUsd, 0.05);
});

test("BudgetTracker.checkPreCall(): Tier 1 within per-call but would exceed session limit → denied, reason: session_limit", () => {
  const t = makeTracker({ sessionLimitUsd: 0.10, perCallLimitUsd: 0.10 });
  // Simulate $0.09 already spent this session
  t.record(makeUsage(10, 5, 0.09), 1);
  // This call estimates $0.05 → $0.09 + $0.05 = $0.14 > $0.10 session limit
  const check = t.checkPreCall(1, 1.0, 50_000);
  assert.strictEqual(check.allowed, false);
  assert.strictEqual(check.reason, "session_limit");
  assertAlmostEqual(check.sessionCostSoFar, 0.09);
  assert.strictEqual(check.sessionLimitUsd, 0.10);
});

test("BudgetTracker.checkPreCall(): Tier 2 within both limits → allowed", () => {
  const t = makeTracker({ sessionLimitUsd: 1.00, perCallLimitUsd: 0.10 });
  // $5/MTok × 1000 tokens = $0.005
  const check = t.checkPreCall(2, 5.0, 1_000);
  assert.strictEqual(check.allowed, true);
});

test("BudgetTracker.checkPreCall(): Tier 2 exceeds per-call limit → denied", () => {
  const t = makeTracker({ perCallLimitUsd: 0.01 });
  // $5/MTok × 10_000 tokens = $0.05 > $0.01
  const check = t.checkPreCall(2, 5.0, 10_000);
  assert.strictEqual(check.allowed, false);
  assert.strictEqual(check.reason, "per_call_limit");
});

test("BudgetTracker.checkPreCall(): only the per-call limit crossed → reason: per_call_limit", () => {
  const t = makeTracker({ sessionLimitUsd: 10.00, perCallLimitUsd: 0.01 });
  // Session limit is generous but per-call is tight
  const check = t.checkPreCall(1, 1.0, 100_000); // $0.10 > $0.01 per-call
  assert.strictEqual(check.reason, "per_call_limit");
});

test("BudgetTracker.checkPreCall(): sessionCostSoFar reflects previously recorded calls", () => {
  const t = makeTracker();
  t.record(makeUsage(100, 50, 0.05), 1);
  const check = t.checkPreCall(1, 1.0, 1_000);
  assertAlmostEqual(check.sessionCostSoFar, 0.05);
});

test("BudgetTracker.checkPreCall(): cost estimate uses input tokens × costInputPerMTok / 1_000_000", () => {
  const t = makeTracker();
  // $3/MTok × 50_000 tokens = $0.15 / 1_000_000 × 50_000
  const check = t.checkPreCall(1, 3.0, 50_000);
  assertAlmostEqual(check.estimatedCost, 0.15);
});

// ── getSummary() ──────────────────────────────────────────────────────────────

test("BudgetTracker.getSummary(): returns correct shape on empty tracker", () => {
  const t = makeTracker();
  const s = t.getSummary();
  assert.strictEqual(s.totalCostUsd, 0);
  assert.strictEqual(s.totalTokensInput, 0);
  assert.strictEqual(s.totalTokensOutput, 0);
  assert.strictEqual(s.totalCalls, 0);
  assert.deepStrictEqual(s.byTier, {});
  assert.strictEqual(s.config.sessionLimitUsd, 1.00);
});

test("BudgetTracker.getSummary(): totalCalls sums calls across all tiers", () => {
  const t = makeTracker();
  t.record(makeUsage(100, 50, 0), 0);
  t.record(makeUsage(100, 50, 0.001), 1);
  t.record(makeUsage(100, 50, 0.005), 2);
  assert.strictEqual(t.getSummary().totalCalls, 3);
});

test("BudgetTracker.getSummary(): returns a snapshot — mutating the tracker after doesn't change the returned summary", () => {
  const t = makeTracker();
  t.record(makeUsage(100, 50, 0.001), 1);
  const snap = t.getSummary();
  t.record(makeUsage(200, 80, 0.002), 1); // record more after snapshot
  assertAlmostEqual(snap.totalCostUsd, 0.001); // snapshot unchanged
});

test("BudgetTracker.getSummary(): config reflects the values passed to the constructor", () => {
  const t = makeTracker({ sessionLimitUsd: 2.50, perCallLimitUsd: 0.25 });
  const s = t.getSummary();
  assert.strictEqual(s.config.sessionLimitUsd, 2.50);
  assert.strictEqual(s.config.perCallLimitUsd, 0.25);
});

// ── buildSummaryEventPayload() ────────────────────────────────────────────────

test("BudgetTracker.buildSummaryEventPayload(): writeSummaryEvent commits the payload through the journal", async () => {
  const store = new MemoryStore();
  const tracker = makeTracker();
  await tracker.writeSummaryEvent(store.journal, { skippedEventWrites: 0 }, {
    eventId: "01SUMMARYEVENT",
  });
  const [row] = await store.events.bySession({
    sessionId: SESSION_ID,
    limit: 10,
    order: "asc",
  });
  assert.strictEqual(row?.event_id, "01SUMMARYEVENT");
  assert.strictEqual(row?.event_type, "budget_summary");
});

test("BudgetTracker.buildSummaryEventPayload(): event_type is 'budget_summary'", () => {
  const payload = makeTracker().buildSummaryEventPayload();
  assert.strictEqual(payload.event_type, "budget_summary");
});

test("BudgetTracker.buildSummaryEventPayload(): carries session_id and trace_id from constructor", () => {
  const payload = makeTracker().buildSummaryEventPayload();
  assert.strictEqual(payload.session_id, SESSION_ID);
  assert.strictEqual(payload.trace_id, TRACE_ID);
});

test("BudgetTracker.buildSummaryEventPayload(): tokens_input and tokens_output reflect recorded usage", () => {
  const t = makeTracker();
  t.record(makeUsage(300, 150, 0.001), 1);
  const payload = t.buildSummaryEventPayload();
  assert.strictEqual(payload.tokens_input, 300);
  assert.strictEqual(payload.tokens_output, 150);
});

test("BudgetTracker.buildSummaryEventPayload(): cost_total reflects recorded cost", () => {
  const t = makeTracker();
  t.record(makeUsage(100, 50, 0.005), 1);
  t.record(makeUsage(200, 80, 0.010), 2);
  const payload = t.buildSummaryEventPayload();
  assertAlmostEqual(payload.cost_total as number, 0.015);
});

test("BudgetTracker.buildSummaryEventPayload(): tokens_input/output/cost_total are null when nothing was recorded", () => {
  const payload = makeTracker().buildSummaryEventPayload();
  assert.strictEqual(payload.tokens_input, null);
  assert.strictEqual(payload.tokens_output, null);
  assert.strictEqual(payload.cost_total, null);
});

test("BudgetTracker.buildSummaryEventPayload(): content is valid JSON containing byTier breakdown", () => {
  const t = makeTracker();
  t.record(makeUsage(100, 50, 0), 0);
  t.record(makeUsage(200, 80, 0.005), 1);
  const payload = t.buildSummaryEventPayload();
  const content = JSON.parse(payload.content as string);
  assert.strictEqual(content.byTier["0"].calls, 1);
  assert.strictEqual(content.byTier["1"].calls, 1);
  assertAlmostEqual(content.byTier["1"].costUsd, 0.005);
});

test("BudgetTracker.buildSummaryEventPayload(): content includes config limits", () => {
  const t = makeTracker({ sessionLimitUsd: 2.00, perCallLimitUsd: 0.20 });
  const content = JSON.parse(t.buildSummaryEventPayload().content as string);
  assert.strictEqual(content.config.sessionLimitUsd, 2.00);
  assert.strictEqual(content.config.perCallLimitUsd, 0.20);
});

test("BudgetTracker.buildSummaryEventPayload(): accepts overrides for event and trace span identifiers", () => {
  const payload = makeTracker().buildSummaryEventPayload({
    eventId: "FIXED_EVENT_ID",
    spanId: "FIXED_SPAN_ID",
    parentSpanId: "TURN_ROOT_SPAN_ID",
  });
  assert.strictEqual(payload.event_id, "FIXED_EVENT_ID");
  assert.strictEqual(payload.span_id, "FIXED_SPAN_ID");
  assert.strictEqual(payload.parent_span_id, "TURN_ROOT_SPAN_ID");
});

test("BudgetTracker.buildSummaryEventPayload(): action is 'summarise' and resource is 'session_budget'", () => {
  const payload = makeTracker().buildSummaryEventPayload();
  assert.strictEqual(payload.action, "summarise");
  assert.strictEqual(payload.resource, "session_budget");
});

// ── daily envelope ────────────────────────────────────────────────────────────

test("daily envelope: checkPreCall crosses the daily limit when today's rollup plus the call exceeds it", () => {
  const tracker = makeTracker(
    { dailyLimitUsd: 25 },
    {
      sessionSpentUsd: 0,
      sessionSpentTodayUsd: 0,
      dailyOtherSessionsUsd: 24.95,
    },
  );
  // $0.06 estimated: within per-call and session, but 24.95 + 0.06 > 25.
  const check = tracker.checkPreCall(2, 6, 10_000);
  assert.strictEqual(check.allowed, false);
  assert.strictEqual(check.reason, "daily_limit");
  assertAlmostEqual(check.dailyCostSoFar, 24.95);
  assert.strictEqual(check.dailyLimitUsd, 25);
});

test("daily envelope: session baseline makes the session envelope survive across turns", () => {
  // A new tracker per turn used to reset session spend to zero; the baseline
  // carries the session's earlier turns.
  const tracker = makeTracker(
    { sessionLimitUsd: 1 },
    {
      sessionSpentUsd: 0.98,
      sessionSpentTodayUsd: 0.98,
      dailyOtherSessionsUsd: 0,
    },
  );
  const check = tracker.checkPreCall(2, 6, 10_000);
  assert.strictEqual(check.allowed, false);
  assert.strictEqual(check.reason, "session_limit");
  assertAlmostEqual(check.sessionCostSoFar, 0.98);
});

// ── cross-session daily refresh ───────────────────────────────────────────────

test("cross-session daily refresh: a refreshed daily figure moves the envelope check", () => {
  const tracker = makeTracker(
    { dailyLimitUsd: 25 },
    { sessionSpentUsd: 0, sessionSpentTodayUsd: 0, dailyOtherSessionsUsd: 0 },
  );
  // $0.06 call: fine while other sessions have spent nothing today.
  assert.strictEqual(tracker.checkPreCall(2, 6, 10_000).allowed, true);
  // Another session finishes a big call; the refreshed figure crosses.
  tracker.refreshDailyOtherSessions(24.99);
  const check = tracker.checkPreCall(2, 6, 10_000);
  assert.strictEqual(check.allowed, false);
  assert.strictEqual(check.reason, "daily_limit");
  assertAlmostEqual(check.dailyCostSoFar, 24.99);
});

// ── resumed sessions spanning days ────────────────────────────────────────────

test("resumed sessions spanning days: yesterday's same-session spend counts for the session, not for today", () => {
  // A session with $10 lifetime spend, only $0.02 of it today: the daily
  // envelope sees today's share; the session envelope sees the lifetime.
  const tracker = makeTracker(
    { sessionLimitUsd: 20, dailyLimitUsd: 25 },
    {
      sessionSpentUsd: 10,
      sessionSpentTodayUsd: 0.02,
      dailyOtherSessionsUsd: 1,
    },
  );
  const check = tracker.checkPreCall(2, 6, 10_000);
  assert.strictEqual(check.allowed, true);
  assertAlmostEqual(check.sessionCostSoFar, 10);
  assertAlmostEqual(check.dailyCostSoFar, 1.02);
});

// ── scope-aware verdicts ──────────────────────────────────────────────────────

test("scope-aware budget errors: checkPreCall reports the outermost crossed scope", () => {
  // Session AND daily both cross: daily (outermost) frames the verdict.
  const tracker = makeTracker(
    { sessionLimitUsd: 1, dailyLimitUsd: 25 },
    {
      sessionSpentUsd: 0.98,
      sessionSpentTodayUsd: 0.98,
      dailyOtherSessionsUsd: 24.5,
    },
  );
  assert.strictEqual(tracker.checkPreCall(2, 6, 10_000).reason, "daily_limit");
});

// ── turn and runaway limits ───────────────────────────────────────────────────

test("turn limit: checkPreCall crosses when this turn's spend plus the call exceeds it", () => {
  const t = makeTracker({ turnLimitUsd: 0.35 });
  t.record(makeUsage(50_000, 500, 0.30), 2);
  // $0.06 estimated: 0.30 + 0.06 > 0.35; session ($1.00) and per-call
  // ($0.10) hold.
  const check = t.checkPreCall(2, 6, 10_000);
  assert.strictEqual(check.allowed, false);
  assert.strictEqual(check.reason, "turn_limit");
  assertAlmostEqual(check.turnCostSoFar, 0.30);
  assert.strictEqual(check.turnLimitUsd, 0.35);
});

test("turn limit: earlier turns' session spend does not count toward the turn", () => {
  const t = makeTracker(
    { sessionLimitUsd: 10, turnLimitUsd: 0.10 },
    { sessionSpentUsd: 5, sessionSpentTodayUsd: 5, dailyOtherSessionsUsd: 0 },
  );
  const check = t.checkPreCall(2, 6, 10_000); // $0.06
  assert.strictEqual(check.allowed, true);
  assert.strictEqual(check.turnCostSoFar, 0);
  assertAlmostEqual(check.sessionCostSoFar, 5);
});

test("turn limit: a projection exactly at the limit is allowed", () => {
  const t = makeTracker({ turnLimitUsd: 0.75, perCallLimitUsd: 1 });
  t.record(makeUsage(1000, 100, 0.5), 2);
  // $1/MTok × 250k = $0.25: 0.50 + 0.25 = 0.75, not over.
  const check = t.checkPreCall(2, 1, 250_000);
  assert.strictEqual(check.allowed, true);
  assert.strictEqual(check.reason, undefined);
});

test("runaway limit: checkPreCall crosses when spend since the last progress plus the call exceeds it", () => {
  const t = makeTracker({ runawayStallUsd: 0.10 });
  t.record(makeUsage(10_000, 100, 0.08), 2);
  // $0.03 estimated: 0.08 + 0.03 > 0.10; turn and session hold.
  const check = t.checkPreCall(2, 3, 10_000);
  assert.strictEqual(check.allowed, false);
  assert.strictEqual(check.reason, "runaway_stall");
  assertAlmostEqual(check.stallCostSoFar, 0.08);
  assert.strictEqual(check.runawayStallUsd, 0.10);
});

test("runaway limit: noteToolProgress() resets stallSpentUsd; turn spend keeps counting", () => {
  const t = makeTracker({ runawayStallUsd: 0.10 });
  t.record(makeUsage(10_000, 100, 0.08), 2);
  assertAlmostEqual(t.stallSpentUsd, 0.08);
  t.noteToolProgress();
  assert.strictEqual(t.stallSpentUsd, 0);
  t.record(makeUsage(10_000, 100, 0.02), 2);
  assertAlmostEqual(t.stallSpentUsd, 0.02);
  // The same $0.03 call that crossed before the mark now fits.
  const check = t.checkPreCall(2, 3, 10_000);
  assert.strictEqual(check.allowed, true);
  assertAlmostEqual(check.stallCostSoFar, 0.02);
  assertAlmostEqual(check.turnCostSoFar, 0.10);
});

test("reason ordering: the outermost crossed limit names the verdict (daily > session > turn > runaway > per-call)", () => {
  // Every case: a $0.06 call ($6/MTok × 10k) after $0.30 of turn spend with
  // no tool progress. Each step tightens one more outer limit.
  const reasonWith = (
    config: Partial<BudgetConfig>,
  ): string | undefined => {
    const t = makeTracker(config);
    t.record(makeUsage(50_000, 500, 0.30), 2);
    return t.checkPreCall(2, 6, 10_000).reason;
  };
  const perCall = { perCallLimitUsd: 0.05 };
  const runaway = { ...perCall, runawayStallUsd: 0.20 };
  const turn = { ...runaway, turnLimitUsd: 0.25 };
  const session = { ...turn, sessionLimitUsd: 0.30 };
  const daily = { ...session, dailyLimitUsd: 0.30 };
  assert.strictEqual(reasonWith(perCall), "per_call_limit");
  assert.strictEqual(reasonWith(runaway), "runaway_stall");
  assert.strictEqual(reasonWith(turn), "turn_limit");
  assert.strictEqual(reasonWith(session), "session_limit");
  assert.strictEqual(reasonWith(daily), "daily_limit");
});

// Own enumerable properties, in order, are what JSON.stringify sees, so the
// order the constructor gives them is pinned.
it("BudgetTracker keeps its own properties in order", () => {
  const tracker = makeTracker();
  assert.deepStrictEqual(Object.keys(tracker), [
    "sessionId",
    "traceId",
    "config",
    "principalId",
    "baselines",
    "_byTier",
    "_totalCost",
    "_totalTokensInput",
    "_totalTokensOutput",
    "_costAtProgress",
  ]);
  assert.deepStrictEqual(tracker.config, {
    sessionLimitUsd: 1.00,
    perCallLimitUsd: 0.10,
    dailyLimitUsd: 25.00,
    turnLimitUsd: 1000,
    runawayStallUsd: 1000,
  });
});
