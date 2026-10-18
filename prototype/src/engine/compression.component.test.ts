/**
 * Component tests for transcript compression: whole native turns over the
 * engine fakes, where the scripted provider transport answers the compression
 * call and the session call in turn. They cover the proactive trigger in
 * `loadTranscript`, reactive recovery in the agent loop, durable persistence
 * of the `context_compressed` event, and compression's locality boundary.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
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
// compress. Long content (~6,700 tokens) so the estimate crosses the
// 50%-of-window trigger on SMALL_WINDOW.
const BIG_HISTORY: WorkbenchMessage[] = [
  { role: "user", content: "old question ".repeat(240) },
  { role: "assistant", content: "old answer ".repeat(240) },
  { role: "user", content: "second question ".repeat(240) },
  { role: "assistant", content: "second answer ".repeat(240) },
  { role: "user", content: "third question ".repeat(240) },
  { role: "assistant", content: "third answer ".repeat(240) },
  { role: "user", content: "fourth question ".repeat(240) },
  { role: "assistant", content: "fourth answer ".repeat(240) },
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

/**
 * The local model with a small window, so the proactive trigger fires. The
 * fixed request prefix (system prompt + tool definitions, ~2,500 tokens)
 * must still fit it, or the fit step fails the turn before any call.
 */
const SMALL_WINDOW: ModelSeed = { ...LOCAL_MODEL, context_window: 12_000 };
/**
 * A window BIG_HISTORY crosses the proactive trigger on, but that the
 * UNCOMPRESSED request still fits: a declined compression leaves a sendable
 * turn rather than one the fit step fails.
 */
const UNCOMPRESSED_FITS_WINDOW = 14_000;
/** A window the proactive trigger never reaches. */
const HUGE_WINDOW: ModelSeed = { ...LOCAL_MODEL, context_window: 1_000_000 };
/** Large enough that the moderate history stays under the trigger. */
const RECOVERY_WINDOW = 6_000;

/** A compression reply that checks it went to the compression prompt. */
function summaryReply(reply = chatReply({ content: VALID_SUMMARY })) {
  return {
    ...reply,
    expect: (request: Parameters<NonNullable<ScriptedExchange["expect"]>>[0]) =>
      assert.deepStrictEqual(systemMessage(request), COMPRESSION_SYSTEM_PROMPT),
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
  const root = await mkdtemp(join(tmpdir(), "engine-compression-"));
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
    ...input,
    frames: {
      onRuntimeEvent: (event) => void frames.push(event),
      ...input.frames,
    },
  });
  try {
    await pending;
  } finally {
    await rm(root, { recursive: true });
  }
  return { run, frames, root };
}

function compressed(frames: WorkbenchRuntimeEvent[]) {
  return frames.find((frame) => frame.type === "contextCompressed");
}

/** The last request the session model received. */
function sessionRequest(run: EngineRun) {
  const request = run.transport.requests.at(-1);
  assert.ok(request !== undefined);
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
  const warn = mock.method(console, "warn", () => {});
  try {
    return await run();
  } finally {
    warn.mock.restore();
  }
}

// ─── proactive trigger ───────────────────────────────────────────────────────

test("compresses elder turns when the transcript crosses ~50% of the window", async () => {
  const { run, frames } = await compressionTurn([
    summaryReply(),
    chatReply({ content: "runtime response" }),
  ], {});
  const frame = compressed(frames);
  assert.ok(frame?.type === "contextCompressed");
  assert.deepStrictEqual(frame.trigger, "proactive");
  assert.deepStrictEqual(frame.turnsCompressed, 2);
  const seen = conversation(sessionRequest(run));
  assert.ok(
    seen[0].content.includes(CONVERSATION_SUMMARY_MARKER),
    `expected seen[0].content to include ${
      JSON.stringify(CONVERSATION_SUMMARY_MARKER)
    }`,
  );
  assert.deepStrictEqual(JSON.stringify(seen).includes("old question"), false);

  const sessionId = frames.find((f) => f.type === "sessionStart")?.sessionId;
  const rows = await eventRows(run, sessionId!);
  const root = rows.find((row) => row.event_type === "session_start")!;
  const compressionCall = rows.find((row) =>
    row.event_type === "provider_call" &&
    row.provider_call_purpose === "context_compression"
  );
  assert.partialDeepStrictEqual(compressionCall ?? {}, {
    parent_span_id: root.span_id,
    provider_call_order: "1",
    tokens_input: "42",
    tokens_output: "7",
    stop_reason: "stop",
  });
  assert.deepStrictEqual(
    rows.filter((row) => row.event_type === "provider_call").map((row) =>
      row.provider_call_order
    ),
    ["1", "2"],
  );
  const event = rows.find((row) => row.event_type === "context_compressed");
  assert.deepStrictEqual(event?.parent_span_id, root.span_id);
});

test("includes compression reasoning in the turn receipt", async () => {
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
  assert.deepStrictEqual(result.tokens.reasoning, 10);
  assert.deepStrictEqual(result.tokens.totalCalls, 2);
});

test("records a safe failed compression attempt and continues uncompressed", async () => {
  const providerMessage = "provider-controlled compression body";
  const { run, frames } = await quietly(() =>
    compressionTurn(
      [
        { respond: { status: 500, body: providerMessage } },
        chatReply({ content: "runtime response" }),
      ],
      {},
      {
        models: [{ ...SMALL_WINDOW, context_window: UNCOMPRESSED_FITS_WINDOW }],
      },
    )
  );
  assert.ok(
    JSON.stringify(conversation(sessionRequest(run))).includes("old question"),
    `expected JSON.stringify(conversation(sessionRequest(run))) to include "old question"`,
  );
  const sessionId = frames.find((f) => f.type === "sessionStart")?.sessionId;
  const rows = await eventRows(run, sessionId!);
  assert.deepStrictEqual(
    rows.some((row) => row.event_type === "context_compressed"),
    false,
  );
  const attempt = rows.find((row) =>
    row.event_type === "provider_call" &&
    row.provider_call_purpose === "context_compression"
  );
  assert.partialDeepStrictEqual(attempt ?? {}, { stop_reason: "error" });
  assert.ok((attempt?.provider_error_class ?? "") !== "");
  assert.deepStrictEqual(
    JSON.stringify(attempt).includes(providerMessage),
    false,
  );
});

test("an abort during compression cannot replace elder context", async () => {
  const abortController = new AbortController();
  const { run, frames } = await compressionTurn([{
    respond: () => {
      abortController.abort();
      throw abortController.signal.reason;
    },
  }], {
    turnId: "123e4567-e89b-42d3-a456-426614174000",
    abortSignal: abortController.signal,
  }, {
    models: [{ ...SMALL_WINDOW, context_window: UNCOMPRESSED_FITS_WINDOW }],
  });
  // The aborted session call is never dispatched, so nothing past the
  // compression request reached the provider, and nothing was adopted.
  assert.deepStrictEqual(run.transport.requests.length, 1);
  assert.deepStrictEqual(compressed(frames), undefined);
  const sessionId = frames.find((f) => f.type === "sessionStart")?.sessionId;
  const rows = await eventRows(run, sessionId!);
  assert.deepStrictEqual(
    rows.some((row) => row.event_type === "context_compressed"),
    false,
  );
  const response = rows.find((row) => row.event_type === "model_response");
  assert.deepStrictEqual(response?.stop_reason, "aborted");
  assert.deepStrictEqual(frames.at(-1)?.type, "turnAborted");
});

test("does not compress below the trigger, and leaves the transcript intact", async () => {
  const { run, frames } = await compressionTurn(
    [chatReply({ content: "runtime response" })],
    {},
    { models: [HUGE_WINDOW] },
  );
  assert.deepStrictEqual(compressed(frames), undefined);
  assert.ok(
    JSON.stringify(conversation(sessionRequest(run))).includes("old question"),
    `expected JSON.stringify(conversation(sessionRequest(run))) to include "old question"`,
  );
});

test("the companion turn's system prompt carries the untrusted-summary policy", async () => {
  const { run } = await compressionTurn(
    [chatReply({ content: "runtime response" })],
    { prompt: "hello", conversationMessages: undefined },
    { models: [HUGE_WINDOW] },
  );
  assert.ok(
    systemMessage(sessionRequest(run)).includes(SUMMARY_TRUST_POLICY),
    `expected systemMessage(sessionRequest(run)) to include ${
      JSON.stringify(SUMMARY_TRUST_POLICY)
    }`,
  );
});

test("[case 16] proactive compression leaves the native notice outside partitioned messages", async () => {
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
  assert.deepStrictEqual(run.transport.requests.length, 2);
  const request = sessionRequest(run);
  assert.ok(
    systemMessage(request).includes("[Workbench-generated history notice]"),
    `expected systemMessage(request) to include "[Workbench-generated history notice]"`,
  );
  assert.deepStrictEqual(
    JSON.stringify(conversation(request)).includes(
      "Workbench-generated history notice",
    ),
    false,
  );
});

// ─── durable persistence ─────────────────────────────────────────────────────

test("declines compression when its event cannot be persisted", async () => {
  const { run, frames } = await quietly(() =>
    compressionTurn(
      [
        summaryReply(),
        chatReply({ content: "runtime response" }),
      ],
      {},
      {
        models: [{ ...SMALL_WINDOW, context_window: UNCOMPRESSED_FITS_WINDOW }],
      },
      failingCompressionWrites({ lands: false }),
    )
  );
  assert.deepStrictEqual(compressed(frames), undefined);
  assert.ok(
    JSON.stringify(conversation(sessionRequest(run))).includes("old question"),
    `expected JSON.stringify(conversation(sessionRequest(run))) to include "old question"`,
  );
});

test("adopts compression when a rejected write turns out to be durable", async () => {
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
  assert.ok(compressed(frames) !== undefined);
  const seen = JSON.stringify(conversation(sessionRequest(run)));
  assert.deepStrictEqual(seen.includes("old question"), false);
  assert.ok(
    seen.includes(CONVERSATION_SUMMARY_MARKER),
    `expected ${JSON.stringify(seen)} to include ${
      JSON.stringify(CONVERSATION_SUMMARY_MARKER)
    }`,
  );
});

test("fails the turn when durability cannot be determined", async () => {
  const error = await quietly(() =>
    compressionTurn(
      [summaryReply()],
      {},
      {},
      failingCompressionWrites({ lands: false, probeFails: true }),
    ).catch((err) => err)
  );
  assert.ok(error instanceof ContextCompressionPersistenceUncertainError);
});

test("reports the write failure's real class, not a spoofed .name", async () => {
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
  assert.ok(error instanceof ContextCompressionPersistenceUncertainError);
  assert.deepStrictEqual(error.writeErrorKind, "Error");
});

test("the payload the proactive path actually emits replays byte-identical", async () => {
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
  assert.ok(event !== undefined);

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
  assert.deepStrictEqual(
    resumed.map((m) => ({ role: m.role, content: m.content })),
    live.map((m) => ({ role: m.role, content: m.content })),
  );
  // The verbatim tail survived: the first retained turn is the one an
  // off-by-one in the retained count silently eats.
  const text = JSON.stringify(resumed);
  assert.ok(
    text.includes("third question"),
    `expected ${JSON.stringify(text)} to include "third question"`,
  );
  assert.ok(
    text.includes("fourth question"),
    `expected ${JSON.stringify(text)} to include "fourth question"`,
  );
  assert.deepStrictEqual(text.includes("old question"), false);
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

test("an overflow with no injected recoverer compresses then retries", async () => {
  const { run, frames } = await compressionTurn([
    overflowReply(RECOVERY_WINDOW - 80),
    summaryReply(),
    chatReply({ content: "recovered answer" }),
  ], {
    prompt: "one more",
    conversationMessages: MODERATE_HISTORY,
  }, { models: [{ ...LOCAL_MODEL, context_window: RECOVERY_WINDOW }] });
  const frame = compressed(frames);
  assert.ok(frame?.type === "contextCompressed");
  assert.deepStrictEqual(frame.trigger, "context_overflow");
  // Presented via the superseding-retry contract.
  assert.ok(frames.some((f) => f.type === "supersedingRetryStarted"));
  assert.deepStrictEqual(frames.at(-1)?.type, "turnCompleted");
  assert.deepStrictEqual(run.transport.requests.length, 3);
});

test("[case 22] persisted reactive compression is followed by an event-recomputed notice on resume", async () => {
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
  assert.deepStrictEqual(result.text, "recovered answer");
  const sessionCalls = run.transport.requests.filter((request) =>
    systemMessage(request) !== COMPRESSION_SYSTEM_PROMPT
  );
  assert.deepStrictEqual(sessionCalls.length, 2);
  for (const request of sessionCalls) {
    assert.ok(
      systemMessage(request).includes("[Workbench-generated history notice]"),
      `expected systemMessage(request) to include "[Workbench-generated history notice]"`,
    );
  }
  assert.deepStrictEqual(result.historyOmission?.detectedInHistory, 2);

  const rows = await eventRows(run, result.sessionId);
  const persisted = rows.find((row) => row.event_type === "context_compressed");
  assert.ok(persisted !== undefined);
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
  assert.partialDeepStrictEqual(recomputed ?? {}, {
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
  assert.deepStrictEqual(subsequent.text, "subsequent answer");
  assert.ok(
    systemMessage(sessionRequest(next)).includes(
      "History records withheld: 1.",
    ),
    `expected systemMessage(sessionRequest(next)) to include "History records withheld: 1."`,
  );
  assert.deepStrictEqual(subsequent.historyOmission?.detectedInHistory, 1);
});

// ─── locality boundary ───────────────────────────────────────────────────────

const HOSTED_SMALL: ModelSeed = {
  ...HOSTED_FREE_MODEL,
  context_window: UNCOMPRESSED_FITS_WINDOW,
};
const LOCAL_FALLBACK: ModelSeed = {
  ...LOCAL_MODEL,
  slug: "qwen3-local",
  display_name: "Qwen3 Local",
};
const HOSTED_KEY = { ANTHROPIC_API_KEY: "test-key-not-real" };

test("declines compression on a tier-0 HOSTED model (locality, not tier)", async () => {
  const { run, frames } = await compressionTurn(
    [anthropicReply("runtime response")],
    { defaultCompanionModel: HOSTED_SMALL.slug },
    { models: [HOSTED_SMALL], env: HOSTED_KEY },
  );
  // No compression request left the machine, and none was surfaced.
  assert.deepStrictEqual(run.transport.requests.length, 1);
  assert.strictEqual(
    new URL(sessionRequest(run).url).hostname,
    "api.anthropic.com",
  );
  assert.deepStrictEqual(compressed(frames), undefined);
  assert.ok(
    sessionRequest(run).body.includes("old question"),
    `expected sessionRequest(run).body to include "old question"`,
  );
});

test("a tier-0 HOSTED session model compresses via a local tier-0 row when one exists", async () => {
  const { run, frames } = await compressionTurn(
    [
      {
        ...summaryReply(),
        expect: (request) => {
          assert.deepStrictEqual(
            systemMessage(request),
            COMPRESSION_SYSTEM_PROMPT,
          );
          assert.deepStrictEqual(requestBody(request).model, "qwen3-local");
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
  assert.ok(compressed(frames) !== undefined);
  assert.ok(
    run.transport.requests[0].url.includes("127.0.0.1"),
    `expected run.transport.requests[0].url to include "127.0.0.1"`,
  );
});

test("compression routes to a local tier-0 row even when a hosted tier-0 row is preferred", async () => {
  const preferredHosted: ModelSeed = {
    ...HOSTED_FREE_MODEL,
    slug: "hosted-preferred",
    context_window: UNCOMPRESSED_FITS_WINDOW,
  };
  const { frames } = await compressionTurn(
    [
      {
        ...summaryReply(),
        expect: (request) =>
          assert.deepStrictEqual(requestBody(request).model, "qwen3-local"),
      },
      anthropicReply("runtime response"),
    ],
    { defaultCompanionModel: HOSTED_SMALL.slug },
    {
      models: [preferredHosted, HOSTED_SMALL, LOCAL_FALLBACK],
      env: HOSTED_KEY,
    },
  );
  assert.ok(compressed(frames) !== undefined);
});

test("a compression call counts toward the turn's cost basis", async () => {
  // The session call is billed by OpenRouter; the local compression call is
  // a catalog estimate, so the turn's total is an estimate too.
  const routed: ModelSeed = {
    slug: "routed-small",
    display_name: "Routed Small",
    provider: "openrouter",
    api: "openai-completions",
    base_url: "https://openrouter.ai/api/v1",
    tier: 0,
    context_window: UNCOMPRESSED_FITS_WINDOW,
    max_output_tokens: 4_096,
    cost_input: 0.3,
    cost_output: 1.2,
    capabilities: ["text", "code"],
  };
  const { run, frames } = await compressionTurn(
    [
      summaryReply(),
      chatReply({
        content: "runtime response",
        usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.000004 },
      }),
    ],
    { defaultCompanionModel: routed.slug },
    {
      models: [routed, LOCAL_FALLBACK],
      env: { OPENROUTER_API_KEY: "test-key-not-real" },
    },
  );
  assert.ok(compressed(frames) !== undefined);
  const sessionId = frames.find((f) => f.type === "sessionStart")?.sessionId;
  const rows = await eventRows(run, sessionId!);
  assert.deepStrictEqual(
    rows.filter((row) => row.event_type === "provider_call").map((row) => [
      row.provider_call_purpose,
      row.cost_basis,
    ]),
    [["context_compression", "catalog_estimate"], [
      "initial",
      "provider_billed",
    ]],
  );
  const response = rows.find((row) => row.event_type === "model_response");
  assert.deepStrictEqual(response?.cost_basis, "catalog_estimate");
});
