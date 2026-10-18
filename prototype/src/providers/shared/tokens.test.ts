// Unit tests for token estimates and time-per-output-token timings.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  estimateTextTokens,
  messageEstimateText,
  withTimePerOutputToken,
} from "./tokens.ts";

describe("estimateTextTokens", () => {
  it("uses a conservative four-character estimate", () => {
    assert.strictEqual(estimateTextTokens("12345678"), 2);
  });
});

describe("messageEstimateText", () => {
  it("counts an assistant turn's text and tool calls", () => {
    const toolCalls = [{ id: "t1", name: "list_files", arguments: {} }];
    assert.strictEqual(
      messageEstimateText({ role: "assistant", content: "hi", toolCalls }),
      "hi" + JSON.stringify(toolCalls),
    );
  });

  it("counts a turn with a reply to replay as the blocks it sends", () => {
    const content = [
      { type: "thinking", thinking: "", signature: "s".repeat(4000) },
      { type: "text", text: "hi" },
    ];
    assert.strictEqual(
      messageEstimateText({
        role: "assistant",
        content: "hi",
        replay: { api: "anthropic-messages", prefixDigest: "d", content },
      }),
      JSON.stringify(content),
    );
  });

  it("counts a user or tool message as its content", () => {
    assert.strictEqual(
      messageEstimateText({ role: "user", content: "hello" }),
      "hello",
    );
  });
});

describe("withTimePerOutputToken", () => {
  it("uses post-first-token generation time for streaming TPOT", () => {
    assert.strictEqual(
      withTimePerOutputToken({
        responseHeadersMs: 10,
        timeToFirstTokenMs: 40,
        generationMs: 60,
        totalMs: 100,
      }, 4).timePerOutputTokenMs,
      20,
    );
  });

  it("does not label total latency as TPOT without streaming timing", () => {
    assert.strictEqual(
      withTimePerOutputToken({
        responseHeadersMs: 10,
        totalMs: 80,
      }, 4).timePerOutputTokenMs,
      undefined,
    );
  });
});
