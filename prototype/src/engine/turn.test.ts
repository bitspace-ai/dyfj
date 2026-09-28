import {
  assertEquals,
  assertObjectMatch,
  assertRejects,
  assertStrictEquals,
  assertStringIncludes,
} from "@std/assert";
import { MapEnv } from "../../testing/fakes/map-env.ts";
import { type EventReader, fetchWorkbenchSessionEvents } from "../store/mod.ts";
import type { WorkbenchSessionEvent } from "../contract/mod.ts";
import type {
  WorkbenchRuntimeInput,
  WorkbenchRuntimeResult,
} from "./native-runner.ts";
import { SessionOwners } from "./session-owner.ts";
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

/** Run with `console.error` captured, returning what it printed. */
async function captureStderr<T>(
  run: () => Promise<T>,
): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...parts: unknown[]) => lines.push(parts.join(" "));
  try {
    return { value: await run(), lines };
  } finally {
    console.error = original;
  }
}

Deno.test("[case 5 boundary] empty-after-withholding history fails before runtime model work", async () => {
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
  await assertRejects(
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
    Error,
    "Session history is empty after withholding unavailable tool evidence",
  );
  assertStrictEquals(runtimeCalled, false);
});

Deno.test("[case 4 boundary] threads incident omission facts into runtime without changing persisted prompt", async () => {
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
  assertEquals(captured?.prompt, "continue now");
  assertEquals(captured?.conversationMessages, [
    { role: "user", content: "original persisted prompt" },
  ]);
  assertObjectMatch(captured?.historyOmission ?? {}, {
    detectedInHistory: 1,
    gapMarkers: 1,
    callsUnknown: true,
  });
});

Deno.test("a resumed turn reads its history only after the prior same-session turn settles", async () => {
  const owners = new SessionOwners();
  const log: string[] = [];
  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>((resolve) => releaseFirst = resolve);
  const fetchSessionEvents = (): Promise<WorkbenchSessionEvent[]> => {
    log.push("fetch history");
    return Promise.resolve([]);
  };
  const first = captureStderr(() =>
    executeTurn(
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
    )
  );
  const second = captureStderr(() =>
    executeTurn(
      resolved({ prompt: "second", sessionId: SESSION_ID }),
      deps({
        owners,
        fetchSessionEvents,
        runRuntime: () => {
          log.push("second runs");
          return Promise.resolve(RESULT);
        },
      }),
    )
  );
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assertEquals(log, ["fetch history", "first runs"]);
  releaseFirst();
  await Promise.all([first, second]);
  assertEquals(log, [
    "fetch history",
    "first runs",
    "first settles",
    "fetch history",
    "second runs",
  ]);
});

Deno.test("the ticket's signal reaches the runtime, and only an identified turn reports its window closing", async () => {
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

  assertStrictEquals(inputs[0].abortSignal, identified.signal);
  inputs[0].onCancellationClosed?.();
  assertStrictEquals(identified.cancel(), false);

  assertStrictEquals(inputs[1].abortSignal, anonymous.signal);
  assertStrictEquals(inputs[1].onCancellationClosed, undefined);

  assertStrictEquals(inputs[2].abortSignal, undefined);
  assertStrictEquals(inputs[2].onCancellationClosed, undefined);
});

Deno.test("executeTurn binds boundary config and the transport's paid verdict", async () => {
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
  assertEquals(captured?.budgetTallyMode, "on");
  assertEquals(captured?.maxToolSteps, 7);
  // Workspace trust is a loopback-only standing decision.
  assertStrictEquals(captured?.trustWorkspaceInstructions, false);
  assertEquals(await captured?.confirmPaidEscalation?.("banner"), {
    decision: "deny",
    reason: "paid inference is not available to remote callers",
  });
  assertEquals(lines, [formatTurnSummaryLine(RESULT)]);
});

Deno.test("formatTurnSummaryLine reports external runner evidence without inventing model or USD facts", () => {
  const line = formatTurnSummaryLine({
    sessionId: "01ACP",
    runner: { profile: "fixture", protocol: "acp", costBasis: "local_free" },
  } as unknown as WorkbenchRuntimeResult);
  assertEquals(
    line,
    "[turn] session=01ACP runner=fixture protocol=acp cost_basis=local_free",
  );
  assertEquals(line.includes("model="), false);
  assertEquals(line.includes("cost=$"), false);
});

Deno.test("formatTurnSummaryLine carries routing and cost facts, never content", () => {
  const line = formatTurnSummaryLine({
    sessionId: "01ABC",
    model: { slug: "claude-opus-4-8" },
    tokens: { input: 87, output: 70 },
    cost: { totalUsd: 0.008498, paidInferenceUsed: true },
    text: "SECRET turn content that must not be logged",
  } as unknown as WorkbenchRuntimeResult);
  assertEquals(
    line,
    "[turn] session=01ABC model=claude-opus-4-8 tokens=87in/70out cost=$0.008498 paid",
  );
  assertEquals(line.includes("SECRET"), false);
});

Deno.test("formatTurnSummaryLine degrades gracefully on partial results", () => {
  const line = formatTurnSummaryLine(
    { sessionId: "01X" } as unknown as WorkbenchRuntimeResult,
  );
  assertStringIncludes(line, "model=unknown");
  assertEquals(line, "[turn] session=01X model=unknown tokens=? cost=$? local");
});
