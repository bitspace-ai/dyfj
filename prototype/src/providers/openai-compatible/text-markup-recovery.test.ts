// Textual tool-call recovery on the OpenAI-compatible path: calls a local
// model leaks as `<tool_call><function=...>` markup in its text are recovered
// into structured tool calls (streamed and buffered), and markup that does
// not name an offered tool, or is not properly wrapped, stays prose.

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

describe("runWorkbenchTurn streaming", () => {
  it("recovers multiple textual calls from SSE without warning metadata", async () => {
    const markup =
      "<tool_call><function=read_file><parameter=path>README.md</parameter></function></tool_call>" +
      "<tool_call><function=list_files><parameter=path>.</parameter></function></tool_call>";
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: sse([
          { choices: [{ delta: { content: markup } }] },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ]),
      },
    }]);
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
    transport.assertDone();

    assertEquals(result.toolCalls, [
      {
        id: "text-tool-1",
        name: "read_file",
        arguments: { path: "README.md" },
      },
      { id: "text-tool-2", name: "list_files", arguments: { path: "." } },
    ]);
    assertStrictEquals(result.unparsedToolCallMarkup, undefined);
  });

  it("withholds a standalone wrapper until the next delta confirms an offered tool", async () => {
    const deltas: string[] = [];
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: sse([
          { choices: [{ delta: { content: "I'll check. <tool_call>" } }] },
          {
            choices: [{
              delta: {
                content:
                  "<function=list_files><parameter=path>.</parameter></function></tool_call>",
              },
            }],
          },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ]),
      },
    }]);
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "list files",
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
    transport.assertDone();

    assertStrictEquals(deltas.join(""), "I'll check. ");
    assertEquals(result.toolCalls, [
      { id: "text-tool-1", name: "list_files", arguments: { path: "." } },
    ]);
  });

  it("recovers a leaked tool call from a buffered (non-streamed) turn", async () => {
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: JSON.stringify({
          choices: [{
            message: {
              content:
                "<tool_call><function=list_files><parameter=path>.</parameter></function></tool_call>",
            },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 5, completion_tokens: 10 },
        }),
      },
    }]);
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "list files",
      routing: { modelId: "gemma4:e2b" },
      models,
      tools: [{
        name: "list_files",
        description: "List files.",
        parameters: { type: "object" },
      }],
      fetchFn: transport.fetch,
    });
    transport.assertDone();

    assertEquals(result.toolCalls, [
      { id: "text-tool-1", name: "list_files", arguments: { path: "." } },
    ]);
    assertStrictEquals(result.stopReason, "tool_use");
  });

  it("recovers multiple textual calls from JSON without warning metadata", async () => {
    const markup =
      "<tool_call><function=read_file><parameter=path>README.md</parameter></function></tool_call>" +
      "<tool_call><function=list_files><parameter=path>.</parameter></function></tool_call>";
    const transport = new ScriptedHttpTransport([{
      respond: () =>
        Response.json({
          choices: [{
            message: { content: markup },
            finish_reason: "stop",
          }],
        }),
    }]);
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
      fetchFn: transport.fetch,
    });
    transport.assertDone();

    assertEquals(result.toolCalls, [
      {
        id: "text-tool-1",
        name: "read_file",
        arguments: { path: "README.md" },
      },
      { id: "text-tool-2", name: "list_files", arguments: { path: "." } },
    ]);
    assertStrictEquals(result.unparsedToolCallMarkup, undefined);
  });

  it("does not recover a textual call to a tool that was not offered", async () => {
    const text =
      "<function=write_file><parameter=path>x</parameter></function>";
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: JSON.stringify({
          choices: [{
            message: { content: text },
            finish_reason: "stop",
          }],
        }),
      },
    }]);
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "explain",
      routing: { modelId: "gemma4:e2b" },
      models,
      tools: [{
        name: "list_files",
        description: "List files.",
        parameters: { type: "object" },
      }],
      fetchFn: transport.fetch,
    });
    transport.assertDone();

    assertStrictEquals(result.text, text);
    assertStrictEquals(result.toolCalls, undefined);
    assertStrictEquals(result.stopReason, "stop");
  });

  it("does not recover an unwrapped textual call to an offered tool", async () => {
    const text =
      "Example: <function=list_files><parameter=path>.</parameter></function>";
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: JSON.stringify({
          choices: [{
            message: { content: text },
            finish_reason: "stop",
          }],
        }),
      },
    }]);
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "explain syntax",
      routing: { modelId: "gemma4:e2b" },
      models,
      tools: [{
        name: "list_files",
        description: "List files.",
        parameters: { type: "object" },
      }],
      fetchFn: transport.fetch,
    });
    transport.assertDone();

    assertStrictEquals(result.text, text);
    assertStrictEquals(result.toolCalls, undefined);
  });

  it("does not recover an offered call with an unclosed wrapper", async () => {
    const text =
      "<tool_call><function=list_files><parameter=path>.</parameter></function>";
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: JSON.stringify({
          choices: [{
            message: { content: text },
            finish_reason: "stop",
          }],
        }),
      },
    }]);
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "explain syntax",
      routing: { modelId: "gemma4:e2b" },
      models,
      tools: [{
        name: "list_files",
        description: "List files.",
        parameters: { type: "object" },
      }],
      fetchFn: transport.fetch,
    });
    transport.assertDone();

    assertStrictEquals(result.text, text);
    assertStrictEquals(result.toolCalls, undefined);
  });

  it("preserves unoffered function prose while recovering a later offered call", async () => {
    const deltas: string[] = [];
    const text = "Example: <function=write_file>not available</function>. " +
      "<tool_call><function=list_files><parameter=path>.</parameter></function></tool_call>";
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: sse([
          { choices: [{ delta: { content: text } }] },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ]),
      },
    }]);
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "explain then list",
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
    transport.assertDone();

    const prose = "Example: <function=write_file>not available</function>.";
    assertStrictEquals(deltas.join(""), `${prose} `);
    assertStrictEquals(result.text, `${prose} `);
    assertEquals(result.toolCalls, [
      { id: "text-tool-1", name: "list_files", arguments: { path: "." } },
    ]);
  });

  it("streams ordinary text after a complete offered call", async () => {
    const deltas: string[] = [];
    const text =
      "  before <tool_call><function=list_files><parameter=path>.</parameter></function></tool_call> after  ";
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: sse([
          { choices: [{ delta: { content: text } }] },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ]),
      },
    }]);
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "list files",
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
    transport.assertDone();

    assertEquals(deltas, ["  before ", " after  "]);
    assertStrictEquals(result.text, "  before  after  ");
    assertEquals(result.toolCalls, [
      { id: "text-tool-1", name: "list_files", arguments: { path: "." } },
    ]);
  });

  it("fails boundedly when textual marker limits cross after hidden calls", async () => {
    const call =
      "<tool_call><function=list_files><parameter=path>.</parameter></function></tool_call>";
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: sse(Array.from(
          { length: 65 },
          () => ({ choices: [{ delta: { content: call } }] }),
        )),
      },
    }]);
    await assertRejects(
      () =>
        runWorkbenchTurn({
          systemPrompt: "system",
          prompt: "list files",
          routing: { modelId: "gemma4:e2b" },
          models,
          tools: [{
            name: "list_files",
            description: "List files.",
            parameters: { type: "object" },
          }],
          onTextDelta: () => {},
          fetchFn: transport.fetch,
        }),
      Error,
      "Provider returned too many textual tool-call markers",
    );
    transport.assertDone();
  });

  it("keeps live and durable text aligned after a complete call and incomplete suffix", async () => {
    const deltas: string[] = [];
    const complete =
      "<tool_call><function=list_files><parameter=path>.</parameter></function></tool_call>";
    const incomplete =
      "<tool_call><function=read_file><parameter=path>README.md";
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: sse([
          {
            choices: [{
              delta: {
                content: `before ${complete} between ${incomplete}`,
              },
            }],
          },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ]),
      },
    }]);
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "inspect files",
      routing: { modelId: "gemma4:e2b" },
      models,
      tools: [{
        name: "list_files",
        description: "List files.",
        parameters: { type: "object" },
      }, {
        name: "read_file",
        description: "Read a file.",
        parameters: { type: "object" },
      }],
      onTextDelta: (delta) => deltas.push(delta),
      fetchFn: transport.fetch,
    });
    transport.assertDone();

    assertStrictEquals(deltas.join(""), "before  between ");
    assertStrictEquals(result.text, "before  between ");
    assertEquals(result.toolCalls, [
      { id: "text-tool-1", name: "list_files", arguments: { path: "." } },
    ]);
  });

  it("does not retain an incomplete offered call hidden from live output", async () => {
    const deltas: string[] = [];
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: sse([
          {
            choices: [{
              delta: {
                content: "answer<tool_call><function=list_files>",
              },
            }],
          },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ]),
      },
    }]);
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "list files",
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
    transport.assertDone();

    assertStrictEquals(deltas.join(""), "answer");
    assertStrictEquals(result.text, "answer");
    assertStrictEquals(result.toolCalls, undefined);
  });
});
