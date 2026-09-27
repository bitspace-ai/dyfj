// The synthetic adapter against the provider conformance kit, plus the one
// registry line that adds it next to the production adapters.

import { assertEquals, assertStrictEquals } from "@std/assert";
import {
  createProviderRegistry,
  PROVIDER_ADAPTERS,
  WorkbenchHostedProviderBaseUrlError,
  type WorkbenchModel,
} from "../../../src/providers/mod.ts";
import { providerAdapterConformance } from "../../conformance/provider-adapter.ts";
import { ScriptedHttpTransport } from "../../fakes/scripted-http-transport.ts";
import { MapEnv } from "../../fakes/map-env.ts";
import { syntheticAdapter } from "./adapter.ts";

const model: WorkbenchModel = {
  slug: "synthetic-small",
  displayName: "Synthetic small",
  provider: "synthetic",
  api: "synthetic",
  baseUrl: "https://synthetic.invalid",
  tier: 1,
  costInput: 2,
  costOutput: 8,
  capabilities: ["text", "tools"],
};

const env = { SYNTHETIC_API_KEY: "synthetic-test-key" };

const events = (...values: unknown[]) =>
  values.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("");

const readFile = {
  name: "file.read",
  description: "Read a file.",
  parameters: { type: "object" },
};

providerAdapterConformance({
  name: "synthetic",
  adapter: syntheticAdapter,
  fixtures: {
    plainText: {
      model,
      env,
      stream: true,
      clock: [0, 4, 6, 9],
      exchanges: [{
        expect: (request) => {
          assertEquals(request.url, "https://synthetic.invalid/v1/generate");
          assertEquals(
            request.headers.authorization,
            "Bearer synthetic-test-key",
          );
          assertEquals(request.redirect, "error");
          assertEquals(JSON.parse(request.body), {
            model: "synthetic-small",
            system: "system",
            messages: [{ role: "user", content: "hello" }],
            max_tokens: 4096,
            stream: true,
          });
        },
        respond: {
          body: events(
            { type: "text", text: "hi" },
            { type: "text", text: " there" },
            { type: "done", reason: "stop", usage: { input: 3, output: 2 } },
          ),
        },
      }],
      expect: {
        frames: ["hi", " there"],
        result: {
          text: "hi there",
          stopReason: "stop",
          timings: {
            responseHeadersMs: 4,
            timeToFirstTokenMs: 6,
            generationMs: 3,
            timePerOutputTokenMs: 3,
            totalMs: 9,
          },
        },
      },
    },
    nativeToolCalls: {
      model,
      env,
      turn: { tools: [readFile] },
      stream: true,
      exchanges: [{
        expect: (request) =>
          assertEquals(JSON.parse(request.body).tools[0].name, "file_read"),
        respond: {
          body: events(
            {
              type: "tool_call",
              id: "call-1",
              name: "file_read",
              arguments: { path: "a.ts" },
            },
            {
              type: "done",
              reason: "tool_calls",
              usage: { input: 5, output: 7 },
            },
          ),
        },
      }],
      expect: {
        frames: [],
        result: {
          toolCalls: [{
            id: "call-1",
            name: "file.read",
            arguments: { path: "a.ts" },
          }],
          stopReason: "tool_use",
        },
      },
    },
    textMarkupToolCalls: {
      // The synthetic family does not recover tool calls from text markup.
      model,
      env,
      turn: { tools: [readFile] },
      stream: false,
      exchanges: [{
        respond: {
          body: JSON.stringify({
            text:
              "<tool_call><function=file_read><parameter=path>a.ts</parameter></function></tool_call>",
            reason: "stop",
          }),
        },
      }],
      expect: {
        result: {
          text:
            "<tool_call><function=file_read><parameter=path>a.ts</parameter></function></tool_call>",
          toolCalls: undefined,
          stopReason: "stop",
        },
      },
    },
    usage: {
      model,
      env,
      stream: false,
      exchanges: [{
        respond: {
          body: JSON.stringify({
            text: "priced",
            reason: "stop",
            usage: { input: 1_000_000, output: 500_000 },
          }),
        },
      }],
      expect: {
        result: {
          // 1M input * $2 + 0.5M output * $8, per-MTok rates.
          usage: {
            input: 1_000_000,
            output: 500_000,
            cost: { total: 6 },
            cacheRead: 0,
            cacheWrite: 0,
          },
        },
      },
    },
    lengthStop: {
      model,
      env,
      turn: { maxOutputTokens: 3 },
      stream: true,
      exchanges: [{
        expect: (request) =>
          assertEquals(JSON.parse(request.body).max_tokens, 3),
        respond: {
          body: events(
            { type: "text", text: "cut" },
            {
              type: "done",
              reason: "max_tokens",
              usage: { input: 2, output: 3 },
            },
          ),
        },
      }],
      expect: { result: { text: "cut", stopReason: "length" } },
    },
    midStreamError: {
      model,
      env,
      stream: true,
      exchanges: [{
        respond: {
          body: events(
            { type: "text", text: "partial" },
            { type: "error", message: "overloaded" },
          ),
        },
      }],
      expect: {
        error: { message: "Synthetic stream returned an error event" },
      },
    },
    abort: {
      model,
      env,
      stream: true,
      abortAfterFrames: 1,
      exchanges: [{
        respond: {
          holdOpen: true,
          body: events({ type: "text", text: "partial" }),
        },
      }],
      expect: {
        result: {
          text: "partial",
          stopReason: "aborted",
          // No usage arrived: 3 input tokens estimated from "system\nhello",
          // 2 output tokens from "partial".
          usage: {
            input: 3,
            output: 2,
            cost: { total: 0.000022 },
            cacheRead: 0,
            cacheWrite: 0,
          },
        },
      },
    },
    baseUrlRejection: {
      model: {
        ...model,
        slug: "synthetic-elsewhere",
        baseUrl: "https://example.com",
      },
      env,
      stream: false,
      exchanges: [],
      expect: { error: { instance: WorkbenchHostedProviderBaseUrlError } },
    },
  },
});

// The one registry line: the synthetic family next to the production ones.
const registry = createProviderRegistry([
  ...PROVIDER_ADAPTERS,
  syntheticAdapter,
]);

Deno.test("the synthetic adapter is dispatched beside the production adapters", async () => {
  assertStrictEquals(registry.adapterFor(model), syntheticAdapter);
  const transport = new ScriptedHttpTransport([{
    respond: {
      body: JSON.stringify({
        text: "routed",
        reason: "stop",
        usage: { input: 1, output: 1 },
      }),
    },
  }]);
  const environment = new MapEnv(env);
  const result = await registry.runWorkbenchTurn({
    systemPrompt: "system",
    prompt: "hello",
    routing: { modelId: model.slug },
    models: [model],
    fetchFn: transport.fetch,
    getEnv: (name) => environment.get(name),
  });
  assertEquals(result.text, "routed");
  transport.assertDone();
});
