// Textual tool-call recovery on the OpenAI-compatible path: calls a local
// model leaks as `<tool_call><function=...>` markup in its text are recovered
// into structured tool calls (streamed and buffered), and markup that does
// not name an offered tool, or is not properly wrapped, stays prose.

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
  DSML_PROSE,
  dsmlBlock,
  dsmlPartialBlock,
} from "../../../testing/providers/dsml-fixtures.ts";

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

    assert.deepStrictEqual(result.toolCalls, [
      {
        id: "text-tool-1",
        name: "read_file",
        arguments: { path: "README.md" },
      },
      { id: "text-tool-2", name: "list_files", arguments: { path: "." } },
    ]);
    assert.strictEqual(result.unparsedToolCallMarkup, undefined);
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

    assert.strictEqual(deltas.join(""), "I'll check. ");
    assert.deepStrictEqual(result.toolCalls, [
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

    assert.deepStrictEqual(result.toolCalls, [
      { id: "text-tool-1", name: "list_files", arguments: { path: "." } },
    ]);
    assert.strictEqual(result.stopReason, "tool_use");
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

    assert.deepStrictEqual(result.toolCalls, [
      {
        id: "text-tool-1",
        name: "read_file",
        arguments: { path: "README.md" },
      },
      { id: "text-tool-2", name: "list_files", arguments: { path: "." } },
    ]);
    assert.strictEqual(result.unparsedToolCallMarkup, undefined);
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

    assert.strictEqual(result.text, text);
    assert.strictEqual(result.toolCalls, undefined);
    assert.strictEqual(result.stopReason, "stop");
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

    assert.strictEqual(result.text, text);
    assert.strictEqual(result.toolCalls, undefined);
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

    assert.strictEqual(result.text, text);
    assert.strictEqual(result.toolCalls, undefined);
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
    assert.strictEqual(deltas.join(""), `${prose} `);
    assert.strictEqual(result.text, `${prose} `);
    assert.deepStrictEqual(result.toolCalls, [
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

    assert.deepStrictEqual(deltas, ["  before ", " after  "]);
    assert.strictEqual(result.text, "  before  after  ");
    assert.deepStrictEqual(result.toolCalls, [
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
    await assert.rejects(
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
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes(
          "Provider returned too many textual tool-call markers",
        ),
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

    assert.strictEqual(deltas.join(""), "before  between ");
    assert.strictEqual(result.text, "before  between ");
    assert.deepStrictEqual(result.toolCalls, [
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

    assert.strictEqual(deltas.join(""), "answer");
    assert.strictEqual(result.text, "answer");
    assert.strictEqual(result.toolCalls, undefined);
  });
});

// Stored model text from local-model turns that ended on a complete textual
// call the engine neither ran nor flagged (BIT-564). The first was the whole
// reply to a forced conclusion, which offers no tools; the second followed a
// `bash` result.
const STORED_READ_FILE_REPLY = "<tool_call>\n<function=read_file>\n" +
  "<parameter=path>\nCHANGELOG.md\n</parameter>\n" +
  "<parameter=limit>\n200\n</parameter>\n" +
  "<parameter=offset>\n401\n</parameter>\n</function>\n</tool_call>";
const STORED_BASH_COMMAND =
  "cd core && cargo test -p dyfj-repl rejected_friction_is_not_recorded 2>&1";
const STORED_BASH_REPLY = "Hmm, 0 tests matched. The test name might not " +
  "be filtering correctly. Let me check:\n\n<tool_call>\n<function=bash>\n" +
  `<parameter=command>\n${STORED_BASH_COMMAND}\n</parameter>\n` +
  "</function>\n</tool_call>";

const tool = (name: string) => ({
  name,
  description: `${name} tool.`,
  parameters: { type: "object" },
});

for (const streamed of [true, false]) {
  const mode = streamed ? "streamed" : "buffered";
  const reply = (content: string) =>
    new ScriptedHttpTransport([{
      respond: {
        body: streamed
          ? sse([
            { choices: [{ delta: { content } }] },
            { choices: [{ delta: {}, finish_reason: "stop" }] },
          ])
          : JSON.stringify({
            choices: [{ message: { content }, finish_reason: "stop" }],
          }),
      },
    }]);
  const turn = (
    transport: ScriptedHttpTransport,
    tools: ReturnType<typeof tool>[] | undefined,
  ) =>
    runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "continue",
      routing: { modelId: "gemma4:e2b" },
      models,
      ...(tools ? { tools } : {}),
      ...(streamed ? { onTextDelta: () => {} } : {}),
      fetchFn: transport.fetch,
    });

  describe(`unrun complete textual tool calls (${mode})`, () => {
    it("flags a complete block when the request offers no tools", async () => {
      const transport = reply(STORED_READ_FILE_REPLY);
      const result = await turn(transport, undefined);
      transport.assertDone();

      assert.strictEqual(result.text, STORED_READ_FILE_REPLY);
      assert.strictEqual(result.toolCalls, undefined);
      assert.deepStrictEqual(result.unparsedToolCallMarkup, {
        count: 1,
        countIsLowerBound: false,
      });
    });

    it("flags a complete block naming a tool that was not offered", async () => {
      const transport = reply(STORED_BASH_REPLY);
      const result = await turn(transport, [
        tool("read_file"),
        tool("edit_file"),
      ]);
      transport.assertDone();

      assert.strictEqual(result.text, STORED_BASH_REPLY);
      assert.strictEqual(result.toolCalls, undefined);
      assert.deepStrictEqual(result.unparsedToolCallMarkup, {
        count: 1,
        countIsLowerBound: false,
      });
    });

    it("recovers the same block when its tool is offered, without a warning", async () => {
      const transport = reply(STORED_BASH_REPLY);
      const result = await turn(transport, [tool("read_file"), tool("bash")]);
      transport.assertDone();

      assert.deepStrictEqual(result.toolCalls, [{
        id: "text-tool-1",
        name: "bash",
        arguments: { command: STORED_BASH_COMMAND },
      }]);
      assert.strictEqual(result.unparsedToolCallMarkup, undefined);
    });

    it("flags only the unoffered block when an offered one is recovered", async () => {
      const offered =
        "<tool_call><function=read_file><parameter=path>README.md</parameter></function></tool_call>";
      const transport = reply(`${offered}\n${STORED_BASH_REPLY}`);
      const result = await turn(transport, [tool("read_file")]);
      transport.assertDone();

      assert.deepStrictEqual(result.toolCalls, [{
        id: "text-tool-1",
        name: "read_file",
        arguments: { path: "README.md" },
      }]);
      assert.deepStrictEqual(result.unparsedToolCallMarkup, {
        count: 1,
        countIsLowerBound: false,
      });
    });
  });
}

// DeepSeek models sometimes write their native tool-call markup into the
// message content instead of a structured `tool_calls` array. The fixtures are
// two replies captured live from DeepSeek V4.1 Flash 1017 via OpenRouter
// (2026-11-24) plus the separator, wrapper and gap spellings an upstream
// tokenizer may vary (BIT-991).
const dsmlTool = (name: string) => ({
  name,
  description: `${name} tool.`,
  parameters: { type: "object" },
});

function dsmlTurn(
  content: string,
  tools: ReturnType<typeof dsmlTool>[] | undefined,
  options: { streamed?: boolean; onTextDelta?: (delta: string) => void } = {},
) {
  const streamed = options.streamed ?? false;
  const transport = new ScriptedHttpTransport([{
    respond: {
      body: streamed
        ? sse([
          { choices: [{ delta: { content } }] },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ])
        : JSON.stringify({
          choices: [{ message: { content }, finish_reason: "stop" }],
        }),
    },
  }]);
  return {
    transport,
    run: () =>
      runWorkbenchTurn({
        systemPrompt: "system",
        prompt: "continue",
        routing: { modelId: "gemma4:e2b" },
        models,
        ...(tools ? { tools } : {}),
        ...(streamed ? { onTextDelta: options.onTextDelta ?? (() => {}) } : {}),
        fetchFn: transport.fetch,
      }),
  };
}

describe("DeepSeek DSML textual tool calls", () => {
  it("recovers the captured bash block in a buffered reply", async () => {
    const { transport, run } = dsmlTurn(
      `${DSML_PROSE}\n\n${DSML_BASH_BLOCK}`,
      [dsmlTool("bash")],
    );
    const result = await run();
    transport.assertDone();

    assert.deepStrictEqual(result.toolCalls, [{
      id: "text-tool-1",
      name: "bash",
      arguments: { command: DSML_BASH_COMMAND },
    }]);
    assert.strictEqual(result.text, `${DSML_PROSE}\n\n`);
    assert.strictEqual(result.unparsedToolCallMarkup, undefined);
  });

  it("recovers the captured gate_wait block and parses string=false values", async () => {
    const { transport, run } = dsmlTurn(DSML_GATE_WAIT_BLOCK, [
      dsmlTool("gate/wait"),
    ]);
    const result = await run();
    transport.assertDone();

    assert.deepStrictEqual(result.toolCalls, [{
      id: "text-tool-1",
      name: "gate/wait",
      arguments: { run: DSML_GATE_RUN, wait_seconds: 60 },
    }]);
    assert.strictEqual(result.text, "");
    assert.strictEqual(result.unparsedToolCallMarkup, undefined);
  });

  it("resolves a wire-normalized invoke name onto the offered tool", async () => {
    const { transport, run } = dsmlTurn(DSML_GATE_WAIT_BLOCK, [
      dsmlTool("gate/wait"),
      dsmlTool("bash"),
    ]);
    const result = await run();
    transport.assertDone();

    assert.deepStrictEqual(result.toolCalls, [{
      id: "text-tool-1",
      name: "gate/wait",
      arguments: { run: DSML_GATE_RUN, wait_seconds: 60 },
    }]);
  });

  it("recovers the tight and ASCII-pipe spellings and the function_calls wrapper", async () => {
    for (const style of ["tight", "ascii"] as const) {
      for (const wrapper of ["calls", "function_calls"] as const) {
        const block = dsmlBlock(
          style,
          "list_files",
          [["path", ' string="true"', "."]],
          wrapper,
        );
        const { transport, run } = dsmlTurn(block, [dsmlTool("list_files")]);
        const result = await run();
        transport.assertDone();

        assert.deepStrictEqual(result.toolCalls, [{
          id: "text-tool-1",
          name: "list_files",
          arguments: { path: "." },
        }], `${style}/${wrapper}`);
        assert.strictEqual(result.unparsedToolCallMarkup, undefined);
      }
    }
  });

  it("keeps a multiline string=true value literal and JSON-parses the rest", async () => {
    const command = "line one\nline two\ntail";
    const block = dsmlBlock("spaced", "bash", [
      ["command", ' string="true"', command],
      ["timeoutSec", ' string="false"', "600"],
      ["login", ' string="false"', "false"],
      ["env", ' string="false"', '{"A":"1","B":[2,3]}'],
    ]);
    const { transport, run } = dsmlTurn(block, [dsmlTool("bash")]);
    const result = await run();
    transport.assertDone();

    assert.deepStrictEqual(result.toolCalls, [{
      id: "text-tool-1",
      name: "bash",
      arguments: {
        command,
        timeoutSec: 600,
        login: false,
        env: { A: "1", B: [2, 3] },
      },
    }]);
  });

  it("recovers multiple DSML calls in one reply, in order", async () => {
    const block = dsmlBlock("spaced", "list_files", [
      ["path", ' string="true"', "."],
    ]);
    const { transport, run } = dsmlTurn(
      `${block}\n${DSML_BASH_BLOCK}`,
      [dsmlTool("list_files"), dsmlTool("bash")],
    );
    const result = await run();
    transport.assertDone();

    assert.deepStrictEqual(result.toolCalls, [{
      id: "text-tool-1",
      name: "list_files",
      arguments: { path: "." },
    }, {
      id: "text-tool-2",
      name: "bash",
      arguments: { command: DSML_BASH_COMMAND },
    }]);
  });

  it("does not run a DSML call naming a tool that was not offered", async () => {
    const { transport, run } = dsmlTurn(DSML_GATE_WAIT_BLOCK, [
      dsmlTool("bash"),
    ]);
    const result = await run();
    transport.assertDone();

    assert.strictEqual(result.toolCalls, undefined);
    assert.strictEqual(result.text, DSML_GATE_WAIT_BLOCK);
    assert.deepStrictEqual(result.unparsedToolCallMarkup, {
      count: 1,
      countIsLowerBound: false,
    });
  });

  it("does not run a DSML call when the request offers no tools", async () => {
    const { transport, run } = dsmlTurn(DSML_BASH_BLOCK, undefined);
    const result = await run();
    transport.assertDone();

    assert.strictEqual(result.toolCalls, undefined);
    assert.strictEqual(result.text, DSML_BASH_BLOCK);
    assert.deepStrictEqual(result.unparsedToolCallMarkup, {
      count: 1,
      countIsLowerBound: false,
    });
  });

  it("flags a partial DSML block rather than treating it as prose", async () => {
    const partial = dsmlPartialBlock("spaced", "bash", [
      ["command", ' string="true"', DSML_BASH_COMMAND],
    ]);
    const { transport, run } = dsmlTurn(partial, [dsmlTool("bash")]);
    const result = await run();
    transport.assertDone();

    assert.strictEqual(result.toolCalls, undefined);
    assert.strictEqual(result.text, partial);
    assert.deepStrictEqual(result.unparsedToolCallMarkup, {
      count: 1,
      countIsLowerBound: false,
    });
  });

  it("flags a malformed DSML block whose parameter element is unclosed", async () => {
    const malformed = DSML_BASH_BLOCK.replace(
      /<\/[^>]*DSML[^>]*parameter>/u,
      "",
    );
    assert.notStrictEqual(malformed, DSML_BASH_BLOCK);
    const { transport, run } = dsmlTurn(malformed, [dsmlTool("bash")]);
    const result = await run();
    transport.assertDone();

    assert.strictEqual(result.toolCalls, undefined);
    assert.strictEqual(result.text, malformed);
    assert.deepStrictEqual(result.unparsedToolCallMarkup, {
      count: 1,
      countIsLowerBound: false,
    });
  });

  it("keeps a string=true value's own leading and trailing newlines", async () => {
    const body = "\nline one\nline two\n\n";
    const block = dsmlBlock("spaced", "bash", [
      ["command", ' string="true"', body],
    ]);
    const { transport, run } = dsmlTurn(block, [dsmlTool("bash")]);
    const result = await run();
    transport.assertDone();

    assert.deepStrictEqual(result.toolCalls, [{
      id: "text-tool-1",
      name: "bash",
      arguments: { command: body },
    }]);
  });

  it("recovers a DSML call from a streamed reply and strips it from the deltas", async () => {
    const deltas: string[] = [];
    const { transport, run } = dsmlTurn(
      `${DSML_PROSE} ${DSML_BASH_BLOCK}`,
      [dsmlTool("bash")],
      { streamed: true, onTextDelta: (delta) => deltas.push(delta) },
    );
    const result = await run();
    transport.assertDone();

    assert.deepStrictEqual(result.toolCalls, [{
      id: "text-tool-1",
      name: "bash",
      arguments: { command: DSML_BASH_COMMAND },
    }]);
    assert.strictEqual(result.text, `${DSML_PROSE} `);
    assert.strictEqual(deltas.join(""), `${DSML_PROSE} `);
  });

  it("leaves Qwen tool_call recovery unchanged beside a DSML block", async () => {
    const qwen = "<tool_call><function=list_files>" +
      "<parameter=path>.</parameter></function></tool_call>";
    const { transport, run } = dsmlTurn(`${qwen}\n${DSML_BASH_BLOCK}`, [
      dsmlTool("list_files"),
      dsmlTool("bash"),
    ]);
    const result = await run();
    transport.assertDone();

    assert.deepStrictEqual(result.toolCalls, [{
      id: "text-tool-1",
      name: "list_files",
      arguments: { path: "." },
    }, {
      id: "text-tool-2",
      name: "bash",
      arguments: { command: DSML_BASH_COMMAND },
    }]);
    assert.strictEqual(result.text, "\n");
  });
});
