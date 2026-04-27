/**
 * Unit tests for src/budget.ts
 *
 * All tests are pure — no Dolt, no network.
 * writeSummaryEvent() is not tested here (it calls writeEvent() which shells
 * out to Dolt); buildSummaryEventPayload() is tested instead as it covers
 * all the interesting logic and produces a deterministic, inspectable result.
 */

import { test, expect, describe, beforeEach } from "bun:test";
import {
  BudgetTracker,
  BudgetExceededError,
  defaultBudgetConfig,
  type BudgetConfig,
  type TierSpend,
} from "./budget";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SESSION_ID = "01TEST0SESSION0000000000000";
const TRACE_ID   = "aabbccddeeff00112233445566778899";

function makeTracker(config?: Partial<BudgetConfig>): BudgetTracker {
  return new BudgetTracker(SESSION_ID, TRACE_ID, {
    sessionLimitUsd:  1.00,
    perCallLimitUsd:  0.10,
    ...config,
  });
}

function makeUsage(input: number, output: number, costTotal: number) {
  return { input, output, cost: { total: costTotal } };
}

// ── defaultBudgetConfig ───────────────────────────────────────────────────────

describe("defaultBudgetConfig", () => {
  test("returns $1.00 session limit by default", () => {
    const original = process.env.DYFJ_BUDGET_SESSION_USD;
    delete process.env.DYFJ_BUDGET_SESSION_USD;
    try {
      expect(defaultBudgetConfig().sessionLimitUsd).toBe(1.00);
    } finally {
      if (original !== undefined) process.env.DYFJ_BUDGET_SESSION_USD = original;
    }
  });

  test("returns $0.10 per-call limit by default", () => {
    const original = process.env.DYFJ_BUDGET_PER_CALL_USD;
    delete process.env.DYFJ_BUDGET_PER_CALL_USD;
    try {
      expect(defaultBudgetConfig().perCallLimitUsd).toBe(0.10);
    } finally {
      if (original !== undefined) process.env.DYFJ_BUDGET_PER_CALL_USD = original;
    }
  });

  test("reads DYFJ_BUDGET_SESSION_USD from env", () => {
    const original = process.env.DYFJ_BUDGET_SESSION_USD;
    process.env.DYFJ_BUDGET_SESSION_USD = "5.00";
    try {
      expect(defaultBudgetConfig().sessionLimitUsd).toBe(5.00);
    } finally {
      if (original === undefined) delete process.env.DYFJ_BUDGET_SESSION_USD;
      else process.env.DYFJ_BUDGET_SESSION_USD = original;
    }
  });

  test("reads DYFJ_BUDGET_PER_CALL_USD from env", () => {
    const original = process.env.DYFJ_BUDGET_PER_CALL_USD;
    process.env.DYFJ_BUDGET_PER_CALL_USD = "0.25";
    try {
      expect(defaultBudgetConfig().perCallLimitUsd).toBe(0.25);
    } finally {
      if (original === undefined) delete process.env.DYFJ_BUDGET_PER_CALL_USD;
      else process.env.DYFJ_BUDGET_PER_CALL_USD = original;
    }
  });
});

// ── record() ─────────────────────────────────────────────────────────────────

describe("BudgetTracker.record()", () => {
  test("starts with zero totals", () => {
    const t = makeTracker();
    expect(t.totalCost).toBe(0);
    expect(t.totalTokensInput).toBe(0);
    expect(t.totalTokensOutput).toBe(0);
    expect(t.totalCalls).toBe(0);
  });

  test("accumulates total cost", () => {
    const t = makeTracker();
    t.record(makeUsage(100, 50, 0.001), 1);
    t.record(makeUsage(200, 80, 0.002), 1);
    expect(t.totalCost).toBeCloseTo(0.003);
  });

  test("accumulates total input tokens", () => {
    const t = makeTracker();
    t.record(makeUsage(100, 50, 0.001), 1);
    t.record(makeUsage(200, 80, 0.002), 1);
    expect(t.totalTokensInput).toBe(300);
  });

  test("accumulates total output tokens", () => {
    const t = makeTracker();
    t.record(makeUsage(100, 50, 0.001), 1);
    t.record(makeUsage(200, 80, 0.002), 1);
    expect(t.totalTokensOutput).toBe(130);
  });

  test("tracks call count", () => {
    const t = makeTracker();
    t.record(makeUsage(100, 50, 0.001), 0);
    t.record(makeUsage(100, 50, 0.001), 1);
    t.record(makeUsage(100, 50, 0.001), 2);
    expect(t.totalCalls).toBe(3);
  });

  test("tracks per-tier breakdown separately", () => {
    const t = makeTracker();
    t.record(makeUsage(1000, 500, 0),     0); // Tier 0 free
    t.record(makeUsage(100,  50,  0.001), 1); // Tier 1
    t.record(makeUsage(200,  80,  0.010), 2); // Tier 2

    const summary = t.getSummary();
    expect(summary.byTier["0"].costUsd).toBe(0);
    expect(summary.byTier["1"].costUsd).toBeCloseTo(0.001);
    expect(summary.byTier["2"].costUsd).toBeCloseTo(0.010);
  });

  test("accumulates multiple calls within the same tier", () => {
    const t = makeTracker();
    t.record(makeUsage(100, 50, 0.001), 1);
    t.record(makeUsage(200, 60, 0.002), 1);

    const tier1 = t.getSummary().byTier["1"];
    expect(tier1.calls).toBe(2);
    expect(tier1.tokensInput).toBe(300);
    expect(tier1.tokensOutput).toBe(110);
    expect(tier1.costUsd).toBeCloseTo(0.003);
  });

  test("Tier 0 calls appear in byTier['0'] with zero cost", () => {
    const t = makeTracker();
    t.record(makeUsage(500, 300, 0), 0);
    t.record(makeUsage(400, 200, 0), 0);

    const tier0 = t.getSummary().byTier["0"];
    expect(tier0.calls).toBe(2);
    expect(tier0.tokensInput).toBe(900);
    expect(tier0.costUsd).toBe(0);
  });

  test("tiers not called are absent from byTier", () => {
    const t = makeTracker();
    t.record(makeUsage(100, 50, 0), 0);

    const summary = t.getSummary();
    expect(summary.byTier["1"]).toBeUndefined();
    expect(summary.byTier["2"]).toBeUndefined();
  });
});

// ── checkPreCall() ────────────────────────────────────────────────────────────

describe("BudgetTracker.checkPreCall()", () => {
  test("Tier 0 is always allowed regardless of cost", () => {
    // Even with a $0 limit, Tier 0 is free
    const t = makeTracker({ sessionLimitUsd: 0, perCallLimitUsd: 0 });
    const check = t.checkPreCall(0, 999, 1_000_000);
    expect(check.allowed).toBe(true);
    expect(check.estimatedCost).toBe(0);
    expect(check.reason).toBeUndefined();
  });

  test("Tier 1 within both limits → allowed", () => {
    const t = makeTracker({ sessionLimitUsd: 1.00, perCallLimitUsd: 0.10 });
    // $1/MTok × 1000 tokens = $0.001 — well within both limits
    const check = t.checkPreCall(1, 1.0, 1_000);
    expect(check.allowed).toBe(true);
    expect(check.estimatedCost).toBeCloseTo(0.000001 * 1_000);
  });

  test("Tier 1 exceeds per-call limit → denied, reason: per_call_limit", () => {
    const t = makeTracker({ perCallLimitUsd: 0.05 });
    // $1/MTok × 100_000 tokens = $0.10 — exceeds $0.05 per-call limit
    const check = t.checkPreCall(1, 1.0, 100_000);
    expect(check.allowed).toBe(false);
    expect(check.reason).toBe("per_call_limit");
    expect(check.estimatedCost).toBeCloseTo(0.10);
    expect(check.perCallLimitUsd).toBe(0.05);
  });

  test("Tier 1 within per-call but would exceed session limit → denied, reason: session_limit", () => {
    const t = makeTracker({ sessionLimitUsd: 0.10, perCallLimitUsd: 0.10 });
    // Simulate $0.09 already spent this session
    t.record(makeUsage(10, 5, 0.09), 1);
    // This call estimates $0.05 → $0.09 + $0.05 = $0.14 > $0.10 session limit
    const check = t.checkPreCall(1, 1.0, 50_000);
    expect(check.allowed).toBe(false);
    expect(check.reason).toBe("session_limit");
    expect(check.sessionCostSoFar).toBeCloseTo(0.09);
    expect(check.sessionLimitUsd).toBe(0.10);
  });

  test("Tier 2 within both limits → allowed", () => {
    const t = makeTracker({ sessionLimitUsd: 1.00, perCallLimitUsd: 0.10 });
    // $5/MTok × 1000 tokens = $0.005
    const check = t.checkPreCall(2, 5.0, 1_000);
    expect(check.allowed).toBe(true);
  });

  test("Tier 2 exceeds per-call limit → denied", () => {
    const t = makeTracker({ perCallLimitUsd: 0.01 });
    // $5/MTok × 10_000 tokens = $0.05 > $0.01
    const check = t.checkPreCall(2, 5.0, 10_000);
    expect(check.allowed).toBe(false);
    expect(check.reason).toBe("per_call_limit");
  });

  test("per-call check runs before session check (per-call limit is stricter)", () => {
    const t = makeTracker({ sessionLimitUsd: 10.00, perCallLimitUsd: 0.01 });
    // Session limit is generous but per-call is tight
    const check = t.checkPreCall(1, 1.0, 100_000); // $0.10 > $0.01 per-call
    expect(check.reason).toBe("per_call_limit");
  });

  test("sessionCostSoFar reflects previously recorded calls", () => {
    const t = makeTracker();
    t.record(makeUsage(100, 50, 0.05), 1);
    const check = t.checkPreCall(1, 1.0, 1_000);
    expect(check.sessionCostSoFar).toBeCloseTo(0.05);
  });

  test("cost estimate uses input tokens × costInputPerMTok / 1_000_000", () => {
    const t = makeTracker();
    // $3/MTok × 50_000 tokens = $0.15 / 1_000_000 × 50_000
    const check = t.checkPreCall(1, 3.0, 50_000);
    expect(check.estimatedCost).toBeCloseTo(0.15);
  });
});

// ── getSummary() ──────────────────────────────────────────────────────────────

describe("BudgetTracker.getSummary()", () => {
  test("returns correct shape on empty tracker", () => {
    const t = makeTracker();
    const s = t.getSummary();
    expect(s.totalCostUsd).toBe(0);
    expect(s.totalTokensInput).toBe(0);
    expect(s.totalTokensOutput).toBe(0);
    expect(s.totalCalls).toBe(0);
    expect(s.byTier).toEqual({});
    expect(s.config.sessionLimitUsd).toBe(1.00);
  });

  test("totalCalls sums calls across all tiers", () => {
    const t = makeTracker();
    t.record(makeUsage(100, 50, 0), 0);
    t.record(makeUsage(100, 50, 0.001), 1);
    t.record(makeUsage(100, 50, 0.005), 2);
    expect(t.getSummary().totalCalls).toBe(3);
  });

  test("returns a snapshot — mutating the tracker after doesn't change the returned summary", () => {
    const t = makeTracker();
    t.record(makeUsage(100, 50, 0.001), 1);
    const snap = t.getSummary();
    t.record(makeUsage(200, 80, 0.002), 1); // record more after snapshot
    expect(snap.totalCostUsd).toBeCloseTo(0.001); // snapshot unchanged
  });

  test("config reflects the values passed to the constructor", () => {
    const t = makeTracker({ sessionLimitUsd: 2.50, perCallLimitUsd: 0.25 });
    const s = t.getSummary();
    expect(s.config.sessionLimitUsd).toBe(2.50);
    expect(s.config.perCallLimitUsd).toBe(0.25);
  });
});

// ── buildSummaryEventPayload() ────────────────────────────────────────────────

describe("BudgetTracker.buildSummaryEventPayload()", () => {
  test("event_type is 'budget_summary'", () => {
    const payload = makeTracker().buildSummaryEventPayload();
    expect(payload.event_type).toBe("budget_summary");
  });

  test("carries session_id and trace_id from constructor", () => {
    const payload = makeTracker().buildSummaryEventPayload();
    expect(payload.session_id).toBe(SESSION_ID);
    expect(payload.trace_id).toBe(TRACE_ID);
  });

  test("tokens_input and tokens_output reflect recorded usage", () => {
    const t = makeTracker();
    t.record(makeUsage(300, 150, 0.001), 1);
    const payload = t.buildSummaryEventPayload();
    expect(payload.tokens_input).toBe(300);
    expect(payload.tokens_output).toBe(150);
  });

  test("cost_total reflects recorded cost", () => {
    const t = makeTracker();
    t.record(makeUsage(100, 50, 0.005), 1);
    t.record(makeUsage(200, 80, 0.010), 2);
    const payload = t.buildSummaryEventPayload();
    expect(payload.cost_total as number).toBeCloseTo(0.015);
  });

  test("tokens_input/output/cost_total are null when nothing was recorded", () => {
    const payload = makeTracker().buildSummaryEventPayload();
    expect(payload.tokens_input).toBeNull();
    expect(payload.tokens_output).toBeNull();
    expect(payload.cost_total).toBeNull();
  });

  test("content is valid JSON containing byTier breakdown", () => {
    const t = makeTracker();
    t.record(makeUsage(100, 50, 0), 0);
    t.record(makeUsage(200, 80, 0.005), 1);
    const payload = t.buildSummaryEventPayload();
    const content = JSON.parse(payload.content as string);
    expect(content.byTier["0"].calls).toBe(1);
    expect(content.byTier["1"].calls).toBe(1);
    expect(content.byTier["1"].costUsd).toBeCloseTo(0.005);
  });

  test("content includes config limits", () => {
    const t = makeTracker({ sessionLimitUsd: 2.00, perCallLimitUsd: 0.20 });
    const content = JSON.parse(t.buildSummaryEventPayload().content as string);
    expect(content.config.sessionLimitUsd).toBe(2.00);
    expect(content.config.perCallLimitUsd).toBe(0.20);
  });

  test("accepts overrides for eventId and spanId (deterministic testing)", () => {
    const payload = makeTracker().buildSummaryEventPayload({
      eventId: "FIXED_EVENT_ID",
      spanId:  "FIXED_SPAN_ID",
    });
    expect(payload.event_id).toBe("FIXED_EVENT_ID");
    expect(payload.span_id).toBe("FIXED_SPAN_ID");
  });

  test("action is 'summarise' and resource is 'session_budget'", () => {
    const payload = makeTracker().buildSummaryEventPayload();
    expect(payload.action).toBe("summarise");
    expect(payload.resource).toBe("session_budget");
  });
});

// ── BudgetExceededError ───────────────────────────────────────────────────────

describe("BudgetExceededError", () => {
  test("carries all fields and correct name", () => {
    const e = new BudgetExceededError("session_limit", 0.15, 1.00, 0.92);
    expect(e.name).toBe("BudgetExceededError");
    expect(e.reason).toBe("session_limit");
    expect(e.estimatedCost).toBe(0.15);
    expect(e.limitUsd).toBe(1.00);
    expect(e.sessionCostSoFar).toBe(0.92);
    expect(e).toBeInstanceOf(Error);
  });

  test("message includes reason, estimated cost, limit, and session total", () => {
    const e = new BudgetExceededError("per_call_limit", 0.12, 0.10, 0.05);
    expect(e.message).toContain("per_call_limit");
    expect(e.message).toContain("0.10");
  });
});
