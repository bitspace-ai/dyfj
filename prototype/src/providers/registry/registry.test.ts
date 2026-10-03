import {
  assertEquals,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { ScriptedHttpTransport } from "../../../testing/fakes/scripted-http-transport.ts";
import {
  createProviderRegistry,
  HostedInferenceRequiresProviderError,
  modelRequestedOutputCap,
  modelStreamsToolCalls,
  modelSupportsTranscriptRetry,
  PROVIDER_ADAPTERS,
  type ProviderAdapter,
  runWorkbenchTurn,
  type WorkbenchModel,
} from "../mod.ts";
import { anthropicAdapter } from "../anthropic/adapter.ts";
import { geminiAdapter } from "../gemini/adapter.ts";
import { openAICompatibleAdapter } from "../openai-compatible/adapter.ts";

function model(provider: string, extra: Partial<WorkbenchModel> = {}) {
  return {
    slug: `${provider}-model`,
    displayName: provider,
    provider,
    api: "any",
    baseUrl: "https://example.invalid",
    tier: 1,
    costInput: 1,
    costOutput: 1,
    capabilities: ["text"],
    ...extra,
  } satisfies WorkbenchModel;
}

Deno.test("each production provider is served by exactly one adapter", () => {
  const registry = createProviderRegistry(PROVIDER_ADAPTERS);
  const expected: Record<string, ProviderAdapter> = {
    "llama-cpp": openAICompatibleAdapter,
    ollama: openAICompatibleAdapter,
    "mlx-lm": openAICompatibleAdapter,
    openai: openAICompatibleAdapter,
    openrouter: openAICompatibleAdapter,
    xai: openAICompatibleAdapter,
    anthropic: anthropicAdapter,
    google: geminiAdapter,
  };
  for (const [provider, adapter] of Object.entries(expected)) {
    assertStrictEquals(registry.adapterFor(model(provider)), adapter, provider);
  }
  for (const provider of ["codex-chatgpt", "vllm", ""]) {
    assertStrictEquals(registry.adapterFor(model(provider)), undefined);
  }
});

Deno.test("dispatch keys on the provider, not the catalog api column", () => {
  const registry = createProviderRegistry(PROVIDER_ADAPTERS);
  assertStrictEquals(
    registry.adapterFor(model("anthropic", { api: "openai-completions" })),
    anthropicAdapter,
  );
});

Deno.test("two adapters may not serve the same provider", () => {
  assertThrows(
    () =>
      createProviderRegistry([
        openAICompatibleAdapter,
        { ...anthropicAdapter, api: "other", providers: new Set(["openai"]) },
      ]),
    Error,
    "provider openai is served by both openai-compatible and other",
  );
});

Deno.test("a provider no adapter serves fails closed before any request", async () => {
  const transport = new ScriptedHttpTransport();
  const unserved = model("vllm", {
    baseUrl: "http://localhost:8000/v1",
    tier: 0,
    costInput: 0,
    costOutput: 0,
  });
  await assertRejects(
    () =>
      runWorkbenchTurn({
        systemPrompt: "system",
        prompt: "hello",
        routing: { modelId: unserved.slug },
        models: [unserved],
        fetchFn: transport.fetch,
      }),
    HostedInferenceRequiresProviderError,
  );
  assertEquals(transport.requests.length, 0);
});

Deno.test("capability queries answer from the serving adapter", () => {
  const table: Array<[string, boolean, boolean]> = [
    // provider, streams tool calls, supports transcript retry
    ["ollama", true, true],
    ["openai", true, true],
    ["anthropic", false, true],
    ["google", false, false],
    ["codex-chatgpt", false, false],
  ];
  for (const [provider, streams, retry] of table) {
    assertEquals(modelStreamsToolCalls(model(provider)), streams, provider);
    assertEquals(
      modelSupportsTranscriptRetry(model(provider)),
      retry,
      provider,
    );
  }
});

Deno.test("the requested output cap applies each adapter's default ceiling", () => {
  const cases: Array<[WorkbenchModel, number | undefined, number | undefined]> =
    [
      [model("anthropic"), undefined, 16000],
      [model("anthropic", { maxOutputTokens: 4096 }), undefined, 4096],
      [model("google"), undefined, 8192],
      [model("openai"), undefined, 8192],
      [model("openrouter", { maxOutputTokens: 100_000 }), undefined, 8192],
      [model("ollama"), undefined, undefined],
      [model("ollama", { maxOutputTokens: 2048 }), undefined, 2048],
      [model("ollama", { maxOutputTokens: 2048 }), 9000, 2048],
      [model("openai", { maxOutputTokens: 32_000 }), 20_000, 20_000],
      [model("codex-chatgpt", { maxOutputTokens: 1234 }), undefined, 1234],
    ];
  for (const [subject, requested, expected] of cases) {
    assertEquals(
      modelRequestedOutputCap(subject, requested),
      expected,
      `${subject.provider} requested=${requested}`,
    );
  }
});
