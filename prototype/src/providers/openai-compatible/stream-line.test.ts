// Unit tests for parsing one OpenAI-compatible chat SSE line.

import { assertEquals, assertStrictEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { parseOpenAIChatStreamLine } from "./stream.ts";

describe("parseOpenAIChatStreamLine", () => {
  it("extracts text deltas and finish reason from SSE data lines", () => {
    const event = parseOpenAIChatStreamLine(
      'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":"stop"}]}',
    );

    assertEquals(event, {
      done: false,
      textDelta: "hello",
      finishReason: "stop",
      usage: undefined,
      reasoningDelta: undefined,
      toolCallDeltas: undefined,
    });
  });

  it("recognizes stream completion sentinel", () => {
    assertEquals(parseOpenAIChatStreamLine("data: [DONE]"), { done: true });
  });

  it("extracts streamed tool-call deltas", () => {
    const event = parseOpenAIChatStreamLine(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"list_files","arguments":"{\\"path\\":\\".\\"}"}}]}}]}',
    );
    assertEquals(event?.toolCallDeltas, [
      {
        index: 0,
        id: "call-1",
        name: "list_files",
        argumentsFragment: '{"path":"."}',
      },
    ]);
  });

  it("extracts plaintext reasoning without duplicating legacy aliases", () => {
    const event = parseOpenAIChatStreamLine(
      'data: {"choices":[{"delta":{"reasoning":"duplicate","reasoning_details":[{"type":"reasoning.text","text":"private thought"},{"type":"reasoning.encrypted","data":"opaque"}]}}],"usage":{"completion_tokens":9,"completion_tokens_details":{"reasoning_tokens":7}}}',
    );

    assertStrictEquals(event?.reasoningDelta, "private thought");
    assertEquals(event?.usage, {
      completion_tokens: 9,
      completion_tokens_details: { reasoning_tokens: 7 },
    });
  });

  it("ignores blank and non-data lines", () => {
    assertStrictEquals(parseOpenAIChatStreamLine(""), null);
    assertStrictEquals(parseOpenAIChatStreamLine("event: message"), null);
  });
});
