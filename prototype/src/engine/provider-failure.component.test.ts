/**
 * Component tests for how a provider's failure reaches the operator: whole
 * native turns over the engine fakes, where the scripted provider answers
 * with a recorded failure. What the operator sees is the `turnFailed`
 * frame's message, which is also the RPC error message the Rust REPL prints
 * after `turn failed:` (the server relays `summarizeError` of the turn's
 * error on both), and the durable `error` event's content. Both must carry
 * the Workbench-written message with its recovery hint, the classified
 * kind, and none of the provider's text.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { stub } from "@std/testing/mock";
import {
  type EngineRun,
  engineServices,
  eventRows,
  GEMINI_FREE_MODEL,
  HOSTED_FREE_MODEL,
  LOCAL_MODEL,
  runTurn,
} from "../../testing/builders/engine.ts";
import type { ScriptedExchange } from "../../testing/fakes/scripted-http-transport.ts";
import * as F from "../../testing/providers/failure-fixtures.ts";
import { summarizeError, type WorkbenchRuntimeEvent } from "../contract/mod.ts";
import type { ModelSeed } from "../store/mod.ts";

interface FailedTurn {
  run: EngineRun;
  frames: WorkbenchRuntimeEvent[];
  error: unknown;
  /** What the REPL prints after `turn failed:` and the TS client after `dyfj:`. */
  operatorLine: string;
  errorRow: { content: string | null; provider_error_class: string | null };
  failed: Extract<WorkbenchRuntimeEvent, { type: "turnFailed" }>;
}

const MODEL_FOR: Record<F.FailureFixture["family"], ModelSeed> = {
  "openai-compatible": LOCAL_MODEL,
  anthropic: HOSTED_FREE_MODEL,
  gemini: GEMINI_FREE_MODEL,
};

async function failingTurn(
  exchange: ScriptedExchange,
  model: ModelSeed,
): Promise<FailedTurn> {
  const run = engineServices([exchange], {
    models: [model],
    env: {
      ANTHROPIC_API_KEY: "test-key-not-real",
      GEMINI_API_KEY: "test-key-not-real",
    },
  });
  const frames: WorkbenchRuntimeEvent[] = [];
  const log = stub(console, "log");
  const error = stub(console, "error");
  let thrown: unknown = null;
  try {
    await runTurn(run, {
      prompt: "a short question",
      defaultCompanionModel: model.slug,
      frames: {
        onRuntimeEvent: (event) => void frames.push(event),
        log: () => {},
      },
    });
  } catch (err) {
    thrown = err;
  } finally {
    log.restore();
    error.restore();
  }
  assert(thrown !== null, "the turn should have failed");
  const failed = frames.at(-1);
  assert(failed?.type === "turnFailed", `last frame was ${failed?.type}`);
  const sessionId = (frames[0] as { sessionId: string }).sessionId;
  const errorRow = (await eventRows(run, sessionId)).find((row) =>
    row.event_type === "error"
  );
  assert(errorRow !== undefined, "no error event was written");
  return {
    run,
    frames,
    error: thrown,
    operatorLine: summarizeError(thrown),
    errorRow: {
      content: errorRow.content,
      provider_error_class: errorRow.provider_error_class,
    },
    failed,
  };
}

function replay(fixture: F.FailureFixture): Promise<FailedTurn> {
  return failingTurn(
    { respond: { status: fixture.status, body: fixture.body } },
    MODEL_FOR[fixture.family],
  );
}

/** The operator line, the frame and the durable row all say the same thing. */
function assertReported(
  turn: FailedTurn,
  expected: { errorName: string; includes: string[]; excludes: string[] },
): void {
  assertEquals(turn.failed.errorName, expected.errorName);
  assertEquals(turn.failed.errorMessage, turn.operatorLine);
  assertEquals(turn.errorRow.content, turn.operatorLine);
  for (const text of expected.includes) {
    assertStringIncludes(turn.operatorLine, text);
  }
  for (const text of expected.excludes) {
    assertEquals(
      turn.operatorLine.includes(text),
      false,
      `operator line relays "${text}": ${turn.operatorLine}`,
    );
  }
}

// ─── the 2026-10-03 case ─────────────────────────────────────────────────────

Deno.test("llama-server's context-size rejection reaches the operator with both sizes, in the line and in the error event", async () => {
  // BIT-565 already turns this rejection into ContextWindowOverflowError
  // after its one refit (nothing to trim on a first turn), whose message
  // names the counts; this pins that both counts reach every surface and
  // that the provider's own words do not.
  const turn = await replay(F.LLAMA_SERVER_CONTEXT_EXCEEDED);
  assertReported(turn, {
    errorName: "ContextWindowOverflowError",
    includes: ["82366", "32768", "/model"],
    excludes: [F.LLAMA_SERVER_CONTEXT_EXCEEDED.foreignText],
  });
  assertEquals(turn.run.transport.requests.length, 1);
});

// ─── one fixture per class ───────────────────────────────────────────────────

Deno.test("an authentication failure names the provider and says which key to check", async () => {
  const turn = await replay(F.ANTHROPIC_AUTH);
  assertReported(turn, {
    errorName: "ProviderAuthenticationError",
    includes: ["Authentication failed", "anthropic", "HTTP 401", "key"],
    excludes: [F.ANTHROPIC_AUTH.foreignText],
  });
  assertEquals(
    turn.errorRow.provider_error_class,
    "ProviderAuthenticationError",
  );
});

Deno.test("a rate limit names the provider and says to wait or switch model", async () => {
  const turn = await replay(F.OPENAI_RATE_LIMIT);
  assertReported(turn, {
    errorName: "ProviderRateLimitedError",
    includes: ["Rate limited", LOCAL_MODEL.provider, "HTTP 429", "/model"],
    excludes: [F.OPENAI_RATE_LIMIT.foreignText],
  });
  assertEquals(turn.errorRow.provider_error_class, "ProviderRateLimitedError");
});

Deno.test("a model the provider does not serve names the model and the registry row", async () => {
  const turn = await replay(F.GEMINI_MODEL_NOT_FOUND);
  assertReported(turn, {
    errorName: "ProviderModelNotFoundError",
    includes: ["Model not found", "google", GEMINI_FREE_MODEL.slug, "HTTP 404"],
    excludes: [F.GEMINI_MODEL_NOT_FOUND.foreignText],
  });
  assertEquals(
    turn.errorRow.provider_error_class,
    "ProviderModelNotFoundError",
  );
});

Deno.test("a refused connection names the provider and says to check the server", async () => {
  const turn = await failingTurn(
    { respond: () => Promise.reject(F.CONNECTION_REFUSED()) },
    LOCAL_MODEL,
  );
  assertReported(turn, {
    errorName: "ProviderUnreachableError",
    includes: ["unreachable", LOCAL_MODEL.provider, "refused", "base URL"],
    excludes: ["os error 61", "error sending request"],
  });
  assertEquals(turn.errorRow.provider_error_class, "ProviderUnreachableError");
});

Deno.test("a request the provider refuses by size names the provider and says to shorten it", async () => {
  const turn = await replay(F.ANTHROPIC_REQUEST_TOO_LARGE);
  assertReported(turn, {
    errorName: "ProviderRequestTooLargeError",
    includes: ["Request too large", "anthropic", "HTTP 413"],
    excludes: [F.ANTHROPIC_REQUEST_TOO_LARGE.foreignText],
  });
  assertEquals(
    turn.errorRow.provider_error_class,
    "ProviderRequestTooLargeError",
  );
});

// ─── unclassified ────────────────────────────────────────────────────────────

Deno.test("an unclassified provider error shows the provider and status, and none of the body", async () => {
  const turn = await replay(F.OPENAI_SERVER_ERROR);
  assertReported(turn, {
    errorName: "ProviderRequestFailedError",
    includes: [LOCAL_MODEL.provider, LOCAL_MODEL.slug, "HTTP 500", "bytes"],
    excludes: [F.OPENAI_SERVER_ERROR.foreignText, "server_error"],
  });
  assertEquals(
    turn.errorRow.provider_error_class,
    "ProviderRequestFailedError",
  );
});

Deno.test("a provider failure is a reported condition, not an unexpected error, on the server console", async () => {
  // The unexpected-error branch prints a class-only [turn-error] line to
  // the server console; a classified provider failure is expected and
  // already fully stated on the operator line.
  const error = stub(console, "error");
  try {
    const run = engineServices([{
      respond: { status: F.ANTHROPIC_AUTH.status, body: F.ANTHROPIC_AUTH.body },
    }], {
      models: [HOSTED_FREE_MODEL],
      env: { ANTHROPIC_API_KEY: "test-key-not-real" },
    });
    await runTurn(run, {
      prompt: "a short question",
      defaultCompanionModel: HOSTED_FREE_MODEL.slug,
      frames: { log: () => {} },
    }).catch(() => {});
  } finally {
    error.restore();
  }
  assertEquals(error.calls.map((c) => String(c.args[0])), []);
});
