import { assertEquals, assertStrictEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { ManualClock } from "../testing/fakes/manual-clock.ts";
import { ScriptedHttpTransport } from "../testing/fakes/scripted-http-transport.ts";
import {
  compareResponseModes,
  type ResponseModeReport,
} from "./model-response-modes.ts";
import type { WorkbenchModel } from "../src/providers/mod.ts";

const models: WorkbenchModel[] = [{
  slug: "gemma4:e2b",
  displayName: "Gemma 4 E2B",
  provider: "ollama",
  api: "openai-completions",
  baseUrl: "http://localhost:11434/v1",
  tier: 0,
  costInput: 0,
  costOutput: 0,
  capabilities: ["text", "reasoning"],
}];

describe("compareResponseModes", () => {
  it("reports non-streaming and streaming timings through the provider path", async () => {
    const report = await compareResponseModes({
      systemPrompt: "system",
      prompt: "Say hello.",
      routing: { modelId: "gemma4:e2b" },
      models,
      now: new ManualClock({ readings: [0, 30, 100, 0, 20, 40, 100] }).now,
      fetchFn: responseModeTransport().fetchLike,
    });

    assertEquals(report.map(summary), [
      {
        mode: "non-streaming",
        provider: "ollama",
        model: "gemma4:e2b",
        streamed: false,
        total_latency_ms: 100,
        time_to_first_token_ms: null,
        output_tokens: 2,
      },
      {
        mode: "streaming",
        provider: "ollama",
        model: "gemma4:e2b",
        streamed: true,
        total_latency_ms: 100,
        time_to_first_token_ms: 40,
        output_tokens: 2,
      },
    ]);
    assertStrictEquals(report[1].text, "hello world");
  });
});

function summary(report: ResponseModeReport) {
  return {
    mode: report.mode,
    provider: report.provider,
    model: report.model,
    streamed: report.streamed,
    total_latency_ms: report.total_latency_ms,
    time_to_first_token_ms: report.time_to_first_token_ms,
    output_tokens: report.output_tokens,
  };
}

function responseModeTransport(): ScriptedHttpTransport {
  return new ScriptedHttpTransport([
    {
      respond: {
        body: JSON.stringify({
          choices: [{
            message: { content: "hello world" },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        }),
      },
    },
    {
      respond: {
        body: [
          'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n',
          "data: [DONE]\n\n",
        ].join(""),
      },
    },
  ]);
}
