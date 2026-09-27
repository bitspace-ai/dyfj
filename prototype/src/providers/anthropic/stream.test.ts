import { describe, it } from "@std/testing/bdd";
import {
  assertExists,
  assertObjectMatch,
  assertStrictEquals,
} from "@std/assert";
import { parseAnthropicStreamLine } from "./stream.ts";

/** Parses a line the test expects to yield an event. */
function parsed(line: string) {
  const event = parseAnthropicStreamLine(line);
  assertExists(event);
  return event;
}

describe("anthropic provider adapter", () => {
  it("parseAnthropicStreamLine extracts deltas, usage, and stop reason", () => {
    assertObjectMatch(
      parsed(
        'data: {"type":"message_start","message":{"usage":{"input_tokens":12,"cache_read_input_tokens":4000,"cache_creation_input_tokens":100}}}',
      ),
      {
        inputTokens: 12,
        cacheReadTokens: 4000,
        cacheWriteTokens: 100,
      },
    );
    assertObjectMatch(
      parsed(
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}',
      ),
      { textDelta: "Hel" },
    );
    assertObjectMatch(
      parsed(
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":9}}',
      ),
      { stopReason: "end_turn", outputTokens: 9 },
    );
    assertObjectMatch(parsed('data: {"type":"message_stop"}'), {
      done: true,
    });
    assertStrictEquals(parseAnthropicStreamLine("event: message_start"), null);
  });
});
