import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { MapEnv } from "../../testing/fakes/map-env.ts";
import { type EventReader, fetchWorkbenchSessionEvents } from "../store/mod.ts";
import type { WorkbenchSessionEvent } from "../contract/mod.ts";
import type {
  WorkbenchRuntimeInput,
  WorkbenchRuntimeResult,
} from "./runtime-types.ts";
import { SessionOwners } from "./session-owner.ts";
import { buildCommandToolCallEventPayload } from "../tools/mod.ts";
import { defineBash } from "../tools/builtin/exec.ts";
import { withheldToolResult } from "./tool-history.ts";
import {
  executeTurn,
  type ExecuteTurnDeps,
  formatTurnSummaryLine,
} from "./turn.ts";
import { type ResolvedTurn, resolveTurnFromBody } from "./turn-request.ts";

const SESSION_ID = "01ABCDEF0123456789ABCDEF01";
const TURN_ID = "123e4567-e89b-42d3-a456-426614174000";

/** An event reader that serves these rows for any session. */
function eventsReturning(rows: Record<string, string>[]): EventReader {
  return {
    exists: () => Promise.resolve(false),
    countBySession: () => Promise.resolve(rows.length),
    latestRun: () => Promise.resolve(null),
    bySession: () => Promise.resolve(rows.map((row) => ({ ...row }))),
  };
}

function resolved(body: Record<string, unknown>): ResolvedTurn {
  const result = resolveTurnFromBody(body, true);
  if ("error" in result) throw new Error(result.error);
  return result;
}

const RESULT = {
  sessionId: SESSION_ID,
  model: { slug: "fixture" },
  tokens: { input: 0, output: 0 },
  cost: { totalUsd: 0, paidInferenceUsed: false },
} as unknown as WorkbenchRuntimeResult;

/** Deps with an empty environment, silencing the per-turn stderr line. */
function deps(overrides: Partial<ExecuteTurnDeps>): ExecuteTurnDeps {
  return {
    owners: new SessionOwners(),
    env: new MapEnv({}),
    authContext: {} as never,
    loopback: true,
    fetchSessionEvents: () => Promise.resolve([]),
    runRuntime: () => Promise.resolve(RESULT),
    ...overrides,
  };
}

/**
 * Run with `console.error` stubbed, returning what it printed. Not
 * reentrant: a test that runs turns concurrently wraps them all in one call.
 */
async function captureStderr<T>(
  run: () => Promise<T>,
): Promise<{ value: T; lines: string[] }> {
  const error = mock.method(console, "error", () => {});
  try {
    const value = await run();
    return {
      value,
      lines: error.mock.calls.map((call) => call.arguments.join(" ")),
    };
  } finally {
    error.mock.restore();
  }
}

test("[case 5 boundary] empty-after-withholding history fails before runtime model work", async () => {
  const events = await fetchWorkbenchSessionEvents({
    sessionId: SESSION_ID,
    events: eventsReturning([{
      event_id: "tool-event",
      event_type: "tool_call",
      trace_id: "trace",
      principal_id: "workbench",
      tool_name: "read_file",
      tool_call_id: "call-1",
      tool_arguments: "not-json",
      tool_result: "README.md",
      tool_is_error: "0",
      created_at: "2026-09-01 12:00:00",
    }]),
  });
  let runtimeCalled = false;
  await assert.rejects(
    () =>
      executeTurn(
        resolved({ prompt: "what did it find?", sessionId: SESSION_ID }),
        deps({
          fetchSessionEvents: () => Promise.resolve(events),
          runRuntime: () => {
            runtimeCalled = true;
            return Promise.reject(new Error("runtime must not start"));
          },
        }),
      ),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes(
        "Session history is empty after withholding unavailable tool evidence",
      ),
  );
  assert.strictEqual(runtimeCalled, false);
});

test("[case 4 boundary] threads incident omission facts into runtime without changing persisted prompt", async () => {
  const events = await fetchWorkbenchSessionEvents({
    sessionId: SESSION_ID,
    events: eventsReturning([
      {
        event_id: "gap-event",
        event_type: "tool_call",
        trace_id: "trace",
        principal_id: "workbench",
        tool_name: "acp.history_unavailable",
        tool_call_id: "gap-1",
        tool_arguments: "{}",
        tool_result: "",
        tool_is_error: "1",
        created_at: "2026-09-01 12:00:01",
      },
      {
        event_id: "prompt-event",
        event_type: "session_start",
        trace_id: "trace",
        principal_id: "operator",
        content: "original persisted prompt",
        created_at: "2026-09-01 12:00:00",
      },
    ]),
  });
  let captured: WorkbenchRuntimeInput | undefined;
  await captureStderr(() =>
    executeTurn(
      resolved({ prompt: "continue now", sessionId: SESSION_ID }),
      deps({
        fetchSessionEvents: () => Promise.resolve(events),
        runRuntime: (input) => {
          captured = input;
          return Promise.resolve(RESULT);
        },
      }),
    )
  );
  assert.deepStrictEqual(captured?.prompt, "continue now");
  assert.deepStrictEqual(captured?.conversationMessages, [
    { role: "user", content: "original persisted prompt" },
  ]);
  assert.partialDeepStrictEqual(captured?.historyOmission ?? {}, {
    detectedInHistory: 1,
    gapMarkers: 1,
    callsUnknown: true,
  });
});

// BIT-812: a bash result from an earlier turn reaches the model on the next
// turn. The durable event is written exactly as `invokeCommandWithEvent`
// writes it, so it holds only the redaction sentinel, and the next turn
// rebuilds its history from that log.
const TAP = [
  "TAP version 13",
  "# Subtest: parses a session id",
  "ok 1 - parses a session id",
  "# Subtest: rejects an empty prompt",
  "not ok 2 - rejects an empty prompt",
  "1..2",
  "# tests 2",
  "# pass 1",
  "# fail 1",
].join("\n");

const LOOPBACK = {
  transport: "loopback",
  authnStatus: "authenticated",
  authnMechanism: "local_user",
  authnIssuerRef: "local",
  authzBasis: "loopback-operator",
} as const;

async function priorBashTurn(): Promise<WorkbenchSessionEvent[]> {
  const toolEvent = buildCommandToolCallEventPayload(
    {
      commandId: "bash",
      callId: "toolu_01",
      caller: { principalId: "workbench", principalType: "agent" },
      arguments: { command: "node --test" },
    },
    {
      decision: "allow",
      authzBasis: "policy:allow:bash-allowlist",
      isError: false,
      result: TAP,
    },
    { sessionId: SESSION_ID, traceId: "trace", eventId: "tool-event" },
    defineBash("/tmp"),
  );
  assert.strictEqual(toolEvent.tool_result, "[redacted]");
  return await fetchWorkbenchSessionEvents({
    sessionId: SESSION_ID,
    events: eventsReturning([
      {
        event_id: "prompt-event",
        event_type: "session_start",
        trace_id: "trace",
        principal_id: "operator",
        content: "run the tests",
        created_at: "2026-10-27 12:00:00",
      },
      {
        ...toolEvent,
        tool_is_error: "0",
        created_at: "2026-10-27 12:00:01",
      } as unknown as Record<string, string>,
    ]),
  });
}

/** The tool message the next turn's rebuilt history gives the model. */
async function replayedToolResult(
  owners: SessionOwners,
  authContext: ExecuteTurnDeps["authContext"],
): Promise<string | undefined> {
  const events = await priorBashTurn();
  let captured: WorkbenchRuntimeInput | undefined;
  await captureStderr(() =>
    executeTurn(
      resolved({ prompt: "how many failed?", sessionId: SESSION_ID }),
      deps({
        owners,
        authContext,
        fetchSessionEvents: () => Promise.resolve(events),
        runRuntime: (input) => {
          captured = input;
          return Promise.resolve(RESULT);
        },
      }),
    )
  );
  const message = captured?.conversationMessages?.find((m) =>
    m.role === "tool"
  );
  return message?.content;
}

test("ordinary node --test TAP output from a prior turn reaches the model on the next turn", async () => {
  const owners = new SessionOwners();
  owners.toolHistory(SESSION_ID, LOOPBACK).record("trace", "toolu_01", TAP);
  assert.strictEqual(await replayedToolResult(owners, LOOPBACK), TAP);
});

test("a turn with other clearance on the same session gets the withheld line, never the recorded text", async () => {
  const owners = new SessionOwners();
  owners.toolHistory(SESSION_ID, LOOPBACK).record("trace", "toolu_01", TAP);
  const replayed = await replayedToolResult(owners, {
    ...LOOPBACK,
    transport: "remote",
    authnMechanism: "api_key",
  });
  assert.strictEqual(replayed, withheldToolResult("bash"));
  assert.ok(!replayed?.includes("# pass"));
});

test("a redacted result the engine no longer holds is replayed as unavailable, not as a bare sentinel", async () => {
  // A fresh owners registry: what a restarted engine has.
  const replayed = await replayedToolResult(new SessionOwners(), LOOPBACK);
  assert.strictEqual(replayed, withheldToolResult("bash"));
  assert.match(replayed ?? "", /not available/);
  assert.match(replayed ?? "", /not the command's output/);
  assert.match(replayed ?? "", /Rerun the command/);
});

test("a resumed turn reads its history only after the prior same-session turn settles", async () => {
  const owners = new SessionOwners();
  const log: string[] = [];
  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>((resolve) => releaseFirst = resolve);
  const fetchSessionEvents = (): Promise<WorkbenchSessionEvent[]> => {
    log.push("fetch history");
    return Promise.resolve([]);
  };
  await captureStderr(async () => {
    const first = executeTurn(
      resolved({ prompt: "first", sessionId: SESSION_ID }),
      deps({
        owners,
        fetchSessionEvents,
        runRuntime: async () => {
          log.push("first runs");
          await firstHeld;
          log.push("first settles");
          return RESULT;
        },
      }),
    );
    const second = executeTurn(
      resolved({ prompt: "second", sessionId: SESSION_ID }),
      deps({
        owners,
        fetchSessionEvents,
        runRuntime: () => {
          log.push("second runs");
          return Promise.resolve(RESULT);
        },
      }),
    );
    for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.deepStrictEqual(log, ["fetch history", "first runs"]);
    releaseFirst();
    await Promise.all([first, second]);
  });
  assert.deepStrictEqual(log, [
    "fetch history",
    "first runs",
    "first settles",
    "fetch history",
    "second runs",
  ]);
});

test("a new-session turn hands the runtime the id its owner holds; a resumed turn carries none", async () => {
  const owners = new SessionOwners();
  const inputs: WorkbenchRuntimeInput[] = [];
  let activeDuringRun = 0;
  const runRuntime = (input: WorkbenchRuntimeInput) => {
    inputs.push(input);
    activeDuringRun = owners.activeSessions;
    return Promise.resolve(RESULT);
  };
  await captureStderr(async () => {
    await executeTurn(
      resolved({ prompt: "new" }),
      deps({ owners, runRuntime }),
    );
    await executeTurn(
      resolved({ prompt: "resumed", sessionId: SESSION_ID }),
      deps({ owners, runRuntime }),
    );
  });
  assert.deepStrictEqual(inputs[0].sessionId, undefined);
  assert.match(inputs[0].newSessionId ?? "", /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.deepStrictEqual(inputs[1].sessionId, SESSION_ID);
  assert.deepStrictEqual(inputs[1].newSessionId, undefined);
  assert.deepStrictEqual(activeDuringRun, 1);
});

test("the ticket's signal reaches the runtime, and only an identified turn reports its window closing", async () => {
  const owners = new SessionOwners();
  const inputs: WorkbenchRuntimeInput[] = [];
  const runRuntime = (input: WorkbenchRuntimeInput) => {
    inputs.push(input);
    return Promise.resolve(RESULT);
  };
  const identified = owners.admit();
  await captureStderr(() =>
    executeTurn(
      resolved({ prompt: "hi", turnId: TURN_ID }),
      deps({ owners, ticket: identified, runRuntime }),
    )
  );
  const anonymous = owners.admit();
  await captureStderr(() =>
    executeTurn(
      resolved({ prompt: "hi" }),
      deps({ owners, ticket: anonymous, runRuntime }),
    )
  );
  await captureStderr(() =>
    executeTurn(resolved({ prompt: "hi" }), deps({ owners, runRuntime }))
  );

  assert.strictEqual(inputs[0].abortSignal, identified.signal);
  inputs[0].cancellationWindow?.closeCancellation();
  assert.strictEqual(identified.cancel(), false);

  assert.strictEqual(inputs[1].abortSignal, anonymous.signal);
  assert.strictEqual(inputs[1].cancellationWindow, undefined);

  assert.strictEqual(inputs[2].abortSignal, undefined);
  assert.strictEqual(inputs[2].cancellationWindow, undefined);
});

test("a turn cancelled while queued behind its session's lock starts already aborted", async () => {
  const owners = new SessionOwners();
  const log: string[] = [];
  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>((resolve) => releaseFirst = resolve);
  let queuedInput: WorkbenchRuntimeInput | undefined;
  const queued = owners.admit();
  await captureStderr(async () => {
    const first = executeTurn(
      resolved({ prompt: "first", sessionId: SESSION_ID }),
      deps({
        owners,
        ticket: owners.admit(),
        runRuntime: async () => {
          log.push("first runs");
          await firstHeld;
          return RESULT;
        },
      }),
    );
    const second = executeTurn(
      resolved({ prompt: "second", sessionId: SESSION_ID, turnId: TURN_ID }),
      deps({
        owners,
        ticket: queued,
        runRuntime: (input) => {
          log.push("second runs");
          queuedInput = input;
          return Promise.resolve(RESULT);
        },
      }),
    );
    for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.deepStrictEqual(log, ["first runs"]);
    // The queued turn's window is open before it runs: the cancel is honored
    // once.
    assert.strictEqual(queued.cancel(), true);
    assert.strictEqual(queued.cancel(), false);
    releaseFirst();
    await Promise.all([first, second]);
  });
  // It keeps its place in the queue, and its runtime starts already aborted.
  assert.deepStrictEqual(log, ["first runs", "second runs"]);
  assert.strictEqual(queuedInput?.abortSignal, queued.signal);
  assert.strictEqual(queuedInput?.abortSignal?.aborted, true);
});

test("executeTurn binds boundary config and the transport's paid verdict", async () => {
  let captured: WorkbenchRuntimeInput | undefined;
  const runRuntime = (input: WorkbenchRuntimeInput) => {
    captured = input;
    return Promise.resolve(RESULT);
  };
  const { lines } = await captureStderr(() =>
    executeTurn(
      resolveTurnFromBody(
        { prompt: "hi", approvePaidInference: true },
        false,
      ) as ResolvedTurn,
      deps({
        loopback: false,
        env: new MapEnv({ DYFJ_BUDGET_TALLY: "on" }),
        trustWorkspaceInstructions: true,
        maxToolSteps: 7,
        runRuntime,
      }),
    )
  );
  assert.deepStrictEqual(captured?.budgetTallyMode, "on");
  assert.deepStrictEqual(captured?.maxToolSteps, 7);
  // Workspace trust is a loopback-only standing decision.
  assert.strictEqual(captured?.trustWorkspaceInstructions, false);
  assert.deepStrictEqual(
    await captured?.approver?.confirmPaidEscalation?.("banner"),
    {
      decision: "deny",
      reason: "paid inference is not available to remote callers",
    },
  );
  assert.deepStrictEqual(lines, [formatTurnSummaryLine(RESULT)]);
});

test("formatTurnSummaryLine reports external runner evidence without inventing model or USD facts", () => {
  const line = formatTurnSummaryLine({
    sessionId: "01ACP",
    runner: { profile: "fixture", protocol: "acp", costBasis: "local_free" },
  } as unknown as WorkbenchRuntimeResult);
  assert.deepStrictEqual(
    line,
    "[turn] session=01ACP runner=fixture protocol=acp cost_basis=local_free",
  );
  assert.deepStrictEqual(line.includes("model="), false);
  assert.deepStrictEqual(line.includes("cost=$"), false);
});

test("formatTurnSummaryLine carries routing and cost facts, never content", () => {
  const line = formatTurnSummaryLine({
    sessionId: "01ABC",
    model: { slug: "claude-opus-4-8" },
    tokens: { input: 87, output: 70 },
    cost: { totalUsd: 0.008498, paidInferenceUsed: true },
    text: "SECRET turn content that must not be logged",
  } as unknown as WorkbenchRuntimeResult);
  assert.deepStrictEqual(
    line,
    "[turn] session=01ABC model=claude-opus-4-8 tokens=87in/70out cost=$0.008498 paid",
  );
  assert.deepStrictEqual(line.includes("SECRET"), false);
});

test("formatTurnSummaryLine degrades gracefully on partial results", () => {
  const line = formatTurnSummaryLine(
    { sessionId: "01X" } as unknown as WorkbenchRuntimeResult,
  );
  assert.ok(
    line.includes("model=unknown"),
    `expected ${JSON.stringify(line)} to include "model=unknown"`,
  );
  assert.deepStrictEqual(
    line,
    "[turn] session=01X model=unknown tokens=? cost=$? local",
  );
});
