// Turn-level tests for how the OpenAI-compatible adapter ranks provider
// errors against cancellation: malformed frames, independent aborts, error
// envelopes, and terminal error finishes.

import {
  assertEquals,
  assertObjectMatch,
  assertRejects,
  assertStrictEquals,
} from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { ScriptedHttpTransport } from "../../../testing/fakes/scripted-http-transport.ts";
import { runWorkbenchTurn } from "../mod.ts";
import { providerTestModels } from "../../../testing/builders/models.ts";

const models = [...providerTestModels];
/** Lets the turn read the held-open body before the test aborts. */
const yieldToStream = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("runWorkbenchTurn streaming", () => {
  it("a concurrent abort does not mask a malformed provider frame", async () => {
    const abortController = new AbortController();
    // A function responder: the abort must land while fetch is in flight.
    const transport = new ScriptedHttpTransport([{
      respond: () => {
        abortController.abort();
        return new Response("data: {malformed}\n\n", { status: 200 });
      },
    }]);
    await assertRejects(
      () =>
        runWorkbenchTurn({
          systemPrompt: "system",
          prompt: "hello",
          routing: { modelId: "gemma4:e2b" },
          models,
          abortSignal: abortController.signal,
          onTextDelta: () => {},
          fetchFn: transport.fetch,
        }),
      SyntaxError,
    );
    transport.assertDone();
  });

  it("a concurrent abort does not mask a truncated frame at clean EOF", async () => {
    const abortController = new AbortController();
    // A function responder: the abort must land while fetch is in flight.
    const transport = new ScriptedHttpTransport([{
      respond: () => {
        abortController.abort();
        return new Response('data: {"choices":[');
      },
    }]);
    await assertRejects(
      () =>
        runWorkbenchTurn({
          systemPrompt: "system",
          prompt: "hello",
          routing: { modelId: "gemma4:e2b" },
          models,
          abortSignal: abortController.signal,
          onTextDelta: () => {},
          fetchFn: transport.fetch,
        }),
      SyntaxError,
    );
    transport.assertDone();
  });

  it("an abort does not suppress a complete malformed buffered frame", async () => {
    const abortController = new AbortController();
    const transport = new ScriptedHttpTransport([{
      respond: { body: "data: {malformed}", holdOpen: true },
    }]);
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

    await assertRejects(() => pending, SyntaxError);
    transport.assertDone();
  });

  it("an abort does not suppress a buffered frame with mismatched delimiters", async () => {
    const abortController = new AbortController();
    const transport = new ScriptedHttpTransport([{
      respond: { body: 'data: {"choices":[}', holdOpen: true },
    }]);
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

    await assertRejects(() => pending, SyntaxError);
    transport.assertDone();
  });

  it("an abort does not suppress an invalid token inside an unfinished object", async () => {
    const abortController = new AbortController();
    const transport = new ScriptedHttpTransport([{
      respond: { body: 'data: {"choices": @', holdOpen: true },
    }]);
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

    await assertRejects(() => pending, SyntaxError);
    transport.assertDone();
  });

  it("a concurrent independent AbortError is not attributed to the caller", async () => {
    const abortController = new AbortController();
    const independent = new DOMException("independent", "AbortError");
    // A function responder: the body errors with a specific value, and the
    // caller's abort must land while fetch is in flight.
    const transport = new ScriptedHttpTransport([{
      respond: () => {
        abortController.abort();
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(independent);
            },
          }),
          { status: 200 },
        );
      },
    }]);
    const error = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemma4:e2b" },
      models,
      abortSignal: abortController.signal,
      onTextDelta: () => {},
      fetchFn: transport.fetch,
    }).then(() => undefined, (x) => x);
    assertStrictEquals(error, independent);
    transport.assertDone();
  });

  it("a provider terminal error outranks a concurrent cancellation", async () => {
    const abortController = new AbortController();
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: 'data: {"choices":[{"delta":{},"finish_reason":"error"}]}\n',
        holdOpen: true,
      },
    }]);
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

    assertObjectMatch(await pending, { stopReason: "error" });
    transport.assertDone();
  });

  it("a top-level provider error envelope fails a buffered response", async () => {
    // A function responder: the old case built the body with Response.json.
    const transport = new ScriptedHttpTransport([{
      respond: () => Response.json({ error: { message: "quota exceeded" } }),
    }]);
    await assertRejects(
      () =>
        runWorkbenchTurn({
          systemPrompt: "system",
          prompt: "hello",
          routing: { modelId: "gemma4:e2b" },
          models,
          fetchFn: transport.fetch,
        }),
      Error,
      "Provider response returned an error envelope",
    );
    transport.assertDone();
  });

  it("a provider terminal error outranks recoverable textual tool markup", async () => {
    const deltas: string[] = [];
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: `data: ${
          JSON.stringify({
            choices: [{
              delta: {
                content:
                  "<tool_call><function=write_file><parameter=path>notes.md</parameter></function></tool_call>",
              },
              finish_reason: "error",
            }],
          })
        }\n`,
      },
    }]);
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemma4:e2b" },
      models,
      tools: [{
        name: "write_file",
        description: "Write a file.",
        parameters: { type: "object" },
      }],
      onTextDelta: (delta) => deltas.push(delta),
      fetchFn: transport.fetch,
    });

    transport.assertDone();
    assertStrictEquals(result.stopReason, "error");
    assertStrictEquals(result.text, "");
    assertEquals(deltas, []);
    assertStrictEquals(result.toolCalls, undefined);
  });

  it("a buffered provider error cannot be reclassified as textual tool use", async () => {
    // A function responder: the old case built the body with Response.json.
    const transport = new ScriptedHttpTransport([{
      respond: () =>
        Response.json({
          choices: [{
            message: {
              content:
                "<tool_call><function=write_file><parameter=path>notes.md</parameter></function></tool_call>",
            },
            finish_reason: "error",
          }],
        }),
    }]);
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemma4:e2b" },
      models,
      tools: [{
        name: "write_file",
        description: "Write a file.",
        parameters: { type: "object" },
      }],
      fetchFn: transport.fetch,
    });

    transport.assertDone();
    assertStrictEquals(result.stopReason, "error");
    assertStrictEquals(result.toolCalls, undefined);
  });
});
