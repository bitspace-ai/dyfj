// The Anthropic Messages adapter against the provider conformance kit.

import {
  assert,
  assertEquals,
  assertObjectMatch,
  assertStrictEquals,
} from "@std/assert";
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

/** A buffered reply, for cases that pin only the request. */
const reply = {
  body: JSON.stringify({
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  }),
};

const memoryRead = {
  name: "memory.read",
  description: "Read a memory",
  parameters: { type: "object", properties: {} },
};

const requestBody = (body: string) => JSON.parse(body);

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
    offHostBaseUrl: {
      model: {
        ...claude,
        slug: "claude-elsewhere",
        baseUrl: "https://example.com",
      },
      env,
      stream: false,
      exchanges: [],
      expect: { error: { instance: WorkbenchHostedProviderBaseUrlError } },
    },
    redirect: {
      model: claude,
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
  cases: {
    "the stable system block carries cache_control": {
      model: claude,
      env,
      turn: {
        systemPrompt: "You are the workbench.",
        prompt: "Say hi.",
        jsonObject: true,
      },
      stream: false,
      exchanges: [{
        expect: (request) => {
          const body = requestBody(request.body);
          assertObjectMatch(body.system[0], {
            text: "You are the workbench.",
            cache_control: { type: "ephemeral" },
          });
          assertStrictEquals(body.system[1].cache_control, undefined);
          assert(body.max_tokens > 0, "max_tokens should be positive");
          assertEquals(body.messages, [{ role: "user", content: "Say hi." }]);
        },
        respond: reply,
      }],
      expect: { result: { text: "ok" } },
    },
    "tools go out in the input_schema shape": {
      model: claude,
      env,
      turn: { tools: [memoryRead] },
      stream: false,
      exchanges: [{
        expect: (request) =>
          assertEquals(requestBody(request.body).tools, [{
            name: "memory_read",
            description: "Read a memory",
            input_schema: { type: "object", properties: {} },
          }]),
        respond: reply,
      }],
      expect: { result: { text: "ok" } },
    },
    "a transcript maps to tool_use and merged tool_result blocks": {
      model: claude,
      env,
      turn: {
        systemPrompt: "sys",
        prompt: "seed",
        tools: [memoryRead],
        messages: [
          { role: "user", content: "what is this repo?" },
          {
            role: "assistant",
            content: "Reading memory.",
            toolCalls: [
              { id: "tu-1", name: "memory.read", arguments: { slug: "a" } },
              { id: "tu-2", name: "memory.read", arguments: { slug: "b" } },
            ],
          },
          {
            role: "tool",
            toolCallId: "tu-1",
            name: "memory.read",
            content: "A",
          },
          {
            role: "tool",
            toolCallId: "tu-2",
            name: "memory.read",
            content: "B",
          },
        ],
      },
      stream: false,
      exchanges: [{
        expect: (request) => {
          const body = requestBody(request.body);
          // System stays top-level; the seed prompt is unused once history
          // exists.
          assertObjectMatch(body.system[0], { text: "sys" });
          assertEquals(body.messages, [
            { role: "user", content: "what is this repo?" },
            // A text block, then one tool_use block per call (name sanitized).
            {
              role: "assistant",
              content: [
                { type: "text", text: "Reading memory." },
                {
                  type: "tool_use",
                  id: "tu-1",
                  name: "memory_read",
                  input: { slug: "a" },
                },
                {
                  type: "tool_use",
                  id: "tu-2",
                  name: "memory_read",
                  input: { slug: "b" },
                },
              ],
            },
            // Consecutive tool results merge into one following user turn.
            {
              role: "user",
              content: [
                { type: "tool_result", tool_use_id: "tu-1", content: "A" },
                { type: "tool_result", tool_use_id: "tu-2", content: "B" },
              ],
            },
          ]);
        },
        respond: reply,
      }],
      expect: { result: { text: "ok" } },
    },
    "a failed tool result carries is_error": {
      model: claude,
      env,
      turn: {
        systemPrompt: "sys",
        prompt: "seed",
        tools: [{
          name: "read_file",
          description: "Read a file",
          parameters: { type: "object", properties: {} },
        }],
        messages: [
          { role: "user", content: "read the friction log" },
          {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "tu-bad", name: "read_file", arguments: {} }],
          },
          {
            role: "tool",
            toolCallId: "tu-bad",
            name: "read_file",
            content:
              "invalid arguments for read_file: missing required argument: path",
            isError: true,
          },
        ],
      },
      stream: false,
      exchanges: [{
        // The denial travels as a tool_result the model reads as an error,
        // not as ordinary tool output, which invites a corrected retry.
        expect: (request) =>
          assertEquals(requestBody(request.body).messages[2], {
            role: "user",
            content: [{
              type: "tool_result",
              tool_use_id: "tu-bad",
              content:
                "invalid arguments for read_file: missing required argument: path",
              is_error: true,
            }],
          }),
        respond: reply,
      }],
      expect: { result: { text: "ok" } },
    },
    "the stream carries cache usage and skips non-data lines": {
      model: claude,
      env,
      stream: true,
      exchanges: [{
        respond: {
          body: lines(
            "event: message_start",
            'data: {"type":"message_start","message":{"usage":{"input_tokens":12,"cache_read_input_tokens":4000,"cache_creation_input_tokens":100}}}',
            "event: content_block_delta",
            'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}',
            'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":9}}',
            'data: {"type":"message_stop"}',
          ),
        },
      }],
      expect: {
        frames: ["Hel"],
        result: {
          text: "Hel",
          stopReason: "stop",
          usage: { input: 12, output: 9, cacheRead: 4000, cacheWrite: 100 },
        },
      },
    },
  },
});
