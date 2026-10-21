/**
 * Unit tests for budget/envelope-gate.ts: the per-call, session and daily
 * ceilings (warn-then-confirm), the ceiling warning, and the envelope errors.
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
} from "./envelope-gate.ts";
import type { BudgetCeilingConfirmations } from "./confirmations.ts";
import type { BudgetLimitReason, PreCallCheck } from "./tracker.ts";

/**
 * The per-scope limit an approval of this warning raises to. Carried on the
 * warning by the BIT-715 change; read through a cast until that type lands.
 */
function raisesTo(
  warning: BudgetCeilingWarning,
  scope: BudgetLimitReason,
): number | undefined {
  return (warning as BudgetCeilingWarning & {
    raisesToUsd?: Partial<Record<BudgetLimitReason, number>>;
  }).raisesToUsd?.[scope];
}

const dailyBudget = { dailyCostSoFar: 0, dailyLimitUsd: 25 };

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
    raisesTo(confirm.mock.calls[1].arguments[0], "per_call_limit") ??
      Number.NaN,
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
    raisesTo(confirm.mock.calls[1].arguments[0], "session_limit") ??
      Number.NaN,
    3.1,
  );
});

test("budgetCeilingApprovalRequest: the wire payload carries the limits an approval raises to", () => {
  const warning = buildBudgetCeilingWarning(
    {
      allowed: false,
      estimatedCost: 0.06,
      sessionCostSoFar: 0.95,
      sessionLimitUsd: 1,
      perCallLimitUsd: 0.5,
      ...dailyBudget,
      reason: "session_limit",
    },
    undefined,
    ["session_limit"],
  );
  const request = budgetCeilingApprovalRequest(warning);
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
      reason: "session_limit",
    },
    undefined,
    ["session_limit"],
  );
  const message = formatBudgetCeilingWarning(warning);
  assert.match(
    message,
    /session limit\s+to \$2\.010000/,
    `expected ${JSON.stringify(message)} to state "session limit to $2.010000"`,
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
  // stored as unbounded (Infinity) for the local day.
  assertAlmostEqual(confirmed.session_limit ?? Number.NaN, 10.1);
  assert.strictEqual(confirmed.daily_limit, Number.POSITIVE_INFINITY);
  assert.strictEqual(confirmed.per_call_limit, undefined);
});

// ── cross-session daily refresh ───────────────────────────────────────────────

test("cross-session daily refresh: the ceiling warning projects the crossed daily scope", () => {
  const message = formatBudgetCeilingWarning(buildBudgetCeilingWarning({
    allowed: false,
    estimatedCost: 0.06,
    sessionCostSoFar: 0.06,
    sessionLimitUsd: 5,
    perCallLimitUsd: 1,
    dailyCostSoFar: 24.99,
    dailyLimitUsd: 25,
    reason: "daily_limit",
  }));
  assert.ok(
    message.includes("Projected today: $25.050000 / 25.000000"),
    `expected ${
      JSON.stringify(message)
    } to include "Projected today: $25.050000 / 25.000000"`,
  );
  assert.ok(
    message.includes("Projected session: $0.120000 / 5.000000"),
    `expected ${
      JSON.stringify(message)
    } to include "Projected session: $0.120000 / 5.000000"`,
  );
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
