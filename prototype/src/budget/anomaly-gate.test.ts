/**
 * Unit tests for budget/anomaly-gate.ts: the runaway-anomaly hard stop, its
 * warning and wire shape, the turn-scoped gate, and the halt error.
 */

import { assertAlmostEqual } from "../../testing/assertions/almost-equal.ts";
import { captureRejection } from "../../testing/assertions/captured.ts";
import assert from "node:assert/strict";
import { it, mock, test } from "node:test";
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

test("ensureAnomalyAllowed: no halt → no prompt, no error", async () => {
  const confirm = approving();
  await ensureAnomalyAllowed(makeTracker().checkAnomaly(2, ANOMALY), confirm);
  assert.equal(confirm.mock.callCount(), 0);
});

test("ensureAnomalyAllowed: fails closed without a confirm handler", async () => {
  await assert.rejects(
    () => ensureAnomalyAllowed(trippedCheck()),
    RunawayAnomalyHaltError,
  );
});

test("ensureAnomalyAllowed: approval admits the call; the warning carries the halt and approval bases", async () => {
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

test("ensureAnomalyAllowed: decline throws with the trigger and figures", async () => {
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

test("ensureAnomalyAllowed: approvals never persist: the same tripped check prompts again", async () => {
  const check = trippedCheck();
  const confirm = approving();
  await ensureAnomalyAllowed(check, confirm);
  await ensureAnomalyAllowed(check, confirm);
  assert.equal(confirm.mock.callCount(), 2); // no high-water mark, no coverage
});

// ── runaway anomaly warning formatting ────────────────────────────────────────

test("runaway anomaly warning formatting: format names the trigger, the actuals, and the halt an approval raises to", () => {
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
  // BIT-715: an approval at $0.35 raises the turn halt to twice that spend.
  assert.ok(
    text.includes("$0.700000"),
    `expected ${JSON.stringify(text)} to include "$0.700000"`,
  );
});

test("runaway anomaly warning formatting: approval-request wire shape carries kind, message, and both bases", () => {
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

test("createRunawayAnomalyGate: one anomalous state prompts once: the same spend level re-checks silently", async () => {
  const confirm = approving();
  const gate = createRunawayAnomalyGate(confirm);
  const check = trackerPast(0.35).checkAnomaly(2, ANOMALY);
  await gate.ensureAllowed(check); // turn entry
  await gate.ensureAllowed(check); // first call, identical actuals
  assert.equal(confirm.mock.callCount(), 1);
});

test("createRunawayAnomalyGate: approving at spend S does not prompt again until spend exceeds 2S", async () => {
  const confirm = approving();
  const gate = createRunawayAnomalyGate(confirm);
  const t = trackerPast(0.35); // S = $0.35
  await gate.ensureAllowed(t.checkAnomaly(2, ANOMALY));
  assert.equal(confirm.mock.callCount(), 1);
  t.record(makeUsage(1000, 100, 0.34), 2); // $0.69: inside 2S = $0.70
  await gate.ensureAllowed(t.checkAnomaly(2, ANOMALY));
  assert.equal(confirm.mock.callCount(), 1);
  t.record(makeUsage(1000, 100, 0.02), 2); // $0.71: past 2S
  await gate.ensureAllowed(t.checkAnomaly(2, ANOMALY));
  assert.equal(confirm.mock.callCount(), 2);
  assertAlmostEqual(confirm.mock.calls[1].arguments[0].spentUsd, 0.71);
});

test("createRunawayAnomalyGate: approvals do not survive the gate instance (one turn)", async () => {
  const confirm = approving();
  const check = trackerPast(0.35).checkAnomaly(2, ANOMALY);
  await createRunawayAnomalyGate(confirm).ensureAllowed(check);
  await createRunawayAnomalyGate(confirm).ensureAllowed(check); // next turn
  assert.equal(confirm.mock.callCount(), 2);
});

test("createRunawayAnomalyGate: fails closed without a handler and records no approval level", async () => {
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

test("createRunawayAnomalyGate: approving only the outermost tripped halt still prompts for each other tripped halt", async () => {
  // Turn halt $0.30, session halt $0.80, daily halt $1.00; $1.20 spent trips all three.
  const t = makeTracker({ sessionLimitUsd: 0.40, dailyLimitUsd: 0.50 });
  t.record(makeUsage(1000, 100, 1.20), 2);
  const check = t.checkAnomaly(2, ANOMALY);
  assert.strictEqual(check.trigger, "daily_scope");
  const confirm = approving();
  await createRunawayAnomalyGate(confirm).ensureAllowed(check);
  assert.deepStrictEqual(
    confirm.mock.calls.map((call) => call.arguments[0].trigger),
    ["daily_scope", "session_scope", "turn_spend"],
  );
});

test("createRunawayAnomalyGate: declining a still-tripped halt after the outermost approval blocks the call", async () => {
  const t = makeTracker({ sessionLimitUsd: 0.40, dailyLimitUsd: 0.50 });
  t.record(makeUsage(1000, 100, 1.20), 2);
  const verdicts: BudgetCeilingVerdict[] = [
    { decision: "approve" },
    { decision: "deny", reason: "session stop" },
  ];
  const confirm = mock.fn(
    (_warning: RunawayAnomalyWarning): Promise<BudgetCeilingVerdict> =>
      Promise.resolve(verdicts.shift()!),
  );
  const caught = await captureRejection(
    () =>
      createRunawayAnomalyGate(confirm).ensureAllowed(
        t.checkAnomaly(2, ANOMALY),
      ),
    RunawayAnomalyHaltError,
  );
  assert.strictEqual(caught.trigger, "session_scope");
  assert.strictEqual(caught.declined, true);
  // The turn halt was never prompted: the call stopped at the session halt.
  assert.equal(confirm.mock.callCount(), 2);
});

// ── RunawayAnomalyHaltError — decline reason sanitization ─────────────────────

test("RunawayAnomalyHaltError — decline reason sanitization: a short, ordinary decline reason passes through unchanged", () => {
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

test("RunawayAnomalyHaltError — decline reason sanitization: caps an oversized decline reason", () => {
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

test("RunawayAnomalyHaltError — decline reason sanitization: strips a terminal escape sequence from the decline reason", () => {
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

// Own enumerable properties, in order, are what JSON.stringify and error
// serialization see, so the order each constructor gives them is pinned.
it("RunawayAnomalyHaltError keeps its own properties and message", () => {
  const err = new RunawayAnomalyHaltError("turn_spend", 1, 2);
  assert.deepStrictEqual(Object.keys(err), [
    "trigger",
    "spentUsd",
    "haltUsd",
    "declined",
    "name",
  ]);
  assert.deepStrictEqual(
    [err.trigger, err.spentUsd, err.haltUsd, err.declined],
    ["turn_spend", 1, 2, false],
  );
  assert.strictEqual(
    err.message,
    "Runaway spend anomaly [turn_spend]: actual $1.000000 past halt " +
      "$2.000000 (no confirmation channel; failing closed)",
  );
  assert.strictEqual(err.cause, undefined);
});
