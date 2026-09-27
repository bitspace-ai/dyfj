import { describe, it } from "@std/testing/bdd";
import {
  assert,
  assertEquals,
  assertObjectMatch,
  assertStrictEquals,
} from "@std/assert";
import { buildAnthropicMessagesRequest } from "./request.ts";

describe("anthropic provider adapter", () => {
  it("buildAnthropicMessagesRequest puts cache_control on the stable system block", () => {
    const body = buildAnthropicMessagesRequest(
      "claude-haiku-4-5",
      "You are the workbench.",
      "Say hi.",
      false,
      { jsonObject: true },
    );
    assertObjectMatch(body.system[0], {
      text: "You are the workbench.",
      cache_control: { type: "ephemeral" },
    });
    assertStrictEquals(body.system[1].cache_control, undefined);
    assert(body.max_tokens > 0, "max_tokens should be positive");
    assertEquals(body.messages, [{ role: "user", content: "Say hi." }]);
  });

  it("buildAnthropicMessagesRequest maps tools to input_schema shape", () => {
    const body = buildAnthropicMessagesRequest(
      "claude-haiku-4-5",
      "sys",
      "prompt",
      false,
      {
        tools: [{
          name: "memory.read",
          description: "Read a memory",
          parameters: { type: "object", properties: {} },
        }],
      },
    );
    assertEquals(body.tools, [{
      name: "memory_read",
      description: "Read a memory",
      input_schema: { type: "object", properties: {} },
    }]);
  });

  it("buildAnthropicMessagesRequest maps a transcript to tool_use/tool_result blocks", () => {
    const tools = [{
      name: "memory.read",
      description: "Read a memory",
      parameters: { type: "object", properties: {} },
    }];
    const body = buildAnthropicMessagesRequest(
      "claude-haiku-4-5",
      "sys",
      "seed",
      false,
      {
        tools,
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
    );

    // System stays top-level; the seed `prompt` is not used when history exists.
    assertObjectMatch(body.system[0], { text: "sys" });
    assertEquals(body.messages[0], {
      role: "user",
      content: "what is this repo?",
    });
    // Assistant turn: text block + one tool_use block per call (name sanitized).
    assertEquals(body.messages[1], {
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
    });
    // Consecutive tool results merge into ONE following user turn (Anthropic shape).
    assertEquals(body.messages[2], {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu-1", content: "A" },
        { type: "tool_result", tool_use_id: "tu-2", content: "B" },
      ],
    });
    assertEquals(body.messages.length, 3);
  });

  it("buildAnthropicMessagesRequest flags failed tool results with is_error", () => {
    const tools = [{
      name: "read_file",
      description: "Read a file",
      parameters: { type: "object", properties: {} },
    }];
    const body = buildAnthropicMessagesRequest(
      "claude-haiku-4-5",
      "sys",
      "seed",
      false,
      {
        tools,
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
    );

    // The denial travels as a tool_result the model reads as an ERROR — not as
    // ordinary tool output — which is what invites a corrected retry.
    assertEquals(body.messages[2], {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu-bad",
          content:
            "invalid arguments for read_file: missing required argument: path",
          is_error: true,
        },
      ],
    });
  });
});
