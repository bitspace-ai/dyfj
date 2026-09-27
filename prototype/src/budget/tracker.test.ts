/**
 * Unit tests for budget/tracker.ts: default config, accumulation, the pre-call
 * envelope check, the anomaly check, and the budget_summary event.
 *
 * All tests are pure — no Dolt, no network. Most of the summary logic lives in
 * buildSummaryEventPayload(), which produces a deterministic, inspectable
 * result; writeSummaryEvent() commits it through a MemoryStore journal.
 */

import {
  assertAlmostEquals,
  assertEquals,
  assertStrictEquals,
} from "@std/assert";
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

Deno.test("defaultBudgetConfig: returns $1.00 session limit by default", () => {
  assertStrictEquals(defaultBudgetConfig(new MapEnv()).sessionLimitUsd, 1.00);
});

Deno.test("defaultBudgetConfig: returns $0.10 per-call limit by default", () => {
  assertStrictEquals(defaultBudgetConfig(new MapEnv()).perCallLimitUsd, 0.10);
});

Deno.test("defaultBudgetConfig: reads DYFJ_BUDGET_SESSION_USD from env", () => {
  const env = new MapEnv({ DYFJ_BUDGET_SESSION_USD: "5.00" });
  assertStrictEquals(defaultBudgetConfig(env).sessionLimitUsd, 5.00);
});

Deno.test("defaultBudgetConfig: reads DYFJ_BUDGET_PER_CALL_USD from env", () => {
  const env = new MapEnv({ DYFJ_BUDGET_PER_CALL_USD: "0.25" });
  assertStrictEquals(defaultBudgetConfig(env).perCallLimitUsd, 0.25);
});

// ── record() ─────────────────────────────────────────────────────────────────

Deno.test("BudgetTracker.record(): starts with zero totals", () => {
  const t = makeTracker();
  assertStrictEquals(t.totalCost, 0);
  assertStrictEquals(t.totalTokensInput, 0);
  assertStrictEquals(t.totalTokensOutput, 0);
  assertStrictEquals(t.totalCalls, 0);
});

Deno.test("BudgetTracker.record(): accumulates total cost", () => {
  const t = makeTracker();
  t.record(makeUsage(100, 50, 0.001), 1);
  t.record(makeUsage(200, 80, 0.002), 1);
  assertAlmostEquals(t.totalCost, 0.003);
});

Deno.test("BudgetTracker.record(): accumulates total input tokens", () => {
  const t = makeTracker();
  t.record(makeUsage(100, 50, 0.001), 1);
  t.record(makeUsage(200, 80, 0.002), 1);
  assertStrictEquals(t.totalTokensInput, 300);
});

Deno.test("BudgetTracker.record(): accumulates total output tokens", () => {
  const t = makeTracker();
  t.record(makeUsage(100, 50, 0.001), 1);
  t.record(makeUsage(200, 80, 0.002), 1);
  assertStrictEquals(t.totalTokensOutput, 130);
});

Deno.test("BudgetTracker.record(): tracks call count", () => {
  const t = makeTracker();
  t.record(makeUsage(100, 50, 0.001), 0);
  t.record(makeUsage(100, 50, 0.001), 1);
  t.record(makeUsage(100, 50, 0.001), 2);
  assertStrictEquals(t.totalCalls, 3);
});

Deno.test("BudgetTracker.record(): tracks per-tier breakdown separately", () => {
  const t = makeTracker();
  t.record(makeUsage(1000, 500, 0), 0); // Tier 0 free
  t.record(makeUsage(100, 50, 0.001), 1); // Tier 1
  t.record(makeUsage(200, 80, 0.010), 2); // Tier 2

  const summary = t.getSummary();
  assertStrictEquals(summary.byTier["0"].costUsd, 0);
  assertAlmostEquals(summary.byTier["1"].costUsd, 0.001);
  assertAlmostEquals(summary.byTier["2"].costUsd, 0.010);
});

Deno.test("BudgetTracker.record(): accumulates multiple calls within the same tier", () => {
  const t = makeTracker();
  t.record(makeUsage(100, 50, 0.001), 1);
  t.record(makeUsage(200, 60, 0.002), 1);

  const tier1 = t.getSummary().byTier["1"];
  assertStrictEquals(tier1.calls, 2);
  assertStrictEquals(tier1.tokensInput, 300);
  assertStrictEquals(tier1.tokensOutput, 110);
  assertAlmostEquals(tier1.costUsd, 0.003);
});

Deno.test("BudgetTracker.record(): Tier 0 calls appear in byTier['0'] with zero cost", () => {
  const t = makeTracker();
  t.record(makeUsage(500, 300, 0), 0);
  t.record(makeUsage(400, 200, 0), 0);

  const tier0 = t.getSummary().byTier["0"];
  assertStrictEquals(tier0.calls, 2);
  assertStrictEquals(tier0.tokensInput, 900);
  assertStrictEquals(tier0.costUsd, 0);
});

Deno.test("BudgetTracker.record(): tiers not called are absent from byTier", () => {
  const t = makeTracker();
  t.record(makeUsage(100, 50, 0), 0);

  const summary = t.getSummary();
  assertStrictEquals(summary.byTier["1"], undefined);
  assertStrictEquals(summary.byTier["2"], undefined);
});

// ── checkPreCall() ────────────────────────────────────────────────────────────

Deno.test("BudgetTracker.checkPreCall(): Tier 0 is always allowed regardless of cost", () => {
  // Even with a $0 limit, Tier 0 is free
  const t = makeTracker({ sessionLimitUsd: 0, perCallLimitUsd: 0 });
  const check = t.checkPreCall(0, 999, 1_000_000);
  assertStrictEquals(check.allowed, true);
  assertStrictEquals(check.estimatedCost, 0);
  assertStrictEquals(check.reason, undefined);
});

Deno.test("BudgetTracker.checkPreCall(): Tier 1 within both limits → allowed", () => {
  const t = makeTracker({ sessionLimitUsd: 1.00, perCallLimitUsd: 0.10 });
  // $1/MTok × 1000 tokens = $0.001 — well within both limits
  const check = t.checkPreCall(1, 1.0, 1_000);
  assertStrictEquals(check.allowed, true);
  assertAlmostEquals(check.estimatedCost, 0.000001 * 1_000);
});

Deno.test("BudgetTracker.checkPreCall(): Tier 1 exceeds per-call limit → denied, reason: per_call_limit", () => {
  const t = makeTracker({ perCallLimitUsd: 0.05 });
  // $1/MTok × 100_000 tokens = $0.10 — exceeds $0.05 per-call limit
  const check = t.checkPreCall(1, 1.0, 100_000);
  assertStrictEquals(check.allowed, false);
  assertStrictEquals(check.reason, "per_call_limit");
  assertAlmostEquals(check.estimatedCost, 0.10);
  assertStrictEquals(check.perCallLimitUsd, 0.05);
});

Deno.test("BudgetTracker.checkPreCall(): Tier 1 within per-call but would exceed session limit → denied, reason: session_limit", () => {
  const t = makeTracker({ sessionLimitUsd: 0.10, perCallLimitUsd: 0.10 });
  // Simulate $0.09 already spent this session
  t.record(makeUsage(10, 5, 0.09), 1);
  // This call estimates $0.05 → $0.09 + $0.05 = $0.14 > $0.10 session limit
  const check = t.checkPreCall(1, 1.0, 50_000);
  assertStrictEquals(check.allowed, false);
  assertStrictEquals(check.reason, "session_limit");
  assertAlmostEquals(check.sessionCostSoFar, 0.09);
  assertStrictEquals(check.sessionLimitUsd, 0.10);
});

Deno.test("BudgetTracker.checkPreCall(): Tier 2 within both limits → allowed", () => {
  const t = makeTracker({ sessionLimitUsd: 1.00, perCallLimitUsd: 0.10 });
  // $5/MTok × 1000 tokens = $0.005
  const check = t.checkPreCall(2, 5.0, 1_000);
  assertStrictEquals(check.allowed, true);
});

Deno.test("BudgetTracker.checkPreCall(): Tier 2 exceeds per-call limit → denied", () => {
  const t = makeTracker({ perCallLimitUsd: 0.01 });
  // $5/MTok × 10_000 tokens = $0.05 > $0.01
  const check = t.checkPreCall(2, 5.0, 10_000);
  assertStrictEquals(check.allowed, false);
  assertStrictEquals(check.reason, "per_call_limit");
});

Deno.test("BudgetTracker.checkPreCall(): per-call check runs before session check (per-call limit is stricter)", () => {
  const t = makeTracker({ sessionLimitUsd: 10.00, perCallLimitUsd: 0.01 });
  // Session limit is generous but per-call is tight
  const check = t.checkPreCall(1, 1.0, 100_000); // $0.10 > $0.01 per-call
  assertStrictEquals(check.reason, "per_call_limit");
});

Deno.test("BudgetTracker.checkPreCall(): sessionCostSoFar reflects previously recorded calls", () => {
  const t = makeTracker();
  t.record(makeUsage(100, 50, 0.05), 1);
  const check = t.checkPreCall(1, 1.0, 1_000);
  assertAlmostEquals(check.sessionCostSoFar, 0.05);
});

Deno.test("BudgetTracker.checkPreCall(): cost estimate uses input tokens × costInputPerMTok / 1_000_000", () => {
  const t = makeTracker();
  // $3/MTok × 50_000 tokens = $0.15 / 1_000_000 × 50_000
  const check = t.checkPreCall(1, 3.0, 50_000);
  assertAlmostEquals(check.estimatedCost, 0.15);
});

// ── getSummary() ──────────────────────────────────────────────────────────────

Deno.test("BudgetTracker.getSummary(): returns correct shape on empty tracker", () => {
  const t = makeTracker();
  const s = t.getSummary();
  assertStrictEquals(s.totalCostUsd, 0);
  assertStrictEquals(s.totalTokensInput, 0);
  assertStrictEquals(s.totalTokensOutput, 0);
  assertStrictEquals(s.totalCalls, 0);
  assertEquals(s.byTier, {});
  assertStrictEquals(s.config.sessionLimitUsd, 1.00);
});

Deno.test("BudgetTracker.getSummary(): totalCalls sums calls across all tiers", () => {
  const t = makeTracker();
  t.record(makeUsage(100, 50, 0), 0);
  t.record(makeUsage(100, 50, 0.001), 1);
  t.record(makeUsage(100, 50, 0.005), 2);
  assertStrictEquals(t.getSummary().totalCalls, 3);
});

Deno.test("BudgetTracker.getSummary(): returns a snapshot — mutating the tracker after doesn't change the returned summary", () => {
  const t = makeTracker();
  t.record(makeUsage(100, 50, 0.001), 1);
  const snap = t.getSummary();
  t.record(makeUsage(200, 80, 0.002), 1); // record more after snapshot
  assertAlmostEquals(snap.totalCostUsd, 0.001); // snapshot unchanged
});

Deno.test("BudgetTracker.getSummary(): config reflects the values passed to the constructor", () => {
  const t = makeTracker({ sessionLimitUsd: 2.50, perCallLimitUsd: 0.25 });
  const s = t.getSummary();
  assertStrictEquals(s.config.sessionLimitUsd, 2.50);
  assertStrictEquals(s.config.perCallLimitUsd, 0.25);
});

// ── buildSummaryEventPayload() ────────────────────────────────────────────────

Deno.test("BudgetTracker.buildSummaryEventPayload(): writeSummaryEvent commits the payload through the journal", async () => {
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
  assertStrictEquals(row?.event_id, "01SUMMARYEVENT");
  assertStrictEquals(row?.event_type, "budget_summary");
});

Deno.test("BudgetTracker.buildSummaryEventPayload(): event_type is 'budget_summary'", () => {
  const payload = makeTracker().buildSummaryEventPayload();
  assertStrictEquals(payload.event_type, "budget_summary");
});

Deno.test("BudgetTracker.buildSummaryEventPayload(): carries session_id and trace_id from constructor", () => {
  const payload = makeTracker().buildSummaryEventPayload();
  assertStrictEquals(payload.session_id, SESSION_ID);
  assertStrictEquals(payload.trace_id, TRACE_ID);
});

Deno.test("BudgetTracker.buildSummaryEventPayload(): tokens_input and tokens_output reflect recorded usage", () => {
  const t = makeTracker();
  t.record(makeUsage(300, 150, 0.001), 1);
  const payload = t.buildSummaryEventPayload();
  assertStrictEquals(payload.tokens_input, 300);
  assertStrictEquals(payload.tokens_output, 150);
});

Deno.test("BudgetTracker.buildSummaryEventPayload(): cost_total reflects recorded cost", () => {
  const t = makeTracker();
  t.record(makeUsage(100, 50, 0.005), 1);
  t.record(makeUsage(200, 80, 0.010), 2);
  const payload = t.buildSummaryEventPayload();
  assertAlmostEquals(payload.cost_total as number, 0.015);
});

Deno.test("BudgetTracker.buildSummaryEventPayload(): tokens_input/output/cost_total are null when nothing was recorded", () => {
  const payload = makeTracker().buildSummaryEventPayload();
  assertStrictEquals(payload.tokens_input, null);
  assertStrictEquals(payload.tokens_output, null);
  assertStrictEquals(payload.cost_total, null);
});

Deno.test("BudgetTracker.buildSummaryEventPayload(): content is valid JSON containing byTier breakdown", () => {
  const t = makeTracker();
  t.record(makeUsage(100, 50, 0), 0);
  t.record(makeUsage(200, 80, 0.005), 1);
  const payload = t.buildSummaryEventPayload();
  const content = JSON.parse(payload.content as string);
  assertStrictEquals(content.byTier["0"].calls, 1);
  assertStrictEquals(content.byTier["1"].calls, 1);
  assertAlmostEquals(content.byTier["1"].costUsd, 0.005);
});

Deno.test("BudgetTracker.buildSummaryEventPayload(): content includes config limits", () => {
  const t = makeTracker({ sessionLimitUsd: 2.00, perCallLimitUsd: 0.20 });
  const content = JSON.parse(t.buildSummaryEventPayload().content as string);
  assertStrictEquals(content.config.sessionLimitUsd, 2.00);
  assertStrictEquals(content.config.perCallLimitUsd, 0.20);
});

Deno.test("BudgetTracker.buildSummaryEventPayload(): accepts overrides for event and trace span identifiers", () => {
  const payload = makeTracker().buildSummaryEventPayload({
    eventId: "FIXED_EVENT_ID",
    spanId: "FIXED_SPAN_ID",
    parentSpanId: "TURN_ROOT_SPAN_ID",
  });
  assertStrictEquals(payload.event_id, "FIXED_EVENT_ID");
  assertStrictEquals(payload.span_id, "FIXED_SPAN_ID");
  assertStrictEquals(payload.parent_span_id, "TURN_ROOT_SPAN_ID");
});

Deno.test("BudgetTracker.buildSummaryEventPayload(): action is 'summarise' and resource is 'session_budget'", () => {
  const payload = makeTracker().buildSummaryEventPayload();
  assertStrictEquals(payload.action, "summarise");
  assertStrictEquals(payload.resource, "session_budget");
});

// ── daily envelope ────────────────────────────────────────────────────────────

Deno.test("daily envelope: checkPreCall crosses the daily limit when today's rollup plus the call exceeds it", () => {
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
  assertStrictEquals(check.allowed, false);
  assertStrictEquals(check.reason, "daily_limit");
  assertAlmostEquals(check.dailyCostSoFar, 24.95);
  assertStrictEquals(check.dailyLimitUsd, 25);
});

Deno.test("daily envelope: session baseline makes the session envelope survive across turns", () => {
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
  assertStrictEquals(check.allowed, false);
  assertStrictEquals(check.reason, "session_limit");
  assertAlmostEquals(check.sessionCostSoFar, 0.98);
});

// ── cross-session daily refresh ───────────────────────────────────────────────

Deno.test("cross-session daily refresh: a refreshed daily figure moves the envelope check", () => {
  const tracker = makeTracker(
    { dailyLimitUsd: 25 },
    { sessionSpentUsd: 0, sessionSpentTodayUsd: 0, dailyOtherSessionsUsd: 0 },
  );
  // $0.06 call: fine while other sessions have spent nothing today.
  assertStrictEquals(tracker.checkPreCall(2, 6, 10_000).allowed, true);
  // Another session finishes a big call; the refreshed figure crosses.
  tracker.refreshDailyOtherSessions(24.99);
  const check = tracker.checkPreCall(2, 6, 10_000);
  assertStrictEquals(check.allowed, false);
  assertStrictEquals(check.reason, "daily_limit");
  assertAlmostEquals(check.dailyCostSoFar, 24.99);
});

// ── resumed sessions spanning days ────────────────────────────────────────────

Deno.test("resumed sessions spanning days: yesterday's same-session spend counts for the session, not for today", () => {
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
  assertStrictEquals(check.allowed, true);
  assertAlmostEquals(check.sessionCostSoFar, 10);
  assertAlmostEquals(check.dailyCostSoFar, 1.02);
});

// ── scope-aware verdicts ──────────────────────────────────────────────────────

Deno.test("scope-aware budget errors: checkPreCall reports the outermost crossed scope", () => {
  // Session AND daily both cross: daily (outermost) frames the verdict.
  const tracker = makeTracker(
    { sessionLimitUsd: 1, dailyLimitUsd: 25 },
    {
      sessionSpentUsd: 0.98,
      sessionSpentTodayUsd: 0.98,
      dailyOtherSessionsUsd: 24.5,
    },
  );
  assertStrictEquals(tracker.checkPreCall(2, 6, 10_000).reason, "daily_limit");
});

// ── checkAnomaly() ────────────────────────────────────────────────────────────

const ANOMALY = { turnMultiple: 3, scopeMultiple: 2 };
// Config: per-call $0.10, session $1.00, daily $25.00 → halts at
// turn $0.30, session $2.00, daily $50.00.

Deno.test("BudgetTracker.checkAnomaly(): tier 0 never halts, even past every threshold", () => {
  const t = makeTracker(undefined, {
    sessionSpentUsd: 100,
    sessionSpentTodayUsd: 100,
    dailyOtherSessionsUsd: 100,
  });
  t.record(makeUsage(1000, 1000, 5), 2);
  const check = t.checkAnomaly(0, ANOMALY);
  assertStrictEquals(check.halted, false);
  assertStrictEquals(check.trigger, undefined);
});

Deno.test("BudgetTracker.checkAnomaly(): no spend → no halt (first call of a fresh turn)", () => {
  const check = makeTracker().checkAnomaly(2, ANOMALY);
  assertStrictEquals(check.halted, false);
  assertStrictEquals(check.turnSpentUsd, 0);
  assertAlmostEquals(check.turnHaltUsd, 0.30);
});

Deno.test("BudgetTracker.checkAnomaly(): uses ACTUAL recorded spend, not estimates: turn accumulation trips the turn trigger", () => {
  const t = makeTracker();
  // Three real calls, each under the per-call limit, piling past 3×.
  t.record(makeUsage(50_000, 500, 0.09), 2);
  t.record(makeUsage(60_000, 500, 0.09), 2);
  let check = t.checkAnomaly(2, ANOMALY);
  assertStrictEquals(check.halted, false); // $0.18 < $0.30
  t.record(makeUsage(80_000, 500, 0.15), 2);
  check = t.checkAnomaly(2, ANOMALY);
  assertStrictEquals(check.halted, true); // $0.33 > $0.30
  assertStrictEquals(check.trigger, "turn_spend");
  assertAlmostEquals(check.turnSpentUsd, 0.33);
});

Deno.test("BudgetTracker.checkAnomaly(): session scope trips at scopeMultiple × session limit, counting baselines", () => {
  const t = makeTracker(undefined, {
    sessionSpentUsd: 1.95,
    sessionSpentTodayUsd: 1.95,
    dailyOtherSessionsUsd: 0,
  });
  t.record(makeUsage(1000, 100, 0.10), 2);
  const check = t.checkAnomaly(2, ANOMALY);
  assertStrictEquals(check.halted, true); // $2.05 > $2.00
  assertStrictEquals(check.trigger, "session_scope");
  assertAlmostEquals(check.sessionSpentUsd, 2.05);
  assertAlmostEquals(check.sessionHaltUsd, 2.00);
});

Deno.test("BudgetTracker.checkAnomaly(): daily scope trips at scopeMultiple × daily limit and outranks session", () => {
  const t = makeTracker(undefined, {
    sessionSpentUsd: 3.0, // session also past its $2 halt
    sessionSpentTodayUsd: 3.0,
    dailyOtherSessionsUsd: 47.5,
  });
  const check = t.checkAnomaly(2, ANOMALY);
  assertStrictEquals(check.halted, true); // $50.50 > $50.00
  assertStrictEquals(check.trigger, "daily_scope"); // outermost frames the halt
  assertAlmostEquals(check.dailySpentUsd, 50.5);
  assertAlmostEquals(check.dailyHaltUsd, 50.0);
});

Deno.test("BudgetTracker.checkAnomaly(): a lifetime-spanning session counts only today toward the daily halt", () => {
  const t = makeTracker(undefined, {
    sessionSpentUsd: 60, // huge lifetime → session_scope trips
    sessionSpentTodayUsd: 0.5,
    dailyOtherSessionsUsd: 1.0,
  });
  const check = t.checkAnomaly(2, ANOMALY);
  assertStrictEquals(check.trigger, "session_scope");
  assertAlmostEquals(check.dailySpentUsd, 1.5); // not 61
});
