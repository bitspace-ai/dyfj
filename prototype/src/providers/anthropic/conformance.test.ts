// The Anthropic Messages adapter against the provider conformance kit.

import { assert, assertEquals } from "@std/assert";
import { providerAdapterConformance } from "../../../testing/conformance/provider-adapter.ts";
import {
  WorkbenchHostedProviderBaseUrlError,
  type WorkbenchModel,
} from "../mod.ts";
import { anthropicAdapter } from "./adapter.ts";

const claude: WorkbenchModel = {
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

const env = { ANTHROPIC_API_KEY: "test-key-not-real" };

const lines = (...frames: string[]) => [...frames, ""].join("\n");

providerAdapterConformance({
  name: "anthropic",
  adapter: anthropicAdapter,
  fixtures: {
    plainText: {
      model: claude,
      env,
      stream: true,
      exchanges: [{
        respond: {
          body: lines(
            'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}',
            'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}',
            'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}',
            'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
            'data: {"type":"message_stop"}',
          ),
        },
      }],
      expect: {
        frames: ["Hel", "lo"],
        result: {
          text: "Hello",
          stopReason: "stop",
          usage: { input: 10, output: 2 },
        },
      },
    },
    nativeToolCalls: {
      model: claude,
      env,
      turn: {
        systemPrompt: "sys",
        prompt: "hi",
        tools: [{
          name: "memory.read",
          description: "Read a memory",
          parameters: { type: "object", properties: {} },
        }],
      },
      stream: false,
      exchanges: [{
        // Dotted registry names go out wire-safe and come back mapped.
        expect: (request) =>
          assertEquals(JSON.parse(request.body).tools[0].name, "memory_read"),
        respond: {
          body: JSON.stringify({
            content: [{
              type: "tool_use",
              id: "toolu_1",
              name: "memory_read",
              input: { slug: "x" },
            }],
            stop_reason: "tool_use",
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        },
      }],
      expect: {
        result: {
          toolCalls: [{
            id: "toolu_1",
            name: "memory.read",
            arguments: { slug: "x" },
          }],
          stopReason: "tool_use",
        },
      },
    },
    textMarkupToolCalls: {
      // Anthropic does not recover tool calls leaked as text markup: the text
      // is returned as generated and no tool call is made.
      model: claude,
      env,
      turn: {
        tools: [{
          name: "list_files",
          description: "List files.",
          parameters: { type: "object" },
        }],
      },
      stream: false,
      exchanges: [{
        respond: {
          body: JSON.stringify({
            content: [{
              type: "text",
              text:
                "<tool_call><function=list_files><parameter=path>.</parameter></function></tool_call>",
            }],
            stop_reason: "end_turn",
            usage: { input_tokens: 3, output_tokens: 20 },
          }),
        },
      }],
      expect: {
        result: {
          text:
            "<tool_call><function=list_files><parameter=path>.</parameter></function></tool_call>",
          toolCalls: undefined,
          stopReason: "stop",
        },
      },
    },
    usage: {
      model: claude,
      env,
      turn: { systemPrompt: "sys", prompt: "hi" },
      stream: false,
      exchanges: [{
        expect: (request) => {
          assertEquals(request.url, "https://api.anthropic.com/v1/messages");
          assertEquals(request.headers["x-api-key"], "test-key-not-real");
          assert(request.headers["anthropic-version"]);
        },
        respond: {
          body: JSON.stringify({
            content: [
              { type: "text", text: "Hello from Claude." },
              {
                type: "tool_use",
                id: "toolu_1",
                name: "memory.read",
                input: { slug: "x" },
              },
            ],
            stop_reason: "tool_use",
            usage: {
              input_tokens: 1_000_000,
              output_tokens: 1_000_000,
              cache_read_input_tokens: 1_000_000,
              cache_creation_input_tokens: 1_000_000,
            },
          }),
        },
      }],
      expect: {
        result: {
          text: "Hello from Claude.",
          stopReason: "tool_use",
          toolCalls: [{
            id: "toolu_1",
            name: "memory.read",
            arguments: { slug: "x" },
          }],
          // 1M of each at costInput=1/costOutput=5: 1 + 0.1 + 1.25 + 5.
          usage: {
            input: 1_000_000,
            output: 1_000_000,
            cost: { total: 1 + 0.1 + 1.25 + 5 },
            cacheRead: 1_000_000,
            cacheWrite: 1_000_000,
          },
        },
      },
    },
    lengthStop: {
      model: claude,
      env,
      turn: { maxOutputTokens: 2 },
      stream: true,
      exchanges: [{
        expect: (request) =>
          assertEquals(JSON.parse(request.body).max_tokens, 2),
        respond: {
          body: lines(
            'data: {"type":"message_start","message":{"usage":{"input_tokens":4}}}',
            'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"cut off"}}',
            'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":2}}',
            'data: {"type":"message_stop"}',
          ),
        },
      }],
      expect: { result: { text: "cut off", stopReason: "length" } },
    },
    midStreamError: {
      model: claude,
      env,
      stream: true,
      exchanges: [{
        respond: {
          body: lines(
            'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}',
            'data: {"type":"error","error":{"type":"overloaded_error"}}',
          ),
        },
      }],
      expect: {
        error: { message: "Anthropic stream returned an error envelope" },
      },
    },
    abort: {
      model: claude,
      env,
      turn: { systemPrompt: "sys", prompt: "hi" },
      stream: true,
      abortAfterFrames: 1,
      exchanges: [{
        respond: {
          holdOpen: true,
          body: lines(
            'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}',
            'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}',
          ),
        },
      }],
      expect: {
        result: {
          text: "partial",
          stopReason: "aborted",
          usage: { input: 10, output: 2 },
        },
      },
    },
    baseUrlRejection: {
      model: {
        ...claude,
        slug: "insecure",
        baseUrl: "http://api.anthropic.com",
      },
      env,
      stream: false,
      exchanges: [],
      expect: { error: { instance: WorkbenchHostedProviderBaseUrlError } },
    },
  },
});
