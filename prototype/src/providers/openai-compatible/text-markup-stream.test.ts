// Textual tool-call markup on the OpenAI-compatible streaming path: literal
// wrappers, names that only prefix an offered tool, and over-long whitespace
// gaps stream as prose, and an abort strips only a genuinely incomplete
// offered call from both the live deltas and the durable text.

import { assertEquals, assertStrictEquals } from "@std/assert";
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
  it("does not treat a tool_call-prefixed word as protocol markup", async () => {
    const deltas: string[] = [];
    const text = "Use <tool_calling> as the heading.";
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
      prompt: "explain syntax",
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

    assertStrictEquals(result.text, text);
    assertStrictEquals(deltas.join(""), text);
  });

  it("does not use tool_calling prose as the wrapper for a later tool call", async () => {
    const deltas: string[] = [];
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: sse([
          {
            choices: [{
              delta: {
                content: "Use <tool_calling> as a heading; ",
              },
            }],
          },
          {
            choices: [{
              delta: {
                content:
                  "<tool_call><function=list_files><parameter=path>.</parameter></function></tool_call>",
              },
            }],
          },
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

    assertStrictEquals(deltas.join(""), "Use <tool_calling> as a heading; ");
    assertStrictEquals(result.text, "Use <tool_calling> as a heading; ");
    assertEquals(result.toolCalls, [
      { id: "text-tool-1", name: "list_files", arguments: { path: "." } },
    ]);
  });

  it("preserves an unrelated literal tool_call wrapper before a later tool call", async () => {
    const deltas: string[] = [];
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: sse([
          {
            choices: [{
              delta: {
                content: "The literal marker is <tool_call> in this sentence. ",
              },
            }],
          },
          {
            choices: [{
              delta: {
                content:
                  "<tool_call><function=list_files><parameter=path>.</parameter></function></tool_call>",
              },
            }],
          },
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

    const narration = "The literal marker is <tool_call> in this sentence.";
    assertStrictEquals(deltas.join(""), `${narration} `);
    assertStrictEquals(result.text, `${narration} `);
    assertEquals(result.toolCalls, [
      { id: "text-tool-1", name: "list_files", arguments: { path: "." } },
    ]);
  });

  it("streams a large batch of literal wrapper markers as prose", async () => {
    const deltas: string[] = [];
    const text = Array.from(
      { length: 10_000 },
      (_, index) => `literal <tool_call> marker ${index}\n`,
    ).join("");
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
      prompt: "show markers",
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

    assertStrictEquals(deltas.join(""), text);
    assertStrictEquals(result.text, text);
    assertStrictEquals(result.toolCalls, undefined);
  });

  it("preserves a closed function name that only prefixes an offered tool", async () => {
    const abortController = new AbortController();
    const deltas: string[] = [];
    let received!: () => void;
    const sawText = new Promise<void>((resolve) => {
      received = resolve;
    });
    const text = "Use <function=list> literally";
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: `data: ${
          JSON.stringify({
            choices: [{ delta: { content: text } }],
          })
        }\n`,
        holdOpen: true,
      },
    }]);
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "explain",
      routing: { modelId: "gemma4:e2b" },
      models,
      abortSignal: abortController.signal,
      tools: [{
        name: "list_files",
        description: "List files.",
        parameters: { type: "object" },
      }],
      onTextDelta: (delta) => {
        deltas.push(delta);
        received();
      },
      fetchFn: transport.fetch,
    });

    await sawText;
    abortController.abort();
    const result = await pending;
    transport.assertDone();

    assertStrictEquals(deltas.join(""), text);
    assertStrictEquals(result.text, text);
  });

  it("preserves a closed wrapped name that only prefixes an offered tool", async () => {
    const abortController = new AbortController();
    const deltas: string[] = [];
    let received!: () => void;
    const sawText = new Promise<void>((resolve) => {
      received = resolve;
    });
    const text =
      "Use <tool_call><function=list></function></tool_call> literally";
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: `data: ${
          JSON.stringify({
            choices: [{ delta: { content: text } }],
          })
        }\n`,
        holdOpen: true,
      },
    }]);
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "explain",
      routing: { modelId: "gemma4:e2b" },
      models,
      abortSignal: abortController.signal,
      tools: [{
        name: "list_files",
        description: "List files.",
        parameters: { type: "object" },
      }],
      onTextDelta: (delta) => {
        deltas.push(delta);
        received();
      },
      fetchFn: transport.fetch,
    });

    await sawText;
    abortController.abort();
    const result = await pending;
    transport.assertDone();

    assertStrictEquals(deltas.join(""), text);
    assertStrictEquals(result.text, text);
  });

  it("preserves ordinary text after a complete offered call when aborted", async () => {
    const abortController = new AbortController();
    const deltas: string[] = [];
    let received!: () => void;
    const sawPrefix = new Promise<void>((resolve) => {
      received = resolve;
    });
    const text =
      "before <tool_call><function=list_files><parameter=path>.</parameter></function></tool_call> after";
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: `data: ${
          JSON.stringify({
            choices: [{ delta: { content: text } }],
          })
        }\n`,
        holdOpen: true,
      },
    }]);
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "list files",
      routing: { modelId: "gemma4:e2b" },
      models,
      abortSignal: abortController.signal,
      tools: [{
        name: "list_files",
        description: "List files.",
        parameters: { type: "object" },
      }],
      onTextDelta: (delta) => {
        deltas.push(delta);
        if (deltas.join("") === "before ") received();
      },
      fetchFn: transport.fetch,
    });

    await sawPrefix;
    abortController.abort();
    const result = await pending;
    transport.assertDone();

    assertStrictEquals(deltas.join(""), "before  after");
    assertStrictEquals(result.text, "before  after");
    assertStrictEquals(result.toolCalls, undefined);
  });

  it("withholds both permitted tool-call whitespace gaps across deltas", async () => {
    const deltas: string[] = [];
    const wrapperGap = " ".repeat(32);
    const functionGap = " ".repeat(32);
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: sse([
          {
            choices: [{
              delta: {
                content: `answer<tool_call>${wrapperGap}<function=list_files `,
              },
            }],
          },
          {
            choices: [{
              delta: {
                content: `${
                  functionGap.slice(1)
                }><parameter=path>.</parameter></function></tool_call>`,
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
    assertEquals(result.toolCalls, [
      { id: "text-tool-1", name: "list_files", arguments: { path: "." } },
    ]);
  });

  it("treats an excessive wrapper gap as prose live and durably", async () => {
    const deltas: string[] = [];
    const text = "<tool_call>" + " ".repeat(33) +
      "<function=list_files><parameter=path>.</parameter></function></tool_call>";
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: sse([
          {
            choices: [{
              delta: { content: "<tool_call>" + " ".repeat(33) },
            }],
          },
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
      prompt: "show syntax",
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

    assertStrictEquals(deltas.join(""), text);
    assertStrictEquals(result.text, text);
    assertStrictEquals(result.toolCalls, undefined);
  });

  it("treats excessive whitespace after a function name as prose", async () => {
    const deltas: string[] = [];
    const prefix = "<tool_call><function=list_files" + " ".repeat(33);
    const suffix = "><parameter=path>.</parameter></function></tool_call>";
    const text = prefix + suffix;
    let streamController:
      | ReadableStreamDefaultController<Uint8Array>
      | undefined;
    const encoder = new TextEncoder();
    // The rest of the stream is released only once the prefix has been
    // emitted live, which the scripted vocabulary cannot express.
    const transport = new ScriptedHttpTransport([{
      respond: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              streamController = controller;
              controller.enqueue(encoder.encode(
                `data: ${
                  JSON.stringify({
                    choices: [{ delta: { content: prefix } }],
                  })
                }\n\n`,
              ));
            },
          }),
          { status: 200 },
        ),
    }]);
    const resultPromise = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "show syntax",
      routing: { modelId: "gemma4:e2b" },
      models,
      tools: [{
        name: "list_files",
        description: "List files.",
        parameters: { type: "object" },
      }],
      onTextDelta: (delta) => {
        deltas.push(delta);
        if (deltas.join("") !== prefix) return;
        streamController?.enqueue(encoder.encode(
          `data: ${
            JSON.stringify({
              choices: [{ delta: { content: suffix } }],
            })
          }\n\ndata: ${
            JSON.stringify({
              choices: [{ delta: {}, finish_reason: "stop" }],
            })
          }\n\n`,
        ));
        streamController?.close();
      },
      fetchFn: transport.fetch,
    });
    const result = await resultPromise;
    transport.assertDone();

    assertStrictEquals(deltas[0], prefix);
    assertStrictEquals(deltas.join(""), text);
    assertStrictEquals(result.text, text);
    assertStrictEquals(result.toolCalls, undefined);
  });

  it("treats an excessive post-name gap in one delta as prose", async () => {
    const deltas: string[] = [];
    const text = "<tool_call><function=list_files" + " ".repeat(33) +
      "><parameter=path>.</parameter></function></tool_call>";
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: sse([
          {
            choices: [{
              delta: {
                content: "<tool_call><function=list_files" + " ".repeat(33),
              },
            }],
          },
          {
            choices: [{
              delta: {
                content:
                  "><parameter=path>.</parameter></function></tool_call>",
              },
            }],
          },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ]),
      },
    }]);
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "show syntax",
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

    assertStrictEquals(deltas.join(""), text);
    assertStrictEquals(result.text, text);
    assertStrictEquals(result.toolCalls, undefined);
  });

  it("a literal wrapper cannot hide a later incomplete offered call on abort", async () => {
    const abortController = new AbortController();
    let received!: () => void;
    const sawPrefix = new Promise<void>((resolve) => {
      received = resolve;
    });
    const prefix = "Literal <tool_call> prose. ";
    const text = `${prefix}<tool_call><function=list_`;
    const deltas: string[] = [];
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: `data: ${
          JSON.stringify({
            choices: [{ delta: { content: text } }],
          })
        }\n`,
        holdOpen: true,
      },
    }]);
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "list files",
      routing: { modelId: "gemma4:e2b" },
      models,
      abortSignal: abortController.signal,
      tools: [{
        name: "list_files",
        description: "List files.",
        parameters: { type: "object" },
      }],
      onTextDelta: (delta) => {
        deltas.push(delta);
        if (deltas.join("") === prefix) received();
      },
      fetchFn: transport.fetch,
    });

    await sawPrefix;
    abortController.abort();
    const result = await pending;
    transport.assertDone();

    assertStrictEquals(deltas.join(""), prefix);
    assertStrictEquals(result.text, prefix);
  });
});
