import { describe, it } from "@std/testing/bdd";
import { assertEquals, assertStrictEquals } from "@std/assert";
import { parseGeminiStreamLine } from "./stream.ts";

describe("parseGeminiStreamLine", () => {
  it("extracts text and usage from an SSE data line", () => {
    const event = parseGeminiStreamLine(
      'data: {"candidates":[{"content":{"parts":[{"text":"hi"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":2}}',
    );
    assertEquals(event, {
      done: false,
      textDelta: "hi",
      stopReason: "STOP",
      inputTokens: 7,
      outputTokens: 2,
      // The parser sets the key even when the frame reports no thinking
      // tokens; std assertEquals distinguishes that from an absent key.
      reasoningTokens: undefined,
    });
  });

  it("ignores blank and non-data lines", () => {
    assertStrictEquals(parseGeminiStreamLine(""), null);
    assertStrictEquals(parseGeminiStreamLine("event: message"), null);
  });

  it("excludes thinking parts from the text delta", () => {
    const event = parseGeminiStreamLine(
      'data: {"candidates":[{"content":{"parts":[{"text":"secret reasoning","thought":true},{"text":"the answer"}]}}]}',
    );
    assertStrictEquals(event?.textDelta, "the answer");
    assertStrictEquals(
      event?.reasoningCharacters,
      "secret reasoning".length,
    );
  });

  it("surfaces thinking-token usage separately from visible output", () => {
    const event = parseGeminiStreamLine(
      'data: {"candidates":[{"content":{"parts":[{"text":"hi"}]},"finishReason":"MAX_TOKENS"}],"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":2,"thoughtsTokenCount":140}}',
    );
    // candidatesTokenCount is visible output; thoughtsTokenCount is the
    // reasoning that also drew from the output budget.
    assertStrictEquals(event?.outputTokens, 2);
    assertStrictEquals(event?.reasoningTokens, 140);
  });
});
