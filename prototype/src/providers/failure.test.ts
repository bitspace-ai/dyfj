// Every adapter turns a provider's known failures into the typed
// ProviderFailureError subclasses whose messages Workbench writes, and
// leaves an unrecognised failure as the unclassified provider error that
// names the provider and the status, never the body.

import {
  assertEquals,
  assertInstanceOf,
  assertRejects,
  assertStrictEquals,
  assertStringIncludes,
} from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { MapEnv } from "../../testing/fakes/map-env.ts";
import { ScriptedHttpTransport } from "../../testing/fakes/scripted-http-transport.ts";
import * as F from "../../testing/providers/failure-fixtures.ts";
import { DomainError } from "../contract/mod.ts";
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
  const error = await assertRejects(
    () => turn(model, transport),
    ProviderFailureError,
  );
  transport.assertDone();
  // The Workbench-written message names the provider, the model and the
  // status, and carries none of the provider's text.
  assertStringIncludes(error.message, model.provider);
  assertStringIncludes(error.message, model.slug);
  assertStringIncludes(error.message, `HTTP ${fixture.status}`);
  assertStrictEquals(error.message.includes(fixture.foreignText), false);
  assertStrictEquals(error.provider, model.provider);
  assertStrictEquals(error.slug, model.slug);
  assertStrictEquals(error.status, fixture.status);
  assertInstanceOf(error, DomainError);
  return error;
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
      assertInstanceOf(error, cls);
    });
  }

  it("a context-size rejection still carries the provider's counts for the refit", async () => {
    const error = await replay(F.LLAMA_SERVER_CONTEXT_EXCEEDED);
    assertInstanceOf(error, ProviderContextExceededError);
    assertEquals(error.report, { requestedTokens: 82366, limitTokens: 32768 });
    assertStringIncludes(error.message, "82366");
    assertStringIncludes(error.message, "32768");
  });

  it("OpenAI's 404, which may mean no access rather than no such model, keeps both in the hint", async () => {
    const error = await replay(F.OPENAI_MODEL_NOT_FOUND);
    assertInstanceOf(error, ProviderModelNotFoundError);
    assertStringIncludes(error.message, "no access");
    assertStringIncludes(error.message, "account's access");
  });

  const unclassified = [
    F.OPENAI_SERVER_ERROR,
    F.ANTHROPIC_SERVER_ERROR,
    F.GEMINI_SERVER_ERROR,
  ];
  for (const fixture of unclassified) {
    it(`${fixture.family}: an unrecognised HTTP ${fixture.status} names the provider and status, withholds the body`, async () => {
      const error = await replay(fixture);
      assertInstanceOf(error, ProviderRequestFailedError);
      assertStrictEquals(error.kind, "unclassified");
      // The body's size is reported, as the opaque label always has; the
      // body itself is not.
      assertStringIncludes(
        error.message,
        `${new TextEncoder().encode(fixture.body).byteLength} bytes`,
      );
    });
  }

  it("an unrecognised failure with an empty body still names the provider and status", async () => {
    const transport = new ScriptedHttpTransport([{
      respond: { status: 502 },
    }]);
    const error = await assertRejects(
      () => turn(local, transport),
      ProviderRequestFailedError,
    );
    assertStringIncludes(error.message, "llama-cpp/qwen3.6-35b-a3b");
    assertStringIncludes(error.message, "HTTP 502");
  });
});

describe("transport failure classification at the adapter", () => {
  for (const model of models) {
    it(`${model.provider}: a refused connection is ProviderUnreachableError`, async () => {
      const transport = new ScriptedHttpTransport([{
        respond: () => Promise.reject(F.CONNECTION_REFUSED()),
      }]);
      const error = await assertRejects(
        () => turn(model, transport),
        ProviderUnreachableError,
      );
      assertStrictEquals(error.reason, "refused");
      assertStringIncludes(error.message, model.provider);
      assertStringIncludes(error.message, model.slug);
      assertStrictEquals(error.message.includes("os error 61"), false);
    });
  }

  it("a host that does not resolve is ProviderUnreachableError", async () => {
    const transport = new ScriptedHttpTransport([{
      respond: () => Promise.reject(F.DNS_FAILURE()),
    }]);
    const error = await assertRejects(
      () => turn(anthropic, transport),
      ProviderUnreachableError,
    );
    assertStrictEquals(error.reason, "dns");
    assertStrictEquals(error.message.includes("nodename"), false);
  });

  it("a redirect the request refused to follow is ProviderRedirectedError", async () => {
    // The scripted transport raises what the platform raises for a redirect
    // status under redirect: "error"; the adapter never follows it.
    const transport = new ScriptedHttpTransport([{
      respond: { status: 307, headers: { location: "https://elsewhere/" } },
    }]);
    const error = await assertRejects(
      () => turn(local, transport),
      ProviderRedirectedError,
    );
    assertStringIncludes(error.message, "redirect");
    assertStringIncludes(error.message, "llama-cpp/qwen3.6-35b-a3b");
    assertStringIncludes(error.message, "base URL");
    assertStrictEquals(error.kind, "redirected");
  });

  it("an unrecognised transport throw becomes the unclassified provider error with the opaque label", async () => {
    const transport = new ScriptedHttpTransport([{
      respond: () => Promise.reject(new Error("local model unavailable")),
    }]);
    const error = await assertRejects(
      () => turn(local, transport),
      ProviderRequestFailedError,
    );
    assertStrictEquals(error.status, undefined);
    assertStringIncludes(error.message, "llama-cpp/qwen3.6-35b-a3b");
    assertStringIncludes(error.message, "[Error, 23 bytes]");
    assertStrictEquals(error.message.includes("unavailable"), false);
  });

  it("a DomainError thrown by the transport passes through unchanged", async () => {
    class Boundary extends DomainError {}
    const thrown = new Boundary("already bounded");
    const transport = new ScriptedHttpTransport([{
      respond: () => Promise.reject(thrown),
    }]);
    const error = await assertRejects(() => turn(local, transport));
    assertStrictEquals(error, thrown);
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
    assertStrictEquals(result.stopReason, "aborted");
  });
});
