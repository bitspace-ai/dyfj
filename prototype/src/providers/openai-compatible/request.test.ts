// Unit tests for building an OpenAI-compatible chat request body.

import {
  assertEquals,
  assertFalse,
  assertObjectMatch,
  assertStrictEquals,
} from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { buildOpenAIChatRequest } from "./request.ts";

describe("buildOpenAIChatRequest", () => {
  it("builds a non-streaming OpenAI-compatible chat request", () => {
    const body = buildOpenAIChatRequest("gemma4", "system", "hello");

    assertEquals(body, {
      model: "gemma4",
      stream: false,
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "hello" },
      ],
    });
  });

  it("can request an OpenAI-compatible streaming response", () => {
    const body = buildOpenAIChatRequest("gemma4", "system", "hello", true);

    assertStrictEquals(body.stream, true);
  });

  it("asks for streamed usage only when told to", () => {
    const plain = buildOpenAIChatRequest("hosted", "system", "hello", true);
    const metered = buildOpenAIChatRequest("hosted", "system", "hello", true, {
      includeStreamUsage: true,
    });
    const unstreamed = buildOpenAIChatRequest(
      "hosted",
      "system",
      "hello",
      false,
      { includeStreamUsage: true },
    );

    assertStrictEquals("stream_options" in plain, false);
    assertEquals(metered.stream_options, { include_usage: true });
    // stream_options is only valid on a streaming request.
    assertStrictEquals("stream_options" in unstreamed, false);
  });

  it("can carry an explicit completion ceiling", () => {
    const body = buildOpenAIChatRequest("hosted", "system", "hello", true, {
      maxCompletionTokens: 8192,
    });

    assertStrictEquals(body.max_completion_tokens, 8192);
  });

  it("can require strict JSON object output", () => {
    const body = buildOpenAIChatRequest("gemma4", "system", "hello", false, {
      jsonObject: true,
    });

    assertObjectMatch(body, {
      response_format: { type: "json_object" },
    });
  });

  it("can project commands as OpenAI-compatible tools", () => {
    const body = buildOpenAIChatRequest("gemma4", "system", "hello", false, {
      tools: [
        {
          name: "memory.read",
          description: "Load one Dolt-backed memory by slug.",
          parameters: {
            type: "object",
            required: ["slug"],
            properties: { slug: { type: "string" } },
            additionalProperties: false,
          },
        },
      ],
    });

    assertObjectMatch(body, {
      tools: [
        {
          type: "function",
          function: {
            // Dotted command id sanitized to OpenAI's ^[a-zA-Z0-9_-]+$ pattern.
            name: "memory_read",
            description: "Load one Dolt-backed memory by slug.",
            parameters: {
              type: "object",
              required: ["slug"],
              properties: { slug: { type: "string" } },
              additionalProperties: false,
            },
          },
        },
      ],
      tool_choice: "auto",
    });
  });

  it("maps a multi-step transcript to system + user/assistant/tool wire messages", () => {
    const tools = [
      {
        name: "memory.read",
        description: "Load one Dolt-backed memory by slug.",
        parameters: {
          type: "object",
          properties: { slug: { type: "string" } },
        },
      },
    ];
    const body = buildOpenAIChatRequest("gemma4", "system", "seed", false, {
      tools,
      messages: [
        { role: "user", content: "what is this repo?" },
        {
          role: "assistant",
          content: "Reading memory.",
          toolCalls: [
            {
              id: "call-1",
              name: "memory.read",
              arguments: { slug: "project_dyfj" },
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "call-1",
          name: "memory.read",
          content: "# DYFJ",
        },
      ],
    });

    assertEquals(body.messages[0], { role: "system", content: "system" });
    assertEquals(body.messages[1], {
      role: "user",
      content: "what is this repo?",
    });
    // Assistant turn carries the tool-call intentions; dotted name sanitized to
    // the same wire form offered in `tools`, arguments serialized to a string.
    assertEquals(body.messages[2], {
      role: "assistant",
      content: "Reading memory.",
      tool_calls: [
        {
          id: "call-1",
          type: "function",
          function: {
            name: "memory_read",
            arguments: JSON.stringify({ slug: "project_dyfj" }),
          },
        },
      ],
    });
    // Tool result links back to the call by id (the seed `prompt` is ignored).
    assertEquals(body.messages[3], {
      role: "tool",
      tool_call_id: "call-1",
      content: "# DYFJ",
    });
  });

  it("keeps historical tool calls wire-safe for a no-tools conclusion", () => {
    const tools = [
      { name: "memory.read", description: "a", parameters: {} },
      { name: "memory_read", description: "b", parameters: {} },
      {
        name: "x".repeat(64) + ".second",
        description: "c",
        parameters: {},
      },
      {
        name: "x".repeat(64) + ".third",
        description: "d",
        parameters: {},
      },
    ];
    const messages = [{
      role: "assistant" as const,
      content: "Gathering context.",
      toolCalls: tools.map((tool, index) => ({
        id: `call-${index}`,
        name: tool.name,
        arguments: {},
      })),
    }];
    const gather = buildOpenAIChatRequest("model", "system", "seed", false, {
      tools,
      messages,
    });
    const forced = buildOpenAIChatRequest("model", "system", "seed", false, {
      historyTools: tools,
      messages,
    });

    assertFalse("tools" in forced);
    assertFalse("tool_choice" in forced);
    const expectedWireNames = [
      "memory_read",
      "memory_read_1",
      "x".repeat(64),
      `${"x".repeat(60)}_3`,
    ];
    assertEquals(
      gather.tools?.map((tool) => tool.function.name),
      expectedWireNames,
    );
    assertEquals(
      forced.messages[1]?.tool_calls?.map((call) => call.function.name),
      expectedWireNames,
    );
    assertStrictEquals(
      expectedWireNames.every((name) => name.length <= 64),
      true,
    );
    assertEquals(
      messages[0].toolCalls.map((call) => call.name),
      tools.map((tool) => tool.name),
    );
  });
});
