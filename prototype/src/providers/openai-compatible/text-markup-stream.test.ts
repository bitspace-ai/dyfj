// Textual tool-call markup on the OpenAI-compatible streaming path: literal
// wrappers, names that only prefix an offered tool, and over-long whitespace
// gaps stream as prose, and an abort strips only a genuinely incomplete
// offered call from both the live deltas and the durable text.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ScriptedHttpTransport } from "../../../testing/fakes/scripted-http-transport.ts";
import { runWorkbenchTurn } from "../mod.ts";
import { providerTestModels } from "../../../testing/builders/models.ts";
import {
  DSML_BASH_BLOCK,
  DSML_BASH_COMMAND,
  DSML_GATE_RUN,
  DSML_GATE_WAIT_BLOCK,
  DSML_INVALID_OFFERED_BLOCK,
  DSML_PIPE,
  DSML_PROSE,
  DSML_UNOFFERED_FIRST_TRUNCATED_SECOND_BLOCK,
  DSML_WITHHELD_UNOFFERED_SECOND_BLOCK,
  DSML_MARKER,
  dsmlClosedMalformedBlockWithNestedQwen,
  dsmlClosedMalformedBlockWithPartialQwen,
  dsmlUnrecoveredBlockWithPartialQwen,
  dsmlTruncatedBlockWithNestedQwen,
  dsmlCharacterChunks,
  dsmlChunksAt,
  dsmlPartialBlock,
  dsmlBlock,
  dsmlCloseTag,
  dsmlTag,
  qwenUnrecoverableBashBlock,
} from "../../../testing/providers/dsml-fixtures.ts";

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

    assert.strictEqual(result.text, text);
    assert.strictEqual(deltas.join(""), text);
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

    assert.strictEqual(deltas.join(""), "Use <tool_calling> as a heading; ");
    assert.strictEqual(result.text, "Use <tool_calling> as a heading; ");
    assert.deepStrictEqual(result.toolCalls, [
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
    assert.strictEqual(deltas.join(""), `${narration} `);
    assert.strictEqual(result.text, `${narration} `);
    assert.deepStrictEqual(result.toolCalls, [
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

    assert.strictEqual(deltas.join(""), text);
    assert.strictEqual(result.text, text);
    assert.strictEqual(result.toolCalls, undefined);
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

    assert.strictEqual(deltas.join(""), text);
    assert.strictEqual(result.text, text);
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

    assert.strictEqual(deltas.join(""), text);
    assert.strictEqual(result.text, text);
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

    assert.strictEqual(deltas.join(""), "before  after");
    assert.strictEqual(result.text, "before  after");
    assert.strictEqual(result.toolCalls, undefined);
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

    assert.strictEqual(deltas.join(""), "answer");
    assert.strictEqual(result.text, "answer");
    assert.deepStrictEqual(result.toolCalls, [
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

    assert.strictEqual(deltas.join(""), text);
    assert.strictEqual(result.text, text);
    assert.strictEqual(result.toolCalls, undefined);
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

    assert.strictEqual(deltas[0], prefix);
    assert.strictEqual(deltas.join(""), text);
    assert.strictEqual(result.text, text);
    assert.strictEqual(result.toolCalls, undefined);
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

    assert.strictEqual(deltas.join(""), text);
    assert.strictEqual(result.text, text);
    assert.strictEqual(result.toolCalls, undefined);
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

    assert.strictEqual(deltas.join(""), prefix);
    assert.strictEqual(result.text, prefix);
  });
});

// A DeepSeek model may write its native tool-call markup as message text. The
// markup must never reach the operator's live output: it is withheld while the
// block streams and stripped once recovery runs (BIT-991).
const dsmlTool = (name: string) => ({
  name,
  description: `${name} tool.`,
  parameters: { type: "object" },
});

describe("DeepSeek DSML markup in streamed text", () => {
  it("withholds a DSML block split across deltas until it closes", async () => {
    const deltas: string[] = [];
    const text = `${DSML_PROSE} ${DSML_GATE_WAIT_BLOCK}`;
    const cut = DSML_PROSE.length + 1 + 40;
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: sse([
          { choices: [{ delta: { content: text.slice(0, cut) } }] },
          { choices: [{ delta: { content: text.slice(cut) } }] },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ]),
      },
    }]);
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "wait for the gate",
      routing: { modelId: "gemma4:e2b" },
      models,
      tools: [dsmlTool("gate/wait")],
      onTextDelta: (delta) => deltas.push(delta),
      fetchFn: transport.fetch,
    });
    transport.assertDone();

    assert.deepStrictEqual(result.toolCalls, [{
      id: "text-tool-1",
      name: "gate/wait",
      arguments: { run: DSML_GATE_RUN, wait_seconds: 60 },
    }]);
    assert.strictEqual(result.text, `${DSML_PROSE} `);
    assert.strictEqual(deltas.join(""), `${DSML_PROSE} `);
  });

  it("resumes streamed prose right after a closed DSML block", async () => {
    const deltas: string[] = [];
    const before = "Checking. ";
    const after = " Done.";
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: sse([
          { choices: [{ delta: { content: `${before}${DSML_BASH_BLOCK}` } }] },
          { choices: [{ delta: { content: after } }] },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ]),
      },
    }]);
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "run the tests",
      routing: { modelId: "gemma4:e2b" },
      models,
      tools: [dsmlTool("bash")],
      onTextDelta: (delta) => deltas.push(delta),
      fetchFn: transport.fetch,
    });
    transport.assertDone();

    assert.deepStrictEqual(result.toolCalls, [{
      id: "text-tool-1",
      name: "bash",
      arguments: { command: DSML_BASH_COMMAND },
    }]);
    assert.strictEqual(deltas.join(""), `${before}${after}`);
    assert.strictEqual(result.text, `${before}${after}`);
  });

  it("shows DSML prose for an unoffered tool instead of hiding it", async () => {
    const deltas: string[] = [];
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: sse([
          { choices: [{ delta: { content: DSML_GATE_WAIT_BLOCK } }] },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ]),
      },
    }]);
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "explain the markup",
      routing: { modelId: "gemma4:e2b" },
      models,
      tools: [dsmlTool("bash")],
      onTextDelta: (delta) => deltas.push(delta),
      fetchFn: transport.fetch,
    });
    transport.assertDone();

    assert.strictEqual(result.toolCalls, undefined);
    assert.strictEqual(result.text, DSML_GATE_WAIT_BLOCK);
    assert.strictEqual(deltas.join(""), DSML_GATE_WAIT_BLOCK);
  });

  it("flags a DSML block left in the text when no tools are offered", async () => {
    const deltas: string[] = [];
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: sse([
          { choices: [{ delta: { content: DSML_BASH_BLOCK } }] },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ]),
      },
    }]);
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "run the tests",
      routing: { modelId: "gemma4:e2b" },
      models,
      onTextDelta: (delta) => deltas.push(delta),
      fetchFn: transport.fetch,
    });
    transport.assertDone();

    assert.strictEqual(result.toolCalls, undefined);
    assert.strictEqual(result.text, DSML_BASH_BLOCK);
    assert.strictEqual(deltas.join(""), DSML_BASH_BLOCK);
    assert.deepStrictEqual(result.unparsedToolCallMarkup, {
      count: 1,
      countIsLowerBound: false,
    });
  });

  it("does not treat a DSML word in ordinary prose as markup", async () => {
    const text = `The separators are ${DSML_PIPE} and | in this dialect.`;
    const deltas: string[] = [];
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
      prompt: "explain separators",
      routing: { modelId: "gemma4:e2b" },
      models,
      tools: [dsmlTool("bash")],
      onTextDelta: (delta) => deltas.push(delta),
      fetchFn: transport.fetch,
    });
    transport.assertDone();

    assert.strictEqual(result.text, text);
    assert.strictEqual(deltas.join(""), text);
    assert.strictEqual(result.toolCalls, undefined);
    assert.strictEqual(result.unparsedToolCallMarkup, undefined);
  });

  it("a partial DSML block on abort leaves no markup in live or durable text", async () => {
    const abortController = new AbortController();
    const deltas: string[] = [];
    let received!: () => void;
    const sawText = new Promise<void>((resolve) => {
      received = resolve;
    });
    const prefix = "Checking. ";
    const text = `${prefix}${
      dsmlPartialBlock("spaced", "bash", [
        ["command", ' string="true"', DSML_BASH_COMMAND],
      ])
    }`;
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: `data: ${
          JSON.stringify({ choices: [{ delta: { content: text } }] })
        }\n`,
        holdOpen: true,
      },
    }]);
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "run the tests",
      routing: { modelId: "gemma4:e2b" },
      models,
      abortSignal: abortController.signal,
      tools: [dsmlTool("bash")],
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

    assert.strictEqual(deltas.join(""), prefix);
    assert.strictEqual(result.text, prefix);
    assert.strictEqual(result.toolCalls, undefined);
  });
});

// A real tokenizer splits the markup wherever a token ends, so an opener or a
// wrapper name can straddle a delta boundary. The reviewer's probes (Pass 1,
// 2026-11-26) showed the raw markup reaching `onTextDelta` in that case, so
// each test here cuts the captured block at a boundary that matters (BIT-991).
describe("DeepSeek DSML markup split across deltas", () => {
  const streamOf = async (
    chunks: readonly string[],
    toolNames: string[],
    options: { tools?: boolean } = {},
  ) => {
    const deltas: string[] = [];
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: sse([
          ...chunks.map((content) => ({ choices: [{ delta: { content } }] })),
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ]),
      },
    }]);
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "continue",
      routing: { modelId: "gemma4:e2b" },
      models,
      ...(options.tools === false ? {} : { tools: toolNames.map(dsmlTool) }),
      onTextDelta: (delta) => deltas.push(delta),
      fetchFn: transport.fetch,
    });
    transport.assertDone();
    return { result, deltas };
  };

  it("withholds a block whose every character arrives in its own delta", async () => {
    const { result, deltas } = await streamOf(
      dsmlCharacterChunks(DSML_BASH_BLOCK),
      ["bash"],
    );

    assert.deepStrictEqual(result.toolCalls, [{
      id: "text-tool-1",
      name: "bash",
      arguments: { command: DSML_BASH_COMMAND },
    }]);
    assert.strictEqual(deltas.join(""), "");
    assert.strictEqual(result.text, "");
    assert.strictEqual(result.unparsedToolCallMarkup, undefined);
  });

  it("withholds a block split inside the separator run and the wrapper name", async () => {
    const opener = dsmlTag("spaced", "calls");
    const cuts = [
      opener.indexOf("DS") + 2,
      opener.length + 2,
      opener.length + 6,
      40,
      90,
    ];
    const { result, deltas } = await streamOf(
      ["Checking. ", ...dsmlChunksAt(DSML_BASH_BLOCK, cuts)],
      ["bash"],
    );

    assert.deepStrictEqual(result.toolCalls, [{
      id: "text-tool-1",
      name: "bash",
      arguments: { command: DSML_BASH_COMMAND },
    }]);
    assert.strictEqual(deltas.join(""), "Checking. ");
    assert.strictEqual(result.text, "Checking. ");
    assert.strictEqual(result.unparsedToolCallMarkup, undefined);
  });

  it("delivers trailing prose live rather than holding it to the finish", async () => {
    const before = "Checking. ";
    const after = [" Do", "ne", "."];
    const { result, deltas } = await streamOf(
      [before, DSML_BASH_BLOCK, ...after],
      ["bash"],
    );

    assert.strictEqual(deltas.join(""), `${before}${after.join("")}`);
    assert.strictEqual(result.text, `${before}${after.join("")}`);
    assert.deepStrictEqual(deltas.slice(1), after);
  });

  it("keeps a DSML block followed later by a Qwen close tag from diverging", async () => {
    const qwen = "\n<tool_call><function=list_files>" +
      "<parameter=path>.</parameter></function></tool_call>";
    const { result, deltas } = await streamOf(
      ["Checking. ", DSML_BASH_BLOCK, " mid ", qwen, " end"],
      ["bash", "list_files"],
    );

    assert.deepStrictEqual(result.toolCalls, [{
      id: "text-tool-1",
      name: "bash",
      arguments: { command: DSML_BASH_COMMAND },
    }, {
      id: "text-tool-2",
      name: "list_files",
      arguments: { path: "." },
    }]);
    const prose = "Checking.  mid \n end";
    assert.strictEqual(result.text, prose);
    assert.strictEqual(deltas.join(""), prose);
  });

  it("bounds how long a stray wrapper opener holds text back", async () => {
    const opener = dsmlTag("spaced", "calls");
    const prose = `The wrapper is ${opener}name and args. `;
    const filler = "x".repeat(4_096);
    const { result, deltas } = await streamOf(
      [prose, filler, filler, filler],
      ["bash"],
    );

    assert.strictEqual(result.text, prose + filler.repeat(3));
    assert.strictEqual(deltas.join(""), result.text);
    assert.strictEqual(result.toolCalls, undefined);
    assert.strictEqual(result.unparsedToolCallMarkup, undefined);
    // The opener is released with the rest once nothing DSML follows it, so the
    // filler arrives live instead of being held to the finish.
    assert.ok(deltas.length > 1, `${deltas.length} deltas`);
  });

  it("releases a stray wrapper opener's following prose live, in every delta", async () => {
    const opener = dsmlTag("spaced", "calls");
    const prose = `The wrapper is ${opener}name and args. `;
    const words = Array.from({ length: 400 }, () => "more prose here. ");
    const { result, deltas } = await streamOf(
      [prose, ...words],
      ["bash"],
    );

    assert.strictEqual(result.text, prose + words.join(""));
    assert.strictEqual(deltas.join(""), result.text);
    // The opener holds back at most its undecided prefix, and the prose after
    // it is forwarded as each delta arrives rather than buffered to the finish,
    // so nearly every word is its own delta.
    assert.ok(
      deltas.length >= words.length - 10,
      `${deltas.length} deltas for ${words.length} words`,
    );
    assert.deepStrictEqual(deltas.slice(-20), words.slice(-20));
  });

  it("scales linearly when prose follows a stray wrapper opener", async () => {
    const opener = dsmlTag("spaced", "calls");
    const prose = `The wrapper is ${opener}name and args. `;
    const measure = async (wordCount: number) => {
      const words = Array.from(
        { length: wordCount },
        () => "more prose here. ",
      );
      const started = performance.now();
      const { result } = await streamOf([prose, ...words], ["bash"]);
      const elapsed = performance.now() - started;
      assert.strictEqual(result.text, prose + words.join(""));
      return elapsed;
    };

    await measure(200);
    const small = await measure(1_000);
    const large = await measure(4_000);
    // Four times the input must not cost more than an order of magnitude more
    // time; a per-delta rescan of the withheld prefix would blow past this.
    assert.ok(
      large < Math.max(small, 1) * 40,
      `small ${small.toFixed(1)}ms large ${large.toFixed(1)}ms`,
    );
  });

  it("withholds the fully split gate_wait block and refuses it when unoffered", async () => {
    const split = await streamOf(dsmlCharacterChunks(DSML_GATE_WAIT_BLOCK), [
      "gate/wait",
    ]);
    assert.deepStrictEqual(split.result.toolCalls, [{
      id: "text-tool-1",
      name: "gate/wait",
      arguments: { run: DSML_GATE_RUN, wait_seconds: 60 },
    }]);
    assert.strictEqual(split.deltas.join(""), "");

    const unoffered = await streamOf(dsmlCharacterChunks(DSML_GATE_WAIT_BLOCK), [
      "bash",
    ]);
    assert.strictEqual(unoffered.result.toolCalls, undefined);
    assert.strictEqual(unoffered.result.text, DSML_GATE_WAIT_BLOCK);
    assert.strictEqual(unoffered.deltas.join(""), DSML_GATE_WAIT_BLOCK);
    assert.deepStrictEqual(unoffered.result.unparsedToolCallMarkup, {
      count: 1,
      countIsLowerBound: false,
    });
  });
});

// A reply can hold markup-shaped prose as well as a real block: prose that
// mentions the wrapper opener, a block naming an offered tool that is not
// recoverable markup, or both in either order. None of those may fail the
// turn's presentation, and none may leave a recovered block visible or
// flagged (BIT-991).
describe("markup-shaped prose beside a recovered DSML block", () => {
  const streamOf = async (chunks: readonly string[], toolNames: string[]) => {
    const deltas: string[] = [];
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: sse([
          ...chunks.map((content) => ({ choices: [{ delta: { content } }] })),
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ]),
      },
    }]);
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "continue",
      routing: { modelId: "gemma4:e2b" },
      models,
      tools: toolNames.map(dsmlTool),
      onTextDelta: (delta) => deltas.push(delta),
      fetchFn: transport.fetch,
    });
    transport.assertDone();
    return { result, deltas };
  };
  const bashCall = {
    id: "text-tool-1",
    name: "bash",
    arguments: { command: DSML_BASH_COMMAND },
  };

  it("A1: forwards a stray wrapper opener in prose that ends near a valid block", async () => {
    const opener = dsmlTag("spaced", "calls");
    const before = `The ${opener} wrapper. More words. `;
    const after = " done";
    const { result, deltas } = await streamOf(
      [before, DSML_BASH_BLOCK, after],
      ["bash"],
    );

    assert.deepStrictEqual(result.toolCalls, [bashCall]);
    assert.strictEqual(result.text, `${before}${after}`);
    assert.strictEqual(deltas.join(""), result.text);
    assert.strictEqual(result.unparsedToolCallMarkup, undefined);
  });

  it("A2: forwards the same stray opener when the reply arrives in one delta", async () => {
    const opener = dsmlTag("spaced", "calls");
    const before = `The ${opener} wrapper. More words. `;
    const after = " done";
    const { result, deltas } = await streamOf(
      [`${before}${DSML_BASH_BLOCK}${after}`],
      ["bash"],
    );

    assert.deepStrictEqual(result.toolCalls, [bashCall]);
    assert.strictEqual(result.text, `${before}${after}`);
    assert.strictEqual(deltas.join(""), result.text);
    assert.strictEqual(result.unparsedToolCallMarkup, undefined);
  });

  it("K1: shows an invalid offered block that follows a valid one, flagged once", async () => {
    const after = " end";
    const { result, deltas } = await streamOf(
      [DSML_BASH_BLOCK, " then ", DSML_INVALID_OFFERED_BLOCK, after],
      ["bash"],
    );

    assert.deepStrictEqual(result.toolCalls, [bashCall]);
    assert.strictEqual(
      result.text,
      ` then ${DSML_INVALID_OFFERED_BLOCK}${after}`,
    );
    assert.strictEqual(deltas.join(""), result.text);
    assert.deepStrictEqual(result.unparsedToolCallMarkup, {
      count: 1,
      countIsLowerBound: false,
    });
  });

  it("K2: shows an invalid offered block ahead of a valid one in one delta", async () => {
    const after = " end";
    const { result, deltas } = await streamOf(
      [`${DSML_INVALID_OFFERED_BLOCK} mid ${DSML_BASH_BLOCK}${after}`],
      ["bash"],
    );

    assert.deepStrictEqual(result.toolCalls, [bashCall]);
    assert.strictEqual(
      result.text,
      `${DSML_INVALID_OFFERED_BLOCK} mid ${after}`,
    );
    assert.strictEqual(deltas.join(""), result.text);
    assert.deepStrictEqual(result.unparsedToolCallMarkup, {
      count: 1,
      countIsLowerBound: false,
    });
  });

  it("K3: shows an invalid offered block that precedes a valid one", async () => {
    const after = " end";
    const { result, deltas } = await streamOf(
      [DSML_INVALID_OFFERED_BLOCK, " mid ", DSML_BASH_BLOCK, after],
      ["bash"],
    );

    assert.deepStrictEqual(result.toolCalls, [bashCall]);
    assert.strictEqual(
      result.text,
      `${DSML_INVALID_OFFERED_BLOCK} mid ${after}`,
    );
    assert.strictEqual(deltas.join(""), result.text);
    assert.deepStrictEqual(result.unparsedToolCallMarkup, {
      count: 1,
      countIsLowerBound: false,
    });
  });
});

// The finish strip and the streaming presenter apply one per-candidate rule:
// a candidate is withheld (and so cut at finish) only while its *first* invoke
// names an offered tool, or while no invoke name has arrived yet and the
// candidate is still undecided. A block whose first invoke names an unoffered
// tool is prose the presenter already forwarded, even when a later invoke the
// reply cuts off inside would prefix an offered name, so the strip must leave
// it alone (BIT-991).
// A reply can carry a DSML block recovery runs *and* a complete Qwen call whose
// arguments cannot be typed. The Qwen reading fails closed, so no Qwen call
// runs and its markup stays in the text - which means it is not an incomplete
// suffix, and the finish strip must not cut it. Reading it as one cut a block
// the presenter had already forwarded and failed the turn (BIT-991).
describe("a failed-closed Qwen block beside a recovered DSML block", () => {
  const streamOf = async (chunks: readonly string[], toolNames: string[]) => {
    const deltas: string[] = [];
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: sse([
          ...chunks.map((content) => ({ choices: [{ delta: { content } }] })),
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ]),
      },
    }]);
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "continue",
      routing: { modelId: "gemma4:e2b" },
      models,
      tools: toolNames.map(dsmlTool),
      onTextDelta: (delta) => deltas.push(delta),
      fetchFn: transport.fetch,
    });
    transport.assertDone();
    return { result, deltas };
  };
  const dsmlCall = {
    id: "text-tool-1",
    name: "bash",
    arguments: { command: DSML_BASH_COMMAND },
  };
  const expectBoth = (
    result: Awaited<ReturnType<typeof streamOf>>["result"],
    deltas: readonly string[],
    expectedText: string,
  ) => {
    assert.deepStrictEqual(result.toolCalls, [dsmlCall]);
    assert.strictEqual(result.text, expectedText);
    assert.strictEqual(deltas.join(""), result.text);
    // The Qwen markup stays visible: its call never ran, so hiding it would
    // lose text the reply actually contained.
    assert.ok(result.text.includes("<tool_call>"), result.text);
  };

  it("keeps the Qwen markup when the failed-closed block comes first", async () => {
    const block = qwenUnrecoverableBashBlock();
    const text = `${block}\n${DSML_BASH_BLOCK}`;
    const { result, deltas } = await streamOf([text], ["bash"]);

    expectBoth(result, deltas, `${block}\n`);
  });

  it("keeps it when the recovered block comes first", async () => {
    const block = qwenUnrecoverableBashBlock();
    const text = `${DSML_BASH_BLOCK}\n${block}`;
    const { result, deltas } = await streamOf([text], ["bash"]);

    expectBoth(result, deltas, `\n${block}`);
  });

  it("keeps it when the reply is cut into small deltas", async () => {
    const block = qwenUnrecoverableBashBlock();
    const text = `${block}\n${DSML_BASH_BLOCK}`;
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += 7) chunks.push(text.slice(i, i + 7));
    const { result, deltas } = await streamOf(chunks, ["bash"]);

    expectBoth(result, deltas, `${block}\n`);
  });
});

describe("finish strip and presenter agree on one candidate rule", () => {
  const streamOf = async (chunks: readonly string[], toolNames: string[]) => {
    const deltas: string[] = [];
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: sse([
          ...chunks.map((content) => ({ choices: [{ delta: { content } }] })),
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ]),
      },
    }]);
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "continue",
      routing: { modelId: "gemma4:e2b" },
      models,
      tools: toolNames.map(dsmlTool),
      onTextDelta: (delta) => deltas.push(delta),
      fetchFn: transport.fetch,
    });
    transport.assertDone();
    return { result, deltas };
  };
  const bashCall = {
    id: "text-tool-1",
    name: "bash",
    arguments: { command: DSML_BASH_COMMAND },
  };
  const forwardedProse = ` then ${DSML_UNOFFERED_FIRST_TRUNCATED_SECOND_BLOCK}`;

  it("P1: keeps a forwarded unoffered block whose later invoke is cut off", async () => {
    const { result, deltas } = await streamOf(
      [DSML_BASH_BLOCK, " then ", DSML_UNOFFERED_FIRST_TRUNCATED_SECOND_BLOCK],
      ["bash"],
    );

    assert.deepStrictEqual(result.toolCalls, [bashCall]);
    assert.strictEqual(result.text, forwardedProse);
    assert.strictEqual(deltas.join(""), result.text);
    assert.deepStrictEqual(result.unparsedToolCallMarkup, {
      count: 1,
      countIsLowerBound: false,
    });
  });

  it("P1: keeps it when the whole reply arrives in one delta", async () => {
    const { result, deltas } = await streamOf(
      [`${DSML_BASH_BLOCK} then ${
        DSML_UNOFFERED_FIRST_TRUNCATED_SECOND_BLOCK
      }`],
      ["bash"],
    );

    assert.deepStrictEqual(result.toolCalls, [bashCall]);
    assert.strictEqual(result.text, forwardedProse);
    assert.strictEqual(deltas.join(""), result.text);
  });

  it("P1: keeps it when the operator aborts before any block is recovered", async () => {
    const abortController = new AbortController();
    const deltas: string[] = [];
    let received!: () => void;
    const sawText = new Promise<void>((resolve) => {
      received = resolve;
    });
    const text = `x ${DSML_UNOFFERED_FIRST_TRUNCATED_SECOND_BLOCK}`;
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: `data: ${
          JSON.stringify({ choices: [{ delta: { content: text } }] })
        }\n`,
        holdOpen: true,
      },
    }]);
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "go on",
      routing: { modelId: "gemma4:e2b" },
      models,
      abortSignal: abortController.signal,
      tools: [dsmlTool("bash")],
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

    assert.strictEqual(result.text, text);
    assert.strictEqual(deltas.join(""), result.text);
    assert.strictEqual(result.toolCalls, undefined);
  });

  it("P2: drops a withheld block whose second invoke is unoffered", async () => {
    const { result, deltas } = await streamOf(
      [`before ${DSML_WITHHELD_UNOFFERED_SECOND_BLOCK}`],
      ["bash"],
    );

    assert.strictEqual(result.text, "before ");
    assert.strictEqual(deltas.join(""), "before ");
    assert.strictEqual(result.toolCalls, undefined);
    assert.strictEqual(result.unparsedToolCallMarkup, undefined);
  });

  /**
   * A block the reply never closes stays withheld to the end, which is the
   * shape that made wall-clock time superlinear: a growing withheld string was
   * flattened by V8 on every close-tag probe. The presenter holds withheld
   * chunks in an array and probes only a carried tail window, so four times the
   * deltas must not cost more than a roughly linear multiple.
   */
  const measureWithheld = async (deltaCount: number) => {
    const block = `${
      dsmlTag("spaced", "calls")
    }\n${dsmlTag("spaced", "invoke", ' name="bash"')}\n${
      dsmlTag("spaced", "parameter", ' name="command" string="true"')
    }${"x".repeat(deltaCount * 5)}`;
    const chunks: string[] = [];
    for (let i = 0; i < block.length; i += 5) chunks.push(block.slice(i, i + 5));
    const started = performance.now();
    const { result, deltas } = await streamOf(chunks, ["bash"]);
    const elapsed = performance.now() - started;
    assert.strictEqual(result.text, "");
    assert.strictEqual(deltas.join(""), "");
    return elapsed;
  };

  it("scales linearly across tens of thousands of withheld deltas", async () => {
    await measureWithheld(2_000);
    const small = await measureWithheld(10_000);
    const large = await measureWithheld(40_000);
    // Four times the deltas. A presenter that rebuilt the withheld span at each
    // close-tag probe flattens a growing V8 rope and lands near sixteen times
    // the cost; measured on the superlinear presenter this replaced, 10k to 40k
    // came out around seventeen times over. Linear reading stays near four.
    assert.ok(
      large < Math.max(small, 1) * 10,
      `small ${small.toFixed(1)}ms large ${large.toFixed(1)}ms`,
    );
  });

  it("P2: drops it when every character arrives in its own delta", async () => {
    const { result, deltas } = await streamOf(
      ["before ", ...dsmlCharacterChunks(DSML_WITHHELD_UNOFFERED_SECOND_BLOCK)],
      ["bash"],
    );

    assert.strictEqual(result.text, "before ");
    assert.strictEqual(deltas.join(""), "before ");
    assert.strictEqual(result.toolCalls, undefined);
  });

  // A truncated DSML block can hold a complete Qwen block in its body: a model
  // writes a heredoc that embeds a Qwen fixture and then stops mid-block.
  // Recovery removes the Qwen block independently of the DSML dialect, so the
  // withheld span is shorter than the distance from its start to the end of the
  // reply. Measuring that distance against the text with complete calls already
  // removed cut into forwarded prose, or past the start of the string, and a
  // live delta that no longer matched the durable text failed the turn. The
  // nested Qwen call still runs; only the strip's arithmetic changed (BIT-991).
  const nestedQwenPrefix = "Prose. ";
  const nestedQwenOf = async (chunks: readonly string[]) => {
    const [first, ...rest] = chunks;
    return await streamOf([`${nestedQwenPrefix}${first}`, ...rest], ["bash"]);
  };

  it("Q1: drops a truncated block holding a short Qwen call", async () => {
    const block = dsmlTruncatedBlockWithNestedQwen("ls");
    const cut = 20;
    const { result, deltas } = await nestedQwenOf([
      block.slice(0, cut),
      block.slice(cut),
    ]);

    assert.strictEqual(result.text, nestedQwenPrefix);
    assert.strictEqual(deltas.join(""), result.text);
    assert.ok(!result.text.includes(DSML_PIPE), result.text);
  });

  it("Q2: drops a truncated block holding a long Qwen call", async () => {
    const command = "node --test prototype/src/providers/shared/" +
      "text-tool-calls.test.ts 2>&1 | tail -12";
    const block = dsmlTruncatedBlockWithNestedQwen(command);
    const cut = 20;
    const { result, deltas } = await nestedQwenOf([
      block.slice(0, cut),
      block.slice(cut),
    ]);

    assert.strictEqual(result.text, nestedQwenPrefix);
    assert.strictEqual(deltas.join(""), result.text);
    assert.ok(!result.text.includes(DSML_PIPE), result.text);
  });

  // The DSML marker bound is spent on markup, not on prose that names the
  // dialect: a reply discussing DSML must still have its block recovered, and a
  // reply holding separator-wrapped markers past the bound is refused rather
  // than parsed. Markers are counted across delta splits, so the bound does not
  // depend on how the reply is chunked (BIT-991).
  it("keeps recovering when prose mentions DSML hundreds of times", async () => {
    const prose = "DSML appears in prose here. ".repeat(513);
    const { result, deltas } = await streamOf(
      [prose, DSML_BASH_BLOCK],
      ["bash"],
    );

    assert.deepStrictEqual(result.toolCalls, [{
      id: "text-tool-1",
      name: "bash",
      arguments: { command: DSML_BASH_COMMAND },
    }]);
    assert.strictEqual(result.text, prose);
    assert.strictEqual(deltas.join(""), prose);
  });

  it("stops recovering once separator-wrapped markers pass the bound", async () => {
    const markers = `${DSML_MARKER} `.repeat(513);
    const { result } = await streamOf([markers, DSML_BASH_BLOCK], ["bash"]);

    // Past the bound the reply is read as prose, so the block stays in the
    // text instead of running.
    assert.strictEqual(result.toolCalls, undefined);
    assert.strictEqual(result.text, `${markers}${DSML_BASH_BLOCK}`);
  });

  it("refuses overlapping runs the same way in one delta and small deltas", async () => {
    // Adjacent runs share a separator, so `|DSML|DSML|` holds two markers. The
    // whole-text scan and the streaming counter must agree on that, or the same
    // reply is refused when it arrives whole and parsed when it arrives in
    // pieces (BIT-991).
    const overlapping = `${"|DSML|"}${"DSML|".repeat(600)}`;
    const asciiBlock = dsmlBlock("ascii", "bash", [
      ["command", ' string="true"', "ls"],
    ]);
    const text = `${overlapping}\n${asciiBlock}`;
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += 5) chunks.push(text.slice(i, i + 5));

    for (const pieces of [[text], chunks]) {
      const { result, deltas } = await streamOf(pieces, ["bash"]);
      assert.strictEqual(result.toolCalls, undefined);
      assert.strictEqual(result.text, text);
      assert.strictEqual(deltas.join(""), text);
    }
  });

  it("counts a separator-wrapped marker split across deltas", async () => {
    const markers = `${DSML_MARKER} `.repeat(513);
    const { result } = await streamOf([...markers, DSML_BASH_BLOCK], ["bash"]);

    assert.strictEqual(result.toolCalls, undefined);
    assert.strictEqual(result.text, `${markers}${DSML_BASH_BLOCK}`);
  });

  // A closed wrapper whose body is not valid DSML can still hold a complete
  // offered Qwen call. The reader withholds the block, then finds on the
  // wrapper's close tag that it is not DSML and releases the span as prose -
  // but the Qwen call inside it runs, so showing its markup would print a call
  // that executed and make the live deltas a prefix the durable text no longer
  // has (BIT-991).
  const closedMalformedOf = async (chunks: readonly string[]) =>
    await streamOf(chunks, ["bash"]);

  it("M1: runs the Qwen call inside a closed malformed DSML block without showing it", async () => {
    const command = "ls";
    const block = dsmlClosedMalformedBlockWithNestedQwen(command);
    const cut = 24;
    const { result, deltas } = await closedMalformedOf([
      block.slice(0, cut),
      block.slice(cut),
    ]);

    assert.deepStrictEqual(result.toolCalls, [{
      id: "text-tool-1",
      name: "bash",
      arguments: { command },
    }]);
    assert.strictEqual(deltas.join(""), result.text);
    assert.ok(!result.text.includes("<tool_call>"), result.text);
  });

  // A valid DSML block followed by a span recovery declines still has to be
  // read under the ordinary rules: an incomplete Qwen opening inside such a span
  // is withheld until it settles or the reply ends, exactly as at top level. It
  // was once settled as raw prose, so the opening was forwarded and then cut at
  // finish, and the live text stopped being a prefix of the durable text
  // (BIT-991).
  const prose = "Let me check that.\n";

  it("does not diverge on a declined span holding an incomplete Qwen opening", async () => {
    const text = `${prose}${DSML_BASH_BLOCK}\n${
      dsmlClosedMalformedBlockWithPartialQwen()
    }`;
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += 9) chunks.push(text.slice(i, i + 9));
    const { result, deltas } = await streamOf(chunks, ["bash", "list_files"]);

    assert.deepStrictEqual(result.toolCalls, [{
      id: "text-tool-1",
      name: "bash",
      arguments: { command: DSML_BASH_COMMAND },
    }]);
    assert.strictEqual(deltas.join(""), result.text);
    assert.ok(!result.text.includes("<tool_call>"), result.text);
  });

  it("does not diverge on a declined DSML block ahead of that span", async () => {
    const text = `${dsmlUnrecoveredBlockWithPartialQwen()}\n${prose}` +
      `${DSML_BASH_BLOCK}`;
    const { result, deltas } = await streamOf([text], ["bash", "list_files"]);

    assert.strictEqual(deltas.join(""), result.text);
    assert.ok(!result.text.includes("<parameter=path>"), result.text);
  });

  it("withholds a Qwen opening whose close tag arrives after the DSML close", async () => {
    const text = `${dsmlClosedMalformedBlockWithPartialQwen()}\n` +
      `</parameter></function></tool_call>`;
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += 6) chunks.push(text.slice(i, i + 6));
    const { result, deltas } = await streamOf(chunks, ["bash", "list_files"]);

    // The Qwen call's close tags land after the DSML close tag, so the opening
    // is still pending when the wrapper ends. It is withheld rather than shown,
    // and the turn's live text stays exactly what it delivered.
    assert.strictEqual(result.toolCalls?.length, 1);
    assert.strictEqual(result.toolCalls?.[0].name, "list_files");
    assert.strictEqual(deltas.join(""), result.text);
    assert.ok(!result.text.includes("<tool_call>"), result.text);
  });

  it("M2: does the same when the whole reply arrives in one delta", async () => {
    const command = "node --test prototype/src/providers/shared/" +
      "text-tool-calls.test.ts 2>&1 | tail -12";
    const block = dsmlClosedMalformedBlockWithNestedQwen(command);
    const { result, deltas } = await closedMalformedOf([block]);

    assert.deepStrictEqual(result.toolCalls, [{
      id: "text-tool-1",
      name: "bash",
      arguments: { command },
    }]);
    assert.strictEqual(deltas.join(""), result.text);
    assert.ok(!result.text.includes("<tool_call>"), result.text);
  });

  it("Q3: drops it when the whole reply arrives in one delta", async () => {
    const command = "node --test prototype/src/providers/shared/" +
      "text-tool-calls.test.ts 2>&1 | tail -12";
    const block = dsmlTruncatedBlockWithNestedQwen(command);
    const { result, deltas } = await nestedQwenOf([block]);

    assert.strictEqual(result.text, nestedQwenPrefix);
    assert.strictEqual(deltas.join(""), result.text);
    assert.ok(!result.text.includes(DSML_PIPE), result.text);
  });
});

// A wrapper opening is a candidate only when the thing the dialect puts next
// follows it: its own whitespace and then an invoke. Searching ahead for the
// next tag instead let a wrapper *mentioned in prose* borrow an invoke further
// down the reply, so the mention read as recoverable and everything between
// them was withheld to the finish (BIT-991).
describe("a DSML wrapper candidate reads only its own whitespace", () => {
  const streamOf = async (chunks: readonly string[], toolNames: string[]) => {
    const deltas: string[] = [];
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: sse([
          ...chunks.map((content) => ({ choices: [{ delta: { content } }] })),
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ]),
      },
    }]);
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "continue",
      routing: { modelId: "gemma4:e2b" },
      models,
      tools: toolNames.map(dsmlTool),
      onTextDelta: (delta) => deltas.push(delta),
      fetchFn: transport.fetch,
    });
    transport.assertDone();
    return { result, deltas };
  };
  const wrapper = dsmlTag("spaced", "calls");
  const invoke = dsmlTag("spaced", "invoke", ' name="bash"');

  it("does not withhold prose between a stray wrapper and a later invoke", async () => {
    const prose = Array.from(
      { length: 60 },
      () => "the wrapper is written like this. ",
    ).join("");
    const text = `Notes: ${wrapper}${prose}${invoke}\nstill prose`;
    const words = text.match(/\S+\s*/g) ?? [];
    const { result, deltas } = await streamOf(words, ["bash"]);

    assert.strictEqual(result.toolCalls, undefined);
    assert.strictEqual(result.text, text);
    assert.strictEqual(deltas.join(""), text);
    // The wrapper and the prose after it are forwarded as they arrive, not
    // held back to the finish: nearly every word is its own delta.
    assert.ok(
      deltas.length >= words.length - 5,
      `${deltas.length} deltas for ${words.length} words`,
    );
    assert.strictEqual(deltas[0], "Notes: ");
  });

  it("is prose when the gap after the wrapper is past the whitespace bound", async () => {
    const text = `${wrapper}${" ".repeat(40)}${invoke}\nstill prose`;
    const words = text.match(/\S+\s*/g) ?? [];
    const { result, deltas } = await streamOf(words, ["bash"]);

    assert.strictEqual(result.toolCalls, undefined);
    assert.strictEqual(result.text, text);
    assert.strictEqual(deltas.join(""), text);
    // Past the gap bound nothing may still be pending, so the words after the
    // wrapper are forwarded as they arrive rather than held to the finish.
    assert.ok(
      deltas.length >= words.length - 2,
      `${deltas.length} deltas for ${words.length} words`,
    );
  });

  it("still withholds a split invoke opening after the wrapper's whitespace", async () => {
    const block = `${wrapper}   ${invoke}\n` +
      `${dsmlTag("spaced", "parameter", ' name="command" string="true"')}` +
      `${DSML_BASH_COMMAND}` +
      `${dsmlCloseTag("spaced", "parameter")}\n` +
      `${dsmlCloseTag("spaced", "invoke")}\n` +
      `${dsmlCloseTag("spaced", "calls")}`;
    const split = 3;
    const head = block.slice(0, block.indexOf(invoke) + split);
    const { result, deltas } = await streamOf([head, block.slice(head.length)], [
      "bash",
    ]);

    assert.deepStrictEqual(result.toolCalls, [{
      id: "text-tool-1",
      name: "bash",
      arguments: { command: DSML_BASH_COMMAND },
    }]);
    assert.strictEqual(result.text, "");
    assert.strictEqual(deltas.join(""), "");
  });
});
