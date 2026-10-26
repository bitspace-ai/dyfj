/**
 * Unit tests for budget/envelope-gate.ts: the spend check over the per-call,
 * runaway, turn, session and daily limits (warn-then-confirm), the warning and
 * its formatting, and the budget errors.
 */

import { assertAlmostEqual } from "../../testing/assertions/almost-equal.ts";
import { captureRejection } from "../../testing/assertions/captured.ts";
import assert from "node:assert/strict";
import { it, mock, test } from "node:test";
import { MAX_REASON_FIELD_BYTES } from "../contract/mod.ts";
import {
  BudgetCeilingDeclinedError,
  type BudgetCeilingVerdict,
  type BudgetCeilingWarning,
  BudgetExceededError,
  buildBudgetCeilingWarning,
  budgetCeilingApprovalRequest,
  createTurnBudgetCeilingGate,
  ensureBudgetAllowed,
  formatBudgetCeilingWarning,
  formatUsd,
} from "./envelope-gate.ts";
import type { BudgetCeilingConfirmations } from "./confirmations.ts";
import type { BudgetLimitReason, PreCallCheck } from "./tracker.ts";

/** The level an approval of this warning raises `scope` to (NaN if absent). */
function raisesTo(
  warning: BudgetCeilingWarning,
  scope: BudgetLimitReason,
): number {
  return warning.raisesToUsd[scope] ?? Number.NaN;
}

const dailyBudget = { dailyCostSoFar: 0, dailyLimitUsd: 25 };
/** Turn and runaway figures far from their limits, for other-scope tests. */
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

// ── BudgetExceededError ───────────────────────────────────────────────────────

test("BudgetExceededError: carries all fields and correct name", () => {
  const e = new BudgetExceededError("session_limit", 0.15, 1.00, 0.92);
  assert.strictEqual(e.name, "BudgetExceededError");
  assert.strictEqual(e.reason, "session_limit");
  assert.strictEqual(e.estimatedCost, 0.15);
  assert.strictEqual(e.limitUsd, 1.00);
  assert.strictEqual(e.scopeCostSoFar, 0.92);
  assert.ok(e instanceof Error);
});

test("BudgetExceededError: message includes reason, estimated cost, limit, and session total", () => {
  const e = new BudgetExceededError("per_call_limit", 0.12, 0.10, 0.05);
  assert.ok(
    e.message.includes("per_call_limit"),
    `expected e.message to include "per_call_limit"`,
  );
  assert.ok(e.message.includes("0.10"), `expected e.message to include "0.10"`);
});

// ── ensureBudgetAllowed (warn-then-confirm) ───────────────────────────────────

test("ensureBudgetAllowed: under ceiling proceeds without prompting", async () => {
  const confirm = approving();
  await ensureBudgetAllowed(
    {
      allowed: true,
      estimatedCost: 0.01,
      sessionCostSoFar: 0,
      sessionLimitUsd: 1,
      perCallLimitUsd: 0.1,
      ...dailyBudget,
    ...turnBudget,
      ...turnBudget,
    },
    confirm,
  );
  assert.equal(confirm.mock.callCount(), 0);
});

test("ensureBudgetAllowed: over ceiling with confirm proceeds on approve", async () => {
  await ensureBudgetAllowed(
    {
      allowed: false,
      estimatedCost: 0.12,
      sessionCostSoFar: 0.95,
      sessionLimitUsd: 1,
      perCallLimitUsd: 0.1,
      ...dailyBudget,
    ...turnBudget,
      ...turnBudget,
      reason: "session_limit",
    },
    () => Promise.resolve({ decision: "approve" }),
  );
});

test("ensureBudgetAllowed: over ceiling without confirm fails closed", async () => {
  await assert.rejects(
    () =>
      ensureBudgetAllowed(
        {
          allowed: false,
          estimatedCost: 0.12,
          sessionCostSoFar: 0.95,
          sessionLimitUsd: 1,
          perCallLimitUsd: 0.1,
          ...dailyBudget,
    ...turnBudget,
      ...turnBudget,
          reason: "session_limit",
        },
      ),
    BudgetExceededError,
  );
});

test("ensureBudgetAllowed: over ceiling denies on decline", async () => {
  await assert.rejects(
    () =>
      ensureBudgetAllowed(
        {
          allowed: false,
          estimatedCost: 0.12,
          sessionCostSoFar: 0,
          sessionLimitUsd: 1,
          perCallLimitUsd: 0.1,
          ...dailyBudget,
    ...turnBudget,
      ...turnBudget,
          reason: "per_call_limit",
        },
        () => Promise.resolve({ decision: "deny", reason: "too much" }),
      ),
    BudgetCeilingDeclinedError,
  );
});

// ── createTurnBudgetCeilingGate (once-per-turn dedupe) ────────────────────────

const overPerCall: PreCallCheck = {
  allowed: false,
  estimatedCost: 0.12,
  sessionCostSoFar: 0,
  sessionLimitUsd: 1,
  perCallLimitUsd: 0.1,
  ...dailyBudget,
  ...turnBudget,
  reason: "per_call_limit",
};

test("createTurnBudgetCeilingGate: dedupes identical pre-flight and per-call gates to one confirm", async () => {
  const confirm = approving();
  const gate = createTurnBudgetCeilingGate(confirm);
  await gate.ensureAllowed(overPerCall);
  await gate.ensureAllowed({ ...overPerCall });
  assert.equal(confirm.mock.callCount(), 1);
});

test("createTurnBudgetCeilingGate: re-prompts when session spend crosses after per-call was already confirmed", async () => {
  const confirm = approving();
  const gate = createTurnBudgetCeilingGate(confirm);
  await gate.ensureAllowed(overPerCall);
  await gate.ensureAllowed({
    allowed: false,
    estimatedCost: 0.12,
    sessionCostSoFar: 0.95,
    sessionLimitUsd: 1,
    perCallLimitUsd: 0.1,
    ...dailyBudget,
    ...turnBudget,
    reason: "per_call_limit",
  });
  assert.equal(confirm.mock.callCount(), 2);
});

test("createTurnBudgetCeilingGate: frames the session re-prompt as a session limit, not the per-call reason checkPreCall reports", async () => {
  const confirm = approving();
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
    ...dailyBudget,
    ...turnBudget,
    reason: "per_call_limit",
  });
  assert.equal(confirm.mock.callCount(), 2);
  const warnings = confirm.mock.calls.map((call) => call.arguments[0]);
  assert.strictEqual(warnings[0].reason, "per_call_limit");
  assertAlmostEqual(warnings[0].limitUsd, 0.1);
  assert.strictEqual(warnings[1].reason, "session_limit");
  assertAlmostEqual(warnings[1].limitUsd, 1);
});

test("createTurnBudgetCeilingGate: a confirmed session overrun covers later larger projections in the scope", async () => {
  const confirm = approving();
  const gate = createTurnBudgetCeilingGate(confirm);
  await gate.ensureAllowed({
    allowed: false,
    estimatedCost: 0.05,
    sessionCostSoFar: 0.96,
    sessionLimitUsd: 1,
    perCallLimitUsd: 0.5,
    ...dailyBudget,
    ...turnBudget,
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
    ...dailyBudget,
    ...turnBudget,
    reason: "session_limit",
  });
  assert.equal(confirm.mock.callCount(), 1);
});

test("createTurnBudgetCeilingGate: decline still aborts without recording a confirmation", async () => {
  const confirm = mock.fn(
    (_warning: BudgetCeilingWarning): Promise<BudgetCeilingVerdict> =>
      Promise.resolve({ decision: "deny", reason: "too much" }),
  );
  const gate = createTurnBudgetCeilingGate(confirm);
  await assert.rejects(
    () => gate.ensureAllowed(overPerCall),
    BudgetCeilingDeclinedError,
  );
  await assert.rejects(
    () => gate.ensureAllowed(overPerCall),
    BudgetCeilingDeclinedError,
  );
  assert.equal(confirm.mock.callCount(), 2);
});

test("createTurnBudgetCeilingGate: without a confirm handler fails closed on every gate", async () => {
  const gate = createTurnBudgetCeilingGate(undefined);
  await assert.rejects(
    () => gate.ensureAllowed(overPerCall),
    BudgetExceededError,
  );
  await assert.rejects(
    () => gate.ensureAllowed(overPerCall),
    BudgetExceededError,
  );
});

// ── BIT-715: approvals hold for the rest of the turn, with stated increments ──

test("createTurnBudgetCeilingGate: a per-call approval covers growth to twice the approved estimate, then asks again", async () => {
  const confirm = approving();
  const gate = createTurnBudgetCeilingGate(confirm);
  const overPerCall = (estimatedCost: number): PreCallCheck => ({
    allowed: false,
    estimatedCost,
    sessionCostSoFar: 0,
    sessionLimitUsd: 1,
    perCallLimitUsd: 0.1,
    ...dailyBudget,
    ...turnBudget,
    reason: "per_call_limit",
  });
  // Approval at $0.12 covers estimates up to $0.24.
  await gate.ensureAllowed(overPerCall(0.12));
  await gate.ensureAllowed(overPerCall(0.15));
  await gate.ensureAllowed(overPerCall(0.2));
  assert.equal(confirm.mock.callCount(), 1);
  // $0.25 passes the $0.24 mark: one more prompt, which raises to $0.50.
  await gate.ensureAllowed(overPerCall(0.25));
  assert.equal(confirm.mock.callCount(), 2);
  assertAlmostEqual(
    raisesTo(confirm.mock.calls[1].arguments[0], "per_call_limit"),
    0.5,
  );
});

test("createTurnBudgetCeilingGate: a session approval raises the mark by one session envelope, not without limit", async () => {
  const confirm = approving();
  const confirmed: BudgetCeilingConfirmations = {};
  const gate = createTurnBudgetCeilingGate(confirm, confirmed);
  const overSession = (
    sessionCostSoFar: number,
    estimatedCost: number,
  ): PreCallCheck => ({
    allowed: false,
    estimatedCost,
    sessionCostSoFar,
    sessionLimitUsd: 1,
    perCallLimitUsd: 0.5,
    ...dailyBudget,
    ...turnBudget,
    reason: "session_limit",
  });
  // Projection $1.01 crosses the $1.00 envelope: the mark becomes $1.01 + $1.00.
  await gate.ensureAllowed(overSession(0.95, 0.06));
  assert.equal(confirm.mock.callCount(), 1);
  assertAlmostEqual(confirmed.session_limit ?? Number.NaN, 2.01);
  // Projection $2.00 is inside the mark: no prompt.
  await gate.ensureAllowed(overSession(1.94, 0.06));
  assert.equal(confirm.mock.callCount(), 1);
  // Projection $2.10 passes the mark: prompt, raising to $3.10.
  await gate.ensureAllowed(overSession(2.04, 0.06));
  assert.equal(confirm.mock.callCount(), 2);
  assertAlmostEqual(
    raisesTo(confirm.mock.calls[1].arguments[0], "session_limit"),
    3.1,
  );
});

test("budgetCeilingApprovalRequest: the wire payload carries the title, the turn and runaway figures, and the limits an approval raises to", () => {
  const warning = buildBudgetCeilingWarning(
    {
      allowed: false,
      estimatedCost: 0.06,
      sessionCostSoFar: 0.95,
      sessionLimitUsd: 1,
      perCallLimitUsd: 0.5,
      ...dailyBudget,
    ...turnBudget,
      ...turnBudget,
      reason: "session_limit",
    },
    undefined,
    ["session_limit"],
  );
  const request = budgetCeilingApprovalRequest(warning);
  assert.strictEqual(request.title, "Spend check");
  assert.strictEqual(request.turnCostSoFarUsd, 0);
  assert.strictEqual(request.turnLimitUsd, 1000);
  assert.strictEqual(request.stallCostSoFarUsd, 0);
  assert.strictEqual(request.runawayStallUsd, 1000);
  assert.deepStrictEqual(request.raisesToUsd, warning.raisesToUsd);
  assertAlmostEqual(
    (request.raisesToUsd as Record<string, number>).session_limit ??
      Number.NaN,
    2.01,
  );
});

test("formatBudgetCeilingWarning: the approval prompt states the session limit it raises to", () => {
  const warning = buildBudgetCeilingWarning(
    {
      allowed: false,
      estimatedCost: 0.06,
      sessionCostSoFar: 0.95,
      sessionLimitUsd: 1,
      perCallLimitUsd: 0.5,
      ...dailyBudget,
    ...turnBudget,
      ...turnBudget,
      reason: "session_limit",
    },
    undefined,
    ["session_limit"],
  );
  const message = formatBudgetCeilingWarning(warning);
  assert.ok(
    message.includes("session limit to $2.01 (+$1.00), for this session"),
    `expected ${
      JSON.stringify(message)
    } to state "session limit to $2.01 (+$1.00), for this session"`,
  );
});

// ── composite ceiling approvals ───────────────────────────────────────────────

test("composite ceiling approvals: one prompt names every newly-crossed scope and raises only those", async () => {
  const confirm = approving();
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
    ...turnBudget,
    reason: "per_call_limit", // deliberately misleading preCall framing
  });
  assert.equal(confirm.mock.callCount(), 1);
  const warning = confirm.mock.calls[0].arguments[0];
  assert.deepStrictEqual(warning.crossedScopes, [
    "daily_limit",
    "session_limit",
  ]);
  const message = formatBudgetCeilingWarning(warning);
  assert.ok(
    message.includes("daily limit + session limit"),
    `expected ${
      JSON.stringify(message)
    } to include "daily limit + session limit"`,
  );
  assert.ok(
    message.includes("Approving raises:"),
    `expected ${JSON.stringify(message)} to include "Approving raises:"`,
  );
  // Only the presented scopes were confirmed; per-call was never confirmed.
  // Session is stored as the projected session spend ($5.10) plus one session
  // envelope ($5), so it covers spend up to $10.10 and no further. Daily is
  // likewise the projected day ($25.10) plus one daily envelope ($25).
  assertAlmostEqual(confirmed.session_limit ?? Number.NaN, 10.1);
  assertAlmostEqual(confirmed.daily_limit ?? Number.NaN, 50.1);
  assert.strictEqual(confirmed.per_call_limit, undefined);
});

// ── turn and runaway approvals ────────────────────────────────────────────────

test("composite ceiling approvals: turn, runaway and per-call crossed together get one prompt naming all three", async () => {
  const confirm = approving();
  const gate = createTurnBudgetCeilingGate(confirm);
  await gate.ensureAllowed({
    allowed: false,
    estimatedCost: 0.6,
    sessionCostSoFar: 2,
    sessionLimitUsd: 10,
    perCallLimitUsd: 0.5,
    ...dailyBudget,
    turnCostSoFar: 3.6,
    turnLimitUsd: 4,
    stallCostSoFar: 0.1,
    runawayStallUsd: 0.5,
    reason: "turn_limit",
  });
  assert.equal(confirm.mock.callCount(), 1);
  const warning = confirm.mock.calls[0].arguments[0];
  assert.strictEqual(warning.reason, "turn_limit");
  assert.strictEqual(warning.limitUsd, 4);
  assert.deepStrictEqual(warning.crossedScopes, [
    "turn_limit",
    "runaway_stall",
    "per_call_limit",
  ]);
  assert.ok(
    formatBudgetCeilingWarning(warning).includes(
      "Crossed:   turn limit + runaway limit + per-call limit",
    ),
  );
});

test("createTurnBudgetCeilingGate: a turn approval raises the turn limit to twice the projection, for this gate only", async () => {
  const confirm = approving();
  const confirmed: BudgetCeilingConfirmations = {};
  const overTurn = (turnCostSoFar: number): PreCallCheck => ({
    allowed: false,
    estimatedCost: 0.2,
    sessionCostSoFar: turnCostSoFar,
    sessionLimitUsd: 1000,
    perCallLimitUsd: 0.5,
    dailyCostSoFar: turnCostSoFar,
    dailyLimitUsd: 1000,
    turnCostSoFar,
    turnLimitUsd: 4,
    stallCostSoFar: 0,
    runawayStallUsd: 1000,
    reason: "turn_limit",
  });
  const gate = createTurnBudgetCeilingGate(confirm, confirmed);
  // Projection $4.10 crosses $4.00: approval raises the turn limit to $8.20.
  await gate.ensureAllowed(overTurn(3.9));
  assert.equal(confirm.mock.callCount(), 1);
  assertAlmostEqual(
    raisesTo(confirm.mock.calls[0].arguments[0], "turn_limit"),
    8.2,
  );
  // Projection $8.00 is inside the raised limit: no prompt.
  await gate.ensureAllowed(overTurn(7.8));
  assert.equal(confirm.mock.callCount(), 1);
  // Projection $8.30 passes it: prompt.
  await gate.ensureAllowed(overTurn(8.1));
  assert.equal(confirm.mock.callCount(), 2);
  // The turn mark lives in the gate, not in the confirmations object.
  assert.deepStrictEqual(confirmed, {});
  // A new gate (the next turn) over the same confirmations asks again.
  await createTurnBudgetCeilingGate(confirm, confirmed).ensureAllowed(
    overTurn(3.9),
  );
  assert.equal(confirm.mock.callCount(), 3);
});

test("createTurnBudgetCeilingGate: a runaway approval raises the runaway limit to twice the projection", async () => {
  const confirm = approving();
  const gate = createTurnBudgetCeilingGate(confirm);
  const overRunaway = (stallCostSoFar: number): PreCallCheck => ({
    allowed: false,
    estimatedCost: 0.1,
    sessionCostSoFar: 0,
    sessionLimitUsd: 1000,
    perCallLimitUsd: 0.5,
    ...dailyBudget,
    turnCostSoFar: stallCostSoFar,
    turnLimitUsd: 1000,
    stallCostSoFar,
    runawayStallUsd: 0.5,
    reason: "runaway_stall",
  });
  // Projection $0.55 crosses $0.50: raised to $1.10.
  await gate.ensureAllowed(overRunaway(0.45));
  assertAlmostEqual(
    raisesTo(confirm.mock.calls[0].arguments[0], "runaway_stall"),
    1.1,
  );
  await gate.ensureAllowed(overRunaway(0.95)); // $1.05: inside
  assert.equal(confirm.mock.callCount(), 1);
  await gate.ensureAllowed(overRunaway(1.05)); // $1.15: past, raises to $2.30
  assert.equal(confirm.mock.callCount(), 2);
  assertAlmostEqual(
    raisesTo(confirm.mock.calls[1].arguments[0], "runaway_stall"),
    2.3,
  );
});

test("createTurnBudgetCeilingGate: a daily approval raises the daily limit to the projection plus one daily limit, then asks again past it", async () => {
  const confirm = approving();
  const confirmed: BudgetCeilingConfirmations = {};
  const gate = createTurnBudgetCeilingGate(confirm, confirmed);
  const overDaily = (dailyCostSoFar: number): PreCallCheck => ({
    allowed: false,
    estimatedCost: 0.2,
    sessionCostSoFar: 0,
    sessionLimitUsd: 1000,
    perCallLimitUsd: 0.5,
    dailyCostSoFar,
    dailyLimitUsd: 25,
    ...turnBudget,
    reason: "daily_limit",
  });
  // Projection $25.10 crosses $25.00: the daily mark becomes $50.10.
  await gate.ensureAllowed(overDaily(24.9));
  assertAlmostEqual(confirmed.daily_limit ?? Number.NaN, 50.1);
  await gate.ensureAllowed(overDaily(49.8)); // $50.00: inside
  assert.equal(confirm.mock.callCount(), 1);
  await gate.ensureAllowed(overDaily(50)); // $50.20: past, raises to $75.20
  assert.equal(confirm.mock.callCount(), 2);
  assertAlmostEqual(confirmed.daily_limit ?? Number.NaN, 75.2);
});

test("createTurnBudgetCeilingGate: an approval given against one limit does not cover a call after the limit is lowered", async () => {
  const confirm = approving();
  const confirmed: BudgetCeilingConfirmations = {};
  const gate = createTurnBudgetCeilingGate(confirm, confirmed);
  const call = (estimatedCost: number, perCallLimitUsd: number): PreCallCheck => ({
    allowed: false,
    estimatedCost,
    sessionCostSoFar: 0,
    sessionLimitUsd: 1000,
    perCallLimitUsd,
    dailyCostSoFar: 0,
    dailyLimitUsd: 1000,
    ...turnBudget,
    reason: "per_call_limit",
  });
  // A $0.60 call past a $0.50 limit: the approval covers calls up to $1.20.
  await gate.ensureAllowed(call(0.6, 0.5));
  await gate.ensureAllowed(call(1.0, 0.5));
  assert.equal(confirm.mock.callCount(), 1);
  // The operator lowers the limit to $0.10: the old approval no longer covers.
  await gate.ensureAllowed(call(1.0, 0.1));
  assert.equal(confirm.mock.callCount(), 2);
  assertAlmostEqual(confirmed.per_call_limit ?? Number.NaN, 2.0);
  assert.equal(confirmed.per_call_limit_basis, 0.1);
});

// ── formatting ────────────────────────────────────────────────────────────────

test("formatBudgetCeilingWarning: the prompt shows each scope's spend so far, the estimate, the limits and the raises", () => {
  const warning = buildBudgetCeilingWarning(
    {
      allowed: false,
      estimatedCost: 0.06,
      sessionCostSoFar: 1.2,
      sessionLimitUsd: 10,
      perCallLimitUsd: 0.5,
      dailyCostSoFar: 3.4,
      dailyLimitUsd: 25,
      turnCostSoFar: 3.96,
      turnLimitUsd: 4,
      stallCostSoFar: 0.48,
      runawayStallUsd: 0.5,
      reason: "turn_limit",
    },
    undefined,
    ["turn_limit", "runaway_stall"],
  );
  assert.strictEqual(
    formatBudgetCeilingWarning(warning),
    [
      "Spend check",
      "Crossed:   turn limit + runaway limit",
      "Turn:      $3.96 spent, $4.02 with this call, limit $4.00",
      // The session figure is sessionCostSoFar, the same number the session
      // limit is checked against before adding the estimate.
      "Session:   $1.20 spent, $1.26 with this call, limit $10.00",
      "Today:     $3.40 spent, $3.46 with this call, limit $25.00",
      "Runaway:   $0.48 spent, $0.54 with this call, limit $0.50 (since the last tool progress)",
      "Per call:  ~$0.06 this call, limit $0.50",
      "Approving raises:",
      "  turn limit to $8.04 (2× the spend with this call), for this turn",
      "  runaway limit to $1.08 (2× the spend with this call), for this turn",
    ].join("\n"),
  );
});

test("formatUsd: whole cents print with two decimals, anything finer with four", () => {
  assert.strictEqual(formatUsd(4), "$4.00");
  assert.strictEqual(formatUsd(0), "$0.00");
  assert.strictEqual(formatUsd(2.01), "$2.01");
  // Float noise around a whole-cent value still reads as whole cents.
  assert.strictEqual(formatUsd(0.1 + 0.2), "$0.30");
  assert.strictEqual(formatUsd(0.0123), "$0.0123");
  assert.strictEqual(formatUsd(0.0042), "$0.0042");
});

// ── scope-aware budget errors ─────────────────────────────────────────────────

test("scope-aware budget errors: a daily fail-closed error carries the daily figures and framing", async () => {
  const caught = await captureRejection(
    () =>
      ensureBudgetAllowed({
        allowed: false,
        estimatedCost: 0.06,
        sessionCostSoFar: 0.5,
        sessionLimitUsd: 5,
        perCallLimitUsd: 1,
        dailyCostSoFar: 24.99,
        dailyLimitUsd: 25,
        ...turnBudget,
        reason: "daily_limit",
      }),
    BudgetExceededError,
  );
  assert.strictEqual(caught.reason, "daily_limit");
  assert.strictEqual(caught.limitUsd, 25);
  assertAlmostEqual(caught.scopeCostSoFar, 24.99);
  assert.ok(
    caught.message.includes("today's total so far"),
    `expected caught.message to include "today's total so far"`,
  );
  assert.ok(!caught.message.includes("session total"));
});

test("scope-aware budget errors: a gate with no handler fails closed on the turn limit with the turn figures", async () => {
  const caught = await captureRejection(
    () =>
      createTurnBudgetCeilingGate(undefined).ensureAllowed({
        allowed: false,
        estimatedCost: 0.06,
        sessionCostSoFar: 1,
        sessionLimitUsd: 10,
        perCallLimitUsd: 0.5,
        ...dailyBudget,
        turnCostSoFar: 3.98,
        turnLimitUsd: 4,
        stallCostSoFar: 0,
        runawayStallUsd: 1000,
        // checkPreCall would say turn_limit; the gate frames from the scopes.
        reason: "per_call_limit",
      }),
    BudgetExceededError,
  );
  assert.strictEqual(caught.reason, "turn_limit");
  assert.strictEqual(caught.limitUsd, 4);
  assertAlmostEqual(caught.scopeCostSoFar, 3.98);
  assert.ok(caught.message.includes("turn total so far"));
});

test("scope-aware budget errors: a runaway fail-closed error carries the spend since the last tool progress", async () => {
  const caught = await captureRejection(
    () =>
      ensureBudgetAllowed({
        allowed: false,
        estimatedCost: 0.1,
        sessionCostSoFar: 1,
        sessionLimitUsd: 10,
        perCallLimitUsd: 0.5,
        ...dailyBudget,
        turnCostSoFar: 1,
        turnLimitUsd: 4,
        stallCostSoFar: 0.45,
        runawayStallUsd: 0.5,
        reason: "runaway_stall",
      }),
    BudgetExceededError,
  );
  assert.strictEqual(caught.reason, "runaway_stall");
  assert.strictEqual(caught.limitUsd, 0.5);
  assertAlmostEqual(caught.scopeCostSoFar, 0.45);
  assert.ok(caught.message.includes("spend since the last tool progress"));
});

// ── Peer-supplied reason fields ────────────────────────────────────────────────
//
// reason/declineReason come from an operator or a remote approval peer via an
// injected confirm callback — content this codebase relays, not authors.
// DomainError only certifies the message the constructor BUILDS, so these
// fields are capped and control-char-stripped before they reach either the
// message or the public `.reason` property the native runner's log branch reads
// directly.

test("BudgetCeilingDeclinedError — reason field sanitization: a short, ordinary reason passes through unchanged", () => {
  const err = new BudgetCeilingDeclinedError("not now");
  assert.strictEqual(err.reason, "not now");
  assert.strictEqual(
    err.message,
    "Budget ceiling confirmation declined: not now",
  );
});

test("BudgetCeilingDeclinedError — reason field sanitization: caps an oversized reason, on both .message and the public .reason property", () => {
  const reason = "SELECT ".repeat(2_000); // well over MAX_REASON_FIELD_BYTES
  const err = new BudgetCeilingDeclinedError(reason);
  assert.ok(
    (new TextEncoder().encode(err.reason ?? "").byteLength) <=
      MAX_REASON_FIELD_BYTES,
    `expected new TextEncoder().encode(err.reason ?? "").byteLength <= ${MAX_REASON_FIELD_BYTES}`,
  );
  assert.ok(!err.message.includes(reason));
  assert.ok(
    (new TextEncoder().encode(err.message).byteLength) < reason.length,
    `expected new TextEncoder().encode(err.message).byteLength < reason.length`,
  );
});

test("BudgetCeilingDeclinedError — reason field sanitization: strips a terminal escape sequence from the reason", () => {
  const esc = String.fromCharCode(27);
  const err = new BudgetCeilingDeclinedError(`${esc}[31mdanger${esc}[0m`);
  assert.ok(!(err.reason ?? "").includes(esc));
  assert.ok(!err.message.includes(esc));
});

// Own enumerable properties, in order, are what JSON.stringify and error
// serialization see, so the order each constructor gives them is pinned.
it("BudgetExceededError keeps its own properties and message", () => {
  const err = new BudgetExceededError("session_limit", 1, 2, 3);
  assert.deepStrictEqual(Object.keys(err), [
    "reason",
    "estimatedCost",
    "limitUsd",
    "scopeCostSoFar",
    "name",
  ]);
  assert.deepStrictEqual(
    [err.reason, err.estimatedCost, err.limitUsd, err.scopeCostSoFar],
    ["session_limit", 1, 2, 3],
  );
  assert.strictEqual(
    err.message,
    "Budget exceeded [session_limit]: estimated $1.000000, limit " +
      "$2.000000, session total so far $3.000000",
  );
  assert.strictEqual(err.cause, undefined);
});
