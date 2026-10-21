/**
 * Unit tests for budget/anomaly-gate.ts: the runaway-anomaly hard stop, its
 * warning and wire shape, the turn-scoped gate, and the halt error.
 */

import { assertAlmostEqual } from "../../testing/assertions/almost-equal.ts";
import { captureRejection } from "../../testing/assertions/captured.ts";
import assert from "node:assert/strict";
import { it, mock, test } from "node:test";
import { ManualClock } from "../../testing/fakes/manual-clock.ts";
import { CeilingConfirmationStore } from "./confirmations.ts";
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
    text.includes("turn spend past its halt (initially 3× the per-call limit)"),
    `expected ${
      JSON.stringify(text)
    } to include "turn spend past its halt (initially 3× the per-call limit)"`,
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

// ── scope-persistent anomaly halts (BIT-715) ─────────────────────────────────

const SCOPE_SESSION = "01TEST0SCOPESESSIONA0000000";
const SCOPE_OTHER_SESSION = "01TEST0SCOPESESSIONB0000000";

/** A clock pinned to local noon on the given day (month is 0-based). */
function clockOn(year: number, month: number, day: number): ManualClock {
  return new ManualClock({ start: new Date(year, month, day, 12).getTime() });
}

/**
 * A session check with session spend `sessionSpent` (session halt $0.80 on a
 * $0.40 session envelope). The turn is $0.10, under its $0.30 halt, so only the
 * session scope can trip.
 */
function sessionCheckAt(sessionSpent: number) {
  const t = new BudgetTracker(
    SCOPE_SESSION,
    TRACE_ID,
    { sessionLimitUsd: 0.40, perCallLimitUsd: 0.10, dailyLimitUsd: 25 },
    "user",
    {
      sessionSpentUsd: sessionSpent - 0.10,
      sessionSpentTodayUsd: sessionSpent - 0.10,
      dailyOtherSessionsUsd: 0,
    },
  );
  t.record(makeUsage(1000, 100, 0.10), 2);
  return t.checkAnomaly(2, ANOMALY);
}

/**
 * A daily check for one session: daily halt $1.00 on a $0.50 daily envelope,
 * session halt $2.00, turn halt $0.30. `otherSessionsUsd` is today's spend in
 * other sessions; `turnSpend` is this turn's spend.
 */
function dailyCheckFor(
  sessionId: string,
  otherSessionsUsd: number,
  turnSpend: number,
) {
  const t = new BudgetTracker(
    sessionId,
    TRACE_ID,
    { sessionLimitUsd: 1.00, perCallLimitUsd: 0.10, dailyLimitUsd: 0.50 },
    "user",
    {
      sessionSpentUsd: 0,
      sessionSpentTodayUsd: 0,
      dailyOtherSessionsUsd: otherSessionsUsd,
    },
  );
  t.record(makeUsage(1000, 100, turnSpend), 2);
  return t.checkAnomaly(2, ANOMALY);
}

test("scope halts: a session anomaly halt survives into a new turn of the same session", async () => {
  const store = new CeilingConfirmationStore(clockOn(2026, 6, 6));
  const confirm = approving();
  // Turn 1: $0.85 session spend passes the $0.80 halt and prompts once.
  await createRunawayAnomalyGate(confirm, store.for(SCOPE_SESSION))
    .ensureAllowed(sessionCheckAt(0.85));
  assert.equal(confirm.mock.callCount(), 1);
  assert.strictEqual(confirm.mock.calls[0].arguments[0].trigger, "session_scope");
  // Turn 2, same session: $0.95 is under the raised $1.70 halt, so no prompt.
  await createRunawayAnomalyGate(confirm, store.for(SCOPE_SESSION))
    .ensureAllowed(sessionCheckAt(0.95));
  assert.equal(confirm.mock.callCount(), 1);
  // Contrast: a gate without the store sees the original $0.80 halt and prompts.
  await createRunawayAnomalyGate(confirm)
    .ensureAllowed(sessionCheckAt(0.95));
  assert.equal(confirm.mock.callCount(), 2);
  // Turn 3, same session: $1.75 passes the raised $1.70 halt and prompts again,
  // with the raised level as the halt in force.
  await createRunawayAnomalyGate(confirm, store.for(SCOPE_SESSION))
    .ensureAllowed(sessionCheckAt(1.75));
  assert.equal(confirm.mock.callCount(), 3);
  assertAlmostEqual(confirm.mock.calls[2].arguments[0].haltUsd, 1.70);
});

test("scope halts: a daily anomaly halt is shared across sessions and resets when the local day rolls over", async () => {
  const clock = clockOn(2026, 6, 6);
  const store = new CeilingConfirmationStore(clock);
  const confirm = approving();
  // Session A: $1.10 today passes the $1.00 daily halt and prompts once.
  await createRunawayAnomalyGate(confirm, store.for(SCOPE_SESSION))
    .ensureAllowed(dailyCheckFor(SCOPE_SESSION, 0.90, 0.20));
  assert.equal(confirm.mock.callCount(), 1);
  assert.strictEqual(confirm.mock.calls[0].arguments[0].trigger, "daily_scope");
  // Session B, same day: $1.30 is under the shared raised $2.20 halt.
  await createRunawayAnomalyGate(confirm, store.for(SCOPE_OTHER_SESSION))
    .ensureAllowed(dailyCheckFor(SCOPE_OTHER_SESSION, 1.10, 0.20));
  assert.equal(confirm.mock.callCount(), 1);
  // Contrast: without the store, session B's $1.30 passes the $1.00 halt.
  await createRunawayAnomalyGate(confirm)
    .ensureAllowed(dailyCheckFor(SCOPE_OTHER_SESSION, 1.10, 0.20));
  assert.equal(confirm.mock.callCount(), 2);
  // Next local day: the raised halt is forgotten and the default $1.00 applies.
  clock.set(new Date(2026, 6, 7, 12).getTime());
  const before = confirm.mock.callCount();
  await createRunawayAnomalyGate(confirm, store.for(SCOPE_OTHER_SESSION))
    .ensureAllowed(dailyCheckFor(SCOPE_OTHER_SESSION, 0, 1.50));
  // The turn's first prompt is the daily scope (the turn halt trips after it).
  const first = confirm.mock.calls[before].arguments[0];
  assert.strictEqual(first.trigger, "daily_scope");
  assertAlmostEqual(first.haltUsd, 1.00);
});

test("scope halts: an out-of-order approval never lowers a stored halt", async () => {
  const store = new CeilingConfirmationStore(clockOn(2026, 6, 6));
  const scope = store.for(SCOPE_SESSION);
  // The slow gate's approval is held open while a newer check is approved.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const slow = createRunawayAnomalyGate(
    () => held.then(() => ({ decision: "approve" as const })),
    scope,
  );
  const slowDone = slow.ensureAllowed(sessionCheckAt(0.85)); // raises to 1.70
  await createRunawayAnomalyGate(approving(), scope)
    .ensureAllowed(sessionCheckAt(0.90)); // raises to 1.80
  release();
  await slowDone;
  // The older 0.85 approval would set 1.70; Math.max keeps 1.80.
  assertAlmostEqual(scope.anomaly_session_halt ?? Number.NaN, 1.80);
});
