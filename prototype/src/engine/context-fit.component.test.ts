/**
 * Component tests for request fitting: whole native turns over the engine
 * fakes on a model with a declared context window, where the scripted
 * provider answers and every request it receives is measured. The window is
 * the engine's to respect — a provider that silently accepts an over-window
 * request (as the scripted transport does) must never see one.
 *
 * Covers the three causes behind BIT-565: tool results bounded only by their
 * own fixed caps, no fit check before each loop call, and a provider's
 * "context exceeded" rejection surfacing as a generic error.
 */
import {
  assert,
  assertEquals,
  assertObjectMatch,
  assertStringIncludes,
} from "@std/assert";
import {
  chatReply,
  conversation,
  type EngineRun,
  engineServices,
  eventRows,
  GEMINI_FREE_MODEL,
  geminiReply,
  LOCAL_MODEL,
  requestBody,
  runTurn,
  systemMessage,
} from "../../testing/builders/engine.ts";
import type { ScriptedExchange } from "../../testing/fakes/scripted-http-transport.ts";
import { COMPRESSION_SYSTEM_PROMPT } from "../context/mod.ts";
import type { WorkbenchRuntimeEvent } from "../contract/mod.ts";
import type { WorkbenchMessage } from "../providers/mod.ts";
import type { ModelSeed } from "../store/mod.ts";
import type {
  NativeWorkbenchRuntimeResult,
  WorkbenchRuntimeInput,
  WorkbenchRuntimeServices,
} from "./runtime-types.ts";

const WINDOW = LOCAL_MODEL.context_window!;

type ToolCall = { id: string; name: string; arguments: unknown };

function toolReply(calls: ToolCall[], text = ""): ScriptedExchange {
  return chatReply({ content: text, toolCalls: calls });
}

const READ = (id: string, path: string): ToolCall => ({
  id,
  name: "read_file",
  arguments: { path },
});

/** A file well past read_file's 64 KiB cap: three reads exceed a 32K window. */
const BIG_FILE = "0123456789abcdef".repeat(12_500) + "\n"; // 200,001 bytes

/** The llama-server rejection of an over-window request, verbatim shape. */
const LLAMA_SERVER_REJECTION: ScriptedExchange = {
  respond: {
    status: 400,
    body: JSON.stringify({
      error: {
        code: 400,
        message: "request (82366 tokens) exceeds the available context size " +
          "(32768 tokens), try increasing it",
        type: "exceed_context_size_error",
        n_prompt_tokens: 82366,
        n_ctx: 32768,
      },
    }),
  },
};

interface FitRun {
  run: EngineRun;
  frames: WorkbenchRuntimeEvent[];
  result?: NativeWorkbenchRuntimeResult;
  error: unknown;
}

/** Run a turn in a workspace holding `files`, returning what it produced or threw. */
async function fitTurn(
  exchanges: ScriptedExchange[],
  input: Partial<WorkbenchRuntimeInput> = {},
  options: {
    files?: Record<string, string>;
    models?: ModelSeed[];
    env?: Record<string, string>;
    recoverContextOverflow?: WorkbenchRuntimeServices["recoverContextOverflow"];
  } = {},
): Promise<FitRun> {
  const root = await Deno.makeTempDir({ prefix: "engine-fit-" });
  for (const [path, content] of Object.entries(options.files ?? {})) {
    await Deno.writeTextFile(`${root}/${path}`, content);
  }
  const run = engineServices(exchanges, {
    models: options.models,
    env: options.env,
  });
  run.services.recoverContextOverflow = options.recoverContextOverflow;
  const frames: WorkbenchRuntimeEvent[] = [];
  try {
    const result = await runTurn(run, {
      prompt: "look around",
      rootOverride: root,
      ...input,
      frames: {
        onRuntimeEvent: (event) => void frames.push(event),
        ...input.frames,
      },
    });
    return { run, frames, result, error: null };
  } catch (error) {
    return { run, frames, error };
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

/**
 * Every request the provider received fits the window by the engine's own
 * estimate (four characters per token). The request body over-approximates
 * what the engine estimates: it carries the tool definitions and the wire
 * framing too, so a body that fits is a request that fits.
 */
function assertEveryRequestFits(run: EngineRun, window = WINDOW): void {
  for (const [index, request] of run.transport.requests.entries()) {
    const tokens = Math.ceil(request.body.length / 4);
    assert(
      tokens <= window,
      `request ${index} estimates at ${tokens} tokens, over the ${window}-token window`,
    );
  }
}

function frame<T extends WorkbenchRuntimeEvent["type"]>(
  frames: WorkbenchRuntimeEvent[],
  type: T,
): Extract<WorkbenchRuntimeEvent, { type: T }> | undefined {
  return frames.find((f) => f.type === type) as
    | Extract<WorkbenchRuntimeEvent, { type: T }>
    | undefined;
}

async function rows(fit: FitRun) {
  const sessionId = frame(fit.frames, "sessionStart")?.sessionId;
  return await eventRows(fit.run, sessionId!);
}

// ─── tool results bounded against the window ─────────────────────────────────

Deno.test("three parallel 64 KiB reads on a 32K window: every result is bounded and no request exceeds the window", async () => {
  const fit = await fitTurn(
    [
      toolReply([
        READ("c1", "CHANGELOG.md"),
        READ("c2", "CHANGELOG.md"),
        READ("c3", "CHANGELOG.md"),
      ]),
      chatReply({ content: "read it" }),
    ],
    {},
    { files: { "CHANGELOG.md": BIG_FILE } },
  );
  assertEquals(fit.error, null);
  assertEquals(fit.result?.text, "read it");
  assertEquals(fit.run.transport.requests.length, 2);
  assertEveryRequestFits(fit.run);

  // The model sees each result cut with an explicit marker that says how
  // much survived and how to get the rest.
  const toolMessages = conversation(fit.run.transport.requests[1])
    .filter((m) => m.role === "tool");
  assertEquals(toolMessages.length, 3);
  for (const message of toolMessages) {
    assertStringIncludes(message.content, "trimmed");
    assertStringIncludes(message.content, `${WINDOW}-token context window`);
    assertStringIncludes(message.content, "offset");
  }
  const trimmed = fit.frames.filter((f) => f.type === "toolResultTrimmed");
  assertEquals(trimmed.length, 3);
  assertObjectMatch(trimmed[0], { commandId: "read_file", callId: "c1" });

  // The durable tool_call events keep the full result (within the event
  // column's own limit): the window bound is a projection for the model, not
  // a rewrite of the log.
  const toolEvents = (await rows(fit)).filter((row) =>
    row.event_type === "tool_call"
  );
  assertEquals(toolEvents.length, 3);
  for (const event of toolEvents) {
    assert(
      (event.tool_result ?? "").length > toolMessages[0].content.length,
      "the event row should hold more of the result than the model saw",
    );
    assertEquals((event.tool_result ?? "").includes("trimmed"), false);
  }
});

// ─── an over-window history recovers on its next turn ───────────────────────

/** The resume projection of one prior turn with three big tool results. */
function overWindowHistory(resultChars: number): WorkbenchMessage[] {
  const history: WorkbenchMessage[] = [
    { role: "user", content: "earlier question" },
  ];
  for (const id of ["h1", "h2", "h3"]) {
    history.push({
      role: "assistant",
      content: "",
      toolCalls: [{ id, name: "read_file", arguments: { path: "big.md" } }],
    });
    history.push({
      role: "tool",
      toolCallId: id,
      name: "read_file",
      content: `${id}:` + "x".repeat(resultChars),
    });
  }
  history.push({ role: "assistant", content: "earlier answer" });
  return history;
}

Deno.test("a session whose history is already over the window completes its next turn", async () => {
  // Three 60,000-character results (the event column's cap) sum to ~45K
  // tokens on a 32K window. Nothing elder exists to compress: the one
  // prior turn is inside the verbatim tail, so only shrinking can save it.
  const history = overWindowHistory(60_000);
  const fit = await fitTurn([chatReply({ content: "still here" })], {
    prompt: "a short follow-up",
    conversationMessages: history,
  });
  assertEquals(fit.error, null);
  assertEquals(fit.result?.text, "still here");
  assertEquals(fit.run.transport.requests.length, 1);
  assertEveryRequestFits(fit.run);

  const seen = conversation(fit.run.transport.requests[0]);
  const toolMessages = seen.filter((m) => m.role === "tool");
  assertEquals(toolMessages.length, 3);
  // Oldest first: the earliest results are trimmed, the newest kept verbatim
  // once the request fits.
  assertStringIncludes(toolMessages[0].content, "trimmed");
  assert(toolMessages[0].content.length < 2_000);
  assertEquals(toolMessages[2].content, history[6].content);
  assertEquals(
    seen.map((m) => m.role),
    [
      "user",
      "assistant",
      "tool",
      "assistant",
      "tool",
      "assistant",
      "tool",
      "assistant",
      "user",
    ],
  );
  const fitted = frame(fit.frames, "contextFitted");
  assert(fitted !== undefined);
  assertObjectMatch(fitted, {
    trigger: "before_send",
    contextWindow: WINDOW,
    compressed: false,
  });
  assert(fitted.trimmedToolResults >= 1);
  assert(fitted.estimatedTokensAfter < fitted.estimatedTokensBefore);
});

// ─── fit compresses elder turns when shrinking is not enough ─────────────────

const VALID_SUMMARY = [
  "## Session intent",
  "Fit test.",
  "## Decisions & outcomes",
  "(none)",
  "## Open threads",
  "(none)",
  "## Key facts & references",
  "(none)",
  "## Tool activity",
  "(none)",
  "## Operator's words",
  "(none)",
].join("\n");

function summaryReply(): ScriptedExchange {
  return {
    ...chatReply({ content: VALID_SUMMARY }),
    expect: (request) =>
      assertEquals(systemMessage(request), COMPRESSION_SYSTEM_PROMPT),
  };
}

/** A window the fixed prefix fits, but two verbatim turns of prose do not. */
const TINY_WINDOW: ModelSeed = {
  ...LOCAL_MODEL,
  context_window: 6_000,
  max_output_tokens: 256,
};

Deno.test("fit compresses elder prose when there are no tool results to shrink", async () => {
  // Four prose turns: load-time compression summarizes the first two, and
  // the two kept verbatim still overfill the window, so the fit step
  // compresses once more before the first call.
  const turn = (word: string) => [
    { role: "user" as const, content: `${word} question `.repeat(300) },
    { role: "assistant" as const, content: `${word} answer `.repeat(300) },
  ];
  const fit = await fitTurn([
    summaryReply(),
    summaryReply(),
    chatReply({ content: "compressed twice" }),
  ], {
    prompt: "one more",
    conversationMessages: [
      ...turn("first"),
      ...turn("second"),
      ...turn("third"),
      ...turn("fourth"),
    ],
  }, { models: [TINY_WINDOW] });
  assertEquals(fit.error, null);
  assertEquals(fit.result?.text, "compressed twice");
  assertEquals(fit.run.transport.requests.length, 3);
  assertEveryRequestFits(fit.run, TINY_WINDOW.context_window!);
  const compressions = fit.frames.filter((f) => f.type === "contextCompressed");
  assertEquals(
    compressions.map((f) => f.type === "contextCompressed" && f.trigger),
    ["proactive", "request_fit"],
  );
  assertObjectMatch(frame(fit.frames, "contextFitted")!, {
    trigger: "before_send",
    compressed: true,
    trimmedToolResults: 0,
  });
  assertEquals(fit.frames.at(-1)?.type, "turnCompleted");
});

// ─── a provider's context-exceeded rejection is context overflow ─────────────

Deno.test("a llama-server context-size rejection is classified and recovered by refitting", async () => {
  // The history fits by estimate, so no fit runs before the first call; the
  // provider disagrees. Its rejection carries the token counts, the refit
  // shrinks the elder result against them, and one retry completes.
  const history = overWindowHistory(8_000);
  const fit = await fitTurn([
    LLAMA_SERVER_REJECTION,
    chatReply({ content: "recovered" }),
  ], {
    prompt: "a short follow-up",
    conversationMessages: history,
  });
  assertEquals(fit.error, null);
  assertEquals(fit.result?.text, "recovered");
  assertEquals(fit.run.transport.requests.length, 2);
  const [first, retry] = fit.run.transport.requests;
  assert(retry.body.length < first.body.length);
  assertStringIncludes(
    conversation(retry).filter((m) => m.role === "tool")[0].content,
    "trimmed",
  );
  assertObjectMatch(frame(fit.frames, "contextFitted")!, {
    trigger: "provider_rejected",
    contextWindow: WINDOW,
  });
  assertEquals(fit.frames.at(-1)?.type, "turnCompleted");

  const calls = (await rows(fit)).filter((row) =>
    row.event_type === "provider_call"
  );
  assertObjectMatch(calls[0], {
    stop_reason: "error",
    provider_error_class: "ProviderContextExceededError",
  });
  assertObjectMatch(calls[1], {
    provider_call_purpose: "recovery",
    stop_reason: "stop",
  });
});

Deno.test("a rejection with nothing left to trim fails as context overflow naming the window", async () => {
  const fit = await fitTurn([LLAMA_SERVER_REJECTION], {
    prompt: "a short question",
  });
  assert(fit.error instanceof Error);
  assertStringIncludes(fit.error.message, "Context window overflow");
  assertStringIncludes(fit.error.message, `${WINDOW}-token context window`);
  assertEquals(fit.run.transport.requests.length, 1);
  assertObjectMatch(fit.frames.at(-1)!, {
    type: "turnFailed",
    errorName: "ContextWindowOverflowError",
  });
  // The provider's body never rides the error: only the counts it reported.
  assertEquals(fit.error.message.includes("try increasing it"), false);
  const errorRow = (await rows(fit)).find((row) => row.event_type === "error");
  assertStringIncludes(errorRow?.content ?? "", "/model");
});

Deno.test("the fit step never sends a request over the window on a tool follow-up", async () => {
  // One read that fits on its own, then a bash-sized result: each follow-up
  // call is measured before it goes out, not only the first.
  const fit = await fitTurn(
    [
      toolReply([READ("c1", "notes.md")]),
      toolReply([READ("c2", "CHANGELOG.md"), READ("c3", "CHANGELOG.md")]),
      chatReply({ content: "all read" }),
    ],
    {},
    {
      files: { "notes.md": "short\n", "CHANGELOG.md": BIG_FILE },
    },
  );
  assertEquals(fit.error, null);
  assertEquals(fit.result?.text, "all read");
  assertEquals(fit.run.transport.requests.length, 3);
  assertEveryRequestFits(fit.run);
  // The small first result survives untouched on the later calls.
  const last = conversation(fit.run.transport.requests[2]);
  assertEquals(last.filter((m) => m.role === "tool")[0].content, "short\n");
  assert(requestBody(fit.run.transport.requests[2]).tools !== undefined);
});

// ─── the fit measures what the adapter sends ─────────────────────────────────

Deno.test("an adapter that sends only the prompt is sized by the prompt: a long history neither compresses nor overflows", async () => {
  // Gemini carries no transcript and no tools on the wire, so the seeded
  // history (which the transcript estimate would put far over a 4,000-token
  // window) costs nothing; the turn goes out and completes. Load-time
  // compression declines without a request: no on-machine compressor.
  const fit = await fitTurn([geminiReply({ text: "prompt-only reply" })], {
    prompt: "a short follow-up",
    conversationMessages: overWindowHistory(60_000),
    defaultCompanionModel: GEMINI_FREE_MODEL.slug,
  }, {
    models: [{ ...GEMINI_FREE_MODEL, context_window: 4_000 }],
    env: { GEMINI_API_KEY: "test-key-not-real" },
  });
  assertEquals(fit.error, null);
  assertEquals(fit.result?.text, "prompt-only reply");
  assertEquals(fit.run.transport.requests.length, 1);
  assertEquals(frame(fit.frames, "contextFitted"), undefined);
  assertEquals(frame(fit.frames, "contextCompressed"), undefined);
  assertEquals(fit.frames.at(-1)?.type, "turnCompleted");
});

// ─── a fit that cannot reach the budget is a failure, not a fitted event ─────

Deno.test("trimming that still leaves the request over the window fails without a contextFitted event", async () => {
  // Three results shrink to their markers, and the fixed prefix plus the
  // markers still exceed a 4,000-token window's budget: the turn fails
  // before any call, and no event claims the request was made to fit.
  const fit = await fitTurn([], {
    prompt: "a short follow-up",
    conversationMessages: overWindowHistory(60_000),
  }, { models: [{ ...LOCAL_MODEL, context_window: 4_000 }] });
  assert(fit.error instanceof Error);
  assertStringIncludes(fit.error.message, "4000-token context window");
  assertEquals(fit.run.transport.requests.length, 0);
  assertEquals(frame(fit.frames, "contextFitted"), undefined);
  assertObjectMatch(fit.frames.at(-1)!, {
    type: "turnFailed",
    errorName: "ContextWindowOverflowError",
  });
});

// ─── recovery retries are fitted before they go out ──────────────────────────

Deno.test("an overflow-recovery plan is fitted before its retry is sent", async () => {
  // The injected plan keeps a 60,000-character tool result in its verbatim
  // tail; the retry must shrink it rather than send it over the window.
  const plan: WorkbenchMessage[] = [
    { role: "user", content: "compressed history" },
    ...overWindowHistory(60_000).slice(1, 3),
    { role: "user", content: "a short follow-up" },
  ];
  const fit = await fitTurn(
    [
      chatReply({
        content: "cut off",
        finishReason: "length",
        usage: { prompt_tokens: 9_750, completion_tokens: 100 },
      }),
      chatReply({ content: "recovered answer" }),
    ],
    { prompt: "a short follow-up" },
    {
      models: [{ ...LOCAL_MODEL, context_window: 10_000 }],
      recoverContextOverflow: () => Promise.resolve({ messages: plan }),
    },
  );
  assertEquals(fit.error, null);
  assertEquals(fit.result?.text, "recovered answer");
  assertEquals(fit.run.transport.requests.length, 2);
  assertEveryRequestFits(fit.run, 10_000);
  const retry = conversation(fit.run.transport.requests[1]);
  assertStringIncludes(
    retry.find((m) => m.role === "tool")!.content,
    "trimmed",
  );
  assertObjectMatch(frame(fit.frames, "contextFitted")!, {
    trigger: "before_send",
    trimmedToolResults: 1,
    compressed: false,
  });
  assertObjectMatch(frame(fit.frames, "lengthRecoveryFinished")!, {
    outcome: "recovered",
    retriesUsed: 1,
  });
});
