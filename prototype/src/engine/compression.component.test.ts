/**
 * Component tests for transcript compression: whole native turns over the
 * engine fakes, where the scripted provider transport answers the compression
 * call and the session call in turn. They cover the proactive trigger in
 * `loadTranscript`, reactive recovery in the agent loop, durable persistence
 * of the `context_compressed` event, and compression's locality boundary.
 */
import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertObjectMatch,
  assertStringIncludes,
} from "@std/assert";
import { stub } from "@std/testing/mock";
import {
  anthropicReply,
  chatReply,
  conversation,
  type EngineRun,
  engineServices,
  eventRows,
  HOSTED_FREE_MODEL,
  LOCAL_MODEL,
  patchStore,
  requestBody,
  runTurn,
  systemMessage,
  tempWorkspace,
} from "../../testing/builders/engine.ts";
import type { ScriptedExchange } from "../../testing/fakes/scripted-http-transport.ts";
import {
  buildConversationMessages,
  COMPRESSION_SECTIONS,
  COMPRESSION_SYSTEM_PROMPT,
  CONVERSATION_SUMMARY_MARKER,
  SUMMARY_TRUST_POLICY,
} from "../context/mod.ts";
import type {
  HistoryOmissionProjection,
  WorkbenchRuntimeEvent,
  WorkbenchSessionEvent,
} from "../contract/mod.ts";
import type { WorkbenchMessage } from "../providers/mod.ts";
import type { ModelSeed, Store } from "../store/mod.ts";
import { ContextCompressionPersistenceUncertainError } from "./errors.ts";
import type { WorkbenchRuntimeInput } from "./runtime-types.ts";

const VALID_SUMMARY = COMPRESSION_SECTIONS.map((s) => `## ${s}\n(none)`)
  .join("\n\n");

// Four turns so that, with the K=2 verbatim tail, two elder turns remain to
// compress. Long content so the estimate crosses the 50%-of-window trigger.
const BIG_HISTORY: WorkbenchMessage[] = [
  { role: "user", content: "old question ".repeat(80) },
  { role: "assistant", content: "old answer ".repeat(80) },
  { role: "user", content: "second question ".repeat(80) },
  { role: "assistant", content: "second answer ".repeat(80) },
  { role: "user", content: "third question ".repeat(80) },
  { role: "assistant", content: "third answer ".repeat(80) },
  { role: "user", content: "fourth question ".repeat(80) },
  { role: "assistant", content: "fourth answer ".repeat(80) },
];

// Moderate history in a large window: the pre-call estimate stays under the
// 50% proactive trigger, but the elder turns are larger than the summary, so
// reactive compression is worthwhile. The overflow is driven by the model's
// REPORTED usage, independent of the estimate.
const MODERATE_HISTORY: WorkbenchMessage[] = [
  { role: "user", content: "question ".repeat(25) },
  { role: "assistant", content: "answer ".repeat(25) },
  { role: "user", content: "again ".repeat(25) },
  { role: "assistant", content: "response ".repeat(25) },
  { role: "user", content: "more ".repeat(25) },
  { role: "assistant", content: "reply ".repeat(25) },
  { role: "user", content: "still ".repeat(25) },
  { role: "assistant", content: "ok ".repeat(25) },
];

/** The local model with a small window, so the proactive trigger fires. */
const SMALL_WINDOW: ModelSeed = { ...LOCAL_MODEL, context_window: 100 };
/** A window the proactive trigger never reaches. */
const HUGE_WINDOW: ModelSeed = { ...LOCAL_MODEL, context_window: 1_000_000 };
/** Large enough that the moderate history stays under the trigger. */
const RECOVERY_WINDOW = 4_000;

/** A compression reply that checks it went to the compression prompt. */
function summaryReply(reply = chatReply({ content: VALID_SUMMARY })) {
  return {
    ...reply,
    expect: (request: Parameters<NonNullable<ScriptedExchange["expect"]>>[0]) =>
      assertEquals(systemMessage(request), COMPRESSION_SYSTEM_PROMPT),
  } satisfies ScriptedExchange;
}

interface CompressionRun {
  run: EngineRun;
  frames: WorkbenchRuntimeEvent[];
}

async function compressionTurn(
  exchanges: ScriptedExchange[],
  input: Partial<WorkbenchRuntimeInput>,
  options: { models?: ModelSeed[]; env?: Record<string, string> } = {},
  patch?: (store: Store) => Partial<Store>,
): Promise<CompressionRun & { root: string }> {
  const root = await Deno.makeTempDir({ prefix: "engine-compression-" });
  const run = engineServices(exchanges, {
    models: options.models ?? [SMALL_WINDOW],
    env: options.env,
  });
  if (patch) run.services.store = patchStore(run.store, patch(run.store));
  const frames: WorkbenchRuntimeEvent[] = [];
  const pending = runTurn(run, {
    prompt: "new question",
    rootOverride: root,
    conversationMessages: BIG_HISTORY,
    onRuntimeEvent: (event) => void frames.push(event),
    ...input,
  });
  try {
    await pending;
  } finally {
    await Deno.remove(root, { recursive: true });
  }
  return { run, frames, root };
}

function compressed(frames: WorkbenchRuntimeEvent[]) {
  return frames.find((frame) => frame.type === "contextCompressed");
}

/** The last request the session model received. */
function sessionRequest(run: EngineRun) {
  const request = run.transport.requests.at(-1);
  assert(request !== undefined);
  return request;
}

/** A store whose journal fails `context_compressed` writes as `failure` says. */
function failingCompressionWrites(
  failure: { lands: boolean; probeFails?: boolean; name?: string },
): (store: Store) => Partial<Store> {
  return (store) => ({
    journal: {
      commit: async (batch, options) => {
        if (batch.events.some((e) => e.event_type === "context_compressed")) {
          if (failure.lands) await store.journal.commit(batch, options);
          const err = new Error("simulated write failure: context_compressed");
          if (failure.name) err.name = failure.name;
          throw err;
        }
        return await store.journal.commit(batch, options);
      },
    },
    events: failure.probeFails
      ? {
        ...store.events,
        exists: () =>
          Promise.reject(new Error("simulated durability probe failure")),
      }
      : store.events,
  });
}

/** Run with console.warn stubbed; compression warns by error class. */
async function quietly<T>(run: () => Promise<T>): Promise<T> {
  const warn = stub(console, "warn");
  try {
    return await run();
  } finally {
    warn.restore();
  }
}

// ─── proactive trigger ───────────────────────────────────────────────────────

Deno.test("compresses elder turns when the transcript crosses ~50% of the window", async () => {
  const { run, frames } = await compressionTurn([
    summaryReply(),
    chatReply({ content: "runtime response" }),
  ], {});
  const frame = compressed(frames);
  assert(frame?.type === "contextCompressed");
  assertEquals(frame.trigger, "proactive");
  assertEquals(frame.turnsCompressed, 2);
  const seen = conversation(sessionRequest(run));
  assertStringIncludes(seen[0].content, CONVERSATION_SUMMARY_MARKER);
  assertEquals(JSON.stringify(seen).includes("old question"), false);

  const sessionId = frames.find((f) => f.type === "sessionStart")?.sessionId;
  const rows = await eventRows(run, sessionId!);
  const root = rows.find((row) => row.event_type === "session_start")!;
  const compressionCall = rows.find((row) =>
    row.event_type === "provider_call" &&
    row.provider_call_purpose === "context_compression"
  );
  assertObjectMatch(compressionCall ?? {}, {
    parent_span_id: root.span_id,
    provider_call_order: "1",
    tokens_input: "42",
    tokens_output: "7",
    stop_reason: "stop",
  });
  assertEquals(
    rows.filter((row) => row.event_type === "provider_call").map((row) =>
      row.provider_call_order
    ),
    ["1", "2"],
  );
  const event = rows.find((row) => row.event_type === "context_compressed");
  assertEquals(event?.parent_span_id, root.span_id);
});

Deno.test("includes compression reasoning in the turn receipt", async () => {
  await using root = await tempWorkspace();
  const run = engineServices([
    summaryReply(chatReply({
      content: VALID_SUMMARY,
      usage: {
        prompt_tokens: 10,
        completion_tokens: 10,
        completion_tokens_details: { reasoning_tokens: 7 },
      },
    })),
    chatReply({
      content: "runtime response",
      usage: {
        prompt_tokens: 10,
        completion_tokens: 10,
        completion_tokens_details: { reasoning_tokens: 3 },
      },
    }),
  ], { models: [SMALL_WINDOW] });
  const result = await runTurn(run, {
    prompt: "new question",
    rootOverride: root.root,
    conversationMessages: BIG_HISTORY,
  });
  assertEquals(result.tokens.reasoning, 10);
  assertEquals(result.tokens.totalCalls, 2);
});

Deno.test("records a safe failed compression attempt and continues uncompressed", async () => {
  const providerMessage = "provider-controlled compression body";
  const { run, frames } = await quietly(() =>
    compressionTurn([
      { respond: { status: 500, body: providerMessage } },
      chatReply({ content: "runtime response" }),
    ], {})
  );
  assertStringIncludes(
    JSON.stringify(conversation(sessionRequest(run))),
    "old question",
  );
  const sessionId = frames.find((f) => f.type === "sessionStart")?.sessionId;
  const rows = await eventRows(run, sessionId!);
  assertEquals(
    rows.some((row) => row.event_type === "context_compressed"),
    false,
  );
  const attempt = rows.find((row) =>
    row.event_type === "provider_call" &&
    row.provider_call_purpose === "context_compression"
  );
  assertObjectMatch(attempt ?? {}, { stop_reason: "error" });
  assert((attempt?.provider_error_class ?? "") !== "");
  assertEquals(JSON.stringify(attempt).includes(providerMessage), false);
});

Deno.test("an abort during compression cannot replace elder context", async () => {
  const abortController = new AbortController();
  const { run, frames } = await compressionTurn([{
    respond: () => {
      abortController.abort();
      throw abortController.signal.reason;
    },
  }], {
    turnId: "123e4567-e89b-42d3-a456-426614174000",
    abortSignal: abortController.signal,
  });
  // The aborted session call is never dispatched, so nothing past the
  // compression request reached the provider, and nothing was adopted.
  assertEquals(run.transport.requests.length, 1);
  assertEquals(compressed(frames), undefined);
  const sessionId = frames.find((f) => f.type === "sessionStart")?.sessionId;
  const rows = await eventRows(run, sessionId!);
  assertEquals(
    rows.some((row) => row.event_type === "context_compressed"),
    false,
  );
  const response = rows.find((row) => row.event_type === "model_response");
  assertEquals(response?.stop_reason, "aborted");
  assertEquals(frames.at(-1)?.type, "turnAborted");
});

Deno.test("does not compress below the trigger, and leaves the transcript intact", async () => {
  const { run, frames } = await compressionTurn(
    [chatReply({ content: "runtime response" })],
    {},
    { models: [HUGE_WINDOW] },
  );
  assertEquals(compressed(frames), undefined);
  assertStringIncludes(
    JSON.stringify(conversation(sessionRequest(run))),
    "old question",
  );
});

Deno.test("the companion turn's system prompt carries the untrusted-summary policy", async () => {
  const { run } = await compressionTurn(
    [chatReply({ content: "runtime response" })],
    { prompt: "hello", conversationMessages: undefined },
    { models: [HUGE_WINDOW] },
  );
  assertStringIncludes(
    systemMessage(sessionRequest(run)),
    SUMMARY_TRUST_POLICY,
  );
});

Deno.test("[case 16] proactive compression leaves the native notice outside partitioned messages", async () => {
  const omission: HistoryOmissionProjection = {
    detectedInHistory: 1,
    malformedToolRecords: 1,
    gapMarkers: 0,
    callsUnknown: false,
    withheldFromProjection: 0,
    projectedPairs: 0,
  };
  const { run } = await compressionTurn([
    summaryReply(),
    chatReply({ content: "runtime response" }),
  ], { historyOmission: omission });
  assertEquals(run.transport.requests.length, 2);
  const request = sessionRequest(run);
  assertStringIncludes(
    systemMessage(request),
    "[Workbench-generated history notice]",
  );
  assertEquals(
    JSON.stringify(conversation(request)).includes(
      "Workbench-generated history notice",
    ),
    false,
  );
});

// ─── durable persistence ─────────────────────────────────────────────────────

Deno.test("declines compression when its event cannot be persisted", async () => {
  const { run, frames } = await quietly(() =>
    compressionTurn(
      [
        summaryReply(),
        chatReply({ content: "runtime response" }),
      ],
      {},
      {},
      failingCompressionWrites({ lands: false }),
    )
  );
  assertEquals(compressed(frames), undefined);
  assertStringIncludes(
    JSON.stringify(conversation(sessionRequest(run))),
    "old question",
  );
});

Deno.test("adopts compression when a rejected write turns out to be durable", async () => {
  const { run, frames } = await quietly(() =>
    compressionTurn(
      [
        summaryReply(),
        chatReply({ content: "runtime response" }),
      ],
      {},
      {},
      failingCompressionWrites({ lands: true }),
    )
  );
  assert(compressed(frames) !== undefined);
  const seen = JSON.stringify(conversation(sessionRequest(run)));
  assertEquals(seen.includes("old question"), false);
  assertStringIncludes(seen, CONVERSATION_SUMMARY_MARKER);
});

Deno.test("fails the turn when durability cannot be determined", async () => {
  const error = await quietly(() =>
    compressionTurn(
      [summaryReply()],
      {},
      {},
      failingCompressionWrites({ lands: false, probeFails: true }),
    ).catch((err) => err)
  );
  assertInstanceOf(error, ContextCompressionPersistenceUncertainError);
});

Deno.test("reports the write failure's real class, not a spoofed .name", async () => {
  const error = await quietly(() =>
    compressionTurn(
      [summaryReply()],
      {},
      {},
      failingCompressionWrites({
        lands: false,
        probeFails: true,
        name: "SpoofedClassName",
      }),
    ).catch((err) => err)
  );
  assertInstanceOf(error, ContextCompressionPersistenceUncertainError);
  assertEquals(error.writeErrorKind, "Error");
});

Deno.test("the payload the proactive path actually emits replays byte-identical", async () => {
  // THE integrated seam guard: run the proactive path, take the
  // context_compressed row it wrote, replay the resulting event stream
  // through the real buildConversationMessages, and require the result to
  // equal the messages the live turn was actually given.
  const { run, frames } = await compressionTurn([
    summaryReply(),
    chatReply({ content: "runtime response" }),
  ], {});
  const sessionId = frames.find((f) => f.type === "sessionStart")?.sessionId;
  const rows = await eventRows(run, sessionId!);
  const event = rows.find((row) => row.event_type === "context_compressed");
  assert(event !== undefined);

  const ev = (eventType: string, content: string | null) =>
    ({ eventType, content }) as unknown as WorkbenchSessionEvent;
  // The event stream a resume would read: the prior turns, the current prompt
  // (persisted before compression), then the compression event.
  const resumed = buildConversationMessages([
    ...BIG_HISTORY.map((m) =>
      ev(m.role === "user" ? "session_start" : "model_response", m.content)
    ),
    ev("session_start", "new question"),
    ev("context_compressed", event.content),
  ]);
  const live = conversation(sessionRequest(run));
  assertEquals(
    resumed.map((m) => ({ role: m.role, content: m.content })),
    live.map((m) => ({ role: m.role, content: m.content })),
  );
  // The verbatim tail survived: the first retained turn is the one an
  // off-by-one in the retained count silently eats.
  const text = JSON.stringify(resumed);
  assertStringIncludes(text, "third question");
  assertStringIncludes(text, "fourth question");
  assertEquals(text.includes("old question"), false);
});

// ─── reactive recovery ───────────────────────────────────────────────────────

/** A session reply that length-stops, reporting `input` prompt tokens. */
function overflowReply(input: number): ScriptedExchange {
  return chatReply({
    content: "cut off",
    finishReason: "length",
    usage: { prompt_tokens: input, completion_tokens: 10 },
  });
}

Deno.test("an overflow with no injected recoverer compresses then retries", async () => {
  const { run, frames } = await compressionTurn([
    overflowReply(RECOVERY_WINDOW - 80),
    summaryReply(),
    chatReply({ content: "recovered answer" }),
  ], {
    prompt: "one more",
    conversationMessages: MODERATE_HISTORY,
  }, { models: [{ ...LOCAL_MODEL, context_window: RECOVERY_WINDOW }] });
  const frame = compressed(frames);
  assert(frame?.type === "contextCompressed");
  assertEquals(frame.trigger, "context_overflow");
  // Presented via the superseding-retry contract.
  assert(frames.some((f) => f.type === "supersedingRetryStarted"));
  assertEquals(frames.at(-1)?.type, "turnCompleted");
  assertEquals(run.transport.requests.length, 3);
});

Deno.test("[case 22] persisted reactive compression is followed by an event-recomputed notice on resume", async () => {
  const omission: HistoryOmissionProjection = {
    detectedInHistory: 2,
    malformedToolRecords: 1,
    gapMarkers: 1,
    callsUnknown: true,
    withheldFromProjection: 0,
    projectedPairs: 1,
  };
  await using root = await tempWorkspace();
  const model = { ...LOCAL_MODEL, context_window: RECOVERY_WINDOW };
  const run = engineServices([
    overflowReply(RECOVERY_WINDOW - 80),
    summaryReply(),
    chatReply({ content: "recovered answer" }),
  ], { models: [model] });
  const result = await runTurn(run, {
    prompt: "one more",
    rootOverride: root.root,
    conversationMessages: MODERATE_HISTORY,
    historyOmission: omission,
  });
  assertEquals(result.text, "recovered answer");
  const sessionCalls = run.transport.requests.filter((request) =>
    systemMessage(request) !== COMPRESSION_SYSTEM_PROMPT
  );
  assertEquals(sessionCalls.length, 2);
  for (const request of sessionCalls) {
    assertStringIncludes(
      systemMessage(request),
      "[Workbench-generated history notice]",
    );
  }
  assertEquals(result.historyOmission?.detectedInHistory, 2);

  const rows = await eventRows(run, result.sessionId);
  const persisted = rows.find((row) => row.event_type === "context_compressed");
  assert(persisted !== undefined);
  const event = (
    eventType: string,
    content: string | null,
    tool: Record<string, unknown> = {},
  ) => ({ eventType, content, ...tool }) as unknown as WorkbenchSessionEvent;
  const persistedHistory = MODERATE_HISTORY.map((message) =>
    event(
      message.role === "user" ? "session_start" : "model_response",
      message.content,
    )
  );
  persistedHistory.splice(
    2,
    0,
    event("tool_call", null, {
      toolName: "acp.history_unavailable",
      toolCallId: "gap-immutable",
      toolArguments: {},
      toolResult: "",
      toolIsError: true,
      toolHistoryValid: true,
    }),
  );
  let recomputed: HistoryOmissionProjection | undefined;
  const resumedMessages = buildConversationMessages([
    ...persistedHistory,
    event("session_start", "one more"),
    event("context_compressed", persisted.content),
    event("model_response", "recovered answer"),
  ], { onOmission: (omission) => void (recomputed = omission) });
  assertObjectMatch(recomputed ?? {}, {
    detectedInHistory: 1,
    gapMarkers: 1,
    callsUnknown: true,
  });

  const next = engineServices([chatReply({ content: "subsequent answer" })], {
    models: [model],
  });
  const subsequent = await runTurn(next, {
    prompt: "after persisted compression",
    rootOverride: root.root,
    conversationMessages: resumedMessages,
    historyOmission: recomputed,
  });
  assertEquals(subsequent.text, "subsequent answer");
  assertStringIncludes(
    systemMessage(sessionRequest(next)),
    "History records withheld: 1.",
  );
  assertEquals(subsequent.historyOmission?.detectedInHistory, 1);
});

// ─── locality boundary ───────────────────────────────────────────────────────

const HOSTED_SMALL: ModelSeed = { ...HOSTED_FREE_MODEL, context_window: 100 };
const LOCAL_FALLBACK: ModelSeed = {
  ...LOCAL_MODEL,
  slug: "qwen3-local",
  display_name: "Qwen3 Local",
};
const HOSTED_KEY = { ANTHROPIC_API_KEY: "test-key-not-real" };

Deno.test("declines compression on a tier-0 HOSTED model (locality, not tier)", async () => {
  const { run, frames } = await compressionTurn(
    [anthropicReply("runtime response")],
    { defaultCompanionModel: HOSTED_SMALL.slug },
    { models: [HOSTED_SMALL], env: HOSTED_KEY },
  );
  // No compression request left the machine, and none was surfaced.
  assertEquals(run.transport.requests.length, 1);
  assertStringIncludes(sessionRequest(run).url, "api.anthropic.com");
  assertEquals(compressed(frames), undefined);
  assertStringIncludes(sessionRequest(run).body, "old question");
});

Deno.test("a tier-0 HOSTED session model compresses via a local tier-0 row when one exists", async () => {
  const { run, frames } = await compressionTurn(
    [
      {
        ...summaryReply(),
        expect: (request) => {
          assertEquals(systemMessage(request), COMPRESSION_SYSTEM_PROMPT);
          assertEquals(requestBody(request).model, "qwen3-local");
        },
      },
      anthropicReply("runtime response"),
    ],
    { defaultCompanionModel: HOSTED_SMALL.slug },
    {
      models: [HOSTED_SMALL, LOCAL_FALLBACK],
      env: HOSTED_KEY,
    },
  );
  assert(compressed(frames) !== undefined);
  assertStringIncludes(run.transport.requests[0].url, "127.0.0.1");
});

Deno.test("compression routes to a local tier-0 row even when a hosted tier-0 row is preferred", async () => {
  const preferredHosted: ModelSeed = {
    ...HOSTED_FREE_MODEL,
    slug: "hosted-preferred",
    context_window: 100,
  };
  const { frames } = await compressionTurn(
    [
      {
        ...summaryReply(),
        expect: (request) =>
          assertEquals(requestBody(request).model, "qwen3-local"),
      },
      anthropicReply("runtime response"),
    ],
    { defaultCompanionModel: HOSTED_SMALL.slug },
    {
      models: [preferredHosted, HOSTED_SMALL, LOCAL_FALLBACK],
      env: HOSTED_KEY,
    },
  );
  assert(compressed(frames) !== undefined);
});
