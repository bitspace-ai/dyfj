// The Gemini adapter against the provider conformance kit.

import { assertEquals } from "@std/assert";
import { providerAdapterConformance } from "../../../testing/conformance/provider-adapter.ts";
import {
  WorkbenchHostedProviderBaseUrlError,
  type WorkbenchModel,
} from "../mod.ts";
import { geminiAdapter } from "./adapter.ts";

const gemini: WorkbenchModel = {
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

const env = { GEMINI_API_KEY: "gem-test-key" };

const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;

const listFiles = {
  name: "list_files",
  description: "List files.",
  parameters: { type: "object" },
};

providerAdapterConformance({
  name: "gemini",
  adapter: geminiAdapter,
  fixtures: {
    plainText: {
      model: gemini,
      env,
      stream: true,
      exchanges: [{
        expect: (request) =>
          assertEquals(
            request.url,
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-test:streamGenerateContent?alt=sse",
          ),
        respond: {
          body: frame({
            candidates: [{ content: { parts: [{ text: "hello" }] } }],
          }) +
            frame({
              candidates: [{
                content: { parts: [{ text: " there" }] },
                finishReason: "STOP",
              }],
              usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
            }),
        },
      }],
      expect: {
        frames: ["hello", " there"],
        result: {
          text: "hello there",
          stopReason: "stop",
          usage: { input: 5, output: 2, reasoning: 0 },
        },
      },
    },
    nativeToolCalls: {
      // Gemini does not return tool calls: tools are not offered on its wire
      // request, and a function-call part is not surfaced.
      model: gemini,
      env,
      turn: { tools: [listFiles] },
      stream: false,
      exchanges: [{
        expect: (request) =>
          assertEquals(JSON.parse(request.body).tools, undefined),
        respond: {
          body: JSON.stringify({
            candidates: [{
              content: {
                parts: [{
                  functionCall: { name: "list_files", args: { path: "." } },
                }],
              },
              finishReason: "STOP",
            }],
            usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4 },
          }),
        },
      }],
      expect: {
        result: { text: "", toolCalls: undefined, stopReason: "stop" },
      },
    },
    textMarkupToolCalls: {
      model: gemini,
      env,
      turn: { tools: [listFiles] },
      stream: false,
      exchanges: [{
        respond: {
          body: JSON.stringify({
            candidates: [{
              content: {
                parts: [{
                  text:
                    "<tool_call><function=list_files><parameter=path>.</parameter></function></tool_call>",
                }],
              },
              finishReason: "STOP",
            }],
          }),
        },
      }],
      expect: {
        result: {
          text:
            "<tool_call><function=list_files><parameter=path>.</parameter></function></tool_call>",
          toolCalls: undefined,
        },
      },
    },
    usage: {
      model: gemini,
      env,
      stream: false,
      exchanges: [{
        expect: (request) => {
          assertEquals(
            request.url,
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent",
          );
          assertEquals(request.headers["x-goog-api-key"], "gem-test-key");
        },
        respond: {
          body: JSON.stringify({
            candidates: [{
              content: { parts: [{ text: "hello from gemini" }] },
              finishReason: "STOP",
            }],
            usageMetadata: {
              promptTokenCount: 1_000_000,
              candidatesTokenCount: 1_000_000,
              thoughtsTokenCount: 500_000,
            },
          }),
        },
      }],
      expect: {
        result: {
          text: "hello from gemini",
          // 1M input * $2 + 1.5M billable output * $12, per-MTok rates.
          usage: {
            input: 1_000_000,
            output: 1_000_000,
            cost: { total: 20 },
            cacheRead: 0,
            cacheWrite: 0,
            reasoning: 500_000,
          },
        },
      },
    },
    lengthStop: {
      model: gemini,
      env,
      turn: { maxOutputTokens: 2 },
      stream: true,
      exchanges: [{
        expect: (request) =>
          assertEquals(
            JSON.parse(request.body).generationConfig.maxOutputTokens,
            2,
          ),
        respond: {
          body: frame({
            candidates: [{
              content: { parts: [{ text: "hi" }] },
              finishReason: "MAX_TOKENS",
            }],
            usageMetadata: {
              promptTokenCount: 7,
              candidatesTokenCount: 2,
              thoughtsTokenCount: 140,
            },
          }),
        },
      }],
      expect: {
        result: {
          text: "hi",
          stopReason: "length",
          usage: { input: 7, output: 2, reasoning: 140 },
        },
      },
    },
    midStreamError: {
      model: gemini,
      env,
      stream: true,
      exchanges: [{
        respond: {
          body: frame({
            candidates: [{ content: { parts: [{ text: "partial" }] } }],
          }) +
            'data: {"error":{"code":429,"message":"quota"}}\n',
        },
      }],
      expect: {
        error: { message: "Gemini stream returned an error envelope" },
      },
    },
    abort: {
      model: gemini,
      env,
      stream: true,
      abortAfterFrames: 1,
      exchanges: [{
        respond: {
          holdOpen: true,
          body: frame({
            candidates: [{ content: { parts: [{ text: "partial" }] } }],
            usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 2 },
          }),
        },
      }],
      expect: {
        result: {
          text: "partial",
          stopReason: "aborted",
          usage: { input: 9, output: 2 },
        },
      },
    },
    baseUrlRejection: {
      model: {
        ...gemini,
        slug: "gemini-poisoned",
        baseUrl: "http://generativelanguage.googleapis.com",
      },
      env,
      stream: false,
      exchanges: [],
      expect: { error: { instance: WorkbenchHostedProviderBaseUrlError } },
    },
    offHostBaseUrl: {
      model: {
        ...gemini,
        slug: "gemini-elsewhere",
        baseUrl: "https://example.com",
      },
      env,
      stream: false,
      exchanges: [],
      expect: { error: { instance: WorkbenchHostedProviderBaseUrlError } },
    },
    redirect: {
      model: gemini,
      env,
      stream: false,
      exchanges: [{
        respond: {
          status: 307,
          headers: { location: "https://example.com/elsewhere" },
        },
      }],
      expect: { error: { message: /redirect/i } },
    },
  },
});
