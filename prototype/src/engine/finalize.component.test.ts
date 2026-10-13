/**
 * Component tests for the native turn's final stage (`finalize.ts`): what a
 * finished, cancelled or failed turn reports — frames, event rows, the
 * receipt and the returned result — and the event-write integrity policy
 * that decides whether a failed write fails the turn. Whole turns run over
 * the engine fakes; a held-open stream gives the cancellation cases a real
 * mid-response abort.
 */
import assert from "node:assert/strict";
import { mock } from "node:test";
import {
  chatReply,
  type EngineRun,
  engineServices,
  eventRows,
  LOCAL_MODEL,
  patchStore,
  runTurn,
} from "../../testing/builders/engine.ts";
import { captureRejection } from "../../testing/assertions/captured.ts";
import type { ScriptedExchange } from "../../testing/fakes/scripted-http-transport.ts";
import type { WorkbenchRuntimeEvent } from "../contract/mod.ts";
import { ProviderRequestFailedError } from "../providers/mod.ts";
import type { EventInsert } from "../store/mod.ts";

/** One SSE line carrying a content delta. */
const contentFrame = (content: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n`;

/** A streamed reply that delivers `text`, then holds the stream open. */
function heldOpenReply(text: string): ScriptedExchange {
  return {
    respond: {
      headers: { "content-type": "text/event-stream" },
      body: contentFrame(text),
      holdOpen: true,
    },
  };
}

/** Fail every journal commit carrying an event of `eventType`. */
function failingWrites(
  run: EngineRun,
  eventType: string,
  message = `simulated write failure: ${eventType}`,
): void {
  const store = run.store;
  run.services.store = patchStore(store, {
    journal: {
      commit: (batch, options) =>
        batch.events.some((e: EventInsert) => e.event_type === eventType)
          ? Promise.reject(new Error(message))
          : store.journal.commit(batch, options),
    },
  });
}

/** Run with console.log/warn/error stubbed; returns the warn lines. */
async function quietly<T>(
  run: () => Promise<T>,
): Promise<{ value: T; warnings: string[] }> {
  const log = mock.method(console, "log", () => {});
  const warn = mock.method(console, "warn", () => {});
  const error = mock.method(console, "error", () => {});
  try {
    const value = await run();
    return {
      value,
      warnings: warn.mock.calls.map((call) => String(call.arguments[0])),
    };
  } finally {
    log.mock.restore();
    warn.mock.restore();
    error.mock.restore();
  }
}

// ─── the runtime spine ───────────────────────────────────────────────────────

Deno.test("emits the runtime spine event sequence without leaking full prompt or response text", async () => {
  const run = engineServices([chatReply({ content: "runtime response" })]);
  const frames: WorkbenchRuntimeEvent[] = [];
  const result = await runTurn(run, {
    prompt: "summarize this sensitive prompt body",
    frames: {
      onRuntimeEvent: (event) => void frames.push(event),
    },
  });
  assert.deepStrictEqual(result.text, "runtime response");
  assert.deepStrictEqual(frames.map((frame) => frame.type), [
    "sessionStart",
    "inputReceived",
    "contextBuilt",
    "modelSelected",
    "beforeProviderRequest",
    "afterProviderResponse",
    "turnCompleted",
  ]);
  const { sessionId, traceId } = result;
  assert.deepStrictEqual(frames[0], {
    type: "sessionStart",
    sessionId,
    traceId,
    mode: "turn",
  });
  assert.deepStrictEqual(frames[1], {
    type: "inputReceived",
    sessionId,
    promptLength: 36,
  });
  assert.partialDeepStrictEqual(frames[2], { type: "contextBuilt", sessionId });
  assert.partialDeepStrictEqual(frames[3], {
    type: "modelSelected",
    sessionId,
    modelSlug: LOCAL_MODEL.slug,
    tier: 0,
  });
  assert.partialDeepStrictEqual(frames[4], {
    type: "beforeProviderRequest",
    sessionId,
    modelSlug: LOCAL_MODEL.slug,
  });
  assert.partialDeepStrictEqual(frames[5], {
    type: "afterProviderResponse",
    sessionId,
    modelSlug: LOCAL_MODEL.slug,
    inputCount: 42,
    outputCount: 7,
  });
  assert.deepStrictEqual(frames[6], {
    type: "turnCompleted",
    sessionId,
    traceId,
  });
  const wire = JSON.stringify(frames);
  assert.deepStrictEqual(
    wire.includes("summarize this sensitive prompt body"),
    false,
  );
  assert.deepStrictEqual(wire.includes("runtime response"), false);
});

Deno.test("treats observer failures as best-effort and preserves the turn result", async () => {
  const run = engineServices([chatReply({ content: "runtime response" })]);
  const { value: result, warnings } = await quietly(() =>
    runTurn(run, {
      prompt: "summarize",
      frames: {
        onRuntimeEvent: () => {
          throw new Error("observer sink down");
        },
      },
    })
  );
  assert.deepStrictEqual(result.text, "runtime response");
  // Provenance-summarized, never raw: an observer failure is a foreign
  // error, so the console line carries a fixed label + byte count, not the
  // message (which can embed payload content).
  assert.ok(warnings.includes("Runtime observer skipped: [Error, 18 bytes]"));
  for (const line of warnings) {
    assert.deepStrictEqual(line.includes("observer sink down"), false);
  }
});

// ─── cancellation ────────────────────────────────────────────────────────────

const TURN_ID = "123e4567-e89b-42d3-a456-426614174000";

Deno.test("an aborted turn finalizes partial text and usage without dispatching tools", async () => {
  const abortController = new AbortController();
  const run = engineServices([
    heldOpenReply("partial answer"),
    chatReply({ content: "next answer" }),
  ]);
  const frames: WorkbenchRuntimeEvent[] = [];
  const first = await runTurn(run, {
    prompt: "start",
    turnId: TURN_ID,
    abortSignal: abortController.signal,
    frames: {
      onTextDelta: () => abortController.abort(),
      onRuntimeEvent: (event) => void frames.push(event),
      log: () => {},
    },
  });
  assert.partialDeepStrictEqual(first, {
    text: "partial answer",
    stopReason: "aborted",
    tokens: { totalCalls: 1 },
  });
  const rows = await eventRows(run, first.sessionId);
  assert.partialDeepStrictEqual(
    rows.find((row) => row.event_type === "model_response")!,
    {
      content: "partial answer",
      stop_reason: "aborted",
      tokens_input: String(first.tokens.input),
      tokens_output: String(first.tokens.output),
    },
  );
  assert.deepStrictEqual(
    rows.some((row) => row.event_type === "tool_call"),
    false,
  );
  assert.ok(
    frames.some((frame) =>
      frame.type === "turnAborted" && frame.sessionId === first.sessionId &&
      frame.traceId === first.traceId && frame.turnId === TURN_ID
    ),
  );
  assert.deepStrictEqual(
    frames.some((frame) => frame.type === "turnCompleted"),
    false,
  );

  const next = await runTurn(run, {
    prompt: "continue",
    sessionId: first.sessionId,
  });
  assert.partialDeepStrictEqual(next, {
    text: "next answer",
    stopReason: "stop",
  });
});

Deno.test("an aborted next-work turn preserves partial text without validating it", async () => {
  const abortController = new AbortController();
  const partial = '{"worklet_id":"next-work.v0"';
  // Next-work replies are JSON, never streamed: the reply lands after the
  // caller cancelled, and the loop reports the turn aborted with its text.
  const run = engineServices([{
    respond: () => {
      abortController.abort();
      return new Response(JSON.stringify({
        choices: [{ message: { content: partial }, finish_reason: "stop" }],
        usage: { prompt_tokens: 17, completion_tokens: 3 },
      }));
    },
  }]);
  const logged: string[] = [];
  const result = await runTurn(run, {
    mode: "next-work",
    prompt: "what should I do next?",
    turnId: TURN_ID,
    abortSignal: abortController.signal,
    frames: {
      log: (...parts: unknown[]) =>
        void logged.push(parts.map(String).join(" ")),
    },
  });
  assert.partialDeepStrictEqual(result, {
    text: partial,
    stopReason: "aborted",
  });
  assert.deepStrictEqual(result.validation, undefined);
  assert.deepStrictEqual(
    logged.some((line) => line.includes("Next-work validation failed")),
    false,
  );
  const response = (await eventRows(run, result.sessionId)).find((row) =>
    row.event_type === "model_response"
  );
  assert.deepStrictEqual(JSON.parse(String(response?.content)), {
    worklet_id: "next-work.v0",
    raw: partial,
  });
});

Deno.test("a provider terminal error outranks a concurrent cancellation", async () => {
  const abortController = new AbortController();
  // A finish_reason "error" reply, delivered after the caller cancelled.
  const run = engineServices([{
    respond: () => {
      abortController.abort();
      return new Response(JSON.stringify({
        choices: [{
          message: { content: "provider refusal" },
          finish_reason: "error",
        }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      }));
    },
  }]);
  const frames: WorkbenchRuntimeEvent[] = [];
  const result = await runTurn(run, {
    prompt: "start",
    abortSignal: abortController.signal,
    frames: {
      onRuntimeEvent: (event) => void frames.push(event),
      log: () => {},
    },
  });
  assert.deepStrictEqual(result.stopReason, "error");
  assert.partialDeepStrictEqual(
    (await eventRows(run, result.sessionId)).find((row) =>
      row.event_type === "model_response"
    )!,
    { stop_reason: "error" },
  );
  assert.deepStrictEqual(
    frames.some((frame) => frame.type === "turnAborted"),
    false,
  );
});

Deno.test("closes cancellation acceptance before terminal finalization", async () => {
  const run = engineServices([chatReply({ content: "done" })]);
  let cancellationClosed = false;
  let closedAtCompletion: boolean | undefined;
  const result = await runTurn(run, {
    prompt: "finish",
    cancellationWindow: {
      closeCancellation: () => {
        cancellationClosed = true;
      },
    },
    frames: {
      onRuntimeEvent: (event) => {
        if (event.type === "turnCompleted") {
          closedAtCompletion = cancellationClosed;
        }
      },
      log: () => {},
    },
  });
  assert.deepStrictEqual(result.stopReason, "stop");
  assert.deepStrictEqual(closedAtCompletion, true);
});

// ─── failures ────────────────────────────────────────────────────────────────

Deno.test("surfaces the error and emits turnFailed when the provider request fails", async () => {
  const run = engineServices([{
    respond: () => Promise.reject(new Error("local model unavailable")),
  }]);
  const frames: WorkbenchRuntimeEvent[] = [];
  // An unexpected provider error propagates to the caller instead of being
  // swallowed into a benign empty receipt; turnFailed is still emitted first.
  // The transport's exception is foreign under the provenance policy, so
  // no surface carries its message: the adapter wraps it as the unclassified
  // provider failure, whose Workbench-written message names the provider and
  // renders the cause as class + byte count only.
  const thrown = await quietly(() =>
    captureRejection(
      () =>
        runTurn(run, {
          prompt: "summarize",
          frames: {
            onRuntimeEvent: (event) => void frames.push(event),
            log: () => {},
          },
        }),
      ProviderRequestFailedError,
    )
  );
  assert.ok(
    thrown.value.message.includes("[Error, 23 bytes]"),
    `expected thrown.value.message to include "[Error, 23 bytes]"`,
  );
  assert.deepStrictEqual(thrown.value.message.includes("unavailable"), false);
  const failed = frames.at(-1)!;
  assert.partialDeepStrictEqual(failed, {
    type: "turnFailed",
    errorName: "ProviderRequestFailedError",
    errorMessage: thrown.value.message,
  });
  assert.ok(
    String((failed as { errorMessage: string }).errorMessage).includes(
      `${LOCAL_MODEL.provider}/${LOCAL_MODEL.slug}`,
    ),
    `expected String((failed as { errorMessage: string }).errorMessage) to include \`\${LOCAL_MODEL.provider}/\${LOCAL_MODEL.slug}\``,
  );
  assert.deepStrictEqual(frames[0].type, "sessionStart");
  assert.partialDeepStrictEqual(failed, {
    sessionId: frames[0].sessionId,
    traceId: (frames[0] as { traceId: string }).traceId,
  });
});

// ─── event-write integrity policy ────────────────────────────────────────────

Deno.test("best-effort event write failure is swallowed (turn still completes)", async () => {
  const run = engineServices([chatReply({ content: "runtime response" })]);
  failingWrites(run, "model_selected");
  const { value: result } = await quietly(() =>
    runTurn(run, { prompt: "policy probe" })
  );
  assert.deepStrictEqual(result.text, "runtime response");
});

Deno.test("integrity event inside the runtime try (model_response) also fails the turn — not masked by the final receipt", async () => {
  const run = engineServices([chatReply({ content: "runtime response" })]);
  failingWrites(run, "model_response");
  await quietly(() =>
    assert.rejects(
      () => runTurn(run, { prompt: "policy probe" }),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("simulated write failure: model_response"),
    )
  );
});

Deno.test("provider_call write failure preserves aggregate accounting and the replay response", async () => {
  const run = engineServices([chatReply({ content: "runtime response" })]);
  failingWrites(run, "provider_call");
  const { value: result } = await quietly(() =>
    runTurn(run, { prompt: "policy probe" })
  );
  assert.partialDeepStrictEqual(result.tokens, {
    input: 42,
    output: 7,
    totalCalls: 1,
  });
  const rows = await eventRows(run, result.sessionId);
  assert.partialDeepStrictEqual(
    rows.find((row) => row.event_type === "model_response")!,
    {
      content: "runtime response",
      tokens_input: "42",
      tokens_output: "7",
    },
  );
  assert.deepStrictEqual(
    rows.some((row) => row.event_type === "provider_call"),
    false,
  );
  assert.ok(
    result.receipt.includes("audit log has gaps"),
    `expected result.receipt to include "audit log has gaps"`,
  );
});

Deno.test("a clean session's receipt carries no audit-gap warning", async () => {
  const run = engineServices([chatReply({ content: "hi" })]);
  const result = await runTurn(run, {
    prompt: "hello",
    frames: { log: () => {} },
  });
  assert.deepStrictEqual(result.receipt.includes("audit log has gaps"), false);
});

// A failed model_response INTEGRITY write still fails the turn, but its
// error's message can embed the whole rejected value (a Dolt "value too large
// for column" rejection quotes the offending content back), and that message
// must not fan out raw via the turnFailed frame (relayed verbatim to every
// connected client), the durable `error` event's `content`, or the injected
// presenter's `log` call.
Deno.test("a failed model_response integrity write sanitizes its message before it reaches turnFailed, the durable error event, and the presenter", async () => {
  const hugePayload = "SELECT ".repeat(20_000); // well over 100KB
  const run = engineServices([chatReply({ content: "runtime response" })]);
  failingWrites(
    run,
    "model_response",
    `insert failed: value '${hugePayload}' is too large for column 'content'`,
  );
  const frames: WorkbenchRuntimeEvent[] = [];
  const logged: string[] = [];
  await quietly(() =>
    assert.rejects(() =>
      runTurn(run, {
        prompt: "policy probe",
        frames: {
          onRuntimeEvent: (event) => void frames.push(event),
          log: (...parts: unknown[]) =>
            void logged.push(parts.map(String).join(" ")),
        },
      })
    )
  );
  const failed = frames.find((frame) => frame.type === "turnFailed");
  assert.ok(failed?.type === "turnFailed");
  const wireMessage = String(failed.errorMessage);
  assert.deepStrictEqual(wireMessage.includes(hugePayload), false);
  assert.ok(wireMessage.length < 1000);
  const error = (await eventRows(run, failed.sessionId)).find((row) =>
    row.event_type === "error"
  );
  assert.ok(error !== undefined);
  assert.deepStrictEqual(String(error.content).includes(hugePayload), false);
  assert.deepStrictEqual(logged.join("\n").includes(hugePayload), false);
});
