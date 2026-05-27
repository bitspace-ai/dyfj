import { describe, expect, test } from "vitest";
import {
  compareContextPayloads,
  type ContextPayloadReport,
} from "./context-size-response";
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

describe("compareContextPayloads", () => {
  test("reports timing and token fields for small and large context payloads", async () => {
    const report = await compareContextPayloads({
      prompt: "Return ok.",
      routing: { modelId: "gemma4:e2b" },
      models,
      payloads: [
        { label: "small", systemPrompt: "short context" },
        { label: "large", systemPrompt: "large context ".repeat(100) },
      ],
      now: buildClock([0, 10, 30, 70, 0, 20, 80, 140]),
      fetchFn: buildFakeStreamingFetch(),
    });

    expect(report.map(summary)).toEqual([
      {
        label: "small",
        provider: "ollama",
        model: "gemma4:e2b",
        streamed: true,
        estimated_input_tokens: 6,
        total_latency_ms: 70,
        time_to_first_token_ms: 30,
      },
      {
        label: "large",
        provider: "ollama",
        model: "gemma4:e2b",
        streamed: true,
        estimated_input_tokens: 353,
        total_latency_ms: 140,
        time_to_first_token_ms: 80,
      },
    ]);
  });
});

function summary(report: ContextPayloadReport) {
  return {
    label: report.label,
    provider: report.provider,
    model: report.model,
    streamed: report.streamed,
    estimated_input_tokens: report.estimated_input_tokens,
    total_latency_ms: report.total_latency_ms,
    time_to_first_token_ms: report.time_to_first_token_ms,
  };
}

function buildClock(values: number[]): () => number {
  let last = 0;
  return () => {
    last = values.shift() ?? last;
    return last;
  };
}

function buildFakeStreamingFetch(): typeof fetch {
  return async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode([
            'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"completion_tokens":1}}\n\n',
            "data: [DONE]\n\n",
          ].join("")));
          controller.close();
        },
      }),
    );
}
