// Turn-level tests for the OpenAI-compatible adapter: local-provider routing,
// redirect refusal, error-body bounds, and how streamed usage frames combine
// with the character estimate.

import {
  assertObjectMatch,
  assertRejects,
  assertStrictEquals,
} from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { ScriptedHttpTransport } from "../../../testing/fakes/scripted-http-transport.ts";
import {
  defaultLocalWorkbenchModels,
  ProviderRequestFailedError,
  runWorkbenchTurn,
} from "../mod.ts";
import { providerTestModels } from "../../../testing/builders/models.ts";

const models = [...providerTestModels];
describe("runWorkbenchTurn streaming", () => {
  it("uses an OpenAI-compatible MLX local provider", async () => {
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: JSON.stringify({
          choices: [{
            message: { content: "hello from mlx" },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 10, completion_tokens: 3 },
        }),
      },
    }]);

    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "mlx-community/Qwen3-Coder-30B-A3B-Instruct-8bit" },
      models: [
        {
          slug: "mlx-community/Qwen3-Coder-30B-A3B-Instruct-8bit",
          displayName: "Qwen3-Coder 30B MLX",
          provider: "mlx-lm",
          api: "openai-completions",
          baseUrl: "http://127.0.0.1:18080/v1",
          tier: 0,
          costInput: 0,
          costOutput: 0,
          capabilities: ["text", "code"],
        },
      ],
      fetchFn: transport.fetch,
    });

    transport.assertDone();
    assertStrictEquals(
      transport.requests[0].url,
      "http://127.0.0.1:18080/v1/chat/completions",
    );
    assertStrictEquals(
      JSON.parse(transport.requests[0].body).model,
      "mlx-community/Qwen3-Coder-30B-A3B-Instruct-8bit",
    );
    assertStrictEquals(result.model.provider, "mlx-lm");
    assertStrictEquals(result.text, "hello from mlx");
  });

  it("refuses redirects on the provider request (no off-box body egress via 307/308)", async () => {
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: JSON.stringify({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      },
    }]);
    await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "laguna-xs-2.1" },
      models: defaultLocalWorkbenchModels(),
      fetchFn: transport.fetch,
    });
    transport.assertDone();
    // Only the initial base URL is validated as loopback; with redirect: "error"
    // the platform fetch throws on a 307/308 instead of re-POSTing the (private)
    // transcript body to the redirect target off loopback.
    assertStrictEquals(transport.requests[0].redirect, "error");
  });

  it("bounds an OpenAI-compatible error response body", async () => {
    const transport = new ScriptedHttpTransport([{
      respond: { status: 500, body: "x".repeat(4 * 1024 * 1024 + 1) },
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
      "Provider response exceeded the adapter limit",
    );
    transport.assertDone();
  });

  it("lower-bounds a completed stream's early usage with later text", async () => {
    const laterText = "x".repeat(400);
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: `data: ${
          JSON.stringify({
            choices: [],
            usage: { prompt_tokens: 7, completion_tokens: 1 },
          })
        }\n` +
          `data: ${
            JSON.stringify({
              choices: [{
                delta: { content: laterText },
                finish_reason: "stop",
              }],
            })
          }\n` +
          "data: [DONE]\n",
      },
    }]);
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemma4:e2b" },
      models,
      onTextDelta: () => {},
      fetchFn: transport.fetch,
    });

    transport.assertDone();
    assertObjectMatch(result, {
      text: laterText,
      stopReason: "stop",
      usage: { input: 7, output: 101 },
    });
  });

  it("does not let an equal usage-only total erase intervening text", async () => {
    const laterText = "x".repeat(400);
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: `data: ${
          JSON.stringify({
            choices: [],
            usage: { prompt_tokens: 7, completion_tokens: 100 },
          })
        }\n` +
          `data: ${
            JSON.stringify({
              choices: [{ delta: { content: laterText } }],
            })
          }\n` +
          `data: ${
            JSON.stringify({
              choices: [],
              usage: { prompt_tokens: 7, completion_tokens: 100 },
            })
          }\n` +
          "data: [DONE]\n",
      },
    }]);
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemma4:e2b" },
      models,
      onTextDelta: () => {},
      fetchFn: transport.fetch,
    });

    transport.assertDone();
    assertObjectMatch(result.usage, { input: 7, output: 200 });
  });

  it("does not let an earlier finish enable a stale equal usage frame", async () => {
    const laterText = "x".repeat(400);
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: `data: ${
          JSON.stringify({
            choices: [],
            usage: { prompt_tokens: 7, completion_tokens: 100 },
          })
        }\n` +
          `data: ${
            JSON.stringify({
              choices: [{ delta: { content: laterText } }],
            })
          }\n` +
          `data: ${
            JSON.stringify({
              choices: [{ delta: {}, finish_reason: "stop" }],
            })
          }\n` +
          `data: ${
            JSON.stringify({
              choices: [],
              usage: { prompt_tokens: 7, completion_tokens: 100 },
            })
          }\n` +
          "data: [DONE]\n",
      },
    }]);
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemma4:e2b" },
      models,
      onTextDelta: () => {},
      fetchFn: transport.fetch,
    });

    transport.assertDone();
    assertObjectMatch(result.usage, { input: 7, output: 200 });
  });

  it("preserves HTTP status diagnostics for a bodyless error response", async () => {
    // A function responder: a scripted 500 with no body gets an empty body,
    // while this case needs a genuinely null body.
    const transport = new ScriptedHttpTransport([{
      respond: () => new Response(null, { status: 500 }),
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
      ProviderRequestFailedError,
      "ollama/gemma4:e2b: HTTP 500",
    );
    transport.assertDone();
  });

  it("does not ask a local server for streamed usage", async () => {
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: `data: ${
          JSON.stringify({
            choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
          })
        }\n` +
          "data: [DONE]\n",
      },
    }]);
    await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemma4:e2b" },
      models,
      onTextDelta: () => {},
      fetchFn: transport.fetch,
    });

    transport.assertDone();
    const body = JSON.parse(transport.requests[0].body);
    assertStrictEquals("stream_options" in body, false);
  });

  it("trusts final provider usage over the character estimate", async () => {
    const text = "x".repeat(400);
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: `data: ${
          JSON.stringify({
            choices: [{
              delta: { content: text },
              finish_reason: "stop",
            }],
            usage: { prompt_tokens: 7, completion_tokens: 1 },
          })
        }\n` +
          "data: [DONE]\n",
      },
    }]);
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemma4:e2b" },
      models,
      onTextDelta: () => {},
      fetchFn: transport.fetch,
    });

    transport.assertDone();
    assertObjectMatch(result.usage, { input: 7, output: 1 });
  });
});
