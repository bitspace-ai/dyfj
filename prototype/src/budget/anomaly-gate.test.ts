/**
 * Unit tests for budget/anomaly-gate.ts: the runaway-anomaly hard stop, its
 * warning and wire shape, the turn-scoped gate, and the halt error.
 */

import {
  assert,
  assertLess,
  assertRejects,
  assertStrictEquals,
  assertStringIncludes,
} from "@std/assert";
import { assertSpyCalls, spy } from "@std/testing/mock";
import type { BudgetCeilingVerdict } from "./envelope-gate.ts";
import {
  buildRunawayAnomalyWarning,
  createRunawayAnomalyGate,
  ensureAnomalyAllowed,
  formatRunawayAnomalyWarning,
  runawayAnomalyApprovalRequest,
  RunawayAnomalyHaltError,
  type RunawayAnomalyWarning,
} from "./anomaly-gate.ts";
import { type BudgetConfig, BudgetTracker } from "./tracker.ts";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SESSION_ID = "01TEST0SESSION0000000000000";
const TRACE_ID = "aabbccddeeff00112233445566778899";
const ANOMALY = { turnMultiple: 3, scopeMultiple: 2 };

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

function approving() {
  return spy(
    (_warning: RunawayAnomalyWarning): Promise<BudgetCeilingVerdict> =>
      Promise.resolve({ decision: "approve" }),
  );
}

// ── ensureAnomalyAllowed ──────────────────────────────────────────────────────

function trippedCheck() {
  const t = makeTracker();
  t.record(makeUsage(100_000, 1000, 0.35), 2);
  return t.checkAnomaly(2, ANOMALY);
}

Deno.test("ensureAnomalyAllowed: no halt → no prompt, no error", async () => {
  const confirm = approving();
  await ensureAnomalyAllowed(makeTracker().checkAnomaly(2, ANOMALY), confirm);
  assertSpyCalls(confirm, 0);
});

Deno.test("ensureAnomalyAllowed: fails closed without a confirm handler", async () => {
  await assertRejects(
    () => ensureAnomalyAllowed(trippedCheck()),
    RunawayAnomalyHaltError,
  );
});

Deno.test("ensureAnomalyAllowed: approval admits the call; the warning carries the halt and approval bases", async () => {
  const seen: unknown[] = [];
  await ensureAnomalyAllowed(trippedCheck(), (warning) => {
    seen.push(warning);
    return Promise.resolve({ decision: "approve" });
  });
  const warning = seen[0] as Record<string, unknown>;
  assertStrictEquals(warning.kind, "runaway_anomaly");
  assertStrictEquals(warning.trigger, "turn_spend");
  assertStrictEquals(warning.authzBasis, "policy:halt:runaway-anomaly");
  assertStrictEquals(
    warning.approvalAuthzBasis,
    "policy:allow:operator-confirmed-anomaly",
  );
});

Deno.test("ensureAnomalyAllowed: decline throws with the trigger and figures", async () => {
  const caught = await assertRejects(
    () =>
      ensureAnomalyAllowed(
        trippedCheck(),
        () => Promise.resolve({ decision: "deny", reason: "not today" }),
      ),
    RunawayAnomalyHaltError,
  );
  assertStrictEquals(caught.name, "RunawayAnomalyHaltError");
  assertStrictEquals(caught.trigger, "turn_spend");
  assertStrictEquals(caught.declined, true);
  assertStringIncludes(caught.message, "not today");
});

Deno.test("ensureAnomalyAllowed: approvals never persist: the same tripped check prompts again", async () => {
  const check = trippedCheck();
  const confirm = approving();
  await ensureAnomalyAllowed(check, confirm);
  await ensureAnomalyAllowed(check, confirm);
  assertSpyCalls(confirm, 2); // no high-water mark, no coverage
});

// ── runaway anomaly warning formatting ────────────────────────────────────────

Deno.test("runaway anomaly warning formatting: format names the trigger, the actuals, and the no-raise semantics", () => {
  const t = makeTracker();
  t.record(makeUsage(100_000, 1000, 0.35), 2);
  const text = formatRunawayAnomalyWarning(
    buildRunawayAnomalyWarning(
      t.checkAnomaly(2, { turnMultiple: 3, scopeMultiple: 2 }),
    ),
  );
  assertStringIncludes(text, "Runaway spend anomaly — hard stop");
  assertStringIncludes(text, "turn spend at 3× the per-call limit");
  assertStringIncludes(text, "$0.350000");
  assertStringIncludes(text, "nothing is raised");
});

Deno.test("runaway anomaly warning formatting: approval-request wire shape carries kind, message, and both bases", () => {
  const t = makeTracker(undefined, {
    sessionSpentUsd: 2.5,
    sessionSpentTodayUsd: 2.5,
    dailyOtherSessionsUsd: 0,
  });
  const request = runawayAnomalyApprovalRequest(
    buildRunawayAnomalyWarning(
      t.checkAnomaly(2, { turnMultiple: 3, scopeMultiple: 2 }),
    ),
  );
  assertStrictEquals(request.kind, "runaway_anomaly");
  assertStrictEquals(request.trigger, "session_scope");
  assertStrictEquals(typeof request.message, "string");
  assertStrictEquals(request.authzBasis, "policy:halt:runaway-anomaly");
  assertStrictEquals(
    request.approvalAuthzBasis,
    "policy:allow:operator-confirmed-anomaly",
  );
});

// ── createRunawayAnomalyGate ──────────────────────────────────────────────────

function trackerPast(turnSpent: number) {
  const t = makeTracker();
  t.record(makeUsage(1000, 100, turnSpent), 2);
  return t;
}

Deno.test("createRunawayAnomalyGate: one anomalous state prompts once: the same spend level re-checks silently", async () => {
  const confirm = approving();
  const gate = createRunawayAnomalyGate(confirm);
  const check = trackerPast(0.35).checkAnomaly(2, ANOMALY);
  await gate.ensureAllowed(check); // turn entry
  await gate.ensureAllowed(check); // first call, identical actuals
  assertSpyCalls(confirm, 1);
});

Deno.test("createRunawayAnomalyGate: recorded spend past the approved level re-prompts", async () => {
  const confirm = approving();
  const gate = createRunawayAnomalyGate(confirm);
  const t = trackerPast(0.35);
  await gate.ensureAllowed(t.checkAnomaly(2, ANOMALY)); // $0.35 approved
  t.record(makeUsage(1000, 100, 0.10), 2); // increment → $0.45
  await gate.ensureAllowed(t.checkAnomaly(2, ANOMALY));
  assertSpyCalls(confirm, 2);
});

Deno.test("createRunawayAnomalyGate: approvals do not survive the gate instance (one turn)", async () => {
  const confirm = approving();
  const check = trackerPast(0.35).checkAnomaly(2, ANOMALY);
  await createRunawayAnomalyGate(confirm).ensureAllowed(check);
  await createRunawayAnomalyGate(confirm).ensureAllowed(check); // next turn
  assertSpyCalls(confirm, 2);
});

Deno.test("createRunawayAnomalyGate: fails closed without a handler and records no approval level", async () => {
  const gate = createRunawayAnomalyGate();
  const check = trackerPast(0.35).checkAnomaly(2, ANOMALY);
  await assertRejects(() => gate.ensureAllowed(check), RunawayAnomalyHaltError);
  await assertRejects(() => gate.ensureAllowed(check), RunawayAnomalyHaltError);
});

// ── RunawayAnomalyHaltError — decline reason sanitization ─────────────────────

Deno.test("RunawayAnomalyHaltError — decline reason sanitization: a short, ordinary decline reason passes through unchanged", () => {
  const err = new RunawayAnomalyHaltError(
    "session_scope",
    0.5,
    0.1,
    true,
    "operator override",
  );
  assertStringIncludes(err.message, "operator override");
});

Deno.test("RunawayAnomalyHaltError — decline reason sanitization: caps an oversized decline reason", () => {
  const reason = "SELECT ".repeat(2_000);
  const err = new RunawayAnomalyHaltError(
    "session_scope",
    0.5,
    0.1,
    true,
    reason,
  );
  assert(!err.message.includes(reason));
  assertLess(new TextEncoder().encode(err.message).byteLength, reason.length);
});

Deno.test("RunawayAnomalyHaltError — decline reason sanitization: strips a terminal escape sequence from the decline reason", () => {
  const esc = String.fromCharCode(27);
  const err = new RunawayAnomalyHaltError(
    "session_scope",
    0.5,
    0.1,
    true,
    `${esc}[31mdanger${esc}[0m`,
  );
  assert(!err.message.includes(esc));
});
