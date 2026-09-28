// runWorkbenchTurn against the Gemini adapter: cancellation, usage coverage,
// timing, and fail-closed cases beyond the conformance kit.

import { describe, it } from "@std/testing/bdd";
import { assertEquals, assertObjectMatch, assertRejects } from "@std/assert";
import { ManualClock } from "../../../testing/fakes/manual-clock.ts";
import { MapEnv } from "../../../testing/fakes/map-env.ts";
import { ScriptedHttpTransport } from "../../../testing/fakes/scripted-http-transport.ts";
import {
  getModelAccessModality,
  HostedProviderCredentialMissingError,
  runWorkbenchTurn,
  WorkbenchHostedProviderBaseUrlError,
  type WorkbenchModel,
} from "../mod.ts";
import { geminiAdapter } from "./adapter.ts";

describe("runWorkbenchTurn Google Gemini", () => {
  const geminiModel: WorkbenchModel = {
    slug: "gemini-test",
    displayName: "Gemini test",
    provider: "google",
    api: "google-generative-ai",
    baseUrl: "https://generativelanguage.googleapis.com",
    tier: 2,
    costInput: 2,
    costOutput: 12,
    capabilities: ["text", "code", "reasoning"],
  };
  const env = new MapEnv({ GEMINI_API_KEY: "gem-test-key" });
  const getEnv = (name: string) => env.get(name);

  it("Gemini error envelopes outrank a concurrent cancellation", async () => {
    const abortController = new AbortController();
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: 'data: {"error":{"code":429,"message":"quota"}}\n',
        holdOpen: true,
      },
    }]);
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemini-test" },
      models: [geminiModel],
      abortSignal: abortController.signal,
      onTextDelta: () => {},
      getEnv,
      fetchFn: transport.fetch,
    });
    const rejection = assertRejects(
      () => pending,
      Error,
      "Gemini stream returned an error envelope",
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    abortController.abort();

    await rejection;
    transport.assertDone();
  });

  it("estimates streamed Gemini reasoning received before cancellation", async () => {
    const abortController = new AbortController();
    const reasoning = "r".repeat(400);
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: `data: ${
          JSON.stringify({
            candidates: [{
              content: { parts: [{ text: reasoning, thought: true }] },
            }],
          })
        }\n`,
        holdOpen: true,
      },
    }]);
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemini-test" },
      models: [geminiModel],
      abortSignal: abortController.signal,
      onTextDelta: () => {},
      getEnv,
      fetchFn: transport.fetch,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    abortController.abort();
    const result = await pending;

    assertObjectMatch(result, {
      stopReason: "aborted",
      usage: { reasoning: 100 },
    });
    transport.assertDone();
  });

  it("lower-bounds aborted Gemini usage with later preserved text", async () => {
    const abortController = new AbortController();
    const laterText = "x".repeat(400);
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: `data: ${
          JSON.stringify({
            candidates: [],
            usageMetadata: {
              promptTokenCount: 9,
              candidatesTokenCount: 1,
            },
          })
        }\n` +
          `data: ${
            JSON.stringify({
              candidates: [{ content: { parts: [{ text: laterText }] } }],
            })
          }\n`,
        holdOpen: true,
      },
    }]);
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemini-test" },
      models: [geminiModel],
      abortSignal: abortController.signal,
      onTextDelta: () => {},
      getEnv,
      fetchFn: transport.fetch,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    abortController.abort();
    const result = await pending;

    assertObjectMatch(result, {
      text: laterText,
      stopReason: "aborted",
      usage: { input: 9, output: 101 },
    });
    transport.assertDone();
  });

  it("retains the highest Gemini usage total before cancellation", async () => {
    const abortController = new AbortController();
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: `data: ${
          JSON.stringify({
            candidates: [],
            usageMetadata: {
              promptTokenCount: 9,
              candidatesTokenCount: 100,
            },
          })
        }\n` +
          `data: ${
            JSON.stringify({
              candidates: [],
              usageMetadata: {
                promptTokenCount: 1,
                candidatesTokenCount: 1,
              },
            })
          }\n`,
        holdOpen: true,
      },
    }]);
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemini-test" },
      models: [geminiModel],
      abortSignal: abortController.signal,
      onTextDelta: () => {},
      getEnv,
      fetchFn: transport.fetch,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    abortController.abort();
    const result = await pending;

    assertObjectMatch(result, {
      stopReason: "aborted",
      usage: { input: 9, output: 100 },
    });
    transport.assertDone();
  });

  it("does not refresh Gemini output coverage from prompt-only usage", async () => {
    const laterText = "x".repeat(400);
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: `data: ${
          JSON.stringify({
            candidates: [],
            usageMetadata: {
              promptTokenCount: 9,
              candidatesTokenCount: 1,
            },
          })
        }\n\n` +
          `data: ${
            JSON.stringify({
              candidates: [{ content: { parts: [{ text: laterText }] } }],
            })
          }\n\n` +
          `data: ${
            JSON.stringify({
              candidates: [{ finishReason: "STOP" }],
              usageMetadata: { promptTokenCount: 9 },
            })
          }\n\n`,
      },
    }]);
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemini-test" },
      models: [geminiModel],
      onTextDelta: () => {},
      getEnv,
      fetchFn: transport.fetch,
    });

    assertObjectMatch(result, {
      text: laterText,
      usage: { input: 9, output: 101 },
    });
    transport.assertDone();
  });

  it("Gemini TPOT uses visible generation tokens, not earlier reasoning", async () => {
    const clock = new ManualClock({ readings: [0, 10, 20, 120] });
    const visible = "x".repeat(40);
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: `data: ${
          JSON.stringify({
            candidates: [{
              content: { parts: [{ text: visible }] },
              finishReason: "STOP",
            }],
            usageMetadata: {
              promptTokenCount: 9,
              candidatesTokenCount: 10,
              thoughtsTokenCount: 500,
            },
          })
        }\n`,
      },
    }]);
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemini-test" },
      models: [geminiModel],
      onTextDelta: () => {},
      now: clock.now,
      getEnv,
      fetchFn: transport.fetch,
    });

    assertObjectMatch(result.usage, { output: 10, reasoning: 500 });
    assertObjectMatch(result.timings, {
      generationMs: 100,
      timePerOutputTokenMs: 11,
    });
    transport.assertDone();
  });

  it("Gemini clean EOF preserves a concurrent trailing-frame error", async () => {
    const abortController = new AbortController();
    // The responder aborts the turn while the request is in flight, which the
    // scripted vocabulary cannot express.
    const transport = new ScriptedHttpTransport([{
      respond: () => {
        abortController.abort();
        return new Response('data: {"candidates":[');
      },
    }]);
    await assertRejects(
      () =>
        runWorkbenchTurn({
          systemPrompt: "system",
          prompt: "hello",
          routing: { modelId: "gemini-test" },
          models: [geminiModel],
          abortSignal: abortController.signal,
          onTextDelta: () => {},
          getEnv,
          fetchFn: transport.fetch,
        }),
      SyntaxError,
    );
    transport.assertDone();
  });

  it("fails closed when GEMINI_API_KEY is absent", async () => {
    const transport = new ScriptedHttpTransport();
    const emptyEnv = new MapEnv();
    await assertRejects(
      () =>
        runWorkbenchTurn({
          systemPrompt: "system",
          prompt: "hello",
          routing: { modelId: "gemini-test" },
          models: [geminiModel],
          getEnv: (name) => emptyEnv.get(name),
          fetchFn: transport.fetch,
        }),
      HostedProviderCredentialMissingError,
    );
    assertEquals(transport.requests.length, 0);
  });
});

describe("Gemini base-URL contract and model path", () => {
  const geminiModel: WorkbenchModel = {
    slug: "gemini-test",
    displayName: "Gemini test",
    provider: "google",
    api: "google-generative-ai",
    baseUrl: "https://generativelanguage.googleapis.com",
    tier: 2,
    costInput: 2,
    costOutput: 12,
    capabilities: ["text", "code", "reasoning"],
  };
  const env = new MapEnv({ GEMINI_API_KEY: "gem-test-key" });
  const getEnv = (name: string) => env.get(name);
  const withBaseUrl = (baseUrl: string): WorkbenchModel => ({
    ...geminiModel,
    baseUrl,
  });
  const accepted = [
    "https://generativelanguage.googleapis.com",
    "https://generativelanguage.googleapis.com/",
    "https://generativelanguage.googleapis.com:443",
    "https://generativelanguage.googleapis.com//",
  ];
  const rejected = [
    "https://example.com",
    "https://generativelanguage.googleapis.com.example.com",
    "https://googleapis.com",
    "https://generativelanguage.googleapis.com:8443",
    "https://generativelanguage.googleapis.com/v1beta",
    "https://generativelanguage.googleapis.com/proxy",
    "https://generativelanguage.googleapis.com/#x",
    "http://generativelanguage.googleapis.com",
  ];
  const okBody = JSON.stringify({
    candidates: [{
      content: { parts: [{ text: "ok" }] },
      finishReason: "STOP",
    }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
  });
  const turn = (model: WorkbenchModel, transport: ScriptedHttpTransport) =>
    runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: model.slug },
      models: [model],
      getEnv,
      fetchFn: transport.fetch,
    });

  it("accepts only the canonical https host and base path", () => {
    for (const url of accepted) {
      assertEquals(geminiAdapter.validateBaseUrl(withBaseUrl(url)).ok, true);
    }
    for (const url of rejected) {
      assertEquals(
        geminiAdapter.validateBaseUrl(withBaseUrl(url)).ok,
        false,
        url,
      );
    }
  });

  it("accepts exactly the base URLs classified as frontier-hosted", () => {
    for (const url of [...accepted, ...rejected]) {
      assertEquals(
        geminiAdapter.validateBaseUrl(withBaseUrl(url)).ok,
        getModelAccessModality({ provider: "google", baseUrl: url }) ===
          "frontier-hosted",
        url,
      );
    }
  });

  it("rejects an off-host base URL before sending", async () => {
    const transport = new ScriptedHttpTransport();
    await assertRejects(
      () => turn(withBaseUrl("https://example.com"), transport),
      WorkbenchHostedProviderBaseUrlError,
    );
    assertEquals(transport.requests.length, 0);
  });

  it("sends the canonical request unchanged, refusing redirects", async () => {
    const transport = new ScriptedHttpTransport([{
      expect: (request) => {
        assertEquals(
          request.url,
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent",
        );
        assertEquals(request.redirect, "error");
        assertEquals(request.headers, {
          "content-type": "application/json",
          "x-goog-api-key": "gem-test-key",
        });
      },
      respond: { body: okBody },
    }]);
    const result = await turn(
      withBaseUrl("https://generativelanguage.googleapis.com/"),
      transport,
    );
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
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent",
          ),
        respond: { body: okBody },
      }]);
      await turn(withBaseUrl(baseUrl), transport);
      transport.assertDone();
    }
  });

  it("keeps the model slug inside one path segment", async () => {
    const slug = "gemini/../x?alt=json#frag";
    const transport = new ScriptedHttpTransport([{
      expect: (request) => {
        const url = new URL(request.url);
        assertEquals(url.host, "generativelanguage.googleapis.com");
        assertEquals(
          url.pathname,
          "/v1beta/models/gemini%2F..%2Fx%3Falt%3Djson%23frag:generateContent",
        );
        assertEquals(url.search, "");
        assertEquals(url.hash, "");
      },
      respond: { body: okBody },
    }]);
    await turn({ ...geminiModel, slug }, transport);
    transport.assertDone();
  });
});
