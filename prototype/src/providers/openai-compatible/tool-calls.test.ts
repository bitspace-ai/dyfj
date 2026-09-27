// Turn-level tool-call handling for the OpenAI-compatible adapter: structured
// calls, mixed structured and textual calls, argument bounds, and flags for
// tool-call markup that did not parse.

import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { ScriptedHttpTransport } from "../../../testing/fakes/scripted-http-transport.ts";
import { runWorkbenchTurn } from "../mod.ts";
import { providerTestModels } from "../../../testing/builders/models.ts";

const models = [...providerTestModels];
function sse(chunks: unknown[]): string {
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") +
    "data: [DONE]\n\n";
}

function sseTransport(chunks: unknown[]): ScriptedHttpTransport {
  return new ScriptedHttpTransport([{ respond: { body: sse(chunks) } }]);
}

describe("runWorkbenchTurn streaming", () => {
  it("removes textual tool markup when a structured call is also present", async () => {
    const deltas: string[] = [];
    const text =
      "before <tool_call><function=list_files><parameter=depth>1</parameter><parameter=path>.</parameter></function></tool_call> after";
    const transport = sseTransport([
      {
        choices: [{
          delta: {
            content: text,
            tool_calls: [{
              index: 0,
              id: "tc-1",
              type: "function",
              function: {
                name: "list_files",
                arguments: '{"path":".","depth":1}',
              },
            }],
          },
        }],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ]);
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "list the files",
      routing: { modelId: "gemma4:e2b" },
      models,
      tools: [{
        name: "list_files",
        description: "List files.",
        parameters: { type: "object" },
      }],
      onTextDelta: (delta) => deltas.push(delta),
      fetchFn: transport.fetch,
    });

    assertStrictEquals(deltas.join(""), "before  after");
    assertStrictEquals(result.text, "before  after");
    assertEquals(result.toolCalls, [
      {
        id: "tc-1",
        name: "list_files",
        arguments: { path: ".", depth: 1 },
      },
    ]);
    transport.assertDone();
  });

  it("retains a distinct textual call alongside a structured call", async () => {
    const text =
      "<tool_call><function=list_files><parameter=path>.</parameter></function></tool_call>";
    const transport = sseTransport([
      {
        choices: [{
          delta: {
            content: text,
            tool_calls: [{
              index: 0,
              id: "tc-1",
              type: "function",
              function: {
                name: "read_file",
                arguments: '{"path":"README.md"}',
              },
            }],
          },
        }],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ]);
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "read and list",
      routing: { modelId: "gemma4:e2b" },
      models,
      tools: [
        {
          name: "read_file",
          description: "Read a file.",
          parameters: { type: "object" },
        },
        {
          name: "list_files",
          description: "List files.",
          parameters: { type: "object" },
        },
      ],
      onTextDelta: () => {},
      fetchFn: transport.fetch,
    });

    assertStrictEquals(result.text, "");
    assertEquals(result.toolCalls, [
      { id: "tc-1", name: "read_file", arguments: { path: "README.md" } },
      { id: "text-tool-1", name: "list_files", arguments: { path: "." } },
    ]);
    transport.assertDone();
  });

  it("rejects deeply nested structured arguments before mixed-call recovery", async () => {
    let deepArguments = '{"leaf":true}';
    for (let depth = 0; depth < 10_000; depth += 1) {
      deepArguments = `{"nested":${deepArguments}}`;
    }
    const text =
      "<tool_call><function=read_file><parameter=path>other.md</parameter></function></tool_call>";
    const transport = sseTransport([
      {
        choices: [{
          delta: {
            content: text,
            tool_calls: [{
              index: 0,
              id: "tc-1",
              type: "function",
              function: {
                name: "read_file",
                arguments: `{"payload":${deepArguments}}`,
              },
            }],
          },
        }],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ]);
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "read and list",
      routing: { modelId: "gemma4:e2b" },
      models,
      tools: [{
        name: "read_file",
        description: "Read a file.",
        parameters: { type: "object" },
      }],
      onTextDelta: () => {},
      fetchFn: transport.fetch,
    });

    await assertRejects(
      () => pending,
      Error,
      "Provider returned oversized tool arguments",
    );
    transport.assertDone();
  });

  it("rejects overly wide structured arguments before mixed-call recovery", async () => {
    const wideArguments = `{
      ${
      Array.from({ length: 10_000 }, (_, index) => `"k${index}":${index}`).join(
        ",",
      )
    }
    }`;
    const text =
      "<tool_call><function=read_file><parameter=path>other.md</parameter></function></tool_call>";
    const transport = sseTransport([
      {
        choices: [{
          delta: {
            content: text,
            tool_calls: [{
              index: 0,
              id: "tc-1",
              type: "function",
              function: {
                name: "read_file",
                arguments: `{"payload":${wideArguments}}`,
              },
            }],
          },
        }],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ]);
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "read",
      routing: { modelId: "gemma4:e2b" },
      models,
      tools: [{
        name: "read_file",
        description: "Read a file.",
        parameters: { type: "object" },
      }],
      onTextDelta: () => {},
      fetchFn: transport.fetch,
    });

    await assertRejects(
      () => pending,
      Error,
      "Provider returned oversized tool arguments",
    );
    transport.assertDone();
  });

  it("over-budget textual tool arguments remain prose", async () => {
    let deep = "true";
    for (let depth = 0; depth < 65; depth += 1) deep = `{"nested":${deep}}`;
    const wide = `{
      ${
      Array.from({ length: 1_025 }, (_, index) => `"k${index}":${index}`).join(
        ",",
      )
    }
    }`;
    const long = JSON.stringify("x".repeat(64 * 1_024));

    for (const raw of [deep, wide, long]) {
      const markup =
        `<tool_call><function=read_file><parameter=payload>${raw}</parameter></function></tool_call>`;
      const deltas: string[] = [];
      const transport = sseTransport([{
        choices: [{
          delta: { content: markup },
          finish_reason: "stop",
        }],
      }]);
      const result = await runWorkbenchTurn({
        systemPrompt: "system",
        prompt: "read",
        routing: { modelId: "gemma4:e2b" },
        models,
        tools: [{
          name: "read_file",
          description: "Read a file.",
          parameters: { type: "object" },
        }],
        onTextDelta: (delta) => deltas.push(delta),
        fetchFn: transport.fetch,
      });

      assertStrictEquals(result.text, markup);
      assertStrictEquals(result.toolCalls, undefined);
      assertEquals(deltas, [markup]);
      transport.assertDone();
    }
  });

  it("flags repeated unmatched tool-call openings without creating calls", async () => {
    const malformed = Array.from(
      { length: 71 },
      (_, index) =>
        `<tool_call>\n${index % 2 === 0 ? "edit_file" : "read_file"}\n`,
    ).join("") + "</tool_call>";
    const transport = new ScriptedHttpTransport([{
      respond: () =>
        Response.json({
          choices: [{
            message: { content: malformed },
            finish_reason: "stop",
          }],
        }),
    }]);
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "make the change",
      routing: { modelId: "gemma4:e2b" },
      models,
      tools: [
        {
          name: "edit_file",
          description: "Edit a file.",
          parameters: { type: "object" },
        },
        {
          name: "read_file",
          description: "Read a file.",
          parameters: { type: "object" },
        },
      ],
      fetchFn: transport.fetch,
    });

    assertStrictEquals(result.text, malformed);
    assertStrictEquals(result.toolCalls, undefined);
    assertEquals(result.unparsedToolCallMarkup, {
      count: 64,
      countIsLowerBound: true,
    });
    transport.assertDone();
  });

  it("flags streamed unparsed openings while preserving visible text", async () => {
    const malformed =
      "before <tool_call>\nedit_file\n<tool_call>\nread_file\n after";
    const deltas: string[] = [];
    const transport = sseTransport([{
      choices: [{
        delta: { content: malformed },
        finish_reason: "stop",
      }],
    }]);
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "make the change",
      routing: { modelId: "gemma4:e2b" },
      models,
      tools: [{
        name: "edit_file",
        description: "Edit a file.",
        parameters: { type: "object" },
      }],
      onTextDelta: (delta) => deltas.push(delta),
      fetchFn: transport.fetch,
    });

    assertStrictEquals(deltas.join(""), malformed);
    assertStrictEquals(result.text, malformed);
    assertStrictEquals(result.toolCalls, undefined);
    assertEquals(result.unparsedToolCallMarkup, {
      count: 2,
      countIsLowerBound: false,
    });
    transport.assertDone();
  });

  it("accumulates fragmented tool-call arguments by index (hosted OpenAI shape)", async () => {
    const transport = sseTransport([
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "tc-2",
              type: "function",
              function: { name: "read_file" },
            }],
          },
        }],
      },
      {
        choices: [{
          delta: {
            tool_calls: [{ index: 0, function: { arguments: '{"path":' } }],
          },
        }],
      },
      {
        choices: [{
          delta: {
            tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }],
          },
          finish_reason: "tool_calls",
        }],
      },
    ]);
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "read a file",
      routing: { modelId: "gemma4:e2b" },
      models,
      onTextDelta: () => {},
      fetchFn: transport.fetch,
    });

    assertEquals(result.toolCalls, [
      { id: "tc-2", name: "read_file", arguments: { path: "a.ts" } },
    ]);
    transport.assertDone();
  });

  it("rejects oversized structured tool arguments before parsing them", async () => {
    const oversized = `{"payload":"${"x".repeat(64 * 1_024)}"}`;
    const common = {
      systemPrompt: "system",
      prompt: "read a file",
      routing: { modelId: "gemma4:e2b" },
      models,
    };

    const buffered = new ScriptedHttpTransport([{
      respond: () =>
        Response.json({
          choices: [{
            message: {
              content: "",
              tool_calls: [{
                id: "tc-buffered",
                type: "function",
                function: { name: "read_file", arguments: oversized },
              }],
            },
            finish_reason: "tool_calls",
          }],
        }),
    }]);
    await assertRejects(
      () => runWorkbenchTurn({ ...common, fetchFn: buffered.fetch }),
      Error,
      "Provider returned oversized tool arguments",
    );
    buffered.assertDone();

    const streamed = sseTransport([{
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: "tc-streamed",
            type: "function",
            function: { name: "read_file", arguments: oversized },
          }],
        },
        finish_reason: "tool_calls",
      }],
    }]);
    await assertRejects(
      () =>
        runWorkbenchTurn({
          ...common,
          onTextDelta: () => {},
          fetchFn: streamed.fetch,
        }),
      Error,
      "Provider returned oversized tool arguments",
    );
    streamed.assertDone();
  });
});

describe("runWorkbenchTurn tool calls", () => {
  it("returns requested model tool calls without executing them", async () => {
    const body = JSON.stringify({
      choices: [
        {
          message: {
            content: "",
            tool_calls: [
              {
                id: "call-memory",
                type: "function",
                function: {
                  name: "memory.read",
                  arguments: '{"slug":"project_dyfj"}',
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 1 },
    });
    const transport = new ScriptedHttpTransport([
      { respond: { status: 200, body } },
    ]);

    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "read memory",
      routing: { modelId: "gemma4:e2b" },
      models,
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
      fetchFn: transport.fetch,
    });

    assertStrictEquals(result.stopReason, "tool_use");
    assertEquals(result.toolCalls, [
      {
        id: "call-memory",
        name: "memory.read",
        arguments: { slug: "project_dyfj" },
      },
    ]);
    transport.assertDone();
  });
});
