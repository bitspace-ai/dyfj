/**
 * Unit tests for budget/anomaly-gate.ts: the runaway-anomaly hard stop, its
 * warning and wire shape, the turn-scoped gate, and the halt error.
 */

import { captureRejection } from "../../testing/assertions/captured.ts";
import assert from "node:assert/strict";
import { mock } from "node:test";
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
  return mock.fn(
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
  assert.equal(confirm.mock.callCount(), 0);
});

Deno.test("ensureAnomalyAllowed: fails closed without a confirm handler", async () => {
  await assert.rejects(
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
  assert.strictEqual(warning.kind, "runaway_anomaly");
  assert.strictEqual(warning.trigger, "turn_spend");
  assert.strictEqual(warning.authzBasis, "policy:halt:runaway-anomaly");
  assert.strictEqual(
    warning.approvalAuthzBasis,
    "policy:allow:operator-confirmed-anomaly",
  );
});

Deno.test("ensureAnomalyAllowed: decline throws with the trigger and figures", async () => {
  const caught = await captureRejection(
    () =>
      ensureAnomalyAllowed(
        trippedCheck(),
        () => Promise.resolve({ decision: "deny", reason: "not today" }),
      ),
    RunawayAnomalyHaltError,
  );
  assert.strictEqual(caught.name, "RunawayAnomalyHaltError");
  assert.strictEqual(caught.trigger, "turn_spend");
  assert.strictEqual(caught.declined, true);
  assert.ok(
    caught.message.includes("not today"),
    `expected caught.message to include "not today"`,
  );
});

Deno.test("ensureAnomalyAllowed: approvals never persist: the same tripped check prompts again", async () => {
  const check = trippedCheck();
  const confirm = approving();
  await ensureAnomalyAllowed(check, confirm);
  await ensureAnomalyAllowed(check, confirm);
  assert.equal(confirm.mock.callCount(), 2); // no high-water mark, no coverage
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
  assert.ok(
    text.includes("Runaway spend anomaly — hard stop"),
    `expected ${
      JSON.stringify(text)
    } to include "Runaway spend anomaly — hard stop"`,
  );
  assert.ok(
    text.includes("turn spend at 3× the per-call limit"),
    `expected ${
      JSON.stringify(text)
    } to include "turn spend at 3× the per-call limit"`,
  );
  assert.ok(
    text.includes("$0.350000"),
    `expected ${JSON.stringify(text)} to include "$0.350000"`,
  );
  assert.ok(
    text.includes("nothing is raised"),
    `expected ${JSON.stringify(text)} to include "nothing is raised"`,
  );
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
  assert.strictEqual(request.kind, "runaway_anomaly");
  assert.strictEqual(request.trigger, "session_scope");
  assert.strictEqual(typeof request.message, "string");
  assert.strictEqual(request.authzBasis, "policy:halt:runaway-anomaly");
  assert.strictEqual(
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
  assert.equal(confirm.mock.callCount(), 1);
});

Deno.test("createRunawayAnomalyGate: recorded spend past the approved level re-prompts", async () => {
  const confirm = approving();
  const gate = createRunawayAnomalyGate(confirm);
  const t = trackerPast(0.35);
  await gate.ensureAllowed(t.checkAnomaly(2, ANOMALY)); // $0.35 approved
  t.record(makeUsage(1000, 100, 0.10), 2); // increment → $0.45
  await gate.ensureAllowed(t.checkAnomaly(2, ANOMALY));
  assert.equal(confirm.mock.callCount(), 2);
});

Deno.test("createRunawayAnomalyGate: approvals do not survive the gate instance (one turn)", async () => {
  const confirm = approving();
  const check = trackerPast(0.35).checkAnomaly(2, ANOMALY);
  await createRunawayAnomalyGate(confirm).ensureAllowed(check);
  await createRunawayAnomalyGate(confirm).ensureAllowed(check); // next turn
  assert.equal(confirm.mock.callCount(), 2);
});

Deno.test("createRunawayAnomalyGate: fails closed without a handler and records no approval level", async () => {
  const gate = createRunawayAnomalyGate();
  const check = trackerPast(0.35).checkAnomaly(2, ANOMALY);
  await assert.rejects(
    () => gate.ensureAllowed(check),
    RunawayAnomalyHaltError,
  );
  await assert.rejects(
    () => gate.ensureAllowed(check),
    RunawayAnomalyHaltError,
  );
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
  assert.ok(
    err.message.includes("operator override"),
    `expected err.message to include "operator override"`,
  );
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
  assert.ok(!err.message.includes(reason));
  assert.ok(
    (new TextEncoder().encode(err.message).byteLength) < reason.length,
    `expected new TextEncoder().encode(err.message).byteLength < reason.length`,
  );
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
  assert.ok(!err.message.includes(esc));
});
