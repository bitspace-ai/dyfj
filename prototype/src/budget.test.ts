/**
 * Unit tests for src/budget.ts
 *
 * All tests are pure — no Dolt, no network.
 * writeSummaryEvent() is not tested here (it calls writeEvent() which shells
 * out to Dolt); buildSummaryEventPayload() is tested instead as it covers
 * all the interesting logic and produces a deterministic, inspectable result.
 */

import { describe, expect, test, vi } from "vitest";
import {
  type BudgetConfig,
  BudgetExceededError,
  BudgetTracker,
  defaultBudgetConfig,
  type PreCallCheck,
  type TierSpend,
  type BudgetCeilingWarning,
} from "./budget";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SESSION_ID = "01TEST0SESSION0000000000000";
const TRACE_ID = "aabbccddeeff00112233445566778899";

function makeTracker(
  config?: Partial<BudgetConfig>,
  baselines?: { sessionSpentUsd: number; dailySpentUsd: number },
): BudgetTracker {
  return new BudgetTracker(SESSION_ID, TRACE_ID, {
    sessionLimitUsd: 1.00,
    perCallLimitUsd: 0.10,
    dailyLimitUsd: 25.00,
    ...config,
  }, "user", baselines);
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
      if (original !== undefined) {
        process.env.DYFJ_BUDGET_SESSION_USD = original;
      }
    }
  });

  test("returns $0.10 per-call limit by default", () => {
    const original = process.env.DYFJ_BUDGET_PER_CALL_USD;
    delete process.env.DYFJ_BUDGET_PER_CALL_USD;
    try {
      expect(defaultBudgetConfig().perCallLimitUsd).toBe(0.10);
    } finally {
      if (original !== undefined) {
        process.env.DYFJ_BUDGET_PER_CALL_USD = original;
      }
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
    t.record(makeUsage(1000, 500, 0), 0); // Tier 0 free
    t.record(makeUsage(100, 50, 0.001), 1); // Tier 1
    t.record(makeUsage(200, 80, 0.010), 2); // Tier 2

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
      spanId: "FIXED_SPAN_ID",
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

// ── ensureBudgetAllowed (warn-then-confirm) ───────────────────────────────────

describe("ensureBudgetAllowed", () => {
  test("under ceiling proceeds without prompting", async () => {
    const { ensureBudgetAllowed } = await import("./budget");
    const confirm = vi.fn();
    await ensureBudgetAllowed(
      {
        allowed: true,
        estimatedCost: 0.01,
        sessionCostSoFar: 0,
        sessionLimitUsd: 1,
        perCallLimitUsd: 0.1,
      },
      confirm,
    );
    expect(confirm).not.toHaveBeenCalled();
  });

  test("over ceiling with confirm proceeds on approve", async () => {
    const { ensureBudgetAllowed } = await import("./budget");
    await ensureBudgetAllowed(
      {
        allowed: false,
        estimatedCost: 0.12,
        sessionCostSoFar: 0.95,
        sessionLimitUsd: 1,
        perCallLimitUsd: 0.1,
        reason: "session_limit",
      },
      async () => ({ decision: "approve" }),
    );
  });

  test("over ceiling without confirm fails closed", async () => {
    const { BudgetExceededError, ensureBudgetAllowed } = await import(
      "./budget"
    );
    await expect(
      ensureBudgetAllowed(
        {
          allowed: false,
          estimatedCost: 0.12,
          sessionCostSoFar: 0.95,
          sessionLimitUsd: 1,
          perCallLimitUsd: 0.1,
          reason: "session_limit",
        },
      ),
    ).rejects.toBeInstanceOf(BudgetExceededError);
  });

  test("over ceiling denies on decline", async () => {
    const { BudgetCeilingDeclinedError, ensureBudgetAllowed } = await import(
      "./budget"
    );
    await expect(
      ensureBudgetAllowed(
        {
          allowed: false,
          estimatedCost: 0.12,
          sessionCostSoFar: 0,
          sessionLimitUsd: 1,
          perCallLimitUsd: 0.1,
          reason: "per_call_limit",
        },
        async () => ({ decision: "deny", reason: "too much" }),
      ),
    ).rejects.toBeInstanceOf(BudgetCeilingDeclinedError);
  });
});

// ── createTurnBudgetCeilingGate (once-per-turn dedupe) ────────────────────────

describe("createTurnBudgetCeilingGate", () => {
  const overPerCall: PreCallCheck = {
    allowed: false,
    estimatedCost: 0.12,
    sessionCostSoFar: 0,
    sessionLimitUsd: 1,
    perCallLimitUsd: 0.1,
    reason: "per_call_limit",
  };

  test("dedupes identical pre-flight and per-call gates to one confirm", async () => {
    const { createTurnBudgetCeilingGate } = await import("./budget");
    const confirm = vi.fn(async () => ({ decision: "approve" as const }));
    const gate = createTurnBudgetCeilingGate(confirm);
    await gate.ensureAllowed(overPerCall);
    await gate.ensureAllowed({ ...overPerCall });
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  test("re-prompts when session spend crosses after per-call was already confirmed", async () => {
    const { createTurnBudgetCeilingGate } = await import("./budget");
    const confirm = vi.fn(async () => ({ decision: "approve" as const }));
    const gate = createTurnBudgetCeilingGate(confirm);
    await gate.ensureAllowed(overPerCall);
    await gate.ensureAllowed({
      allowed: false,
      estimatedCost: 0.12,
      sessionCostSoFar: 0.95,
      sessionLimitUsd: 1,
      perCallLimitUsd: 0.1,
      reason: "per_call_limit",
    });
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  test("frames the session re-prompt as a session limit, not the per-call reason checkPreCall reports", async () => {
    const { createTurnBudgetCeilingGate } = await import("./budget");
    const warnings: Array<{ reason: string; limitUsd: number }> = [];
    const confirm = vi.fn(async (w: { reason: string; limitUsd: number }) => {
      warnings.push({ reason: w.reason, limitUsd: w.limitUsd });
      return { decision: "approve" as const };
    });
    const gate = createTurnBudgetCeilingGate(confirm);
    await gate.ensureAllowed(overPerCall);
    // Session accumulation now crosses the session ceiling; per-call already
    // confirmed at this estimate, so the only *newly* crossed dimension is session.
    await gate.ensureAllowed({
      allowed: false,
      estimatedCost: 0.12,
      sessionCostSoFar: 0.95,
      sessionLimitUsd: 1,
      perCallLimitUsd: 0.1,
      reason: "per_call_limit",
    });
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(warnings[0].reason).toBe("per_call_limit");
    expect(warnings[0].limitUsd).toBeCloseTo(0.1);
    expect(warnings[1].reason).toBe("session_limit");
    expect(warnings[1].limitUsd).toBeCloseTo(1);
  });

  test("a confirmed session overrun covers later larger projections in the scope", async () => {
    const { createTurnBudgetCeilingGate } = await import("./budget");
    const confirm = vi.fn(async () => ({ decision: "approve" as const }));
    const gate = createTurnBudgetCeilingGate(confirm);
    await gate.ensureAllowed({
      allowed: false,
      estimatedCost: 0.05,
      sessionCostSoFar: 0.96,
      sessionLimitUsd: 1,
      perCallLimitUsd: 0.5,
      reason: "session_limit",
    });
    // Larger projection, same scope: the session confirmation holds — an
    // agent loop must not degenerate into per-call ceremony.
    await gate.ensureAllowed({
      allowed: false,
      estimatedCost: 0.08,
      sessionCostSoFar: 0.95,
      sessionLimitUsd: 1,
      perCallLimitUsd: 0.5,
      reason: "session_limit",
    });
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  test("decline still aborts without recording a confirmation", async () => {
    const { BudgetCeilingDeclinedError, createTurnBudgetCeilingGate } =
      await import("./budget");
    const confirm = vi.fn(async () => ({
      decision: "deny" as const,
      reason: "too much",
    }));
    const gate = createTurnBudgetCeilingGate(confirm);
    await expect(gate.ensureAllowed(overPerCall)).rejects.toBeInstanceOf(
      BudgetCeilingDeclinedError,
    );
    await expect(gate.ensureAllowed(overPerCall)).rejects.toBeInstanceOf(
      BudgetCeilingDeclinedError,
    );
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  test("without a confirm handler fails closed on every gate", async () => {
    const { BudgetExceededError, createTurnBudgetCeilingGate } = await import(
      "./budget"
    );
    const gate = createTurnBudgetCeilingGate(undefined);
    await expect(gate.ensureAllowed(overPerCall)).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
    await expect(gate.ensureAllowed(overPerCall)).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
  });
});

describe("daily envelope", () => {
  test("checkPreCall crosses the daily limit when today's rollup plus the call exceeds it", () => {
    const tracker = makeTracker(
      { dailyLimitUsd: 25 },
      { sessionSpentUsd: 0, dailySpentUsd: 24.95 },
    );
    // $0.06 estimated: within per-call and session, but 24.95 + 0.06 > 25.
    const check = tracker.checkPreCall(2, 6, 10_000);
    expect(check.allowed).toBe(false);
    expect(check.reason).toBe("daily_limit");
    expect(check.dailyCostSoFar).toBeCloseTo(24.95);
    expect(check.dailyLimitUsd).toBe(25);
  });

  test("session baseline makes the session envelope survive across turns", () => {
    // A new tracker per turn used to reset session spend to zero; the baseline
    // carries the session's earlier turns.
    const tracker = makeTracker(
      { sessionLimitUsd: 1 },
      { sessionSpentUsd: 0.98, dailySpentUsd: 0.98 },
    );
    const check = tracker.checkPreCall(2, 6, 10_000);
    expect(check.allowed).toBe(false);
    expect(check.reason).toBe("session_limit");
    expect(check.sessionCostSoFar).toBeCloseTo(0.98);
  });

  test("fetchSpendBaselines maps the rollup row and scopes by session and day", async () => {
    const { fetchSpendBaselines } = await import("./budget");
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const query = async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return [{ session_spent: "0.12", daily_spent: "3.4" }];
    };
    const baselines = await fetchSpendBaselines(
      SESSION_ID,
      "2026-07-06 00:00:00",
      query as never,
    );
    expect(baselines).toEqual({ sessionSpentUsd: 0.12, dailySpentUsd: 3.4 });
    expect(calls[0].params).toEqual([SESSION_ID, "2026-07-06 00:00:00"]);
    expect(calls[0].sql).toContain("cost_total");
    // budget_summary rows aggregate the session and would double count.
    expect(calls[0].sql).toContain("event_type = 'model_response'");
  });

  test("localDayStart is a local-midnight timestamp string", async () => {
    const { localDayStart, localDayKey } = await import("./budget");
    const start = localDayStart(new Date(2026, 6, 6, 15, 30));
    expect(start).toBe("2026-07-06 00:00:00");
    expect(localDayKey(new Date(2026, 6, 6, 15, 30))).toBe("2026-07-06");
  });

  test("a confirmed overrun raises the envelope for its scope across turns", async () => {
    const {
      ceilingConfirmationStoreFor,
      createTurnBudgetCeilingGate,
      resetCeilingConfirmations,
    } = await import("./budget");
    resetCeilingConfirmations();
    const confirm = vi.fn(async () => ({ decision: "approve" as const }));
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
      ceilingConfirmationStoreFor("SESSION-A", "2026-07-06"),
    );
    await gateA.ensureAllowed(overDaily);
    expect(confirm).toHaveBeenCalledTimes(1);
    // Turn 2 — and even a DIFFERENT session — same day, same projection: the
    // daily raise holds, no re-prompt.
    const gateB = createTurnBudgetCeilingGate(
      confirm,
      ceilingConfirmationStoreFor("SESSION-B", "2026-07-06"),
    );
    await gateB.ensureAllowed({ ...overDaily });
    expect(confirm).toHaveBeenCalledTimes(1);
    // A new day forgets the raise.
    const gateC = createTurnBudgetCeilingGate(
      confirm,
      ceilingConfirmationStoreFor("SESSION-B", "2026-07-07"),
    );
    await gateC.ensureAllowed({ ...overDaily });
    expect(confirm).toHaveBeenCalledTimes(2);
    resetCeilingConfirmations();
  });

  test("session-scope raises persist per session id, not globally", async () => {
    const {
      ceilingConfirmationStoreFor,
      createTurnBudgetCeilingGate,
      resetCeilingConfirmations,
    } = await import("./budget");
    resetCeilingConfirmations();
    const confirm = vi.fn(async () => ({ decision: "approve" as const }));
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
      ceilingConfirmationStoreFor("SESSION-A", "2026-07-06"),
    );
    await gate1.ensureAllowed(overSession);
    // Next turn, same session: raise holds.
    const gate2 = createTurnBudgetCeilingGate(
      confirm,
      ceilingConfirmationStoreFor("SESSION-A", "2026-07-06"),
    );
    await gate2.ensureAllowed({ ...overSession });
    expect(confirm).toHaveBeenCalledTimes(1);
    // Different session: its own envelope, re-prompts.
    const gate3 = createTurnBudgetCeilingGate(
      confirm,
      ceilingConfirmationStoreFor("SESSION-B", "2026-07-06"),
    );
    await gate3.ensureAllowed({ ...overSession });
    expect(confirm).toHaveBeenCalledTimes(2);
    resetCeilingConfirmations();
  });
});

describe("scope-period ceiling confirmations", () => {
  test("one daily confirm covers later larger projections in the same period", async () => {
    // UAT reproduction: an agent-loop turn's second call projected past the
    // level recorded at confirmation time and re-prompted mid-turn.
    const {
      ceilingConfirmationStoreFor,
      createTurnBudgetCeilingGate,
      resetCeilingConfirmations,
    } = await import("./budget");
    resetCeilingConfirmations();
    const confirm = vi.fn(async () => ({ decision: "approve" as const }));
    const gate = createTurnBudgetCeilingGate(
      confirm,
      ceilingConfirmationStoreFor("SESSION-A", "2026-07-07"),
    );
    const overDaily = (estimatedCost: number, dailyCostSoFar: number): PreCallCheck => ({
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
    expect(confirm).toHaveBeenCalledTimes(1);
    // Later call in the same turn, larger projection: covered.
    await gate.ensureAllowed(overDaily(0.074, 0.091));
    // Next turn, same day, even bigger: still covered.
    const nextTurnGate = createTurnBudgetCeilingGate(
      confirm,
      ceilingConfirmationStoreFor("SESSION-A", "2026-07-07"),
    );
    await nextTurnGate.ensureAllowed(overDaily(0.9, 3.0));
    expect(confirm).toHaveBeenCalledTimes(1);
    resetCeilingConfirmations();
  });

  test("per-call stays a per-event high-water: a bigger single call re-prompts", async () => {
    const {
      ceilingConfirmationStoreFor,
      createTurnBudgetCeilingGate,
      resetCeilingConfirmations,
    } = await import("./budget");
    resetCeilingConfirmations();
    const confirm = vi.fn(async () => ({ decision: "approve" as const }));
    const gate = createTurnBudgetCeilingGate(
      confirm,
      ceilingConfirmationStoreFor("SESSION-A", "2026-07-07"),
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
    expect(confirm).toHaveBeenCalledTimes(1);
    await gate.ensureAllowed(overPerCall(2.5)); // bigger single call: fresh check
    expect(confirm).toHaveBeenCalledTimes(2);
    resetCeilingConfirmations();
  });
});

describe("composite ceiling approvals", () => {
  test("one prompt names every newly-crossed scope and raises only those", async () => {
    const {
      createTurnBudgetCeilingGate,
      formatBudgetCeilingWarning,
    } = await import("./budget");
    const warnings: BudgetCeilingWarning[] = [];
    const confirm = vi.fn(async (w: BudgetCeilingWarning) => {
      warnings.push(w);
      return { decision: "approve" as const };
    });
    const confirmed: Record<string, number | undefined> = {};
    const gate = createTurnBudgetCeilingGate(confirm, confirmed);
    // Session AND daily newly cross together; per-call does not.
    await gate.ensureAllowed({
      allowed: false,
      estimatedCost: 0.2,
      sessionCostSoFar: 4.9,
      sessionLimitUsd: 5,
      perCallLimitUsd: 1,
      dailyCostSoFar: 24.9,
      dailyLimitUsd: 25,
      reason: "per_call_limit", // deliberately misleading preCall framing
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].crossedScopes).toEqual(["daily_limit", "session_limit"]);
    const message = formatBudgetCeilingWarning(warnings[0]);
    expect(message).toContain("daily limit + session limit");
    expect(message).toContain("Approving raises:");
    // Only the presented scopes were confirmed — period-wide for session and
    // daily; per-call was never confirmed.
    expect(confirmed.session_limit).toBe(Number.POSITIVE_INFINITY);
    expect(confirmed.daily_limit).toBe(Number.POSITIVE_INFINITY);
    expect(confirmed.per_call_limit).toBeUndefined();
  });
});
