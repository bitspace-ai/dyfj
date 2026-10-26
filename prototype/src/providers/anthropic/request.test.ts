// The history's cache breakpoints (BIT-717): where they go, how many there
// are, and that they change only what a request costs. Stripped of the
// markers, each request is what the model read before, and one step's
// request is a prefix of the next one's.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WorkbenchMessage, WorkbenchToolDefinition } from "../types.ts";
import {
  anthropicReplyPrefixDigest,
  buildAnthropicMessagesRequest,
} from "./request.ts";

const tools: WorkbenchToolDefinition[] = [{
  name: "read_file",
  description: "Read a file",
  parameters: { type: "object", properties: {} },
}];

const MARK = { type: "ephemeral" };

/** A transcript after `steps` tool steps, each with `calls` parallel calls. */
function transcript(steps: number, calls = 1): WorkbenchMessage[] {
  const messages: WorkbenchMessage[] = [
    { role: "user", content: "read the repo" },
  ];
  for (let step = 1; step <= steps; step++) {
    const ids = Array.from({ length: calls }, (_, i) => `tu-${step}-${i}`);
    messages.push({
      role: "assistant",
      content: `step ${step}`,
      toolCalls: ids.map((id) => ({
        id,
        name: "read_file",
        arguments: { path: id },
      })),
    });
    for (const id of ids) {
      messages.push({
        role: "tool",
        toolCallId: id,
        name: "read_file",
        content: `contents of ${id}`,
      });
    }
  }
  return messages;
}

function build(messages: WorkbenchMessage[], offerTools = true) {
  return buildAnthropicMessagesRequest("claude-sonnet-5-5", "sys", "", false, {
    tools: offerTools ? tools : undefined,
    historyTools: tools,
    messages,
  });
}

type Body = ReturnType<typeof build>;

/** Where the markers are: [message index, block index]. */
function marks(body: Body): Array<[number, number]> {
  const found: Array<[number, number]> = [];
  body.messages.forEach((message, m) => {
    if (typeof message.content === "string") return;
    message.content.forEach((block, b) => {
      if ("cache_control" in block) found.push([m, b]);
    });
  });
  return found;
}

/** The request without its history markers, as the model reads it. */
function stripped(body: Body): unknown[] {
  return JSON.parse(JSON.stringify(body.messages)).map(
    (message: { role: string; content: unknown }) => {
      if (!Array.isArray(message.content)) return message;
      const content = message.content.map(
        (block: Record<string, unknown>) => {
          const { cache_control: _, ...rest } = block;
          return rest;
        },
      );
      return content.length === 1 && content[0].type === "text"
        ? { role: message.role, content: content[0].text }
        : { role: message.role, content };
    },
  );
}

function breakpointCount(body: Body): number {
  return JSON.stringify(body).split('"cache_control"').length - 1;
}

describe("anthropic history cache breakpoints", () => {
  it("mark the last block of the request and of the previous request", () => {
    const body = build(transcript(2));
    // user, assistant, user(results 1), assistant, user(results 2)
    assert.deepEqual(marks(body), [[2, 0], [4, 0]]);
    assert.deepEqual(body.messages[4].content, [{
      type: "tool_result",
      tool_use_id: "tu-2-0",
      content: "contents of tu-2-0",
      cache_control: MARK,
    }]);
  });

  it("mark only the last block of a step with many parallel calls", () => {
    const body = build(transcript(2, 12));
    assert.deepEqual(marks(body), [[2, 11], [4, 11]]);
  });

  it("send the prompt as one marked text block on the first call", () => {
    const body = build(transcript(0));
    assert.deepEqual(body.messages, [{
      role: "user",
      content: [{ type: "text", text: "read the repo", cache_control: MARK }],
    }]);
  });

  it("use at most four breakpoints, the system prompt's included", () => {
    for (const steps of [0, 1, 2, 5, 20]) {
      const body = build(transcript(steps, 3));
      assert.ok(breakpointCount(body) <= 4, `${steps} steps`);
      assert.equal(breakpointCount(body), steps === 0 ? 2 : 3, `${steps} steps`);
    }
  });

  it("change nothing the model reads", () => {
    for (const steps of [0, 1, 3]) {
      assert.deepEqual(stripped(build(transcript(steps))), [
        { role: "user", content: "read the repo" },
        ...transcript(steps).slice(1).reduce<unknown[]>((wire, message) => {
          if (message.role === "assistant") {
            wire.push({
              role: "assistant",
              content: [
                { type: "text", text: message.content },
                ...(message.toolCalls ?? []).map((call) => ({
                  type: "tool_use",
                  id: call.id,
                  name: call.name,
                  input: call.arguments,
                })),
              ],
            });
          } else if (message.role === "tool") {
            wire.push({
              role: "user",
              content: [{
                type: "tool_result",
                tool_use_id: message.toolCallId,
                content: message.content,
              }],
            });
          }
          return wire;
        }, []),
      ]);
    }
  });

  it("keep each step's request a prefix of the next step's", () => {
    for (let steps = 0; steps < 6; steps++) {
      const before = stripped(build(transcript(steps)));
      const after = stripped(build(transcript(steps + 1)));
      assert.deepEqual(after.slice(0, before.length), before);
    }
  });

  it("leave the reply digest unchanged by the markers", () => {
    // Thinking blocks are replayed only while the digest of what precedes
    // them matches the digest taken when they were produced.
    for (let steps = 0; steps < 4; steps++) {
      const sent = build(transcript(steps));
      const next = build(transcript(steps + 1));
      assert.equal(
        anthropicReplyPrefixDigest({
          ...next,
          messages: next.messages.slice(0, sent.messages.length),
        }),
        anthropicReplyPrefixDigest(sent),
      );
    }
  });

  it("leave a forced conclusion, which offers no tools, unmarked", () => {
    const body = build(transcript(2), false);
    assert.equal(body.tools, undefined);
    assert.deepEqual(marks(body), []);
    assert.equal(breakpointCount(body), 1);
  });

  it("mark a user text block that follows the tool results", () => {
    const body = build([
      ...transcript(1),
      { role: "user", content: "one more thing" },
    ]);
    assert.deepEqual(body.messages[2].content, [
      { type: "tool_result", tool_use_id: "tu-1-0", content: "contents of tu-1-0" },
      { type: "text", text: "one more thing", cache_control: MARK },
    ]);
    assert.deepEqual(marks(body), [[0, 0], [2, 1]]);
  });

  it("leave a request without a transcript unmarked", () => {
    const body = buildAnthropicMessagesRequest("claude-sonnet-5-5", "sys", "hi");
    assert.deepEqual(body.messages, [{ role: "user", content: "hi" }]);
    assert.equal(breakpointCount(body), 1);
  });

  it("leave an empty text block unmarked", () => {
    const body = build([{ role: "user", content: "" }]);
    assert.deepEqual(body.messages, [{ role: "user", content: "" }]);
  });
});
