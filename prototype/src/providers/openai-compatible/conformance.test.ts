// The OpenAI-compatible adapter against the provider conformance kit.

import { assertEquals } from "@std/assert";
import { providerAdapterConformance } from "../../../testing/conformance/provider-adapter.ts";
import {
  estimateTextTokens,
  WorkbenchHostedProviderBaseUrlError,
  WorkbenchLocalProviderBaseUrlError,
  type WorkbenchModel,
} from "../mod.ts";
import { openAICompatibleAdapter } from "./adapter.ts";

const local: WorkbenchModel = {
  slug: "gemma4:e2b",
  displayName: "Gemma 4 E2B",
  provider: "ollama",
  api: "openai-completions",
  baseUrl: "http://localhost:11434/v1",
  tier: 0,
  costInput: 0,
  costOutput: 0,
  capabilities: ["text", "reasoning"],
};

const hosted: WorkbenchModel = {
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

const listFiles = {
  name: "list_files",
  description: "List files.",
  parameters: { type: "object" },
};

function sse(chunks: unknown[]): string {
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") +
    "data: [DONE]\n\n";
}

const abortedText = "partial<tool_call><function=list_files>" +
  "<parameter=path>.</parameter></function></tool_call>";

providerAdapterConformance({
  name: "openai-compatible",
  adapter: openAICompatibleAdapter,
  fixtures: {
    plainText: {
      model: local,
      stream: true,
      clock: [0, 10, 15, 20],
      exchanges: [{
        expect: (request) => {
          assertEquals(
            request.url,
            "http://localhost:11434/v1/chat/completions",
          );
          assertEquals(request.redirect, "error");
          assertEquals(JSON.parse(request.body).stream, true);
        },
        respond: {
          body: [
            'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
            'data: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n',
            "data: [DONE]\n\n",
          ],
        },
      }],
      expect: {
        frames: ["hello", " world"],
        result: {
          text: "hello world",
          usage: { input: 10, output: 2 },
          stopReason: "stop",
          timings: {
            responseHeadersMs: 10,
            timeToFirstTokenMs: 15,
            generationMs: 5,
            timePerOutputTokenMs: 5,
            totalMs: 20,
          },
        },
      },
    },
    nativeToolCalls: {
      model: local,
      turn: { prompt: "list the files" },
      stream: true,
      exchanges: [{
        respond: {
          body: sse([
            {
              choices: [{
                delta: {
                  role: "assistant",
                  tool_calls: [{
                    index: 0,
                    id: "tc-1",
                    type: "function",
                    function: { name: "list_files", arguments: '{"path":"."}' },
                  }],
                },
                finish_reason: null,
              }],
            },
            { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
          ]),
        },
      }],
      expect: {
        // A tool-call turn streams no text.
        frames: [],
        result: {
          toolCalls: [{
            id: "tc-1",
            name: "list_files",
            arguments: { path: "." },
          }],
          stopReason: "tool_use",
        },
      },
    },
    textMarkupToolCalls: {
      model: local,
      turn: { prompt: "list files", tools: [listFiles] },
      stream: true,
      exchanges: [{
        respond: {
          body: sse([
            { choices: [{ delta: { content: "I'll check. " } }] },
            {
              choices: [{
                delta: {
                  content:
                    "<tool_call><function=list_files><parameter=path>.</parameter></function></tool_call>",
                },
              }],
            },
            { choices: [{ delta: {}, finish_reason: "stop" }] },
          ]),
        },
      }],
      expect: {
        // The narration streamed; the tool-call markup was suppressed.
        frames: ["I'll check. "],
        result: {
          toolCalls: [
            { id: "text-tool-1", name: "list_files", arguments: { path: "." } },
          ],
          stopReason: "tool_use",
        },
      },
    },
    usage: {
      model: hosted,
      env: { OPENAI_API_KEY: "sk-test-key" },
      stream: false,
      exchanges: [{
        expect: (request) => {
          assertEquals(
            request.url,
            "https://api.openai.com/v1/chat/completions",
          );
          assertEquals(request.headers.authorization, "Bearer sk-test-key");
          assertEquals(JSON.parse(request.body).max_completion_tokens, 8192);
        },
        respond: {
          body: JSON.stringify({
            choices: [{
              message: { content: "hello from gpt" },
              finish_reason: "stop",
            }],
            usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 },
          }),
        },
      }],
      expect: {
        result: {
          text: "hello from gpt",
          // 1M input * $5 + 1M output * $30, per-MTok rates.
          usage: {
            input: 1_000_000,
            output: 1_000_000,
            cost: { total: 35 },
            cacheRead: 0,
            cacheWrite: 0,
            reasoning: 0,
          },
        },
      },
    },
    lengthStop: {
      model: local,
      turn: { maxOutputTokens: 2 },
      stream: true,
      exchanges: [{
        expect: (request) =>
          assertEquals(JSON.parse(request.body).max_completion_tokens, 2),
        respond: {
          body: sse([
            { choices: [{ delta: { content: "cut" } }] },
            {
              choices: [{
                delta: { content: " off" },
                finish_reason: "length",
              }],
              usage: { prompt_tokens: 4, completion_tokens: 2 },
            },
          ]),
        },
      }],
      expect: {
        result: { text: "cut off", stopReason: "length" },
      },
    },
    midStreamError: {
      model: local,
      stream: true,
      exchanges: [{
        respond: {
          body: 'data: {"choices":[{"delta":{"content":"partial"}}]}\n' +
            'data: {"error":{"message":"upstream failed"}}\n',
        },
      }],
      expect: {
        error: { message: "Provider stream returned an error envelope" },
      },
    },
    abort: {
      model: local,
      turn: { tools: [listFiles] },
      stream: true,
      abortAfterFrames: 1,
      exchanges: [{
        respond: {
          holdOpen: true,
          body:
            `data: ${
              JSON.stringify({ choices: [{ delta: { content: abortedText } }] })
            }\n` +
            `data: ${
              JSON.stringify({
                choices: [],
                usage: { prompt_tokens: 7, completion_tokens: 2 },
              })
            }`,
        },
      }],
      expect: {
        result: {
          text: "partial",
          stopReason: "aborted",
          usage: { input: 7, output: estimateTextTokens(abortedText) },
          toolCalls: undefined,
        },
      },
    },
    baseUrlRejection: {
      model: {
        ...local,
        slug: "poisoned-local",
        provider: "mlx-lm",
        baseUrl: "https://example.com/v1",
      },
      stream: false,
      exchanges: [],
      expect: { error: { instance: WorkbenchLocalProviderBaseUrlError } },
    },
    offHostBaseUrl: {
      // A hosted provider's key is pinned to its own host.
      model: {
        ...hosted,
        slug: "gpt-elsewhere",
        baseUrl: "https://example.com/v1",
      },
      env: { OPENAI_API_KEY: "sk-test-not-real" },
      stream: false,
      exchanges: [],
      expect: { error: { instance: WorkbenchHostedProviderBaseUrlError } },
    },
    redirect: {
      model: local,
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
