import { describe, expect, test } from "vitest";
import {
  compareResponseModes,
  type ResponseModeReport,
} from "./model-response-modes";
import type { WorkbenchModel } from "./provider";

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
  test("reports non-streaming and streaming timings through the provider path", async () => {
    const report = await compareResponseModes({
      systemPrompt: "system",
      prompt: "Say hello.",
      routing: { modelId: "gemma4:e2b" },
      models,
      now: buildClock([0, 30, 100, 0, 20, 40, 100]),
      fetchFn: buildFakeResponseModeFetch(),
    });

    expect(report.map(summary)).toEqual([
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
    expect(report[1].text).toBe("hello world");
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

function buildClock(values: number[]): () => number {
  let last = 0;
  return () => {
    last = values.shift() ?? last;
    return last;
  };
}

function buildFakeResponseModeFetch(): typeof fetch {
  let call = 0;
  return async () => {
    call += 1;
    if (call === 1) {
      return Response.json({
        choices: [{
          message: { content: "hello world" },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      });
    }

    const body = [
      'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(body));
          controller.close();
        },
      }),
    );
  };
}
