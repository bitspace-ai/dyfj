/**
 * Component tests for the native turn pipeline: `runWorkbenchRuntime` wired to
 * in-repo fakes only — a seeded `MemoryStore`, a `ScriptedHttpTransport` that
 * answers each provider call, a `ManualClock`, a `MapEnv`, and real temp
 * directories as workspaces. No module is mocked. Each test drives a whole
 * turn and reads what crossed the ports: provider requests, event rows, the
 * session record, frames, and the returned receipt.
 */
import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertObjectMatch,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { assertSpyCalls, spy, stub } from "@std/testing/mock";
import {
  chatReply,
  conversation,
  type EngineRun,
  engineServices,
  eventRows,
  LOCAL_MODEL,
  patchStore,
  pricedLocalModel,
  runTurn,
  systemMessage,
  tempWorkspace,
} from "../../testing/builders/engine.ts";
import type {
  HistoryOmissionProjection,
  WorkbenchAuthContext,
  WorkbenchRuntimeEvent,
} from "../contract/mod.ts";
import {
  createWorkbenchSession,
  fetchWorkbenchSessionEvents,
} from "../store/mod.ts";
import type { ConfirmToolApproval } from "../tools/mod.ts";
import { AGENTS_INSTRUCTIONS_TRUST_PREAMBLE } from "./build-context.ts";
import { WorkspaceContextUnavailableError } from "./errors.ts";
import { runWorkbenchRuntime } from "./native-runner.ts";
import type { NativeWorkbenchRuntimeResult } from "./runtime-types.ts";
import { SessionOwners } from "./session-owner.ts";
import { executeTurn } from "./turn.ts";
import { resolveTurnFromBody } from "./turn-request.ts";

const RESUMED = "01TEST00000000000000000001";
const REMOTE: WorkbenchAuthContext = {
  transport: "remote",
  authnStatus: "authenticated",
  authnMechanism: "api_key",
  authnIssuerRef: "test_issuer",
  authzBasis: "bearer_token",
};
const NOTICE_OPEN = "[Workbench-generated history notice]";

async function createResumedSession(run: EngineRun): Promise<void> {
  await createWorkbenchSession({
    journal: run.store.journal,
    sessionId: RESUMED,
    slug: "workbench-resumed",
    taskDescription: "earlier",
    workspace: undefined,
    content: "{}",
  });
}

// ─── pipeline shape ──────────────────────────────────────────────────────────

Deno.test("a companion turn runs open → context → route → loop → finalize with one provider call", async () => {
  await using root = await tempWorkspace();
  const run = engineServices([chatReply({ content: "runtime response" })]);
  const frames: WorkbenchRuntimeEvent[] = [];
  const result = await runTurn(run, {
    rootOverride: root.root,
    frames: {
      onRuntimeEvent: (event) => void frames.push(event),
    },
  });
  run.transport.assertDone();
  assertEquals(result.text, "runtime response");
  assertEquals(result.stopReason, "stop");
  assertEquals(result.model.slug, "local-chat");
  const types = (await eventRows(run, result.sessionId)).map((row) =>
    row.event_type
  );
  assertEquals(types[0], "session_start");
  assert(types.includes("provider_call"));
  assert(types.includes("model_response"));
  assertEquals(types.at(-2), "session_end");
  assertEquals(
    frames.map((frame) => frame.type).slice(0, 3),
    ["sessionStart", "inputReceived", "contextBuilt"],
  );
  assertEquals(frames.at(-1)?.type, "turnCompleted");
});

Deno.test("principalId from the input attributes every event of the turn except model_selected", async () => {
  await using root = await tempWorkspace();
  const run = engineServices([chatReply({ content: "ok" })], {
    env: { DYFJ_PRINCIPAL_ID: "env-principal" },
  });
  const result = await runTurn(run, {
    rootOverride: root.root,
    principalId: "custom-principal",
  });
  const rows = await eventRows(run, result.sessionId);
  assert(rows.filter((row) => row.event_type !== "model_selected").length >= 4);
  const principals = new Set(
    rows.filter((row) => row.event_type !== "model_selected").map((row) =>
      row.principal_id
    ),
  );
  assertEquals(principals, new Set(["custom-principal"]));
  // model_selected has always named the environment's principal (logged in
  // specs/bug-log.md); the engine reads it through its env port.
  const selected = rows.find((row) => row.event_type === "model_selected");
  assertEquals(selected?.principal_id, "env-principal");
});

// ─── workspace binding across stages ─────────────────────────────────────────

Deno.test("an ask turn whose selected workspace is unavailable fails before any provider call", async () => {
  await using runtime = await tempWorkspace({ "README.md": "RUNTIME ROOT" });
  const run = engineServices([]);
  await assertRejects(
    () =>
      runTurn(run, {
        mode: "ask",
        rootOverride: runtime.root,
        workspaceRoot: `${runtime.root}/missing-workspace`,
      }),
    WorkspaceContextUnavailableError,
  );
  assertEquals(run.transport.requests.length, 0);
});

Deno.test("an ask turn whose resumed-workspace lookup fails stops before any provider call", async () => {
  await using runtime = await tempWorkspace({ "README.md": "RUNTIME ROOT" });
  const run = engineServices([]);
  run.services.store = patchStore(run.store, {
    sessions: {
      ...run.store.sessions,
      workspace: () => Promise.reject(new Error("session row unreadable")),
    },
  });
  const error = await runTurn(run, {
    mode: "ask",
    rootOverride: runtime.root,
    sessionId: RESUMED,
  }).catch((err) => err);
  assertInstanceOf(error, WorkspaceContextUnavailableError);
  assertEquals(run.transport.requests.length, 0);
});

Deno.test("a remote resumed ask stays pinned when its stored-workspace lookup fails, and completes", async () => {
  await using runtime = await tempWorkspace({ "README.md": "RUNTIME ROOT" });
  const run = engineServices([chatReply({ content: "answer" })]);
  run.services.store = patchStore(run.store, {
    sessions: {
      ...run.store.sessions,
      workspace: () => Promise.reject(new Error("session row unreadable")),
    },
  });
  const result = await runTurn(run, {
    mode: "ask",
    rootOverride: runtime.root,
    sessionId: RESUMED,
    authContext: REMOTE,
  });
  assertEquals(result.text, "answer");
  assertEquals(run.transport.requests.length, 1);
  assertStringIncludes(
    systemMessage(run.transport.requests[0]),
    "RUNTIME ROOT",
  );
});

Deno.test("an elevated AGENTS.md reaches the provider request and the session record", async () => {
  await using root = await tempWorkspace({
    "AGENTS.md": "# Repo Rules\n\nLog friction to the pilot register.",
  });
  const run = engineServices([chatReply({ content: "runtime response" })]);
  const result = await runTurn(run, {
    rootOverride: root.root,
    trustWorkspaceInstructions: true,
  });
  const system = systemMessage(run.transport.requests[0]);
  assertStringIncludes(
    system,
    `## AGENTS.md\n${AGENTS_INSTRUCTIONS_TRUST_PREAMBLE}`,
  );
  assertStringIncludes(system, "Log friction to the pilot register.");
  const row = await run.store.sessions.detail({ sessionId: result.sessionId });
  assertStringIncludes(row?.content ?? "", "AGENTS.md");
});

// ─── persisted-history omission notice ───────────────────────────────────────

const GAP_OMISSION: HistoryOmissionProjection = {
  detectedInHistory: 1,
  malformedToolRecords: 0,
  gapMarkers: 1,
  callsUnknown: true,
  withheldFromProjection: 1,
  projectedPairs: 0,
};
const MALFORMED_OMISSION: HistoryOmissionProjection = {
  detectedInHistory: 1,
  malformedToolRecords: 1,
  gapMarkers: 0,
  callsUnknown: false,
  withheldFromProjection: 1,
  projectedPairs: 0,
};

Deno.test("[follow-up case 15] successful native companion composition exposes the omission notice and receipt", async () => {
  await using root = await tempWorkspace();
  const run = engineServices([chatReply({ content: "runtime response" })]);
  const result = await runTurn(run, {
    prompt: "continue",
    rootOverride: root.root,
    conversationMessages: [{ role: "user", content: "persisted prompt" }],
    historyOmission: GAP_OMISSION,
  });
  const request = run.transport.requests[0];
  assertStringIncludes(systemMessage(request), NOTICE_OPEN);
  assertEquals(conversation(request), [
    { role: "user", content: "persisted prompt" },
    { role: "user", content: "continue" },
  ]);
  assertObjectMatch(result.historyOmission ?? {}, {
    historyDelivery: "projected-transcript",
    noticeIncluded: true,
  });
  assertStringIncludes(result.receipt, "Tool evidence withheld: 1 record");
  assertStringIncludes(result.receipt, "notice composed for this request");
  assertEquals(result.receipt.includes("notice included yes"), false);
  assert(
    result.context.sources.some((source) =>
      source.includes("persisted tool history notice")
    ),
  );
});

Deno.test("[follow-up A1] resumed native ask excludes omission notice and receipt without replaying transcript messages", async () => {
  await using root = await tempWorkspace({ "README.md": "ROOT" });
  const run = engineServices([chatReply({ content: "runtime response" })]);
  const result = await runTurn(run, {
    mode: "ask",
    prompt: "inspect the repository",
    rootOverride: root.root,
    sessionId: RESUMED,
    conversationMessages: [{ role: "user", content: "not replayed" }],
    historyOmission: MALFORMED_OMISSION,
  });
  const request = run.transport.requests[0];
  assertEquals(systemMessage(request).includes(NOTICE_OPEN), false);
  assertEquals(conversation(request), [
    { role: "user", content: "inspect the repository" },
  ]);
  assertEquals("historyOmission" in result, false);
  assertEquals(result.receipt.includes("Tool evidence withheld:"), false);
  assertEquals(
    result.context.sources.some((source) =>
      source.includes("persisted tool history notice")
    ),
    false,
  );
});

Deno.test("[follow-up A1] resumed native next-work excludes omission notice and receipt", async () => {
  await using root = await tempWorkspace({ "README.md": "ROOT" });
  const run = engineServices([chatReply({
    content: JSON.stringify({
      worklet_id: "next-work.v0",
      context_profile: "compact",
      recommendation: "Continue the bounded task.",
      rationale: "The scoped work is ready.",
      evidence: ["README.md"],
      risks: ["Keep the change bounded."],
      next_commands: ["deno task test"],
      confidence: "high",
    }),
  })]);
  const result = await runTurn(run, {
    mode: "next-work",
    prompt: "what should I do next?",
    rootOverride: root.root,
    sessionId: RESUMED,
    conversationMessages: [{ role: "user", content: "not replayed" }],
    historyOmission: GAP_OMISSION,
  });
  const request = run.transport.requests[0];
  assertEquals(systemMessage(request).includes(NOTICE_OPEN), false);
  const messages = conversation(request);
  assertEquals(messages.length, 1);
  assertEquals(messages[0].role, "user");
  assertStringIncludes(messages[0].content, "next-work.v0");
  assertEquals("historyOmission" in result, false);
  assertEquals(result.receipt.includes("Tool evidence withheld:"), false);
  assertEquals(result.validation, { ok: true, errors: [] });
});

Deno.test("[follow-up N1] native companion failure before notice composition omits the omission receipt", async () => {
  await using root = await tempWorkspace();
  const run = engineServices([]);
  await createResumedSession(run);
  run.services.store = patchStore(run.store, {
    memories: {
      ...run.store.memories,
      injected: () =>
        Promise.reject(new Error("simulated context load failure")),
    },
  });
  await assertRejects(
    () =>
      runTurn(run, {
        prompt: "continue",
        rootOverride: root.root,
        sessionId: RESUMED,
        conversationMessages: [{ role: "user", content: "persisted prompt" }],
        historyOmission: MALFORMED_OMISSION,
      }),
    Error,
    "simulated context load failure",
  );
  assertEquals(run.transport.requests.length, 0);
  const row = await run.store.sessions.detail({ sessionId: RESUMED });
  const content = row?.content ?? "";
  // The session record carries the final receipt and context sources.
  assertStringIncludes(content, "Workbench receipt");
  assertEquals(content.includes("Tool evidence withheld:"), false);
  assertEquals(content.includes("persisted tool history notice"), false);
});

// ─── budget gate ─────────────────────────────────────────────────────────────

const PRICED = pricedLocalModel({ costInput: 15, costOutput: 75 });

Deno.test("declining paid inference aborts before any provider call", async () => {
  await using root = await tempWorkspace();
  const run = engineServices([], { models: [PRICED] });
  await assertRejects(
    () =>
      runTurn(run, {
        prompt: "explore",
        rootOverride: root.root,
        defaultCompanionModel: PRICED.slug,
        conversationMessages: [{ role: "user", content: "persisted prompt" }],
        historyOmission: GAP_OMISSION,
        approver: {
          confirmPaidEscalation: () =>
            Promise.resolve({ decision: "deny", reason: "operator declined" }),
        },
      }),
    Error,
    "Paid inference consent declined",
  );
  assertEquals(run.transport.requests.length, 0);
  const rows = await run.store.sessions.list({ limit: 5 });
  const row = await run.store.sessions.detail({
    sessionId: rows[0].session_id,
  });
  assertStringIncludes(row?.content ?? "", "notice composed for this request");
  assertEquals((row?.content ?? "").includes("notice included yes"), false);
});

Deno.test("confirms a budget ceiling overrun once per turn (preflight + per-call gate)", async () => {
  await using root = await tempWorkspace();
  const run = engineServices([chatReply({ content: "done" })], {
    models: [PRICED],
  });
  const confirmBudgetCeiling = spy(() =>
    Promise.resolve({ decision: "approve" as const })
  );
  const result = await runTurn(run, {
    prompt: "explore",
    rootOverride: root.root,
    defaultCompanionModel: PRICED.slug,
    defaultPerCallBudgetUsd: 0.00001,
    approver: {
      confirmPaidEscalation: () => Promise.resolve({ decision: "approve" }),
      confirmBudgetCeiling,
    },
  });
  assertSpyCalls(confirmBudgetCeiling, 1);
  assertEquals(run.transport.requests.length, 1);
  assertEquals(result.text, "done");
});

Deno.test("declining a budget ceiling aborts before any provider call", async () => {
  await using root = await tempWorkspace();
  const run = engineServices([], { models: [PRICED] });
  await assertRejects(
    () =>
      runTurn(run, {
        prompt: "explore",
        rootOverride: root.root,
        defaultCompanionModel: PRICED.slug,
        defaultPerCallBudgetUsd: 0.00001,
        approver: {
          confirmPaidEscalation: () => Promise.resolve({ decision: "approve" }),
          confirmBudgetCeiling: () =>
            Promise.resolve({ decision: "deny", reason: "too much" }),
        },
      }),
    Error,
    "Budget ceiling confirmation declined",
  );
  assertEquals(run.transport.requests.length, 0);
});

Deno.test("cancelling a budget approval finalizes an aborted turn", async () => {
  await using root = await tempWorkspace();
  const run = engineServices([], { models: [PRICED] });
  const abortController = new AbortController();
  const frames: WorkbenchRuntimeEvent[] = [];
  const turnId = "123e4567-e89b-42d3-a456-426614174000";
  const result = await runTurn(run, {
    prompt: "explore",
    rootOverride: root.root,
    defaultCompanionModel: PRICED.slug,
    turnId,
    abortSignal: abortController.signal,
    defaultPerCallBudgetUsd: 0.00001,
    approver: {
      confirmPaidEscalation: () => Promise.resolve({ decision: "approve" }),
      confirmBudgetCeiling: () => {
        abortController.abort();
        throw abortController.signal.reason;
      },
    },
    frames: {
      onRuntimeEvent: (event) => void frames.push(event),
    },
  });
  assertObjectMatch(result, {
    text: "",
    stopReason: "aborted",
    tokens: { input: 0, output: 0, totalCalls: 0 },
  });
  assertEquals(run.transport.requests.length, 0);
  const response = (await eventRows(run, result.sessionId)).find((row) =>
    row.event_type === "model_response"
  );
  assertObjectMatch(response ?? {}, {
    content: "",
    stop_reason: "aborted",
    tokens_input: "0",
    tokens_output: "0",
  });
  assert(
    frames.some((frame) =>
      frame.type === "turnAborted" && frame.turnId === turnId
    ),
  );
  assertEquals(
    frames.some((frame) => frame.type === "afterProviderResponse"),
    false,
  );
  assertEquals(frames.some((frame) => frame.type === "turnFailed"), false);
});

const ANOMALY_MODEL = pricedLocalModel({
  costInput: 0.000001,
  costOutput: 10_000,
});
const SPENT_PAST_SCOPE = () =>
  Promise.resolve({
    sessionSpentUsd: 2.5,
    sessionSpentTodayUsd: 2.5,
    dailyOtherSessionsUsd: 0,
  });

Deno.test("scope hard-multiple halts even spend a ceiling confirmation already covered", async () => {
  await using root = await tempWorkspace();
  const run = engineServices([], { models: [ANOMALY_MODEL] });
  // Session lifetime spend already past 2× the $1 envelope.
  run.services.fetchSpendBaselines = SPENT_PAST_SCOPE;
  const confirmBudgetCeiling = spy(() =>
    Promise.resolve({ decision: "approve" as const })
  );
  await assertRejects(
    () =>
      runTurn(run, {
        prompt: "explore",
        rootOverride: root.root,
        defaultCompanionModel: ANOMALY_MODEL.slug,
        defaultSessionBudgetUsd: 1.0,
        anomalyTurnMultiple: 3,
        anomalyScopeMultiple: 2,
        approver: {
          confirmPaidEscalation: () => Promise.resolve({ decision: "approve" }),
          // The ceiling handler approving is exactly the blind spot: the
          // anomaly halt must fire regardless, and fail closed without its own
          // handler.
          confirmBudgetCeiling,
        },
      }),
    Error,
    "Runaway spend anomaly",
  );
  assertEquals(run.transport.requests.length, 0);
  // The hard stop fires at turn entry BEFORE the soft ceiling confirm, so
  // the aborted turn leaves no scope-period ceiling confirmation behind.
  assertSpyCalls(confirmBudgetCeiling, 0);
});

Deno.test("an approved entry halt does not re-prompt the identical state at the first call", async () => {
  await using root = await tempWorkspace();
  const run = engineServices([chatReply({
    content: "done",
    usage: { prompt_tokens: 10, completion_tokens: 12 },
  })], { models: [ANOMALY_MODEL] });
  run.services.fetchSpendBaselines = SPENT_PAST_SCOPE;
  const confirmRunawayAnomaly = spy(() =>
    Promise.resolve({ decision: "approve" as const })
  );
  const result = await runTurn(run, {
    prompt: "explore",
    rootOverride: root.root,
    defaultCompanionModel: ANOMALY_MODEL.slug,
    defaultSessionBudgetUsd: 1.0,
    anomalyTurnMultiple: 3,
    anomalyScopeMultiple: 2,
    approver: {
      confirmPaidEscalation: () => Promise.resolve({ decision: "approve" }),
      confirmBudgetCeiling: () => Promise.resolve({ decision: "approve" }),
      confirmRunawayAnomaly,
    },
  });
  assertEquals(result.text, "done");
  // Entry check and first-call check see identical actuals ($2.50): one
  // prompt, not two — the same-state dedupe, not scope-period coverage.
  assertSpyCalls(confirmRunawayAnomaly, 1);
});

// ─── approvals cannot start turns ────────────────────────────────────────────

Deno.test("an approval verdict cannot start a new turn: a turn requested from inside the approver waits for the approving turn to finalize", async () => {
  await using root = await tempWorkspace({ "README.md": "# readme\n" });
  const run = engineServices([
    chatReply({ content: "seeded" }),
    chatReply({
      toolCalls: [{
        id: "w1",
        name: "write_file",
        arguments: { path: "note.txt", content: "approved" },
      }],
    }),
    chatReply({ content: "first done" }),
    chatReply({ content: "second done" }),
  ]);
  const seeded = await runTurn(run, {
    prompt: "seed",
    workspaceRoot: root.root,
  });
  const owners = new SessionOwners();
  const frames: string[] = [];
  const turn = (
    prompt: string,
    tag: string,
    approver?: ConfirmToolApproval,
  ) => {
    const resolved = resolveTurnFromBody({
      prompt,
      sessionId: seeded.sessionId,
      workspace: root.root,
    }, true);
    if ("error" in resolved) throw new Error(resolved.error);
    return executeTurn(resolved, {
      owners,
      env: run.env,
      authContext: {
        transport: "loopback",
        authnStatus: "authenticated",
        authnMechanism: "local_user",
        authnIssuerRef: "local_os",
        authzBasis: "user_consent",
      },
      loopback: true,
      defaultCompanionModel: LOCAL_MODEL.slug,
      fetchSessionEvents: ({ sessionId }) =>
        fetchWorkbenchSessionEvents({ sessionId, events: run.store.events }),
      runRuntime: (input) =>
        runWorkbenchRuntime(
          { ...input, frames: { ...input.frames, log: () => {} } },
          run.services,
        ),
      frames: {
        onRuntimeEvent: (event) => void frames.push(`${tag}:${event.type}`),
      },
      approver: {
        confirmToolApproval: approver,
      },
    });
  };

  let second: Promise<unknown> | undefined;
  let framesAtVerdict: string[] = [];
  const error = stub(console, "error");
  try {
    const first = turn("write the note", "first", async () => {
      // The approver asks for another turn on the same session, then
      // returns its verdict.
      second = turn("and then?", "second");
      for (let i = 0; i < 20; i++) await Promise.resolve();
      framesAtVerdict = [...frames];
      return { decision: "approve" };
    });
    const firstResult = await first;
    assertEquals(firstResult.text, "first done");
    const secondResult = await second as NativeWorkbenchRuntimeResult;
    assertEquals(secondResult.text, "second done");
  } finally {
    error.restore();
  }
  // Nothing of the second turn ran while the approver held its verdict...
  assertEquals(framesAtVerdict.some((f) => f.startsWith("second:")), false);
  // ...and the verdict resumed the approving turn, whose tool ran and which
  // finalized before the second turn started.
  assertEquals(
    await Deno.readTextFile(`${root.root}/note.txt`),
    "approved",
  );
  const firstEnd = frames.indexOf("first:turnCompleted");
  const secondStart = frames.indexOf("second:sessionStart");
  assert(firstEnd >= 0 && secondStart > firstEnd);
  assertEquals(
    frames.filter((f) => f.endsWith(":sessionStart")),
    ["first:sessionStart", "second:sessionStart"],
  );
});

// ─── a new session's turn holds its lock from admission ──────────────────────

Deno.test("a turn naming a new session's id, issued while that session's first turn runs, waits for it", async () => {
  await using root = await tempWorkspace({ "README.md": "# readme\n" });
  const run = engineServices([
    chatReply({
      toolCalls: [{
        id: "w1",
        name: "write_file",
        arguments: { path: "note.txt", content: "approved" },
      }],
    }),
    chatReply({ content: "first done" }),
    chatReply({ content: "second done" }),
  ]);
  const owners = new SessionOwners();
  const frames: string[] = [];
  let newSessionId: string | undefined;
  const turn = (
    body: Record<string, unknown>,
    tag: string,
    approver?: ConfirmToolApproval,
  ) => {
    const resolved = resolveTurnFromBody(
      { ...body, workspace: root.root },
      true,
    );
    if ("error" in resolved) throw new Error(resolved.error);
    return executeTurn(resolved, {
      owners,
      env: run.env,
      authContext: {
        transport: "loopback",
        authnStatus: "authenticated",
        authnMechanism: "local_user",
        authnIssuerRef: "local_os",
        authzBasis: "user_consent",
      },
      loopback: true,
      defaultCompanionModel: LOCAL_MODEL.slug,
      fetchSessionEvents: ({ sessionId }) =>
        fetchWorkbenchSessionEvents({ sessionId, events: run.store.events }),
      runRuntime: (input) =>
        runWorkbenchRuntime(
          { ...input, frames: { ...input.frames, log: () => {} } },
          run.services,
        ),
      frames: {
        onRuntimeEvent: (event) => {
          frames.push(`${tag}:${event.type}`);
          if (tag === "first" && event.type === "sessionStart") {
            newSessionId = event.sessionId;
          }
        },
      },
      approver: {
        confirmToolApproval: approver,
      },
    });
  };

  let second: Promise<unknown> | undefined;
  let framesAtVerdict: string[] = [];
  const error = stub(console, "error");
  try {
    // The first turn names no session; the approver learns the new id from
    // the sessionStart frame and issues a second turn naming it.
    const first = turn({ prompt: "write the note" }, "first", async () => {
      assert(newSessionId !== undefined);
      second = turn(
        { prompt: "and then?", sessionId: newSessionId },
        "second",
      );
      for (let i = 0; i < 20; i++) await Promise.resolve();
      framesAtVerdict = [...frames];
      return { decision: "approve" };
    });
    const firstResult = await first;
    assertEquals(firstResult.sessionId, newSessionId);
    const secondResult = await second as NativeWorkbenchRuntimeResult;
    assertEquals(secondResult.sessionId, newSessionId);
    assertEquals(secondResult.text, "second done");
  } finally {
    error.restore();
  }
  // Nothing of the second turn ran while the first held its session...
  assertEquals(framesAtVerdict.some((f) => f.startsWith("second:")), false);
  // ...and the second started only after the first finalized.
  const firstEnd = frames.indexOf("first:turnCompleted");
  const secondStart = frames.indexOf("second:sessionStart");
  assert(firstEnd >= 0 && secondStart > firstEnd);
  // Both turns appended to the one session, the second after the first.
  const events = await fetchWorkbenchSessionEvents({
    sessionId: newSessionId!,
    events: run.store.events,
  });
  assertEquals(
    events.filter((e) => e.eventType === "session_start").map((e) => e.content),
    ["write the note", "and then?"],
  );
});
