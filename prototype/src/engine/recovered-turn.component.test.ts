/**
 * Component tests for length-stop recovery (`recovered-turn.ts`): whole
 * native turns over the engine fakes whose provider calls stop at "length".
 * The OpenAI-compatible adapter covers the transcript-retry paths; Anthropic
 * covers cache-side prompt accounting; Gemini covers an adapter that cannot
 * run a transcript retry and reports thinking tokens separately.
 */
import { assert, assertEquals, assertObjectMatch } from "@std/assert";
import { assertSpyCalls, spy } from "@std/testing/mock";
import {
  anthropicStop,
  chatReply,
  conversation,
  type EngineRun,
  engineServices,
  eventRows,
  GEMINI_FREE_MODEL,
  geminiReply,
  HOSTED_FREE_MODEL,
  LOCAL_MODEL,
  pricedLocalModel,
  runTurn,
  tempWorkspace,
} from "../../testing/builders/engine.ts";
import type { ScriptedExchange } from "../../testing/fakes/scripted-http-transport.ts";
import { LENGTH_CONTINUATION_NUDGE } from "../context/mod.ts";
import type { WorkbenchRuntimeEvent } from "../contract/mod.ts";
import type { ModelSeed } from "../store/mod.ts";
import type { WorkbenchRuntimeInput } from "./runtime-types.ts";

/** A reply that stops at the output limit. */
function lengthReply(
  content: string,
  usage = { prompt_tokens: 42, completion_tokens: 7 },
  toolCalls?: Array<{ id: string; name: string; arguments: unknown }>,
): ScriptedExchange {
  return chatReply({ content, finishReason: "length", usage, toolCalls });
}

const SMALL_WINDOW: ModelSeed = { ...LOCAL_MODEL, context_window: 100 };
const COMPRESSED = [{ role: "user" as const, content: "compressed history" }];

interface LengthRun {
  run: EngineRun;
  frames: WorkbenchRuntimeEvent[];
  error: unknown;
  text: string | undefined;
}

async function lengthTurn(
  exchanges: ScriptedExchange[],
  input: Partial<WorkbenchRuntimeInput> = {},
  options: { models?: ModelSeed[]; env?: Record<string, string> } = {},
): Promise<LengthRun> {
  await using root = await tempWorkspace();
  const run = engineServices(exchanges, options);
  const frames: WorkbenchRuntimeEvent[] = [];
  let error: unknown = null;
  let text: string | undefined;
  try {
    const result = await runTurn(run, {
      prompt: "write a long report",
      rootOverride: root.root,
      defaultCompanionModel: (options.models?.[0] ?? LOCAL_MODEL).slug,
      onRuntimeEvent: (event) => void frames.push(event),
      ...input,
    });
    text = result.text;
  } catch (err) {
    error = err;
  }
  return { run, frames, error, text };
}

function frame<T extends WorkbenchRuntimeEvent["type"]>(
  frames: WorkbenchRuntimeEvent[],
  type: T,
): Extract<WorkbenchRuntimeEvent, { type: T }> | undefined {
  return frames.find((f) => f.type === type) as
    | Extract<WorkbenchRuntimeEvent, { type: T }>
    | undefined;
}

async function modelResponse(run: EngineRun, frames: WorkbenchRuntimeEvent[]) {
  const sessionId = frame(frames, "sessionStart")?.sessionId;
  const rows = await eventRows(run, sessionId!);
  return rows.find((row) => row.event_type === "model_response");
}

// ─── output-budget exhaustion: one continuation retry ────────────────────────

Deno.test("output-budget truncation runs one continuation retry and merges the text", async () => {
  const { run, frames, text } = await lengthTurn([
    lengthReply("first half "),
    chatReply({ content: "second half" }),
  ]);
  assertEquals(text, "first half second half");
  assertEquals(run.transport.requests.length, 2);
  // The retry is a continuation: same transcript + the partial assistant
  // turn + the nudge (the live transcript itself is not mutated).
  const retry = conversation(run.transport.requests[1]);
  assertObjectMatch(retry.at(-2)!, {
    role: "assistant",
    content: "first half ",
  });
  assertEquals(retry.at(-1), {
    role: "user",
    content: LENGTH_CONTINUATION_NUDGE,
  });
  assertObjectMatch(frame(frames, "lengthStopDetected")!, {
    classification: "output_budget_exhausted",
    severity: "warn",
    modelSlug: LOCAL_MODEL.slug,
    inputTokens: 42,
    outputTokens: 7,
  });
  assertObjectMatch(frame(frames, "lengthRecoveryFinished")!, {
    outcome: "recovered",
    retriesUsed: 1,
  });
  assertEquals(frames.at(-1)?.type, "turnCompleted");
  assertEquals((await modelResponse(run, frames))?.stop_reason, "stop");
});

Deno.test("a retry that is still truncated stops after exactly one retry and returns the merged partial", async () => {
  const { run, frames, text } = await lengthTurn([
    lengthReply("part "),
    lengthReply("part "),
  ]);
  // Bounded: one retry, never a third call, and the turn still completes
  // with the merged partial output marked truncated on the audit log.
  assertEquals(run.transport.requests.length, 2);
  assertEquals(text, "part part ");
  assertObjectMatch(frame(frames, "lengthRecoveryFinished")!, {
    outcome: "still_truncated",
    retriesUsed: 1,
  });
  assertEquals(frames.at(-1)?.type, "turnCompleted");
  assertEquals((await modelResponse(run, frames))?.stop_reason, "length");
});

/** Priced so a 3-token completion records $0.03; the input price is ~0. */
const PENNY_OUTPUT = pricedLocalModel({
  costInput: 0.000001,
  costOutput: 10_000,
});

Deno.test("a retry the budget envelope refuses is skipped and the truncated turn is delivered", async () => {
  const { run, frames, text } = await lengthTurn([
    lengthReply("truncated answer", {
      prompt_tokens: 42,
      completion_tokens: 3,
    }),
  ], {
    // The first call's recorded $0.03 exceeds the $0.02 session envelope, so
    // the retry's pre-call gate fails closed (no ceiling handler).
    defaultSessionBudgetUsd: 0.02,
    confirmPaidEscalation: () => Promise.resolve({ decision: "approve" }),
  }, { models: [PENNY_OUTPUT] });
  assertEquals(run.transport.requests.length, 1);
  assertEquals(text, "truncated answer");
  assertObjectMatch(frame(frames, "lengthRecoveryFinished")!, {
    outcome: "retry_refused_budget",
    retriesUsed: 0,
  });
  // The refusal downgrades the retry, not the turn.
  assertEquals(frames.at(-1)?.type, "turnCompleted");
});

Deno.test("a runaway-anomaly halt on the retry fails the turn — never downgraded to a partial", async () => {
  // Recorded $0.03 exceeds the turn halt (2 × $0.01 per-call limit); the
  // retry's anomaly gate fails closed and the halt must surface, not be
  // converted into a delivered partial.
  const { run, frames, error } = await lengthTurn([
    lengthReply("truncated answer", {
      prompt_tokens: 42,
      completion_tokens: 3,
    }),
  ], {
    defaultPerCallBudgetUsd: 0.01,
    anomalyTurnMultiple: 2,
    confirmPaidEscalation: () => Promise.resolve({ decision: "approve" }),
  }, { models: [PENNY_OUTPUT] });
  assert(error instanceof Error);
  assertEquals(run.transport.requests.length, 1);
  assertObjectMatch(frame(frames, "lengthRecoveryFinished")!, {
    outcome: "retry_errored",
  });
  assertObjectMatch(frames.at(-1)!, {
    type: "turnFailed",
    errorName: "RunawayAnomalyHaltError",
  });
});

Deno.test("a continuation retry never signals a supersede — its text extends the partial", async () => {
  const { frames, text } = await lengthTurn([
    lengthReply("first half "),
    chatReply({ content: "second half" }),
  ]);
  // Merged text: what streamed (partial + continuation) IS the answer, so a
  // consumer resetting here would lose real output.
  assertEquals(text, "first half second half");
  assertEquals(frame(frames, "supersedingRetryStarted"), undefined);
});

Deno.test("both cap and window bind: the continuation would overflow, so it is skipped and the capped partial delivered", async () => {
  // Output cap hit (200 >= 200) → output-budget exhaustion by cap
  // precedence, though the window is also full. The continuation cannot fit
  // the 100-token window, so a retry would be a doomed over-window call.
  const partial = "x".repeat(600);
  const { run, frames, text } = await lengthTurn(
    [
      lengthReply(partial, { prompt_tokens: 50, completion_tokens: 200 }, [
        { id: "c1", name: "list_files", arguments: {} },
      ]),
    ],
    { prompt: "one more question" },
    {
      models: [{ ...SMALL_WINDOW, max_output_tokens: 200 }],
    },
  );
  // Exactly one provider call — the doomed continuation was not attempted.
  assertEquals(run.transport.requests.length, 1);
  assertEquals(text, partial);
  assertObjectMatch(frame(frames, "lengthStopDetected")!, {
    classification: "output_budget_exhausted",
  });
  assertObjectMatch(frame(frames, "lengthRecoveryFinished")!, {
    outcome: "retry_would_overflow",
    retriesUsed: 0,
  });
  // Cut-off tool plan stripped; the turn completes cleanly.
  assertEquals(frame(frames, "toolStepStarted"), undefined);
  assertEquals(frames.at(-1)?.type, "turnCompleted");
});

// ─── adapters without a transcript retry ─────────────────────────────────────

const GEMINI_KEY = { GEMINI_API_KEY: "gem-test-key" };

Deno.test("an adapter without transcript retry delivers the truncated partial instead of replaying the prompt", async () => {
  const { run, frames, text } = await lengthTurn(
    [
      geminiReply({
        text: "truncated answer",
        finishReason: "MAX_TOKENS",
        functionCalls: [{ name: "list_files", args: {} }],
      }),
    ],
    {},
    { models: [GEMINI_FREE_MODEL], env: GEMINI_KEY },
  );
  assertEquals(run.transport.requests.length, 1);
  assertEquals(text, "truncated answer");
  assertObjectMatch(frame(frames, "lengthRecoveryFinished")!, {
    outcome: "retry_unsupported",
    retriesUsed: 0,
  });
  // The cut-off tool-call plan is stripped: no tool step ran.
  assertEquals(frame(frames, "toolStepStarted"), undefined);
  assertEquals(frames.at(-1)?.type, "turnCompleted");
});

Deno.test("thinking tokens count toward classification: a thinking-model cap hit near the window is exhaustion, not a false overflow", async () => {
  // Reported output (96) sits below the 150 cap and input+output (196)
  // reaches the 200-token window's 98% line — so WITHOUT counting reasoning
  // this would misclassify as overflow and hard-fail. WITH reasoning, output
  // is 96 + 60 = 156 ≥ 150 → output-budget exhaustion → truncated partial.
  const { run, frames, text } = await lengthTurn(
    [
      geminiReply({
        text: "truncated thinking-model answer",
        finishReason: "MAX_TOKENS",
        usage: {
          promptTokenCount: 100,
          candidatesTokenCount: 96,
          thoughtsTokenCount: 60,
        },
      }),
    ],
    { prompt: "one more question" },
    {
      models: [{
        ...GEMINI_FREE_MODEL,
        context_window: 200,
        max_output_tokens: 150,
      }],
      env: GEMINI_KEY,
    },
  );
  assertEquals(run.transport.requests.length, 1);
  assertEquals(text, "truncated thinking-model answer");
  assertObjectMatch(frame(frames, "lengthStopDetected")!, {
    classification: "output_budget_exhausted",
    severity: "warn",
    // The event reports true consumption: 96 visible + 60 reasoning.
    outputTokens: 156,
  });
  assertObjectMatch(frame(frames, "lengthRecoveryFinished")!, {
    outcome: "retry_unsupported",
    retriesUsed: 0,
  });
  assertEquals(frames.at(-1)?.type, "turnCompleted");
});

// ─── context overflow ────────────────────────────────────────────────────────

/** A 100-token-window reply that overflows: 95 in + 4 out ≥ 98. */
const OVERFLOW = lengthReply("cut off", {
  prompt_tokens: 95,
  completion_tokens: 4,
});

Deno.test("context overflow fails the turn with the structured operator message and a clean event trail", async () => {
  const { run, frames, error } = await lengthTurn(
    [
      lengthReply("cut off", { prompt_tokens: 90, completion_tokens: 9 }),
    ],
    { prompt: "one more question" },
    { models: [SMALL_WINDOW] },
  );
  assert(error instanceof Error);
  assert(error.message.includes("Context window overflow"));
  assertEquals(run.transport.requests.length, 1);
  assertObjectMatch(frame(frames, "lengthStopDetected")!, {
    classification: "context_overflow",
    severity: "error",
    contextWindow: 100,
  });
  assertObjectMatch(frame(frames, "lengthRecoveryFinished")!, {
    outcome: "overflow_failed",
    retriesUsed: 0,
  });
  assertObjectMatch(frames.at(-1)!, {
    type: "turnFailed",
    errorName: "ContextWindowOverflowError",
  });
  // Session state stays consistent: the failure is on the audit log with the
  // length stop it came from, no half-turn model_response exists for resume
  // to replay, and the session is properly closed.
  const sessionId = frame(frames, "sessionStart")?.sessionId;
  const rows = await eventRows(run, sessionId!);
  const types = rows.map((row) => row.event_type);
  assertEquals(types.includes("model_response"), false);
  assert(types.includes("session_end"));
  const errorRow = rows.find((row) => row.event_type === "error");
  assertEquals(errorRow?.stop_reason, "length");
  assert((errorRow?.content ?? "").includes("/model"));
  assert((errorRow?.content ?? "").includes("fresh session"));
});

Deno.test("an injected overflow recovery plan buys exactly one retry (the compressor seam)", async () => {
  const recoverContextOverflow = spy(() =>
    Promise.resolve({ messages: COMPRESSED })
  );
  const { run, frames, text } = await lengthTurn(
    [
      lengthReply("cut off", {
        prompt_tokens: 95,
        completion_tokens: 10,
        completion_tokens_details: { reasoning_tokens: 6 },
      } as never),
      chatReply({ content: "recovered answer" }),
    ],
    { prompt: "one more question", recoverContextOverflow },
    {
      models: [SMALL_WINDOW],
    },
  );
  assertEquals(text, "recovered answer");
  assertSpyCalls(recoverContextOverflow, 1);
  // The hook context reports reasoning-inclusive output (4 visible + 6
  // reasoning), consistent with classification — the compression consumer
  // sizes its plan from true token pressure, not just visible output.
  assertObjectMatch(
    (recoverContextOverflow.calls[0].args as unknown[])[0] as Record<
      string,
      unknown
    >,
    {
      modelSlug: LOCAL_MODEL.slug,
      contextWindow: 100,
      usage: { input: 95, output: 10 },
    },
  );
  assertEquals(conversation(run.transport.requests[1]), COMPRESSED);
  assertObjectMatch(frame(frames, "lengthRecoveryFinished")!, {
    outcome: "recovered",
    retriesUsed: 1,
  });
  assertEquals(frames.at(-1)?.type, "turnCompleted");
});

Deno.test("the overflow-recovery retry announces the supersede before any retry output exists", async () => {
  // One ordered trail of frames AND provider calls: the supersede signal must
  // land after the overflowed attempt but before the retry call runs, so an
  // in-order stream consumer resets before the replacement text arrives.
  const trail: string[] = [];
  const retry = chatReply({ content: "recovered answer" });
  const { text } = await lengthTurn([
    OVERFLOW,
    {
      ...retry,
      expect: () => void trail.push("retryProviderCall"),
    },
  ], {
    prompt: "one more question",
    recoverContextOverflow: () => Promise.resolve({ messages: COMPRESSED }),
    onRuntimeEvent: (event) => void trail.push(event.type),
  }, { models: [SMALL_WINDOW] });
  assertEquals(text, "recovered answer");
  const supersedeAt = trail.indexOf("supersedingRetryStarted");
  assert(supersedeAt > trail.indexOf("lengthStopDetected"));
  assert(supersedeAt < trail.indexOf("retryProviderCall"));
  assert(
    trail.indexOf("retryProviderCall") <
      trail.indexOf("lengthRecoveryFinished"),
  );
});

Deno.test("a failed supersede delivery aborts the retry instead of streaming an unmarked replacement", async () => {
  // The consumer's event channel is broken exactly when the supersede signal
  // is delivered. Streaming the replacement anyway would glue it onto the
  // stale text still on the consumer's screen, so the turn must fail.
  const trail: string[] = [];
  const { run, error } = await lengthTurn([OVERFLOW], {
    prompt: "one more question",
    recoverContextOverflow: () => Promise.resolve({ messages: COMPRESSED }),
    onRuntimeEvent: (event) => {
      if (event.type === "supersedingRetryStarted") {
        throw new Error("event channel closed");
      }
      trail.push(event.type);
    },
  }, { models: [SMALL_WINDOW] });
  assert(error instanceof Error);
  assertEquals(error.message, "event channel closed");
  assertEquals(run.transport.requests.length, 1);
});

Deno.test("a recovery hook that throws closes the recovery trail before the turn fails", async () => {
  const { frames, error } = await lengthTurn([OVERFLOW], {
    prompt: "one more question",
    recoverContextOverflow: () => {
      throw new Error("compressor exploded");
    },
  }, { models: [SMALL_WINDOW] });
  assert(error instanceof Error);
  assertEquals(error.message, "compressor exploded");
  assertObjectMatch(frame(frames, "lengthRecoveryFinished")!, {
    outcome: "retry_errored",
    retriesUsed: 0,
  });
  assertEquals(frames.at(-1)?.type, "turnFailed");
});

Deno.test("a recovery-plan retry that still overflows fails structured — the hook never loops", async () => {
  const recoverContextOverflow = spy(() =>
    Promise.resolve({ messages: COMPRESSED })
  );
  const { run, frames, error } = await lengthTurn([OVERFLOW, OVERFLOW], {
    prompt: "one more question",
    recoverContextOverflow,
  }, { models: [SMALL_WINDOW] });
  assert(error instanceof Error);
  assert(error.message.includes("Context window overflow"));
  assertEquals(run.transport.requests.length, 2);
  assertSpyCalls(recoverContextOverflow, 1);
  assertObjectMatch(frame(frames, "lengthRecoveryFinished")!, {
    outcome: "overflow_failed",
    retriesUsed: 1,
  });
});

Deno.test("compression resolves the overflow but the fresh answer hits its output cap: bounded truncation, not a false overflow", async () => {
  const recoverContextOverflow = spy(() =>
    Promise.resolve({ messages: COMPRESSED })
  );
  const { run, frames, text } = await lengthTurn(
    [
      OVERFLOW,
      // The compressed retry fits the window but hits the 200-token cap.
      lengthReply(
        "compressed but truncated answer",
        { prompt_tokens: 2, completion_tokens: 200 },
        [{ id: "c1", name: "list_files", arguments: {} }],
      ),
    ],
    { prompt: "one more question", recoverContextOverflow },
    {
      models: [{ ...SMALL_WINDOW, max_output_tokens: 200 }],
    },
  );
  // The retry is reclassified against its OWN usage (output 200 ≥ cap 200 →
  // exhaustion), so the turn does NOT throw a stale context overflow.
  assertEquals(text, "compressed but truncated answer");
  assertEquals(run.transport.requests.length, 2);
  assertObjectMatch(frame(frames, "lengthRecoveryFinished")!, {
    outcome: "still_truncated",
    retriesUsed: 1,
  });
  // Bounded terminal: cut-off tool plan stripped, turn completes cleanly.
  assertEquals(frame(frames, "toolStepStarted"), undefined);
  assertEquals(frames.at(-1)?.type, "turnCompleted");
});

Deno.test("cached prompt tokens count toward the window: a cache-heavy overflow is not mistaken for exhaustion", async () => {
  // 20 + 70 cached + 5 cache-written prompt-side tokens + 4 output = 99 ≥ 98%
  // of the 100-token window. Anthropic reports cache traffic outside
  // input_tokens, so the prompt-side total must add it back.
  const { frames, error } = await lengthTurn(
    [
      anthropicStop("cut off", "max_tokens", {
        input_tokens: 20,
        output_tokens: 4,
        cache_read_input_tokens: 70,
        cache_creation_input_tokens: 5,
      }),
    ],
    { prompt: "one more question" },
    {
      models: [{ ...HOSTED_FREE_MODEL, context_window: 100 }],
      env: { ANTHROPIC_API_KEY: "test-key-not-real" },
    },
  );
  assert(error instanceof Error);
  assert(error.message.includes("Context window overflow"));
  assertObjectMatch(frame(frames, "lengthStopDetected")!, {
    classification: "context_overflow",
    inputTokens: 95,
  });
});

Deno.test("an overflow on a model with no on-machine compressor fails without a compression call", async () => {
  // The default recoverer compresses on-machine only; with no local row it
  // declines without a request, and the overflow fails structured.
  const { run, error } = await lengthTurn(
    [
      anthropicStop("cut off", "max_tokens", {
        input_tokens: 95,
        output_tokens: 4,
      }),
    ],
    { prompt: "one more question" },
    {
      models: [{ ...HOSTED_FREE_MODEL, context_window: 100 }],
      env: { ANTHROPIC_API_KEY: "test-key-not-real" },
    },
  );
  assert(error instanceof Error);
  assert(error.message.includes("Context window overflow"));
  assertEquals(run.transport.requests.length, 1);
});
