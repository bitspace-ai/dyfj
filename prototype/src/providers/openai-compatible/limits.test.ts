// Turn-level response bounds for the OpenAI-compatible adapter: byte,
// fragment, and read limits; reader cancellation on failure; structured-call
// count bounds; fragmented names; and dotted tool names across the wire.

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

const LIMIT_MESSAGE = "Provider response exceeded the adapter limit";

describe("runWorkbenchTurn streaming", () => {
  it("bounds buffered and streamed OpenAI-compatible responses before JSON parsing", async () => {
    const oversized = `{"payload":"${"x".repeat(4 * 1024 * 1024)}"}`;
    const response = {
      choices: [{
        message: {
          content: "",
          tool_calls: [{
            id: "tc-large",
            type: "function",
            function: { name: "read_file", arguments: oversized },
          }],
        },
        finish_reason: "tool_calls",
      }],
    };
    const common = {
      systemPrompt: "system",
      prompt: "read a file",
      routing: { modelId: "gemma4:e2b" },
      models,
    };

    const buffered = new ScriptedHttpTransport([{
      respond: () => Response.json(response),
    }]);
    await assertRejects(
      () => runWorkbenchTurn({ ...common, fetchFn: buffered.fetch }),
      Error,
      LIMIT_MESSAGE,
    );
    buffered.assertDone();

    const streamed = sseTransport([response]);
    await assertRejects(
      () =>
        runWorkbenchTurn({
          ...common,
          onTextDelta: () => {},
          fetchFn: streamed.fetch,
        }),
      Error,
      LIMIT_MESSAGE,
    );
    streamed.assertDone();
  });

  it("bounds response fragmentation in buffered and streamed modes", async () => {
    const fragmentedResponse = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (let index = 0; index < 8_193; index++) {
              controller.enqueue(new Uint8Array([0x20]));
            }
          },
        }),
      );
    const common = {
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemma4:e2b" },
      models,
    };

    const buffered = new ScriptedHttpTransport([{
      respond: () => fragmentedResponse(),
    }]);
    await assertRejects(
      () => runWorkbenchTurn({ ...common, fetchFn: buffered.fetch }),
      Error,
      LIMIT_MESSAGE,
    );
    buffered.assertDone();

    const streamed = new ScriptedHttpTransport([{
      respond: () => fragmentedResponse(),
    }]);
    await assertRejects(
      () =>
        runWorkbenchTurn({
          ...common,
          onTextDelta: () => {},
          fetchFn: streamed.fetch,
        }),
      Error,
      LIMIT_MESSAGE,
    );
    streamed.assertDone();
  });

  it("does not count zero-byte reads toward the fragmentation limit", async () => {
    const responseAfterEmptyReads = (body: string) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (let index = 0; index < 8_193; index++) {
              controller.enqueue(new Uint8Array());
            }
            controller.enqueue(new TextEncoder().encode(body));
            controller.close();
          },
        }),
      );
    const common = {
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemma4:e2b" },
      models,
    };
    const response = {
      choices: [{
        message: { content: "ok" },
        finish_reason: "stop",
      }],
    };
    const transport = new ScriptedHttpTransport([
      { respond: () => responseAfterEmptyReads(JSON.stringify(response)) },
      {
        respond: () =>
          responseAfterEmptyReads(`data: ${JSON.stringify(response)}\n\n`),
      },
    ]);

    const buffered = await runWorkbenchTurn({
      ...common,
      fetchFn: transport.fetch,
    });
    const streamed = await runWorkbenchTurn({
      ...common,
      onTextDelta: () => {},
      fetchFn: transport.fetch,
    });

    assertStrictEquals(buffered.text, "ok");
    assertStrictEquals(streamed.text, "ok");
    transport.assertDone();
  });

  it("bounds total response reads even when every read is empty", async () => {
    const emptyReads = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (let index = 0; index < 16_385; index++) {
              controller.enqueue(new Uint8Array());
            }
          },
        }),
      );
    const common = {
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemma4:e2b" },
      models,
    };
    const transport = new ScriptedHttpTransport([
      { respond: () => emptyReads() },
      { respond: () => emptyReads() },
    ]);

    await assertRejects(
      () => runWorkbenchTurn({ ...common, fetchFn: transport.fetch }),
      Error,
      LIMIT_MESSAGE,
    );
    await assertRejects(
      () =>
        runWorkbenchTurn({
          ...common,
          onTextDelta: () => {},
          fetchFn: transport.fetch,
        }),
      Error,
      LIMIT_MESSAGE,
    );
    transport.assertDone();
  });

  it("does not wait for reader cancellation before rejecting a response limit", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));
      },
      cancel() {
        return new Promise<void>(() => {});
      },
    });
    const transport = new ScriptedHttpTransport([{
      respond: () => new Response(body),
    }]);
    const rejection = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemma4:e2b" },
      models,
      onTextDelta: () => {},
      fetchFn: transport.fetch,
    });

    // The guard timer is cleared afterwards so the op sanitizer stays quiet.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await assertRejects(
        () =>
          Promise.race([
            rejection,
            new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("reader cancellation blocked")),
                100,
              );
            }),
          ]),
        Error,
        LIMIT_MESSAGE,
      );
    } finally {
      clearTimeout(timer);
    }
    transport.assertDone();
  });

  it("bounds streamed structured-call count and aggregate name fragments", async () => {
    const calls = Array.from({ length: 129 }, (_, index) => ({
      index,
      id: `tc-${index}`,
      type: "function",
      function: { name: "read_file", arguments: "{}" },
    }));
    const common = {
      systemPrompt: "system",
      prompt: "read files",
      routing: { modelId: "gemma4:e2b" },
      models,
      onTextDelta: () => {},
    };

    const tooMany = sseTransport([{
      choices: [{ delta: { tool_calls: calls } }],
    }]);
    await assertRejects(
      () => runWorkbenchTurn({ ...common, fetchFn: tooMany.fetch }),
      Error,
      "Provider returned too many structured tool calls",
    );
    tooMany.assertDone();

    const longName = sseTransport([{
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            function: { name: "x".repeat(64 * 1024 + 1) },
          }],
        },
      }],
    }]);
    await assertRejects(
      () => runWorkbenchTurn({ ...common, fetchFn: longName.fetch }),
      Error,
      "Provider returned too many structured tool calls",
    );
    longName.assertDone();
  });

  it("cancels the response reader when mid-stream validation fails", async () => {
    let cancelled = false;
    const calls = Array.from({ length: 129 }, (_, index) => ({
      index,
      function: { name: "read_file", arguments: "{}" },
    }));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          `data: ${
            JSON.stringify({
              choices: [{ delta: { tool_calls: calls } }],
            })
          }\n\n`,
        ));
      },
      cancel() {
        cancelled = true;
      },
    });
    const transport = new ScriptedHttpTransport([{
      respond: () => new Response(body),
    }]);

    await assertRejects(
      () =>
        runWorkbenchTurn({
          systemPrompt: "system",
          prompt: "read files",
          routing: { modelId: "gemma4:e2b" },
          models,
          onTextDelta: () => {},
          fetchFn: transport.fetch,
        }),
      Error,
      "Provider returned too many structured tool calls",
    );
    assertStrictEquals(cancelled, true);
    transport.assertDone();
  });

  it("cancels the response reader when a complete SSE line is malformed", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: {oops}\n\n"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const transport = new ScriptedHttpTransport([{
      respond: () => new Response(body),
    }]);

    await assertRejects(
      () =>
        runWorkbenchTurn({
          systemPrompt: "system",
          prompt: "hello",
          routing: { modelId: "gemma4:e2b" },
          models,
          onTextDelta: () => {},
          fetchFn: transport.fetch,
        }),
      SyntaxError,
    );
    assertStrictEquals(cancelled, true);
    transport.assertDone();
  });

  it("cancels an open response as soon as tool arguments exceed the limit", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          `data: ${
            JSON.stringify({
              choices: [{
                delta: {
                  tool_calls: [{
                    index: 0,
                    function: {
                      name: "read_file",
                      arguments: "x".repeat(64 * 1024 + 1),
                    },
                  }],
                },
              }],
            })
          }\n\n`,
        ));
      },
      cancel() {
        cancelled = true;
      },
    });
    const transport = new ScriptedHttpTransport([{
      respond: () => new Response(body),
    }]);

    await assertRejects(
      () =>
        runWorkbenchTurn({
          systemPrompt: "system",
          prompt: "read a file",
          routing: { modelId: "gemma4:e2b" },
          models,
          tools: [{
            name: "read_file",
            description: "Read a file.",
            parameters: { type: "object" },
          }],
          onTextDelta: () => {},
          fetchFn: transport.fetch,
        }),
      Error,
      "Provider returned oversized tool arguments",
    );
    assertStrictEquals(cancelled, true);
    transport.assertDone();
  });

  it("accumulates fragmented tool-call names by index", async () => {
    const transport = sseTransport([
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "tc-3",
              type: "function",
              function: { name: "write" },
            }],
          },
        }],
      },
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              function: {
                name: "_file",
                arguments: '{"path":"notes.md"}',
              },
            }],
          },
          finish_reason: "tool_calls",
        }],
      },
    ]);
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "write a file",
      routing: { modelId: "gemma4:e2b" },
      models,
      onTextDelta: () => {},
      fetchFn: transport.fetch,
    });

    assertEquals(result.toolCalls, [{
      id: "tc-3",
      name: "write_file",
      arguments: { path: "notes.md" },
    }]);
    transport.assertDone();
  });

  it("sanitizes dotted tool names on the wire and maps the response back", async () => {
    const transport = new ScriptedHttpTransport([{
      respond: {
        status: 200,
        body: JSON.stringify({
          choices: [{
            message: {
              content: "",
              tool_calls: [{
                id: "c1",
                type: "function",
                function: { name: "memory_read", arguments: '{"slug":"x"}' },
              }],
            },
            finish_reason: "tool_calls",
          }],
          usage: { prompt_tokens: 5, completion_tokens: 3 },
        }),
      },
    }]);
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "load a memory",
      routing: { modelId: "gemma4:e2b" },
      models,
      tools: [{
        name: "memory.read",
        description: "Load one memory by slug.",
        parameters: {
          type: "object",
          properties: { slug: { type: "string" } },
        },
      }],
      fetchFn: transport.fetch,
    });

    const sentBody: { tools?: Array<{ function: { name: string } }> } = JSON
      .parse(transport.requests[0].body);
    // Request carried the sanitized name (OpenAI rejects the dotted form)...
    assertStrictEquals(sentBody.tools?.[0].function.name, "memory_read");
    // ...and the response mapped back to the registry name for dispatch.
    assertEquals(result.toolCalls, [
      { id: "c1", name: "memory.read", arguments: { slug: "x" } },
    ]);
    transport.assertDone();
  });
});
