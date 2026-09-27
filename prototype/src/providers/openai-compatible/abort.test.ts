// Turn-level tests for a caller abort on the OpenAI-compatible adapter: what
// partial text, usage, and timings survive, and how leaked or ambiguous tool
// markup is handled when the stream is cut short.

import {
  assertEquals,
  assertObjectMatch,
  assertStrictEquals,
} from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { assertSpyCalls, spy } from "@std/testing/mock";
import { ManualClock } from "../../../testing/fakes/manual-clock.ts";
import { ScriptedHttpTransport } from "../../../testing/fakes/scripted-http-transport.ts";
import { estimateTextTokens, runWorkbenchTurn } from "../mod.ts";
import { providerTestModels } from "../../../testing/builders/models.ts";

const models = [...providerTestModels];
const listFiles = {
  name: "list_files",
  description: "List files.",
  parameters: { type: "object" },
};

/** A transport whose one response delivers `body`, then holds open. */
const heldOpen = (body: string) =>
  new ScriptedHttpTransport([{ respond: { body, holdOpen: true } }]);

/** One SSE line carrying a content delta. */
const contentFrame = (content: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n`;

/** Lets the turn read the held-open body before the test aborts. */
const yieldToStream = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("runWorkbenchTurn streaming", () => {
  it("abort fallback meters structured tool-call fragments", async () => {
    const abortController = new AbortController();
    const name = "write_file";
    const argumentsFragment = `{"content":"${"x".repeat(8_192)}"}`;
    const transport = heldOpen(
      `data: ${
        JSON.stringify({
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: "tc-1",
                type: "function",
                function: { name, arguments: argumentsFragment },
              }],
            },
          }],
        })
      }\n`,
    );
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemma4:e2b" },
      models,
      abortSignal: abortController.signal,
      tools: [{
        name,
        description: "Write a file.",
        parameters: { type: "object" },
      }],
      onTextDelta: () => {},
      fetchFn: transport.fetch,
    });

    await yieldToStream();
    abortController.abort();
    const result = await pending;

    transport.assertDone();
    assertObjectMatch(result, {
      stopReason: "aborted",
      usage: {
        output: Math.ceil((name.length + argumentsFragment.length) / 4),
      },
    });
    assertStrictEquals(result.toolCalls, undefined);
  });

  it("an aborted stream preserves excessive complete tool markup as prose", async () => {
    const abortController = new AbortController();
    const markup = Array.from(
      { length: 65 },
      (_, index) =>
        `<tool_call><function=list_files><parameter=path>${index}</parameter></function></tool_call>`,
    ).join("");
    const deltas: string[] = [];
    const transport = heldOpen(contentFrame(markup));
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemma4:e2b" },
      models,
      abortSignal: abortController.signal,
      tools: [listFiles],
      onTextDelta: (delta) => deltas.push(delta),
      fetchFn: transport.fetch,
    });

    await yieldToStream();
    abortController.abort();
    const result = await pending;

    transport.assertDone();
    assertEquals(deltas, [markup]);
    assertObjectMatch(result, { text: markup, stopReason: "aborted" });
    assertStrictEquals(result.toolCalls, undefined);
  });

  it("an aborted stream retains usage fields split across frames", async () => {
    const abortController = new AbortController();
    const { promise: firstDelta, resolve: sawDelta } = Promise
      .withResolvers<void>();
    const transport = heldOpen(
      `data: ${
        JSON.stringify({
          choices: [{ delta: { content: "partial" } }],
          usage: { prompt_tokens: 100 },
        })
      }\n` +
        `data: ${
          JSON.stringify({
            choices: [],
            usage: { completion_tokens: 20 },
          })
        }\n`,
    );
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemma4:e2b" },
      models,
      abortSignal: abortController.signal,
      onTextDelta: () => sawDelta(),
      fetchFn: transport.fetch,
    });

    await firstDelta;
    abortController.abort();
    const result = await pending;

    transport.assertDone();
    assertObjectMatch(result.usage, { input: 100, output: 20 });
  });

  it("an abort observed before dispatch records no provider call usage", async () => {
    const abortController = new AbortController();
    abortController.abort();
    // The empty transport would itself reject an already-aborted call without
    // recording it, so a spy is what proves the call never happened.
    const transport = new ScriptedHttpTransport();
    const fetchFn = spy(transport.fetch);

    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemma4:e2b" },
      models,
      abortSignal: abortController.signal,
      fetchFn,
    });

    assertSpyCalls(fetchFn, 0);
    assertStrictEquals(transport.requests.length, 0);
    assertStrictEquals(result.stopReason, "aborted");
    assertStrictEquals(result.requestDispatched, false);
    assertObjectMatch(result.usage, {
      input: 0,
      output: 0,
      cost: { total: 0 },
    });
  });

  it("an abort ignores only an incomplete buffered frame", async () => {
    const abortController = new AbortController();
    const { promise: firstDelta, resolve: sawDelta } = Promise
      .withResolvers<void>();
    const transport = heldOpen(
      'data: {"choices":[{"delta":{"content":"partial"}}]}\n' +
        'data: {"choices":[',
    );
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemma4:e2b" },
      models,
      abortSignal: abortController.signal,
      onTextDelta: () => sawDelta(),
      fetchFn: transport.fetch,
    });

    await firstDelta;
    abortController.abort();

    assertObjectMatch(await pending, {
      text: "partial",
      stopReason: "aborted",
    });
    transport.assertDone();
  });

  it("an aborted stream strips a long incomplete leaked tool-call suffix", async () => {
    const abortController = new AbortController();
    const { promise: firstDelta, resolve: sawDelta } = Promise
      .withResolvers<void>();
    const generated =
      "partial<tool_call><function=list_files><parameter=path>" +
      "x".repeat(1024);
    const transport = heldOpen(contentFrame(generated));
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemma4:e2b" },
      models,
      abortSignal: abortController.signal,
      tools: [listFiles],
      onTextDelta: () => sawDelta(),
      fetchFn: transport.fetch,
    });

    await firstDelta;
    abortController.abort();
    const result = await pending;

    transport.assertDone();
    assertStrictEquals(result.text, "partial");
    assertStrictEquals(result.stopReason, "aborted");
    assertStrictEquals(result.toolCalls, undefined);
    assertStrictEquals(result.usage.output, estimateTextTokens(generated));
  });

  it("an aborted stream preserves an ambiguous literal wrapper suffix", async () => {
    const abortController = new AbortController();
    const { promise: firstDelta, resolve: sawDelta } = Promise
      .withResolvers<void>();
    const text = "explain <tool_call>";
    const transport = heldOpen(contentFrame(text));
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "explain syntax",
      routing: { modelId: "gemma4:e2b" },
      models,
      abortSignal: abortController.signal,
      tools: [listFiles],
      onTextDelta: () => sawDelta(),
      fetchFn: transport.fetch,
    });

    await firstDelta;
    abortController.abort();
    const result = await pending;

    transport.assertDone();
    assertStrictEquals(result.text, text);
    assertStrictEquals(result.stopReason, "aborted");
    assertStrictEquals(result.toolCalls, undefined);
  });

  it("an abort ignores a truncated buffered JSON array at the input boundary", async () => {
    const abortController = new AbortController();
    const transport = heldOpen('data: {"choices":[1,2');
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemma4:e2b" },
      models,
      abortSignal: abortController.signal,
      onTextDelta: () => {},
      fetchFn: transport.fetch,
    });

    await yieldToStream();
    abortController.abort();

    assertObjectMatch(await pending, { stopReason: "aborted" });
    transport.assertDone();
  });

  it("an aborted stream preserves whitespace before stripped tool markup", async () => {
    const abortController = new AbortController();
    const { promise: firstDelta, resolve: sawDelta } = Promise
      .withResolvers<void>();
    const prefix = "partial  \n";
    const transport = heldOpen(
      contentFrame(`${prefix}<tool_call><function=list_files><parameter=path>`),
    );
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemma4:e2b" },
      models,
      abortSignal: abortController.signal,
      tools: [listFiles],
      onTextDelta: () => sawDelta(),
      fetchFn: transport.fetch,
    });

    await firstDelta;
    abortController.abort();
    const result = await pending;

    transport.assertDone();
    assertStrictEquals(result.text, prefix);
    assertStrictEquals(result.stopReason, "aborted");
  });

  it("an aborted stream preserves tool-like prose when no matching tool was offered", async () => {
    const abortController = new AbortController();
    const { promise: firstDelta, resolve: sawDelta } = Promise
      .withResolvers<void>();
    const text =
      "The syntax is <tool_call><function=foo></function></tool_call>.";
    const transport = heldOpen(contentFrame(text));
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemma4:e2b" },
      models,
      abortSignal: abortController.signal,
      tools: [listFiles],
      onTextDelta: () => sawDelta(),
      fetchFn: transport.fetch,
    });

    await firstDelta;
    abortController.abort();
    const result = await pending;

    transport.assertDone();
    assertStrictEquals(result.text, text);
    assertStrictEquals(result.stopReason, "aborted");
  });

  it("an aborted no-tools stream preserves complete function-like prose", async () => {
    const abortController = new AbortController();
    const { promise: received, resolve: sawDelta } = Promise
      .withResolvers<void>();
    const text = "Use <function=foo> literally";
    const deltas: string[] = [];
    const transport = heldOpen(contentFrame(text));
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemma4:e2b" },
      models,
      abortSignal: abortController.signal,
      onTextDelta: (delta) => {
        deltas.push(delta);
        sawDelta();
      },
      fetchFn: transport.fetch,
    });

    await received;
    abortController.abort();
    const result = await pending;

    transport.assertDone();
    assertStrictEquals(deltas.join(""), text);
    assertStrictEquals(result.text, text);
    assertStrictEquals(result.stopReason, "aborted");
  });

  it("an aborted stream releases an ambiguous tool prefix once later text disproves it", async () => {
    const abortController = new AbortController();
    const { promise: received, resolve: sawDelta } = Promise
      .withResolvers<void>();
    const deltas: string[] = [];
    const text = "Use <function=list_users> literally";
    const transport = heldOpen(
      contentFrame("Use <function=list_") + contentFrame("users> literally"),
    );
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemma4:e2b" },
      models,
      abortSignal: abortController.signal,
      tools: [listFiles],
      onTextDelta: (delta) => {
        deltas.push(delta);
        if (deltas.join("") === text) sawDelta();
      },
      fetchFn: transport.fetch,
    });

    await received;
    abortController.abort();
    const result = await pending;

    transport.assertDone();
    assertStrictEquals(deltas.join(""), text);
    assertStrictEquals(result.text, text);
    assertStrictEquals(result.stopReason, "aborted");
  });

  it("releases a malformed wrapped opening after a bounded prefix", async () => {
    const abortController = new AbortController();
    const { promise: sawText, resolve: received } = Promise
      .withResolvers<void>();
    const text = "<tool_call><function=list_files " + "x".repeat(128);
    const deltas: string[] = [];
    const transport = heldOpen(contentFrame(text));
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "explain",
      routing: { modelId: "gemma4:e2b" },
      models,
      abortSignal: abortController.signal,
      tools: [listFiles],
      onTextDelta: (delta) => {
        deltas.push(delta);
        if (deltas.join("") === text) received();
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

  it("an aborted stream preserves an empty function-name prefix", async () => {
    const abortController = new AbortController();
    const { promise: sawText, resolve: received } = Promise
      .withResolvers<void>();
    const text = "Explain <function=";
    const deltas: string[] = [];
    const transport = heldOpen(contentFrame(text));
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemma4:e2b" },
      models,
      abortSignal: abortController.signal,
      tools: [listFiles],
      onTextDelta: (delta) => {
        deltas.push(delta);
        if (deltas.join("") === text) received();
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

  it("a pre-header abort records elapsed time without claiming headers arrived", async () => {
    const abortController = new AbortController();
    const clock = new ManualClock({ readings: [105, 130] });
    const transport = new ScriptedHttpTransport([{
      respond: { withholdHeaders: true },
    }]);
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemma4:e2b" },
      models,
      abortSignal: abortController.signal,
      now: clock.now,
      fetchFn: transport.fetch,
    });

    abortController.abort();
    const result = await pending;

    transport.assertDone();
    assertStrictEquals(result.stopReason, "aborted");
    assertEquals(result.timings, {
      responseHeadersMs: 0,
      totalMs: 25,
    });
  });
});
