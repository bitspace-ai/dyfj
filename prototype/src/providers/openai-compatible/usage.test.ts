// Hosted OpenAI-compatible metering through runWorkbenchTurn: catalog rates,
// reasoning-token splits, and how streamed usage frames cover later output.

import {
  assert,
  assertAlmostEquals,
  assertObjectMatch,
  assertStrictEquals,
} from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { ManualClock } from "../../../testing/fakes/manual-clock.ts";
import { MapEnv } from "../../../testing/fakes/map-env.ts";
import { ScriptedHttpTransport } from "../../../testing/fakes/scripted-http-transport.ts";
import {
  estimateTextTokens,
  runWorkbenchTurn,
  type WorkbenchModel,
} from "../mod.ts";

function jsonResponse(body: unknown): ScriptedHttpTransport {
  return new ScriptedHttpTransport([{
    respond: { body: JSON.stringify(body) },
  }]);
}

describe("runWorkbenchTurn hosted OpenRouter", () => {
  const openRouterModel: WorkbenchModel = {
    slug: "z-ai/glm-5.2",
    displayName: "GLM 5.2",
    provider: "openrouter",
    api: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1",
    tier: 1,
    costInput: 0.2688,
    costOutput: 0.8448,
    capabilities: ["text", "code", "reasoning"],
  };
  const env = new MapEnv({ OPENROUTER_API_KEY: "sk-or-key" });
  const getEnv = (name: string) => env.get(name);

  it("meters DeepSeek V3 on OpenRouter with exact rates", async () => {
    const deepseekModel: WorkbenchModel = {
      slug: "deepseek/deepseek-chat",
      displayName: "DeepSeek V3",
      provider: "openrouter",
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
      tier: 1,
      costInput: 0.2574,
      costOutput: 1.0287,
      capabilities: ["text", "code", "reasoning", "tools", "long-context"],
    };
    const transport = jsonResponse({
      choices: [{
        message: { content: "hello from deepseek v3" },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 100_000, completion_tokens: 50_000 },
    });

    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "deepseek/deepseek-chat" },
      models: [deepseekModel],
      getEnv,
      fetchFn: transport.fetch,
    });

    transport.assertDone();
    assertStrictEquals(result.model.slug, "deepseek/deepseek-chat");
    // 0.1M in * 0.2574 + 0.05M out * 1.0287 = 0.02574 + 0.051435 = 0.077175
    assertAlmostEquals(result.usage.cost.total, 0.077175, 5e-6);
  });

  it("meters Meta Muse Spark 1.2 on OpenRouter with exact rates", async () => {
    const museModel: WorkbenchModel = {
      slug: "meta/muse-spark-1.2",
      displayName: "Meta Muse Spark 1.2",
      provider: "openrouter",
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
      tier: 2,
      costInput: 1.25,
      costOutput: 4.25,
      capabilities: [
        "text",
        "code",
        "reasoning",
        "tools",
        "thinking",
        "long-context",
      ],
    };
    const transport = jsonResponse({
      choices: [{
        message: { content: "hello from muse spark" },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 200_000, completion_tokens: 10_000 },
    });

    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "meta/muse-spark-1.2" },
      models: [museModel],
      getEnv,
      fetchFn: transport.fetch,
    });

    transport.assertDone();
    assertStrictEquals(result.model.slug, "meta/muse-spark-1.2");
    // 0.2M in * 1.25 + 0.01M out * 4.25 = 0.25 + 0.0425 = 0.2925
    assertAlmostEquals(result.usage.cost.total, 0.2925, 5e-6);
  });

  it("meters Grok 4.6 on OpenRouter with pass-through rates", async () => {
    const grokOrModel: WorkbenchModel = {
      slug: "x-ai/grok-4.6",
      displayName: "Grok 4.6 (OpenRouter)",
      provider: "openrouter",
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
      tier: 2,
      costInput: 2.0,
      costOutput: 6.0,
      capabilities: [
        "text",
        "code",
        "reasoning",
        "vision",
        "tools",
        "thinking",
        "long-context",
      ],
    };
    const transport = jsonResponse({
      choices: [{
        message: { content: "hello from grok on openrouter" },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 50_000, completion_tokens: 10_000 },
    });

    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "x-ai/grok-4.6" },
      models: [grokOrModel],
      getEnv,
      fetchFn: transport.fetch,
    });

    transport.assertDone();
    assertStrictEquals(result.model.slug, "x-ai/grok-4.6");
    // 0.05M in * 2.0 + 0.01M out * 6.0 = 0.10 + 0.06 = 0.16
    assertAlmostEquals(result.usage.cost.total, 0.16, 5e-6);
  });

  it("meters buffered structured tool calls when usage is absent", async () => {
    const name = "write_file";
    const argumentsJson = `{"content":"${"x".repeat(8_192)}"}`;
    const transport = new ScriptedHttpTransport([{
      respond: () =>
        Response.json({
          choices: [{
            message: {
              content: "",
              tool_calls: [{
                id: "tc-1",
                type: "function",
                function: { name, arguments: argumentsJson },
              }],
            },
            finish_reason: "tool_calls",
          }],
        }),
    }]);
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "z-ai/glm-5.2" },
      models: [openRouterModel],
      tools: [{
        name,
        description: "Write a file.",
        parameters: { type: "object" },
      }],
      getEnv,
      fetchFn: transport.fetch,
    });

    transport.assertDone();
    assertStrictEquals(
      result.usage.output,
      Math.ceil((name.length + argumentsJson.length) / 4),
    );
    assert(result.usage.cost.total > 0, "cost should be positive");
  });

  it("splits provider-reported reasoning from visible output without double charging", async () => {
    const transport = jsonResponse({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 9,
        completion_tokens_details: { reasoning_tokens: 7 },
      },
    });
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "z-ai/glm-5.2" },
      models: [openRouterModel],
      getEnv,
      fetchFn: transport.fetch,
    });

    transport.assertDone();
    assertObjectMatch(result.usage, { input: 10, output: 2, reasoning: 7 });
    assertAlmostEquals(
      result.usage.cost.total,
      (10 * 0.2688 + 9 * 0.8448) / 1_000_000,
      5e-13,
    );
  });

  it("OpenAI-compatible TPOT excludes earlier reasoning tokens", async () => {
    const clock = new ManualClock({ readings: [0, 10, 20, 120] });
    const visible = "x".repeat(40);
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: `data: ${
          JSON.stringify({
            choices: [{
              delta: { content: visible },
              finish_reason: "stop",
            }],
            usage: {
              prompt_tokens: 9,
              completion_tokens: 510,
              completion_tokens_details: { reasoning_tokens: 500 },
            },
          })
        }\n`,
      },
    }]);
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "z-ai/glm-5.2" },
      models: [openRouterModel],
      onTextDelta: () => {},
      now: clock.now,
      getEnv,
      fetchFn: transport.fetch,
    });

    transport.assertDone();
    assertObjectMatch(result.usage, { output: 10, reasoning: 500 });
    assertObjectMatch(result.timings ?? {}, {
      generationMs: 100,
      timePerOutputTokenMs: 11,
    });
  });

  it("ignores a nonnumeric provider reasoning-token value", async () => {
    const transport = jsonResponse({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 9,
        completion_tokens_details: { reasoning_tokens: "7" },
      },
    });
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "z-ai/glm-5.2" },
      models: [openRouterModel],
      getEnv,
      fetchFn: transport.fetch,
    });

    transport.assertDone();
    assertObjectMatch(result.usage, { input: 10, output: 9, reasoning: 0 });
    assertAlmostEquals(
      result.usage.cost.total,
      (10 * 0.2688 + 9 * 0.8448) / 1_000_000,
      5e-13,
    );
  });

  it("uses a smaller catalog completion ceiling when one is declared", async () => {
    const transport = jsonResponse({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "z-ai/glm-5.2" },
      models: [{ ...openRouterModel, maxOutputTokens: 1024 }],
      getEnv,
      fetchFn: transport.fetch,
    });

    transport.assertDone();
    const requestBody = JSON.parse(transport.requests[0].body);
    assertStrictEquals(requestBody.max_completion_tokens, 1024);
  });

  it("estimates streamed plaintext reasoning when cancellation precedes usage", async () => {
    const abortController = new AbortController();
    const reasoning = "1234567890123456789012345678901234567890";
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: `data: ${
          JSON.stringify({
            choices: [{
              delta: {
                reasoning_details: [{
                  type: "reasoning.text",
                  text: reasoning,
                }],
              },
            }],
          })
        }\n`,
        holdOpen: true,
      },
    }]);
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "z-ai/glm-5.2" },
      models: [openRouterModel],
      abortSignal: abortController.signal,
      onTextDelta: () => {},
      getEnv,
      fetchFn: transport.fetch,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    abortController.abort();
    const result = await pending;
    const input = estimateTextTokens("system\nhello");
    const reasoningTokens = estimateTextTokens(reasoning);

    transport.assertDone();
    assertObjectMatch(result, {
      text: "",
      stopReason: "aborted",
      usage: { input, output: 0, reasoning: reasoningTokens },
    });
    assertAlmostEquals(
      result.usage.cost.total,
      (input * 0.2688 + reasoningTokens * 0.8448) / 1_000_000,
      5e-13,
    );
  });

  it("estimates abort-time reasoning when only interim completion usage arrived", async () => {
    const abortController = new AbortController();
    const reasoning = "1234567890123456789012345678901234567890";
    const visible = "12345678901234567890123456789012";
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: `data: ${
          JSON.stringify({
            choices: [{
              delta: {
                reasoning_details: [{
                  type: "reasoning.text",
                  text: reasoning,
                }],
              },
            }],
            usage: { prompt_tokens: 7, completion_tokens: 2 },
          })
        }\n` +
          `data: ${
            JSON.stringify({ choices: [{ delta: { content: visible } }] })
          }\n`,
        holdOpen: true,
      },
    }]);
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "z-ai/glm-5.2" },
      models: [openRouterModel],
      abortSignal: abortController.signal,
      onTextDelta: () => {},
      getEnv,
      fetchFn: transport.fetch,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    abortController.abort();
    const result = await pending;
    const reasoningTokens = estimateTextTokens(reasoning);

    transport.assertDone();
    assertObjectMatch(result, {
      text: visible,
      stopReason: "aborted",
      usage: { input: 7, output: 8, reasoning: reasoningTokens },
    });
    assertAlmostEquals(
      result.usage.cost.total,
      (7 * 0.2688 + (8 + reasoningTokens) * 0.8448) / 1_000_000,
      5e-13,
    );
  });

  it("merges reasoning-token detail across streamed usage frames", async () => {
    const abortController = new AbortController();
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: `data: ${
          JSON.stringify({
            choices: [],
            usage: {
              prompt_tokens: 7,
              completion_tokens: 9,
              completion_tokens_details: { reasoning_tokens: 7 },
            },
          })
        }\n` +
          `data: ${
            JSON.stringify({
              choices: [],
              usage: {
                completion_tokens_details: {
                  accepted_prediction_tokens: 1,
                },
              },
            })
          }\n`,
        holdOpen: true,
      },
    }]);
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "z-ai/glm-5.2" },
      models: [openRouterModel],
      abortSignal: abortController.signal,
      onTextDelta: () => {},
      getEnv,
      fetchFn: transport.fetch,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    abortController.abort();
    const result = await pending;

    transport.assertDone();
    assertObjectMatch(result, {
      stopReason: "aborted",
      usage: { input: 7, output: 2, reasoning: 7 },
    });
  });

  it("lower-bounds interim reasoning usage with later plaintext reasoning", async () => {
    const abortController = new AbortController();
    const laterReasoning = "r".repeat(400);
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: `data: ${
          JSON.stringify({
            choices: [],
            usage: {
              prompt_tokens: 7,
              completion_tokens: 1,
              completion_tokens_details: { reasoning_tokens: 1 },
            },
          })
        }\n` +
          `data: ${
            JSON.stringify({
              choices: [{
                delta: {
                  reasoning_details: [{
                    type: "reasoning.text",
                    text: laterReasoning,
                  }],
                },
              }],
            })
          }\n`,
        holdOpen: true,
      },
    }]);
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "z-ai/glm-5.2" },
      models: [openRouterModel],
      abortSignal: abortController.signal,
      onTextDelta: () => {},
      getEnv,
      fetchFn: transport.fetch,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    abortController.abort();
    const result = await pending;

    transport.assertDone();
    assertObjectMatch(result, {
      stopReason: "aborted",
      usage: { input: 7, output: 0, reasoning: 101 },
    });
    assertAlmostEquals(
      result.usage.cost.total,
      (7 * 0.2688 + 101 * 0.8448) / 1_000_000,
      5e-13,
    );
  });

  it("retains reasoning usage reported without a completion total", async () => {
    const abortController = new AbortController();
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: `data: ${
          JSON.stringify({
            choices: [],
            usage: {
              prompt_tokens: 7,
              completion_tokens_details: { reasoning_tokens: 7 },
            },
          })
        }\n`,
        holdOpen: true,
      },
    }]);
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "z-ai/glm-5.2" },
      models: [openRouterModel],
      abortSignal: abortController.signal,
      onTextDelta: () => {},
      getEnv,
      fetchFn: transport.fetch,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    abortController.abort();
    const result = await pending;

    transport.assertDone();
    assertObjectMatch(result, {
      stopReason: "aborted",
      usage: { input: 7, output: 0, reasoning: 7 },
    });
    assertAlmostEquals(
      result.usage.cost.total,
      (7 * 0.2688 + 7 * 0.8448) / 1_000_000,
      5e-13,
    );
  });

  it("lower-bounds completed usage when plaintext reasoning follows its frame", async () => {
    const laterReasoning = "r".repeat(400);
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: `data: ${
          JSON.stringify({
            choices: [],
            usage: {
              prompt_tokens: 7,
              completion_tokens: 1,
              completion_tokens_details: { reasoning_tokens: 1 },
            },
          })
        }\n\n` +
          `data: ${
            JSON.stringify({
              choices: [{
                delta: {
                  reasoning_details: [{
                    type: "reasoning.text",
                    text: laterReasoning,
                  }],
                },
                finish_reason: "stop",
              }],
            })
          }\n\n` +
          "data: [DONE]\n\n",
      },
    }]);
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "z-ai/glm-5.2" },
      models: [openRouterModel],
      onTextDelta: () => {},
      getEnv,
      fetchFn: transport.fetch,
    });

    transport.assertDone();
    assertObjectMatch(result.usage, {
      input: 7,
      output: 0,
      reasoning: 101,
    });
    assertAlmostEquals(
      result.usage.cost.total,
      (7 * 0.2688 + 101 * 0.8448) / 1_000_000,
      5e-13,
    );
  });

  it("does not refresh completion coverage from a prompt-only usage frame", async () => {
    const laterText = "x".repeat(400);
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: `data: ${
          JSON.stringify({
            choices: [],
            usage: { prompt_tokens: 7, completion_tokens: 1 },
          })
        }\n\n` +
          `data: ${
            JSON.stringify({ choices: [{ delta: { content: laterText } }] })
          }\n\n` +
          `data: ${
            JSON.stringify({
              choices: [{ delta: {}, finish_reason: "stop" }],
              usage: { prompt_tokens: 7 },
            })
          }\n\n` +
          "data: [DONE]\n\n",
      },
    }]);
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "z-ai/glm-5.2" },
      models: [openRouterModel],
      onTextDelta: () => {},
      getEnv,
      fetchFn: transport.fetch,
    });

    transport.assertDone();
    assertObjectMatch(result.usage, { input: 7, output: 101 });
  });

  it("adds post-snapshot text to the highest cumulative usage total", async () => {
    const laterText = "x".repeat(400);
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: `data: ${
          JSON.stringify({
            choices: [],
            usage: { prompt_tokens: 7, completion_tokens: 100 },
          })
        }\n\n` +
          `data: ${
            JSON.stringify({
              choices: [{
                delta: { content: laterText },
                finish_reason: "stop",
              }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            })
          }\n\n` +
          "data: [DONE]\n\n",
      },
    }]);
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "z-ai/glm-5.2" },
      models: [openRouterModel],
      onTextDelta: () => {},
      getEnv,
      fetchFn: transport.fetch,
    });

    transport.assertDone();
    assertObjectMatch(result.usage, { input: 7, output: 200 });
  });

  it("trusts a final completion total without a repeated reasoning split", async () => {
    const laterReasoning = "r".repeat(400);
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: `data: ${
          JSON.stringify({
            choices: [],
            usage: {
              prompt_tokens: 7,
              completion_tokens: 10,
              completion_tokens_details: { reasoning_tokens: 1 },
            },
          })
        }\n\n` +
          `data: ${
            JSON.stringify({
              choices: [{
                delta: {
                  reasoning_details: [{
                    type: "reasoning.text",
                    text: laterReasoning,
                  }],
                },
              }],
            })
          }\n\n` +
          `data: ${
            JSON.stringify({
              choices: [{ delta: {}, finish_reason: "stop" }],
              usage: { completion_tokens: 10 },
            })
          }\n\n` +
          "data: [DONE]\n\n",
      },
    }]);
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "z-ai/glm-5.2" },
      models: [openRouterModel],
      onTextDelta: () => {},
      getEnv,
      fetchFn: transport.fetch,
    });

    transport.assertDone();
    assertObjectMatch(result.usage, {
      input: 7,
      output: 0,
      reasoning: 10,
    });
    assertAlmostEquals(
      result.usage.cost.total,
      (7 * 0.2688 + 10 * 0.8448) / 1_000_000,
      5e-13,
    );
  });
});

describe("runWorkbenchTurn hosted prompt-cache metering", () => {
  const cachedModel: WorkbenchModel = {
    slug: "z-ai/glm-5.2",
    displayName: "GLM 5.2",
    provider: "openrouter",
    api: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1",
    tier: 1,
    costInput: 1,
    costOutput: 2,
    costCacheRead: 0.1,
    costCacheWrite: 1.25,
    capabilities: ["text"],
  };
  const env = new MapEnv({ OPENROUTER_API_KEY: "sk-or-key" });
  const getEnv = (name: string) => env.get(name);
  const cachedUsage = {
    prompt_tokens: 100_000,
    completion_tokens: 1_000,
    prompt_tokens_details: {
      cached_tokens: 60_000,
      cache_write_tokens: 10_000,
    },
  };

  it("splits cached prompt tokens out of input and prices them at the catalog cache rates", async () => {
    const transport = jsonResponse({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: cachedUsage,
    });

    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: cachedModel.slug },
      models: [cachedModel],
      getEnv,
      fetchFn: transport.fetch,
    });

    transport.assertDone();
    // prompt_tokens includes cache traffic; input is the uncached remainder.
    assertObjectMatch(result.usage, {
      input: 30_000,
      cacheRead: 60_000,
      cacheWrite: 10_000,
      output: 1_000,
    });
    // 0.03M * 1 + 0.06M * 0.1 + 0.01M * 1.25 + 0.001M * 2 = 0.0505
    assertAlmostEquals(result.usage.cost.total, 0.0505, 5e-9);
  });

  it("prices cache traffic at the input rate when the row has no cache price", async () => {
    const transport = jsonResponse({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: cachedUsage,
    });
    const { costCacheRead: _r, costCacheWrite: _w, ...unpricedCache } =
      cachedModel;

    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: cachedModel.slug },
      models: [unpricedCache],
      getEnv,
      fetchFn: transport.fetch,
    });

    transport.assertDone();
    assertObjectMatch(result.usage, { cacheRead: 60_000, cacheWrite: 10_000 });
    // Same total as an uncached call: 0.1M * 1 + 0.001M * 2 = 0.102
    assertAlmostEquals(result.usage.cost.total, 0.102, 5e-9);
  });

  it("never reports more cache traffic than prompt tokens", async () => {
    const transport = jsonResponse({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 50,
        completion_tokens: 1,
        prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 40 },
      },
    });

    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: cachedModel.slug },
      models: [cachedModel],
      getEnv,
      fetchFn: transport.fetch,
    });

    transport.assertDone();
    assertObjectMatch(result.usage, {
      input: 0,
      cacheRead: 40,
      cacheWrite: 10,
    });
  });

  it("carries cache tokens from the final streamed usage frame", async () => {
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: `data: ${
          JSON.stringify({
            choices: [{ delta: { content: "ok" }, finish_reason: null }],
          })
        }\n` +
          `data: ${
            JSON.stringify({
              choices: [{ delta: { content: "" }, finish_reason: "stop" }],
              usage: cachedUsage,
            })
          }\n` +
          "data: [DONE]\n",
      },
    }]);

    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: cachedModel.slug },
      models: [cachedModel],
      getEnv,
      onTextDelta: () => {},
      fetchFn: transport.fetch,
    });

    transport.assertDone();
    assertObjectMatch(result.usage, {
      input: 30_000,
      cacheRead: 60_000,
      cacheWrite: 10_000,
    });
    const body = JSON.parse(transport.requests[0].body);
    assertObjectMatch(body, { stream_options: { include_usage: true } });
  });
});
