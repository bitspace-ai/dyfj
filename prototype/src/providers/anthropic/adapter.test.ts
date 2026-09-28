// runWorkbenchTurn against the Anthropic adapter: cancellation, usage, and
// fail-closed cases beyond the conformance kit.

import { describe, it } from "@std/testing/bdd";
import {
  assertEquals,
  assertMatch,
  assertObjectMatch,
  assertRejects,
} from "@std/assert";
import { MapEnv } from "../../../testing/fakes/map-env.ts";
import { ScriptedHttpTransport } from "../../../testing/fakes/scripted-http-transport.ts";
import {
  getModelAccessModality,
  HostedProviderCredentialMissingError,
  runWorkbenchTurn,
  WorkbenchHostedProviderBaseUrlError,
  type WorkbenchModel,
} from "../mod.ts";
import { anthropicAdapter } from "./adapter.ts";

const anthropicModel: WorkbenchModel = {
  slug: "claude-haiku-4-5",
  displayName: "Claude Haiku 4.5",
  provider: "anthropic",
  api: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
  tier: 1,
  costInput: 1,
  costOutput: 5,
  capabilities: ["text", "code"],
};
// The old suite's shared catalog: two local models plus the Anthropic one.
const models: WorkbenchModel[] = [
  {
    slug: "laguna-xs-2.1",
    displayName: "Laguna XS 2.1",
    provider: "ollama",
    api: "openai-completions",
    baseUrl: "http://localhost:11434/v1",
    tier: 0,
    costInput: 0,
    costOutput: 0,
    capabilities: ["text", "code", "reasoning"],
  },
  {
    slug: "gemma4:e2b",
    displayName: "Gemma 4 E2B",
    provider: "ollama",
    api: "openai-completions",
    baseUrl: "http://localhost:11434/v1",
    tier: 0,
    costInput: 0,
    costOutput: 0,
    capabilities: ["text", "reasoning"],
  },
  anthropicModel,
];
const env = new MapEnv({ ANTHROPIC_API_KEY: "test-key-not-real" });
const getEnv = (name: string) => env.get(name);

describe("anthropic provider adapter", () => {
  it("Anthropic clean EOF honors a concurrent abort signal", async () => {
    const abortController = new AbortController();
    // The responder aborts the turn while the request is in flight, which the
    // scripted vocabulary cannot express.
    const transport = new ScriptedHttpTransport([{
      respond: () => {
        abortController.abort();
        return new Response([
          'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}',
          'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}',
          'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
          "",
        ].join("\n"));
      },
    }]);
    const result = await runWorkbenchTurn({
      systemPrompt: "sys",
      prompt: "hi",
      routing: { modelId: anthropicModel.slug },
      models,
      abortSignal: abortController.signal,
      onTextDelta: () => {},
      getEnv,
      fetchFn: transport.fetch,
    });

    assertObjectMatch(result, {
      text: "partial",
      stopReason: "aborted",
      usage: { input: 10, output: 2 },
    });
    transport.assertDone();
  });

  it("Anthropic clean EOF preserves a concurrent trailing-frame error", async () => {
    const abortController = new AbortController();
    // The responder aborts the turn while the request is in flight.
    const transport = new ScriptedHttpTransport([{
      respond: () => {
        abortController.abort();
        return new Response('data: {"type":"content_block_delta"');
      },
    }]);
    await assertRejects(
      () =>
        runWorkbenchTurn({
          systemPrompt: "sys",
          prompt: "hi",
          routing: { modelId: anthropicModel.slug },
          models,
          abortSignal: abortController.signal,
          onTextDelta: () => {},
          getEnv,
          fetchFn: transport.fetch,
        }),
      SyntaxError,
    );
    transport.assertDone();
  });

  it("Anthropic error envelopes outrank a concurrent cancellation", async () => {
    const abortController = new AbortController();
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: 'data: {"type":"error","error":{"type":"overloaded_error"}}\n',
        holdOpen: true,
      },
    }]);
    const pending = runWorkbenchTurn({
      systemPrompt: "sys",
      prompt: "hi",
      routing: { modelId: anthropicModel.slug },
      models,
      abortSignal: abortController.signal,
      onTextDelta: () => {},
      getEnv,
      fetchFn: transport.fetch,
    });
    const rejection = assertRejects(
      () => pending,
      Error,
      "Anthropic stream returned an error envelope",
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    abortController.abort();

    await rejection;
    transport.assertDone();
  });

  it("Anthropic keeps the highest streamed usage totals", async () => {
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: [
          'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}',
          'data: {"type":"message_delta","usage":{"output_tokens":100}}',
          'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
          'data: {"type":"message_stop"}',
          "",
        ].join("\n"),
      },
    }]);
    const result = await runWorkbenchTurn({
      systemPrompt: "sys",
      prompt: "hi",
      routing: { modelId: anthropicModel.slug },
      models,
      onTextDelta: () => {},
      getEnv,
      fetchFn: transport.fetch,
    });

    assertObjectMatch(result.usage, { input: 10, output: 100 });
    transport.assertDone();
  });

  it("fails closed when the credential is not projected", async () => {
    // The old test passed no fetchFn; an empty script also proves no request
    // is attempted.
    const transport = new ScriptedHttpTransport();
    const emptyEnv = new MapEnv();
    await assertRejects(
      () =>
        runWorkbenchTurn({
          systemPrompt: "sys",
          prompt: "hi",
          routing: { modelId: anthropicModel.slug },
          models,
          getEnv: (name) => emptyEnv.get(name),
          fetchFn: transport.fetch,
        }),
      HostedProviderCredentialMissingError,
    );
    assertEquals(transport.requests.length, 0);
  });
});

describe("tool wire names", () => {
  it("error surfaces the provider response body", async () => {
    const transport = new ScriptedHttpTransport([{
      respond: {
        status: 400,
        body: JSON.stringify({
          error: { message: "tools.0.name: should match pattern" },
        }),
      },
    }]);
    const error = await assertRejects(() =>
      runWorkbenchTurn({
        systemPrompt: "sys",
        prompt: "hi",
        routing: { modelId: anthropicModel.slug },
        models,
        fetchFn: transport.fetch,
        getEnv,
      })
    );
    assertMatch((error as Error).message, /HTTP 400.*should match pattern/);
    transport.assertDone();
  });
});

describe("Anthropic base-URL contract", () => {
  const withBaseUrl = (baseUrl: string): WorkbenchModel => ({
    ...anthropicModel,
    baseUrl,
  });
  const accepted = [
    "https://api.anthropic.com",
    "https://api.anthropic.com/",
    "https://api.anthropic.com:443",
    "https://api.anthropic.com//",
  ];
  const rejected = [
    "https://example.com",
    "https://api.anthropic.com.example.com",
    "https://anthropic.com",
    "https://api.anthropic.com:8443",
    "https://api.anthropic.com/v1",
    "https://api.anthropic.com/proxy",
    "https://api.anthropic.com/?x=1",
    "http://api.anthropic.com",
  ];

  it("accepts only the canonical https host and base path", () => {
    for (const url of accepted) {
      assertEquals(anthropicAdapter.validateBaseUrl(withBaseUrl(url)).ok, true);
    }
    for (const url of rejected) {
      assertEquals(
        anthropicAdapter.validateBaseUrl(withBaseUrl(url)).ok,
        false,
        url,
      );
    }
  });

  it("accepts exactly the base URLs classified as frontier-hosted", () => {
    for (const url of [...accepted, ...rejected]) {
      assertEquals(
        anthropicAdapter.validateBaseUrl(withBaseUrl(url)).ok,
        getModelAccessModality({ provider: "anthropic", baseUrl: url }) ===
          "frontier-hosted",
        url,
      );
    }
  });

  it("rejects an off-host base URL before reading the key or sending", async () => {
    const transport = new ScriptedHttpTransport();
    let keyRead = false;
    await assertRejects(
      () =>
        runWorkbenchTurn({
          systemPrompt: "sys",
          prompt: "hi",
          routing: { modelId: anthropicModel.slug },
          models: [withBaseUrl("https://example.com")],
          fetchFn: transport.fetch,
          getEnv: (name) => {
            keyRead = true;
            return env.get(name);
          },
        }),
      WorkbenchHostedProviderBaseUrlError,
    );
    assertEquals(keyRead, false);
    assertEquals(transport.requests.length, 0);
  });

  it("sends the canonical request unchanged, refusing redirects", async () => {
    const transport = new ScriptedHttpTransport([{
      expect: (request) => {
        assertEquals(request.url, "https://api.anthropic.com/v1/messages");
        assertEquals(request.method, "POST");
        assertEquals(request.redirect, "error");
        assertEquals(request.headers, {
          "content-type": "application/json",
          "x-api-key": "test-key-not-real",
          "anthropic-version": "2023-06-01",
        });
      },
      respond: {
        body: JSON.stringify({
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      },
    }]);
    const result = await runWorkbenchTurn({
      systemPrompt: "sys",
      prompt: "hi",
      routing: { modelId: anthropicModel.slug },
      models: [withBaseUrl("https://api.anthropic.com/")],
      fetchFn: transport.fetch,
      getEnv,
    });
    assertEquals(result.text, "ok");
    transport.assertDone();
  });

  it("builds the canonical request URL from any accepted base URL", async () => {
    for (const baseUrl of accepted) {
      const transport = new ScriptedHttpTransport([{
        // Parsed, as fetch sends it: an explicit :443 is the default port.
        expect: (request) =>
          assertEquals(
            new URL(request.url).href,
            "https://api.anthropic.com/v1/messages",
          ),
        respond: {
          body: JSON.stringify({
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        },
      }]);
      await runWorkbenchTurn({
        systemPrompt: "sys",
        prompt: "hi",
        routing: { modelId: anthropicModel.slug },
        models: [withBaseUrl(baseUrl)],
        fetchFn: transport.fetch,
        getEnv,
      });
      transport.assertDone();
    }
  });
});
