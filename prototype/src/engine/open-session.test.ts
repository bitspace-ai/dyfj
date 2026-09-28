/**
 * Unit tests for the `openSession` stage over a `MemoryStore`: the turn's
 * identity and configuration, the frames it announces, and the integrity
 * `session_start` row.
 */
import {
  assert,
  assertEquals,
  assertNotEquals,
  assertObjectMatch,
  assertRejects,
} from "@std/assert";
import {
  chatReply,
  enginePorts,
  engineServices,
  LOCAL_MODEL,
  patchStore,
} from "../../testing/builders/engine.ts";
import { localDayStart } from "../budget/mod.ts";
import { AGENT_DEFAULTS, BUDGET_DEFAULTS } from "../config/mod.ts";
import type { WorkbenchRuntimeEvent } from "../contract/mod.ts";
import type { Store } from "../store/mod.ts";
import { runWorkbenchRuntime } from "./native-runner.ts";
import { MAX_TOOL_STEPS, openSession } from "./open-session.ts";
import type { WorkbenchRuntimeInput } from "./runtime-types.ts";

const RESUMED = "01TEST00000000000000000001";

function input(
  overrides: Partial<WorkbenchRuntimeInput> = {},
): WorkbenchRuntimeInput {
  return { mode: "turn", prompt: "hello", routingOptions: {}, ...overrides };
}

async function sessionRows(store: Store, sessionId: string) {
  return await store.events.bySession({ sessionId, limit: 50, order: "asc" });
}

Deno.test("openSession writes session_start under the turn root span, with the prompt", async () => {
  const fakes = enginePorts();
  const frames: WorkbenchRuntimeEvent[] = [];
  const session = await openSession(
    input({
      prompt: "what changed?",
      frames: {
        onRuntimeEvent: (event) => void frames.push(event),
      },
    }),
    fakes.ports,
  );
  const rows = await sessionRows(fakes.store, session.sessionId);
  assertEquals(rows.length, 1);
  assertObjectMatch(rows[0], {
    event_type: "session_start",
    trace_id: session.traceId,
    span_id: session.turnRootSpanId,
    principal_id: "user",
    content: "what changed?",
  });
  assertEquals(frames, [
    {
      type: "sessionStart",
      sessionId: session.sessionId,
      traceId: session.traceId,
      mode: "turn",
    },
    { type: "inputReceived", sessionId: session.sessionId, promptLength: 13 },
  ]);
  assertEquals(session.resumingSession, false);
  assertEquals(session.startedAt, 1_000_000);
});

Deno.test("openSession continues a named session instead of creating one", async () => {
  const fakes = enginePorts();
  const session = await openSession(input({ sessionId: RESUMED }), fakes.ports);
  assertEquals(session.sessionId, RESUMED);
  assertEquals(session.resumingSession, true);
});

Deno.test("principalId comes from the input struct and flows to events", async () => {
  const fakes = enginePorts();
  const session = await openSession(
    input({ principalId: "custom-principal" }),
    fakes.ports,
  );
  const rows = await sessionRows(fakes.store, session.sessionId);
  assertEquals(rows.map((row) => row.principal_id), ["custom-principal"]);
  assertEquals(session.principalId, "custom-principal");
});

Deno.test("the input's principalId attributes every row a whole turn writes", async () => {
  const run = engineServices([chatReply({ content: "done" })]);
  // model_selected names the environment's principal, read through the env
  // port, not the input (a known gap, recorded in specs/bug-log.md), so it
  // is excluded here.
  const { sessionId } = await runWorkbenchRuntime({
    mode: "turn",
    prompt: "probe",
    routingOptions: {},
    defaultCompanionModel: LOCAL_MODEL.slug,
    principalId: "custom-principal",
    frames: {
      log: () => {},
    },
  }, run.services);
  const rows = (await sessionRows(run.store, sessionId))
    .filter((row) => row.event_type !== "model_selected");
  assert(rows.length >= 4);
  assertEquals(
    new Set(rows.map((row) => row.principal_id)),
    new Set(["custom-principal"]),
  );
});

Deno.test("an integrity session_start write failure fails the turn before anything else", async () => {
  for (const mode of ["turn", "ask"] as const) {
    const fakes = enginePorts();
    const store: Store = {
      ...fakes.store,
      events: fakes.store.events,
      sessions: fakes.store.sessions,
      memories: fakes.store.memories,
      models: fakes.store.models,
      prompts: fakes.store.prompts,
      spend: fakes.store.spend,
      close: () => fakes.store.close(),
      journal: {
        commit: () =>
          Promise.reject(new Error("simulated write failure: session_start")),
      },
    };
    await assertRejects(
      () => openSession(input({ mode }), { ...fakes.ports, store }),
      Error,
      "simulated write failure: session_start",
    );
  }
});

Deno.test("openSession resolves the budget posture: turn override, then boundary default, then declared default", async () => {
  const fakes = enginePorts();
  const session = await openSession(
    input({
      sessionLimitUsd: 3,
      defaultSessionBudgetUsd: 2,
      defaultPerCallBudgetUsd: 0.5,
      anomalyTurnMultiple: 7,
    }),
    fakes.ports,
  );
  assertEquals(session.budgetConfig, {
    sessionLimitUsd: 3,
    perCallLimitUsd: 0.5,
    dailyLimitUsd: BUDGET_DEFAULTS.dailyLimitUsd,
  });
  assertEquals(session.anomalyConfig.turnMultiple, 7);
});

Deno.test("openSession clamps the tool-step limit and falls back for non-integers", async () => {
  const fakes = enginePorts();
  const cases: Array<[number | undefined, number]> = [
    [undefined, AGENT_DEFAULTS.maxToolSteps],
    [2.5, AGENT_DEFAULTS.maxToolSteps],
    [Number.NaN, AGENT_DEFAULTS.maxToolSteps],
    [0, 1],
    [1_000, MAX_TOOL_STEPS],
    [5, 5],
  ];
  for (const [maxToolSteps, expected] of cases) {
    const session = await openSession(input({ maxToolSteps }), fakes.ports);
    assertEquals(session.maxToolSteps, expected);
  }
});

Deno.test("openSession pins a remote caller's requested workspace to the default root", async () => {
  const fakes = enginePorts();
  const local = await openSession(
    input({ workspaceRoot: "/requested" }),
    fakes.ports,
  );
  assertEquals(local.honoredWorkspace, "/requested");
  const remote = await openSession(
    input({
      workspaceRoot: "/requested",
      authContext: {
        transport: "remote",
        authnStatus: "authenticated",
        authnMechanism: "api_key",
        authnIssuerRef: "test_issuer",
        authzBasis: "bearer_token",
      },
    }),
    fakes.ports,
  );
  assertEquals(remote.honoredWorkspace, undefined);
  assertNotEquals(remote.sessionId, local.sessionId);
});

Deno.test("openSession seeds the budget tracker with spend already on the books", async () => {
  const fakes = enginePorts();
  const session = await openSession(
    input({ sessionId: RESUMED }),
    {
      ...fakes.ports,
      fetchSpendBaselines: (id) => {
        assert(id === RESUMED);
        return Promise.resolve({
          sessionSpentUsd: 0.25,
          sessionSpentTodayUsd: 0.25,
          dailyOtherSessionsUsd: 1,
        });
      },
    },
  );
  const precall = session.budget.checkPreCall(1, 0, 0);
  assertEquals(precall.sessionCostSoFar, 0.25);
});

Deno.test("openSession reads spend baselines for the local day of the injected clock", async () => {
  const fakes = enginePorts({ start: Date.UTC(2020, 1, 29, 12) });
  const reads: Array<{ sessionId: string; dayStart: string }> = [];
  const store = patchStore(fakes.store, {
    spend: {
      baselines: (sessionId, dayStart) => {
        reads.push({ sessionId, dayStart });
        return Promise.resolve({
          sessionSpentUsd: 0,
          sessionSpentTodayUsd: 0,
          dailyOtherSessionsUsd: 0,
        });
      },
    },
  });
  await openSession(input({ sessionId: RESUMED }), {
    ...fakes.ports,
    store,
  });
  assertEquals(reads, [{
    sessionId: RESUMED,
    dayStart: localDayStart(new Date(Date.UTC(2020, 1, 29, 12))),
  }]);
});
