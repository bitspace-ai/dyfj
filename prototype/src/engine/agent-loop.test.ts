/**
 * Unit tests for the agent loop's transcript builder: each tool step replays
 * as the assistant's tool-call turn followed by one linked tool message per
 * result.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { toolStepToMessages } from "./agent-loop.ts";

test("toolStepToMessages emits the assistant tool-call turn followed by linked tool results", () => {
  const toolCalls = [
    {
      id: "call-memory",
      name: "memory.read",
      arguments: { slug: "project_dyfj" },
    },
  ];
  const messages = toolStepToMessages(
    "Let me read the project memory.",
    toolCalls,
    [
      {
        commandId: "memory.read",
        callId: "call-memory",
        isError: false,
        result: "# Project DYFJ\n\nPublic repo context",
      },
    ],
  );

  assert.deepStrictEqual(messages.length, 2);
  // The assistant turn carries the model's own text + its tool-call intentions.
  assert.partialDeepStrictEqual(messages[0], {
    role: "assistant",
    content: "Let me read the project memory.",
    toolCalls,
  });
  // The tool result is linked back to the call by id (toolCallId === call id).
  assert.partialDeepStrictEqual(messages[1], {
    role: "tool",
    toolCallId: "call-memory",
    name: "memory.read",
    content: "# Project DYFJ\n\nPublic repo context",
  });
});

test("toolStepToMessages emits one tool message per result, preserving order and errors", () => {
  const messages = toolStepToMessages(
    "",
    [
      { id: "c1", name: "list_files", arguments: { path: "." } },
      { id: "c2", name: "memory.read", arguments: { slug: "missing" } },
    ],
    [
      {
        commandId: "list_files",
        callId: "c1",
        isError: false,
        result: "a.ts",
      },
      {
        commandId: "memory.read",
        callId: "c2",
        isError: true,
        result: "slug does not match required pattern",
      },
    ],
  );

  assert.deepStrictEqual(messages.map((m) => m.role), [
    "assistant",
    "tool",
    "tool",
  ]);
  assert.partialDeepStrictEqual(messages[1], {
    toolCallId: "c1",
    content: "a.ts",
  });
  assert.partialDeepStrictEqual(messages[2], {
    toolCallId: "c2",
    content: "slug does not match required pattern",
  });
});

test("toolStepToMessages marks failed results isError so wire formats can flag them", () => {
  const messages = toolStepToMessages(
    "",
    [{ id: "c1", name: "read_file", arguments: {} }],
    [
      {
        commandId: "read_file",
        callId: "c1",
        isError: true,
        result:
          "invalid arguments for read_file: missing required argument: path",
      },
    ],
  );

  assert.partialDeepStrictEqual(messages[1], {
    role: "tool",
    toolCallId: "c1",
    isError: true,
    content: "invalid arguments for read_file: missing required argument: path",
  });
  // Successful results carry no error mark at all (absent, not false).
  const ok = toolStepToMessages(
    "",
    [{ id: "c2", name: "list_files", arguments: { path: "." } }],
    [{ commandId: "list_files", callId: "c2", isError: false, result: "a" }],
  );
  assert.deepStrictEqual("isError" in ok[1], false);
});
