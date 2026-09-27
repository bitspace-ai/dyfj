/**
 * Unit tests for budget/envelope-gate.ts: the per-call, session and daily
 * ceilings (warn-then-confirm), the ceiling warning, and the envelope errors.
 */

import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertInstanceOf,
  assertLess,
  assertLessOrEqual,
  assertRejects,
  assertStrictEquals,
  assertStringIncludes,
} from "@std/assert";
import { assertSpyCalls, spy } from "@std/testing/mock";
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
  return spy(
    (_warning: BudgetCeilingWarning): Promise<BudgetCeilingVerdict> =>
      Promise.resolve({ decision: "approve" }),
  );
}

// ── BudgetExceededError ───────────────────────────────────────────────────────

Deno.test("BudgetExceededError: carries all fields and correct name", () => {
  const e = new BudgetExceededError("session_limit", 0.15, 1.00, 0.92);
  assertStrictEquals(e.name, "BudgetExceededError");
  assertStrictEquals(e.reason, "session_limit");
  assertStrictEquals(e.estimatedCost, 0.15);
  assertStrictEquals(e.limitUsd, 1.00);
  assertStrictEquals(e.scopeCostSoFar, 0.92);
  assertInstanceOf(e, Error);
});

Deno.test("BudgetExceededError: message includes reason, estimated cost, limit, and session total", () => {
  const e = new BudgetExceededError("per_call_limit", 0.12, 0.10, 0.05);
  assertStringIncludes(e.message, "per_call_limit");
  assertStringIncludes(e.message, "0.10");
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
  assertSpyCalls(confirm, 0);
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
  await assertRejects(
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
  await assertRejects(
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
  assertSpyCalls(confirm, 1);
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
  assertSpyCalls(confirm, 2);
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
  assertSpyCalls(confirm, 2);
  const warnings = confirm.calls.map((call) => call.args[0]);
  assertStrictEquals(warnings[0].reason, "per_call_limit");
  assertAlmostEquals(warnings[0].limitUsd, 0.1);
  assertStrictEquals(warnings[1].reason, "session_limit");
  assertAlmostEquals(warnings[1].limitUsd, 1);
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
  assertSpyCalls(confirm, 1);
});

Deno.test("createTurnBudgetCeilingGate: decline still aborts without recording a confirmation", async () => {
  const confirm = spy(
    (_warning: BudgetCeilingWarning): Promise<BudgetCeilingVerdict> =>
      Promise.resolve({ decision: "deny", reason: "too much" }),
  );
  const gate = createTurnBudgetCeilingGate(confirm);
  await assertRejects(
    () => gate.ensureAllowed(overPerCall),
    BudgetCeilingDeclinedError,
  );
  await assertRejects(
    () => gate.ensureAllowed(overPerCall),
    BudgetCeilingDeclinedError,
  );
  assertSpyCalls(confirm, 2);
});

Deno.test("createTurnBudgetCeilingGate: without a confirm handler fails closed on every gate", async () => {
  const gate = createTurnBudgetCeilingGate(undefined);
  await assertRejects(
    () => gate.ensureAllowed(overPerCall),
    BudgetExceededError,
  );
  await assertRejects(
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
  assertSpyCalls(confirm, 1);
  const warning = confirm.calls[0].args[0];
  assertEquals(warning.crossedScopes, ["daily_limit", "session_limit"]);
  const message = formatBudgetCeilingWarning(warning);
  assertStringIncludes(message, "daily limit + session limit");
  assertStringIncludes(message, "Approving raises:");
  // Only the presented scopes were confirmed — period-wide for session and
  // daily; per-call was never confirmed.
  assertStrictEquals(confirmed.session_limit, Number.POSITIVE_INFINITY);
  assertStrictEquals(confirmed.daily_limit, Number.POSITIVE_INFINITY);
  assertStrictEquals(confirmed.per_call_limit, undefined);
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
  assertStringIncludes(message, "Projected today: $25.050000 / 25.000000");
  assertStringIncludes(message, "Projected session: $0.120000 / 5.000000");
});

// ── scope-aware budget errors ─────────────────────────────────────────────────

Deno.test("scope-aware budget errors: a daily fail-closed error carries the daily figures and framing", async () => {
  const caught = await assertRejects(
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
  assertStrictEquals(caught.reason, "daily_limit");
  assertStrictEquals(caught.limitUsd, 25);
  assertAlmostEquals(caught.scopeCostSoFar, 24.99);
  assertStringIncludes(caught.message, "today's total so far");
  assert(!caught.message.includes("session total"));
});

// ── Peer-supplied reason fields ────────────────────────────────────────────────
//
// reason/declineReason come from an operator or a remote approval peer via an
// injected confirm callback — content this codebase relays, not authors.
// DomainError only certifies the message the constructor BUILDS, so these
// fields are capped and control-char-stripped before they reach either the
// message or the public `.reason` property workbench.ts's log branch reads
// directly.

Deno.test("BudgetCeilingDeclinedError — reason field sanitization: a short, ordinary reason passes through unchanged", () => {
  const err = new BudgetCeilingDeclinedError("not now");
  assertStrictEquals(err.reason, "not now");
  assertStrictEquals(
    err.message,
    "Budget ceiling confirmation declined: not now",
  );
});

Deno.test("BudgetCeilingDeclinedError — reason field sanitization: caps an oversized reason, on both .message and the public .reason property", () => {
  const reason = "SELECT ".repeat(2_000); // well over MAX_REASON_FIELD_BYTES
  const err = new BudgetCeilingDeclinedError(reason);
  assertLessOrEqual(
    new TextEncoder().encode(err.reason ?? "").byteLength,
    MAX_REASON_FIELD_BYTES,
  );
  assert(!err.message.includes(reason));
  assertLess(new TextEncoder().encode(err.message).byteLength, reason.length);
});

Deno.test("BudgetCeilingDeclinedError — reason field sanitization: strips a terminal escape sequence from the reason", () => {
  const esc = String.fromCharCode(27);
  const err = new BudgetCeilingDeclinedError(`${esc}[31mdanger${esc}[0m`);
  assert(!(err.reason ?? "").includes(esc));
  assert(!err.message.includes(esc));
});
