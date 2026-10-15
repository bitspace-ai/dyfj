// Every adapter turns a provider's known failures into the typed
// ProviderFailureError subclasses whose messages Workbench writes, and
// leaves an unrecognised failure as the unclassified provider error that
// names the provider and the status, never the body.

import { captureRejection } from "../../testing/assertions/captured.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MapEnv } from "../../testing/fakes/map-env.ts";
import { ScriptedHttpTransport } from "../../testing/fakes/scripted-http-transport.ts";
import * as F from "../../testing/providers/failure-fixtures.ts";
import { DomainError } from "../contract/mod.ts";
import { MAX_ERROR_BODY_BYTES } from "./shared/error-body.ts";
import {
  ProviderAuthenticationError,
  ProviderContextExceededError,
  ProviderFailureError,
  ProviderModelNotFoundError,
  ProviderRateLimitedError,
  ProviderRedirectedError,
  ProviderRequestFailedError,
  ProviderRequestTooLargeError,
  ProviderUnreachableError,
  runWorkbenchTurn,
  type WorkbenchModel,
} from "./mod.ts";

const local: WorkbenchModel = {
  slug: "qwen3.6-35b-a3b",
  displayName: "Local test",
  provider: "llama-cpp",
  api: "openai-completions",
  baseUrl: "http://localhost:8080/v1",
  tier: 0,
  costInput: 0,
  costOutput: 0,
  capabilities: ["text"],
  contextWindow: 32_768,
};
const anthropic: WorkbenchModel = {
  slug: "anthropic-test",
  displayName: "Anthropic test",
  provider: "anthropic",
  api: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
  tier: 2,
  costInput: 3,
  costOutput: 15,
  capabilities: ["text"],
};
const gemini: WorkbenchModel = {
  slug: "gemini-test",
  displayName: "Gemini test",
  provider: "google",
  api: "google-generative-ai",
  baseUrl: "https://generativelanguage.googleapis.com",
  tier: 2,
  costInput: 2,
  costOutput: 12,
  capabilities: ["text"],
};
const models = [local, anthropic, gemini];
const byFamily: Record<F.FailureFixture["family"], WorkbenchModel> = {
  "openai-compatible": local,
  anthropic,
  gemini,
};
const env = new MapEnv({
  ANTHROPIC_API_KEY: "test-key-not-real",
  GEMINI_API_KEY: "test-key-not-real",
});
const getEnv = (name: string) => env.get(name);

function turn(model: WorkbenchModel, transport: ScriptedHttpTransport) {
  return runWorkbenchTurn({
    systemPrompt: "system",
    prompt: "hello",
    routing: { modelId: model.slug },
    models,
    getEnv,
    fetchFn: transport.fetch,
  });
}

async function replay(
  fixture: F.FailureFixture,
): Promise<ProviderFailureError> {
  const model = byFamily[fixture.family];
  const transport = new ScriptedHttpTransport([{
    respond: { status: fixture.status, body: fixture.body },
  }]);
  const error = await captureRejection(
    () => turn(model, transport),
    ProviderFailureError,
  );
  transport.assertDone();
  // The Workbench-written message names the provider, the model and the
  // status, and carries none of the provider's text.
  assert.ok(
    error.message.includes(model.provider),
    `expected error.message to include model.provider`,
  );
  assert.ok(
    error.message.includes(model.slug),
    `expected error.message to include model.slug`,
  );
  assert.ok(
    error.message.includes(`HTTP ${fixture.status}`),
    `expected error.message to include \`HTTP \${fixture.status}\``,
  );
  assert.strictEqual(error.message.includes(fixture.foreignText), false);
  assert.strictEqual(error.provider, model.provider);
  assert.strictEqual(error.slug, model.slug);
  assert.strictEqual(error.status, fixture.status);
  assert.ok(error instanceof DomainError);
  return error;
}

/** The promise's value, or "hung" when it has not settled within `ms`. */
async function settlesWithin<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | "hung"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"hung">((resolve) => {
    timer = setTimeout(() => resolve("hung"), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

describe("provider failure classification at the adapter", () => {
  const classified: ReadonlyArray<
    // deno-lint-ignore no-explicit-any
    [F.FailureFixture, new (...args: any[]) => ProviderFailureError]
  > = [
    [F.LLAMA_SERVER_CONTEXT_EXCEEDED, ProviderContextExceededError],
    [F.ANTHROPIC_CONTEXT_EXCEEDED, ProviderContextExceededError],
    [F.GEMINI_CONTEXT_EXCEEDED, ProviderContextExceededError],
    [F.LLAMA_SERVER_AUTH, ProviderAuthenticationError],
    [F.OPENAI_AUTH, ProviderAuthenticationError],
    [F.OPENROUTER_AUTH, ProviderAuthenticationError],
    [F.ANTHROPIC_AUTH, ProviderAuthenticationError],
    [F.ANTHROPIC_PERMISSION, ProviderAuthenticationError],
    [F.GEMINI_AUTH, ProviderAuthenticationError],
    [F.OPENAI_RATE_LIMIT, ProviderRateLimitedError],
    [F.OPENAI_QUOTA, ProviderRateLimitedError],
    [F.OPENROUTER_RATE_LIMIT, ProviderRateLimitedError],
    [F.ANTHROPIC_RATE_LIMIT, ProviderRateLimitedError],
    [F.ANTHROPIC_OVERLOADED, ProviderRateLimitedError],
    [F.GEMINI_QUOTA, ProviderRateLimitedError],
    [F.GEMINI_OVERLOADED, ProviderRateLimitedError],
    [F.OPENAI_MODEL_NOT_FOUND, ProviderModelNotFoundError],
    [F.OPENROUTER_INVALID_MODEL, ProviderModelNotFoundError],
    [F.OPENROUTER_NO_ENDPOINTS, ProviderModelNotFoundError],
    [F.ANTHROPIC_MODEL_NOT_FOUND, ProviderModelNotFoundError],
    [F.GEMINI_MODEL_NOT_FOUND, ProviderModelNotFoundError],
    [F.PROXY_REQUEST_TOO_LARGE, ProviderRequestTooLargeError],
    [F.ANTHROPIC_REQUEST_TOO_LARGE, ProviderRequestTooLargeError],
    [F.GEMINI_REQUEST_TOO_LARGE, ProviderRequestTooLargeError],
  ];
  for (const [fixture, cls] of classified) {
    it(`${fixture.family}: ${fixture.source} HTTP ${fixture.status} is ${cls.name}`, async () => {
      const error = await replay(fixture);
      assert.ok(error instanceof cls);
    });
  }

  it("a context-size rejection still carries the provider's counts for the refit", async () => {
    const error = await replay(F.LLAMA_SERVER_CONTEXT_EXCEEDED);
    assert.ok(error instanceof ProviderContextExceededError);
    assert.deepStrictEqual(error.report, {
      requestedTokens: 82366,
      limitTokens: 32768,
    });
    assert.ok(
      error.message.includes("82366"),
      `expected error.message to include "82366"`,
    );
    assert.ok(
      error.message.includes("32768"),
      `expected error.message to include "32768"`,
    );
  });

  it("OpenAI's 404, which may mean no access rather than no such model, keeps both in the hint", async () => {
    const error = await replay(F.OPENAI_MODEL_NOT_FOUND);
    assert.ok(error instanceof ProviderModelNotFoundError);
    assert.ok(
      error.message.includes("no access"),
      `expected error.message to include "no access"`,
    );
    assert.ok(
      error.message.includes("account's access"),
      `expected error.message to include "account's access"`,
    );
  });

  const unclassified = [
    F.OPENAI_SERVER_ERROR,
    F.ANTHROPIC_SERVER_ERROR,
    F.GEMINI_SERVER_ERROR,
  ];
  for (const fixture of unclassified) {
    it(`${fixture.family}: an unrecognised HTTP ${fixture.status} names the provider and status, withholds the body`, async () => {
      const error = await replay(fixture);
      assert.ok(error instanceof ProviderRequestFailedError);
      assert.strictEqual(error.kind, "unclassified");
      // The body's size is reported, as the opaque label always has; the
      // body itself is not.
      assert.ok(
        error.message.includes(
          `${new TextEncoder().encode(fixture.body).byteLength} bytes`,
        ),
        `expected error.message to include \`\${new TextEncoder().encode(fixture.body).byteLength} bytes\``,
      );
    });
  }

  for (const model of models) {
    it(`${model.provider}: an oversized unrecognised body is read only to the cap and reported as cut`, async () => {
      const transport = new ScriptedHttpTransport([{
        respond: {
          status: 500,
          body: F.oversizedErrorBody(MAX_ERROR_BODY_BYTES * 4),
        },
      }]);
      const error = await captureRejection(
        () => turn(model, transport),
        ProviderRequestFailedError,
      );
      assert.ok(
        error.message.includes(`at least ${MAX_ERROR_BODY_BYTES} bytes`),
        `expected error.message to include \`at least \${MAX_ERROR_BODY_BYTES} bytes\``,
      );
    });
  }

  it("an error body of exactly the cap that never closes still fails the turn, as cut", async () => {
    const transport = new ScriptedHttpTransport([{
      respond: {
        status: 500,
        body: F.oversizedErrorBody(MAX_ERROR_BODY_BYTES),
        holdOpen: true,
      },
    }]);
    const outcome = await settlesWithin(
      turn(local, transport).then(() => "resolved", (error) => error),
      500,
    );
    assert.ok(outcome instanceof ProviderRequestFailedError);
    assert.ok(
      outcome.message.includes(`at least ${MAX_ERROR_BODY_BYTES} bytes`),
      `expected outcome.message to include \`at least \${MAX_ERROR_BODY_BYTES} bytes\``,
    );
  });

  it("a per-minute quota says the quota resets, not only to add credit", async () => {
    const error = await replay(F.GEMINI_QUOTA_PER_MINUTE);
    assert.ok(error instanceof ProviderRateLimitedError);
    assert.ok(
      error.message.includes("reset"),
      `expected error.message to include "reset"`,
    );
  });

  it("an unrecognised failure with an empty body still names the provider and status", async () => {
    const transport = new ScriptedHttpTransport([{
      respond: { status: 502 },
    }]);
    const error = await captureRejection(
      () => turn(local, transport),
      ProviderRequestFailedError,
    );
    assert.ok(
      error.message.includes("llama-cpp/qwen3.6-35b-a3b"),
      `expected error.message to include "llama-cpp/qwen3.6-35b-a3b"`,
    );
    assert.ok(
      error.message.includes("HTTP 502"),
      `expected error.message to include "HTTP 502"`,
    );
  });
});

describe("transport failure classification at the adapter", () => {
  for (const model of models) {
    it(`${model.provider}: a refused connection is ProviderUnreachableError`, async () => {
      const transport = new ScriptedHttpTransport([{
        respond: () => Promise.reject(F.CONNECTION_REFUSED()),
      }]);
      const error = await captureRejection(
        () => turn(model, transport),
        ProviderUnreachableError,
      );
      assert.strictEqual(error.reason, "refused");
      assert.ok(
        error.message.includes(model.provider),
        `expected error.message to include model.provider`,
      );
      assert.ok(
        error.message.includes(model.slug),
        `expected error.message to include model.slug`,
      );
      assert.strictEqual(error.message.includes("os error 61"), false);
    });
  }

  it("a host that does not resolve is ProviderUnreachableError", async () => {
    const transport = new ScriptedHttpTransport([{
      respond: () => Promise.reject(F.DNS_FAILURE()),
    }]);
    const error = await captureRejection(
      () => turn(anthropic, transport),
      ProviderUnreachableError,
    );
    assert.strictEqual(error.reason, "dns");
    assert.strictEqual(error.message.includes("nodename"), false);
  });

  it("a redirect the request refused to follow is ProviderRedirectedError", async () => {
    // The scripted transport raises what the platform raises for a redirect
    // status under redirect: "error"; the adapter never follows it.
    const transport = new ScriptedHttpTransport([{
      respond: { status: 307, headers: { location: "https://elsewhere/" } },
    }]);
    const error = await captureRejection(
      () => turn(local, transport),
      ProviderRedirectedError,
    );
    assert.ok(
      error.message.includes("redirect"),
      `expected error.message to include "redirect"`,
    );
    assert.ok(
      error.message.includes("llama-cpp/qwen3.6-35b-a3b"),
      `expected error.message to include "llama-cpp/qwen3.6-35b-a3b"`,
    );
    assert.ok(
      error.message.includes("base URL"),
      `expected error.message to include "base URL"`,
    );
    assert.strictEqual(error.kind, "redirected");
  });

  it("an unrecognised transport throw becomes the unclassified provider error with the opaque label", async () => {
    const transport = new ScriptedHttpTransport([{
      respond: () => Promise.reject(new Error("local model unavailable")),
    }]);
    const error = await captureRejection(
      () => turn(local, transport),
      ProviderRequestFailedError,
    );
    assert.strictEqual(error.status, undefined);
    assert.ok(
      error.message.includes("llama-cpp/qwen3.6-35b-a3b"),
      `expected error.message to include "llama-cpp/qwen3.6-35b-a3b"`,
    );
    assert.ok(
      error.message.includes("[Error, 23 bytes]"),
      `expected error.message to include "[Error, 23 bytes]"`,
    );
    assert.strictEqual(error.message.includes("unavailable"), false);
  });

  it("a DomainError thrown by the transport passes through unchanged", async () => {
    class Boundary extends DomainError {}
    const thrown = new Boundary("already bounded");
    const transport = new ScriptedHttpTransport([{
      respond: () => Promise.reject(thrown),
    }]);
    const error = await captureRejection(() => turn(local, transport));
    assert.strictEqual(error, thrown);
  });

  it("the caller's own abort is still the aborted result, not a failure", async () => {
    const controller = new AbortController();
    const transport = new ScriptedHttpTransport([{
      respond: () => {
        controller.abort();
        return Promise.reject(controller.signal.reason);
      },
    }]);
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: local.slug },
      models,
      getEnv,
      fetchFn: transport.fetch,
      abortSignal: controller.signal,
    });
    assert.strictEqual(result.stopReason, "aborted");
  });
});
