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
import {
  chatReply,
  type EngineRun,
  engineServices,
  patchStore,
  tempWorkspace,
} from "../../testing/builders/engine.ts";
import type { RecordedRequest } from "../../testing/fakes/scripted-http-transport.ts";
import type {
  HistoryOmissionProjection,
  WorkbenchAuthContext,
  WorkbenchRuntimeEvent,
} from "../contract/mod.ts";
import { createWorkbenchSession } from "../store/mod.ts";
import { AGENTS_INSTRUCTIONS_TRUST_PREAMBLE } from "./build-context.ts";
import { WorkspaceContextUnavailableError } from "./errors.ts";
import { runWorkbenchRuntime } from "./native-runner.ts";
import type {
  NativeWorkbenchRuntimeResult,
  WorkbenchRuntimeInput,
} from "./runtime-types.ts";

const RESUMED = "01TEST00000000000000000001";
const REMOTE: WorkbenchAuthContext = {
  transport: "remote",
  authnStatus: "authenticated",
  authnMechanism: "api_key",
  authnIssuerRef: "test_issuer",
  authzBasis: "bearer_token",
};
const NOTICE_OPEN = "[Workbench-generated history notice]";

/** Run one native turn against `run`'s fakes. */
function runTurn(
  run: EngineRun,
  input: Partial<WorkbenchRuntimeInput>,
): Promise<NativeWorkbenchRuntimeResult> {
  return runWorkbenchRuntime({
    mode: "turn",
    prompt: "hello",
    routingOptions: {},
    defaultCompanionModel: "local-chat",
    ...input,
    runner: undefined,
  }, run.services);
}

interface ChatRequestBody {
  messages: Array<{ role: string; content: string }>;
  tools?: unknown[];
}

function requestBody(request: RecordedRequest): ChatRequestBody {
  return JSON.parse(request.body) as ChatRequestBody;
}

function systemMessage(request: RecordedRequest): string {
  const system = requestBody(request).messages.find((message) =>
    message.role === "system"
  );
  return system?.content ?? "";
}

function conversation(request: RecordedRequest) {
  return requestBody(request).messages.filter((message) =>
    message.role !== "system"
  );
}

async function eventRows(run: EngineRun, sessionId: string) {
  return await run.store.events.bySession({
    sessionId,
    limit: 200,
    order: "asc",
  });
}

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
    onRuntimeEvent: (event) => void frames.push(event),
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

Deno.test("principalId from the input attributes every event of the turn", async () => {
  await using root = await tempWorkspace();
  const run = engineServices([chatReply({ content: "ok" })]);
  const result = await runTurn(run, {
    rootOverride: root.root,
    principalId: "custom-principal",
  });
  const principals = new Set(
    (await eventRows(run, result.sessionId)).map((row) => row.principal_id),
  );
  assertEquals(principals, new Set(["custom-principal"]));
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
