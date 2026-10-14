/**
 * Unit tests for budget/envelope-gate.ts: the per-call, session and daily
 * ceilings (warn-then-confirm), the ceiling warning, and the envelope errors.
 */

import { assertAlmostEqual } from "../../testing/assertions/almost-equal.ts";
import { captureRejection } from "../../testing/assertions/captured.ts";
import assert from "node:assert/strict";
import { mock } from "node:test";
import { MAX_REASON_FIELD_BYTES } from "../contract/mod.ts";
import {
  BudgetCeilingDeclinedError,
  type BudgetCeilingVerdict,
  type BudgetCeilingWarning,
  BudgetExceededError,
  buildBudgetCeilingWarning,
  createTurnBudgetCeilingGate,
  ensureBudgetAllowed,
  formatBudgetCeilingWarning,
} from "./envelope-gate.ts";
import type { PreCallCheck } from "./tracker.ts";

const dailyBudget = { dailyCostSoFar: 0, dailyLimitUsd: 25 };

function approving() {
  return mock.fn(
    (_warning: BudgetCeilingWarning): Promise<BudgetCeilingVerdict> =>
      Promise.resolve({ decision: "approve" }),
  );
}

// ── BudgetExceededError ───────────────────────────────────────────────────────

Deno.test("BudgetExceededError: carries all fields and correct name", () => {
  const e = new BudgetExceededError("session_limit", 0.15, 1.00, 0.92);
  assert.strictEqual(e.name, "BudgetExceededError");
  assert.strictEqual(e.reason, "session_limit");
  assert.strictEqual(e.estimatedCost, 0.15);
  assert.strictEqual(e.limitUsd, 1.00);
  assert.strictEqual(e.scopeCostSoFar, 0.92);
  assert.ok(e instanceof Error);
});

Deno.test("BudgetExceededError: message includes reason, estimated cost, limit, and session total", () => {
  const e = new BudgetExceededError("per_call_limit", 0.12, 0.10, 0.05);
  assert.ok(
    e.message.includes("per_call_limit"),
    `expected e.message to include "per_call_limit"`,
  );
  assert.ok(e.message.includes("0.10"), `expected e.message to include "0.10"`);
});

// ── ensureBudgetAllowed (warn-then-confirm) ───────────────────────────────────

Deno.test("ensureBudgetAllowed: under ceiling proceeds without prompting", async () => {
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

Deno.test("ensureBudgetAllowed: over ceiling with confirm proceeds on approve", async () => {
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

Deno.test("ensureBudgetAllowed: over ceiling without confirm fails closed", async () => {
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

Deno.test("ensureBudgetAllowed: over ceiling denies on decline", async () => {
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

Deno.test("createTurnBudgetCeilingGate: dedupes identical pre-flight and per-call gates to one confirm", async () => {
  const confirm = approving();
  const gate = createTurnBudgetCeilingGate(confirm);
  await gate.ensureAllowed(overPerCall);
  await gate.ensureAllowed({ ...overPerCall });
  assert.equal(confirm.mock.callCount(), 1);
});

Deno.test("createTurnBudgetCeilingGate: re-prompts when session spend crosses after per-call was already confirmed", async () => {
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

Deno.test("createTurnBudgetCeilingGate: frames the session re-prompt as a session limit, not the per-call reason checkPreCall reports", async () => {
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

Deno.test("createTurnBudgetCeilingGate: a confirmed session overrun covers later larger projections in the scope", async () => {
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

Deno.test("createTurnBudgetCeilingGate: decline still aborts without recording a confirmation", async () => {
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

Deno.test("createTurnBudgetCeilingGate: without a confirm handler fails closed on every gate", async () => {
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

// ── composite ceiling approvals ───────────────────────────────────────────────

Deno.test("composite ceiling approvals: one prompt names every newly-crossed scope and raises only those", async () => {
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
  // Only the presented scopes were confirmed — period-wide for session and
  // daily; per-call was never confirmed.
  assert.strictEqual(confirmed.session_limit, Number.POSITIVE_INFINITY);
  assert.strictEqual(confirmed.daily_limit, Number.POSITIVE_INFINITY);
  assert.strictEqual(confirmed.per_call_limit, undefined);
});

// ── cross-session daily refresh ───────────────────────────────────────────────

Deno.test("cross-session daily refresh: the ceiling warning projects the crossed daily scope", () => {
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

Deno.test("scope-aware budget errors: a daily fail-closed error carries the daily figures and framing", async () => {
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

Deno.test("BudgetCeilingDeclinedError — reason field sanitization: a short, ordinary reason passes through unchanged", () => {
  const err = new BudgetCeilingDeclinedError("not now");
  assert.strictEqual(err.reason, "not now");
  assert.strictEqual(
    err.message,
    "Budget ceiling confirmation declined: not now",
  );
});

Deno.test("BudgetCeilingDeclinedError — reason field sanitization: caps an oversized reason, on both .message and the public .reason property", () => {
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

Deno.test("BudgetCeilingDeclinedError — reason field sanitization: strips a terminal escape sequence from the reason", () => {
  const esc = String.fromCharCode(27);
  const err = new BudgetCeilingDeclinedError(`${esc}[31mdanger${esc}[0m`);
  assert.ok(!(err.reason ?? "").includes(esc));
  assert.ok(!err.message.includes(esc));
});
