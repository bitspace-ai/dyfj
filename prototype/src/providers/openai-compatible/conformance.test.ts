// The OpenAI-compatible adapter against the provider conformance kit.

import {
  assertEquals,
  assertFalse,
  assertObjectMatch,
  assertStrictEquals,
} from "@std/assert";
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

/** A buffered reply, for cases that pin only the request. */
const reply = {
  body: JSON.stringify({
    choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  }),
};

/** A streamed reply, for cases that pin only the request. */
const streamedReply = {
  body: sse([
    { choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] },
  ]),
};

const requestBody = (body: string) => JSON.parse(body);

const memoryRead = {
  name: "memory.read",
  description: "Load one Dolt-backed memory by slug.",
  parameters: {
    type: "object",
    required: ["slug"],
    properties: { slug: { type: "string" } },
    additionalProperties: false,
  },
};

// Tool names that collide once made wire-safe, or exceed the 64-character
// limit: every request must name them the same way, offered or historical.
const collidingTools = [
  { name: "memory.read", description: "a", parameters: {} },
  { name: "memory_read", description: "b", parameters: {} },
  { name: "x".repeat(64) + ".second", description: "c", parameters: {} },
  { name: "x".repeat(64) + ".third", description: "d", parameters: {} },
];
const collidingHistory = [{
  role: "assistant" as const,
  content: "Gathering context.",
  toolCalls: collidingTools.map((tool, index) => ({
    id: `call-${index}`,
    name: tool.name,
    arguments: {},
  })),
}];
const collidingWireNames = [
  "memory_read",
  "memory_read_1",
  "x".repeat(64),
  `${"x".repeat(60)}_3`,
];

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
  cases: {
    "a buffered local request carries only the conversation": {
      model: local,
      turn: { systemPrompt: "system", prompt: "hello" },
      stream: false,
      exchanges: [{
        expect: (request) =>
          assertEquals(requestBody(request.body), {
            model: "gemma4:e2b",
            stream: false,
            messages: [
              { role: "system", content: "system" },
              { role: "user", content: "hello" },
            ],
          }),
        respond: reply,
      }],
      expect: { result: { text: "ok" } },
    },
    "a streamed local request does not ask for streamed usage": {
      model: local,
      stream: true,
      exchanges: [{
        expect: (request) => {
          const body = requestBody(request.body);
          assertStrictEquals(body.stream, true);
          assertStrictEquals("stream_options" in body, false);
        },
        respond: streamedReply,
      }],
      expect: { result: { text: "ok" } },
    },
    "a streamed hosted request asks for usage and carries its ceiling": {
      model: hosted,
      env: { OPENAI_API_KEY: "sk-test-key" },
      turn: { maxOutputTokens: 8192 },
      stream: true,
      exchanges: [{
        expect: (request) => {
          const body = requestBody(request.body);
          assertEquals(body.stream_options, { include_usage: true });
          assertStrictEquals(body.max_completion_tokens, 8192);
        },
        respond: streamedReply,
      }],
      expect: { result: { text: "ok" } },
    },
    "a buffered hosted request carries no stream_options": {
      model: hosted,
      env: { OPENAI_API_KEY: "sk-test-key" },
      stream: false,
      exchanges: [{
        // stream_options is only valid on a streaming request.
        expect: (request) =>
          assertStrictEquals(
            "stream_options" in requestBody(request.body),
            false,
          ),
        respond: reply,
      }],
      expect: { result: { text: "ok" } },
    },
    "strict JSON output sets response_format": {
      model: local,
      turn: { jsonObject: true },
      stream: false,
      exchanges: [{
        expect: (request) =>
          assertObjectMatch(requestBody(request.body), {
            response_format: { type: "json_object" },
          }),
        respond: reply,
      }],
      expect: { result: { text: "ok" } },
    },
    "commands are offered as function tools": {
      model: local,
      turn: { tools: [memoryRead] },
      stream: false,
      exchanges: [{
        expect: (request) =>
          assertObjectMatch(requestBody(request.body), {
            tools: [{
              type: "function",
              function: {
                // Dotted command id sanitized to ^[a-zA-Z0-9_-]+$.
                name: "memory_read",
                description: memoryRead.description,
                parameters: memoryRead.parameters,
              },
            }],
            tool_choice: "auto",
          }),
        respond: reply,
      }],
      expect: { result: { text: "ok" } },
    },
    "a transcript maps to system, user, assistant and tool messages": {
      model: local,
      turn: {
        systemPrompt: "system",
        prompt: "seed",
        tools: [memoryRead],
        messages: [
          { role: "user", content: "what is this repo?" },
          {
            role: "assistant",
            content: "Reading memory.",
            toolCalls: [{
              id: "call-1",
              name: "memory.read",
              arguments: { slug: "project_dyfj" },
            }],
          },
          {
            role: "tool",
            toolCallId: "call-1",
            name: "memory.read",
            content: "# DYFJ",
          },
        ],
      },
      stream: false,
      exchanges: [{
        expect: (request) =>
          assertEquals(requestBody(request.body).messages, [
            { role: "system", content: "system" },
            { role: "user", content: "what is this repo?" },
            // The tool-call intentions: dotted name sanitized to the wire form
            // offered in `tools`, arguments serialized to a string.
            {
              role: "assistant",
              content: "Reading memory.",
              tool_calls: [{
                id: "call-1",
                type: "function",
                function: {
                  name: "memory_read",
                  arguments: JSON.stringify({ slug: "project_dyfj" }),
                },
              }],
            },
            // The result links back to the call by id; the seed prompt is
            // unused once history exists.
            { role: "tool", tool_call_id: "call-1", content: "# DYFJ" },
          ]),
        respond: reply,
      }],
      expect: { result: { text: "ok" } },
    },
    "offered tools get collision-free wire names": {
      model: local,
      turn: { tools: collidingTools, messages: collidingHistory },
      stream: false,
      exchanges: [{
        expect: (request) => {
          const body = requestBody(request.body);
          assertEquals(
            body.tools.map((tool: { function: { name: string } }) =>
              tool.function.name
            ),
            collidingWireNames,
          );
          assertEquals(
            body.messages[1].tool_calls.map((
              call: { function: { name: string } },
            ) => call.function.name),
            collidingWireNames,
          );
        },
        respond: reply,
      }],
      expect: { result: { text: "ok" } },
    },
    "a no-tools conclusion keeps historical tool calls wire-safe": {
      model: local,
      turn: { historyTools: collidingTools, messages: collidingHistory },
      stream: false,
      exchanges: [{
        expect: (request) => {
          const body = requestBody(request.body);
          assertFalse("tools" in body);
          assertFalse("tool_choice" in body);
          assertEquals(
            body.messages[1].tool_calls.map((
              call: { function: { name: string } },
            ) => call.function.name),
            collidingWireNames,
          );
          assertStrictEquals(
            collidingWireNames.every((name) => name.length <= 64),
            true,
          );
          // The caller's transcript keeps its registry names.
          assertEquals(
            collidingHistory[0].toolCalls.map((call) => call.name),
            collidingTools.map((tool) => tool.name),
          );
        },
        respond: reply,
      }],
      expect: { result: { text: "ok" } },
    },
    // The consumer does not stop reading at [DONE]; it ignores the sentinel
    // and ends at EOF. What is observable, and pinned here, is that the
    // sentinel is recognized rather than handed to JSON.parse, which would
    // throw and fail the turn.
    "the stream skips non-data lines and the [DONE] sentinel": {
      model: local,
      stream: true,
      exchanges: [{
        respond: {
          body: [
            "event: message\n\n",
            'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":"stop"}]}\n\n',
            "data: [DONE]\n\n",
          ],
        },
      }],
      expect: {
        frames: ["hello"],
        result: { text: "hello", stopReason: "stop" },
      },
    },
    "plaintext reasoning is counted once, not per legacy alias": {
      model: local,
      stream: true,
      exchanges: [{
        respond: {
          body: sse([
            {
              choices: [{
                delta: {
                  reasoning: "duplicate",
                  reasoning_details: [
                    { type: "reasoning.text", text: "private thought" },
                    { type: "reasoning.encrypted", data: "opaque" },
                  ],
                },
              }],
            },
            { choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] },
          ]),
        },
      }],
      expect: {
        frames: ["ok"],
        // No usage reported: reasoning is estimated from "private thought"
        // alone (15 characters, four per token), not from the alias too.
        result: { text: "ok", usage: { reasoning: 4 } },
      },
    },
    "reported reasoning tokens are taken from completion details": {
      model: local,
      stream: true,
      exchanges: [{
        respond: {
          body: sse([
            {
              choices: [{
                delta: {
                  reasoning_details: [
                    { type: "reasoning.text", text: "private thought" },
                  ],
                },
              }],
            },
            {
              choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
              usage: {
                prompt_tokens: 3,
                completion_tokens: 9,
                completion_tokens_details: { reasoning_tokens: 7 },
              },
            },
          ]),
        },
      }],
      expect: {
        frames: ["ok"],
        result: { text: "ok", usage: { reasoning: 7 } },
      },
    },
  },
});
