// Hosted OpenAI-compatible turns (OpenAI, OpenRouter, xAI): credentials,
// pinned hosts and ports, and request shaping through runWorkbenchTurn.

import {
  assertAlmostEquals,
  assertEquals,
  assertInstanceOf,
  assertNotMatch,
  assertObjectMatch,
  assertRejects,
  assertStrictEquals,
  assertStringIncludes,
} from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { MapEnv } from "../../../testing/fakes/map-env.ts";
import { ScriptedHttpTransport } from "../../../testing/fakes/scripted-http-transport.ts";
import {
  HostedProviderCredentialMissingError,
  runWorkbenchTurn,
  WorkbenchHostedProviderBaseUrlError,
  type WorkbenchModel,
} from "../mod.ts";

describe("runWorkbenchTurn hosted OpenAI", () => {
  const gptModel: WorkbenchModel = {
    slug: "gpt-test",
    displayName: "GPT test",
    provider: "openai",
    api: "openai-completions",
    baseUrl: "https://api.openai.com/v1",
    tier: 2,
    costInput: 5,
    costOutput: 30,
    capabilities: ["text", "code", "reasoning"],
  };

  it("fails closed when OPENAI_API_KEY is absent", async () => {
    const env = new MapEnv();
    const transport = new ScriptedHttpTransport();
    await assertRejects(
      () =>
        runWorkbenchTurn({
          systemPrompt: "system",
          prompt: "hello",
          routing: { modelId: "gpt-test" },
          models: [gptModel],
          getEnv: (name) => env.get(name),
          fetchFn: transport.fetch,
        }),
      HostedProviderCredentialMissingError,
    );
    assertStrictEquals(transport.requests.length, 0);
  });

  it("an abort during credential lookup records zero pre-dispatch usage", async () => {
    const abortController = new AbortController();
    const transport = new ScriptedHttpTransport();

    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gpt-test" },
      models: [gptModel],
      abortSignal: abortController.signal,
      // Hand-written: the lookup itself aborts the turn.
      getEnv: () => {
        abortController.abort();
        return "present";
      },
      fetchFn: transport.fetch,
    });

    assertStrictEquals(transport.requests.length, 0);
    assertObjectMatch(result, {
      stopReason: "aborted",
      usage: {
        input: 0,
        output: 0,
        cost: { total: 0 },
      },
    });
  });

  it("rejects a non-https hosted base URL before inference", async () => {
    const env = new MapEnv({ OPENAI_API_KEY: "sk-test-key" });
    const transport = new ScriptedHttpTransport();
    await assertRejects(
      () =>
        runWorkbenchTurn({
          systemPrompt: "system",
          prompt: "hello",
          routing: { modelId: "gpt-poisoned" },
          models: [{
            ...gptModel,
            slug: "gpt-poisoned",
            baseUrl: "http://api.openai.com/v1",
          }],
          getEnv: (name) => env.get(name),
          fetchFn: transport.fetch,
        }),
      WorkbenchHostedProviderBaseUrlError,
    );
    assertStrictEquals(transport.requests.length, 0);
  });

  it("an openai row never sends its key to another provider's https host", async () => {
    // The credential contract pins the host, not just the scheme: catalog
    // data must not be able to redirect OPENAI_API_KEY to a different
    // (still-https) endpoint.
    const env = new MapEnv({ OPENAI_API_KEY: "sk-test-key" });
    const transport = new ScriptedHttpTransport();
    await assertRejects(
      () =>
        runWorkbenchTurn({
          systemPrompt: "system",
          prompt: "hello",
          routing: { modelId: "gpt-cross-host" },
          models: [{
            ...gptModel,
            slug: "gpt-cross-host",
            baseUrl: "https://openrouter.ai/api/v1",
          }],
          getEnv: (name) => env.get(name),
          fetchFn: transport.fetch,
        }),
      WorkbenchHostedProviderBaseUrlError,
    );
    assertStrictEquals(transport.requests.length, 0);
  });

  it("an openai row never reads another provider's key", async () => {
    // The per-provider map must not widen what satisfies the openai path:
    // an OpenRouter key alone leaves an openai row fail-closed.
    const env = new MapEnv({ OPENROUTER_API_KEY: "sk-or-key" });
    const transport = new ScriptedHttpTransport();
    await assertRejects(
      () =>
        runWorkbenchTurn({
          systemPrompt: "system",
          prompt: "hello",
          routing: { modelId: "gpt-test" },
          models: [gptModel],
          getEnv: (name) => env.get(name),
          fetchFn: transport.fetch,
        }),
      HostedProviderCredentialMissingError,
    );
    assertStrictEquals(transport.requests.length, 0);
  });
});

describe("runWorkbenchTurn hosted OpenRouter", () => {
  const openRouterModel: WorkbenchModel = {
    slug: "z-ai/glm-5.2",
    displayName: "GLM 5.2",
    provider: "openrouter",
    api: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1",
    tier: 1,
    costInput: 0.2688,
    costOutput: 0.8448,
    capabilities: ["text", "code", "reasoning"],
  };

  it("calls OpenRouter with its own bearer key and meters cost from the row", async () => {
    const env = new MapEnv({ OPENROUTER_API_KEY: "sk-or-key" });
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: JSON.stringify({
          choices: [{
            message: { content: "hello from openrouter" },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 },
        }),
      },
    }]);

    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "z-ai/glm-5.2" },
      models: [openRouterModel],
      getEnv: (name) => env.get(name),
      fetchFn: transport.fetch,
    });

    transport.assertDone();
    const request = transport.requests[0];
    const requestBody = JSON.parse(request.body);
    assertStrictEquals(
      request.url,
      "https://openrouter.ai/api/v1/chat/completions",
    );
    assertStrictEquals(request.headers["authorization"], "Bearer sk-or-key");
    assertStrictEquals(requestBody.max_completion_tokens, 8192);
    assertStrictEquals(result.model.provider, "openrouter");
    assertStrictEquals(result.text, "hello from openrouter");
    // 1M input * $0.2688 + 1M output * $0.8448, per-MTok rates.
    assertAlmostEquals(result.usage.cost.total, 1.1136, 5e-6);
  });

  it("calls xAI with its own bearer key, x-grok-conv-id header, and meters cost from the row", async () => {
    const grokModel: WorkbenchModel = {
      slug: "grok-4.6",
      displayName: "Grok 4.6",
      provider: "xai",
      api: "openai-completions",
      baseUrl: "https://api.x.ai/v1",
      tier: 2,
      costInput: 2.0,
      costOutput: 6.0,
      capabilities: [
        "text",
        "code",
        "reasoning",
        "vision",
        "tools",
        "thinking",
        "long-context",
      ],
      contextWindow: 500000,
      maxOutputTokens: 65536,
      reasoningEffortControl: true,
    };

    const env = new MapEnv({ XAI_API_KEY: "sk-xai-test-key" });
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: JSON.stringify({
          choices: [{
            message: { content: "hello from grok 4.6" },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 500_000, completion_tokens: 100_000 },
        }),
      },
    }]);

    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      sessionId: "session-12345",
      routing: { modelId: "grok-4.6" },
      models: [grokModel],
      getEnv: (name) => env.get(name),
      fetchFn: transport.fetch,
    });

    transport.assertDone();
    const request = transport.requests[0];
    const requestBody = JSON.parse(request.body);
    assertStrictEquals(request.url, "https://api.x.ai/v1/chat/completions");
    assertStrictEquals(
      request.headers["authorization"],
      "Bearer sk-xai-test-key",
    );
    assertStrictEquals(request.headers["x-grok-conv-id"], "session-12345");
    assertStrictEquals(requestBody.max_completion_tokens, 8192);
    assertStrictEquals(result.model.provider, "xai");
    assertStrictEquals(result.text, "hello from grok 4.6");
    // 0.5M input * $2.0 + 0.1M output * $6.0 = $1.0 + $0.6 = $1.6
    assertAlmostEquals(result.usage.cost.total, 1.6, 5e-6);
  });

  it("honors custom maxOutputTokens requested by caller up to catalog limit for hosted providers", async () => {
    const grokModel: WorkbenchModel = {
      slug: "grok-4.6",
      displayName: "Grok 4.6",
      provider: "xai",
      api: "openai-completions",
      baseUrl: "https://api.x.ai/v1",
      tier: 2,
      costInput: 2.0,
      costOutput: 6.0,
      capabilities: ["text", "code", "reasoning"],
      contextWindow: 500000,
      maxOutputTokens: 65536,
    };

    const env = new MapEnv({ XAI_API_KEY: "sk-xai-test-key" });
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: JSON.stringify({
          choices: [{
            message: { content: "ok" },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 10, completion_tokens: 10 },
        }),
      },
    }]);

    await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      maxOutputTokens: 32768,
      routing: { modelId: "grok-4.6" },
      models: [grokModel],
      getEnv: (name) => env.get(name),
      fetchFn: transport.fetch,
    });

    transport.assertDone();
    const requestBody = JSON.parse(transport.requests[0].body);
    assertStrictEquals(requestBody.max_completion_tokens, 32768);
  });

  it("fails closed naming OPENROUTER_API_KEY — an OpenAI key does not satisfy it", async () => {
    // Presence-only, per-provider: OPENAI_API_KEY being set must not leak
    // onto an openrouter row, and the error names the missing env var (never
    // a value).
    const env = new MapEnv({ OPENAI_API_KEY: "sk-openai-key" });
    const transport = new ScriptedHttpTransport();
    const failure = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "z-ai/glm-5.2" },
      models: [openRouterModel],
      getEnv: (name) => env.get(name),
      fetchFn: transport.fetch,
    }).then(() => undefined, (error) => error);

    assertInstanceOf(failure, HostedProviderCredentialMissingError);
    assertStrictEquals(failure.envVar, "OPENROUTER_API_KEY");
    assertStringIncludes(failure.message, "OPENROUTER_API_KEY");
    assertNotMatch(failure.message, /sk-openai-key/);
    assertStrictEquals(transport.requests.length, 0);
  });

  it("rejects a non-https OpenRouter base URL before inference", async () => {
    const env = new MapEnv({ OPENROUTER_API_KEY: "sk-or-key" });
    const transport = new ScriptedHttpTransport();
    await assertRejects(
      () =>
        runWorkbenchTurn({
          systemPrompt: "system",
          prompt: "hello",
          routing: { modelId: "z-ai/glm-5.2" },
          models: [{
            ...openRouterModel,
            baseUrl: "http://openrouter.ai/api/v1",
          }],
          getEnv: (name) => env.get(name),
          fetchFn: transport.fetch,
        }),
      WorkbenchHostedProviderBaseUrlError,
    );
    assertStrictEquals(transport.requests.length, 0);
  });

  it("an openrouter row never sends its key to another provider's https host", async () => {
    // A mis-catalogued row pairing provider "openrouter" with another
    // provider's https base URL must fail closed before any request leaves.
    const env = new MapEnv({ OPENROUTER_API_KEY: "sk-or-key" });
    const transport = new ScriptedHttpTransport();
    await assertRejects(
      () =>
        runWorkbenchTurn({
          systemPrompt: "system",
          prompt: "hello",
          routing: { modelId: "z-ai/glm-5.2" },
          models: [{
            ...openRouterModel,
            baseUrl: "https://api.openai.com/v1",
          }],
          getEnv: (name) => env.get(name),
          fetchFn: transport.fetch,
        }),
      WorkbenchHostedProviderBaseUrlError,
    );
    assertStrictEquals(transport.requests.length, 0);
  });

  it("rejects a pinned host on a non-default port before inference", async () => {
    // openrouter.ai:8443 is not the pinned endpoint even though the hostname
    // matches — the net grant and the contract both name port 443 only.
    const env = new MapEnv({ OPENROUTER_API_KEY: "sk-or-key" });
    const transport = new ScriptedHttpTransport();
    await assertRejects(
      () =>
        runWorkbenchTurn({
          systemPrompt: "system",
          prompt: "hello",
          routing: { modelId: "z-ai/glm-5.2" },
          models: [{
            ...openRouterModel,
            baseUrl: "https://openrouter.ai:8443/api/v1",
          }],
          getEnv: (name) => env.get(name),
          fetchFn: transport.fetch,
        }),
      WorkbenchHostedProviderBaseUrlError,
    );
    assertStrictEquals(transport.requests.length, 0);
  });

  it("accepts an explicit :443 on the pinned host — it is the default port", async () => {
    // The pin passes only when URL normalizes the explicit :443 to an empty
    // port; a row that spells the default port out must still route, or the
    // check would reject a legitimate endpoint. Complements the :8443
    // rejection above, which shares this normalization path.
    const env = new MapEnv({ OPENROUTER_API_KEY: "sk-or-key" });
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: JSON.stringify({
          choices: [{
            message: { content: "ok" },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      },
    }]);
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "z-ai/glm-5.2" },
      models: [{
        ...openRouterModel,
        baseUrl: "https://openrouter.ai:443/api/v1",
      }],
      getEnv: (name) => env.get(name),
      fetchFn: transport.fetch,
    });

    transport.assertDone();
    assertEquals(
      transport.requests[0].url,
      "https://openrouter.ai:443/api/v1/chat/completions",
    );
    assertStrictEquals(result.model.provider, "openrouter");
  });
});
