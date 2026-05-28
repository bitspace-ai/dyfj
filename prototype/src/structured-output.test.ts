import { describe, expect, test } from "vitest";
import {
  compareStreamingStructuredOutputModes,
  compareStructuredOutputModes,
  type StreamingStructuredOutputReport,
  type StructuredOutputReport,
} from "./structured-output";
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

describe("compareStructuredOutputModes", () => {
  test("reports validation for prompt-only and JSON-object provider modes", async () => {
    const report = await compareStructuredOutputModes({
      systemPrompt: "Return JSON with answer and confidence.",
      prompt: "Say ok.",
      routing: { modelId: "gemma4:e2b" },
      models,
      now: buildClock([0, 10, 50, 0, 10, 40]),
      fetchFn: buildFakeStructuredOutputFetch(),
    });

    expect(report.map(summary)).toEqual([
      {
        mode: "prompt-only",
        provider: "ollama",
        model: "gemma4:e2b",
        json_object_requested: false,
        validation_ok: false,
        validation_errors: ["model output was not strict JSON"],
        total_latency_ms: 50,
      },
      {
        mode: "json-object",
        provider: "ollama",
        model: "gemma4:e2b",
        json_object_requested: true,
        validation_ok: true,
        validation_errors: [],
        total_latency_ms: 40,
      },
    ]);
    expect(report[1].parsed).toEqual({
      answer: "ok",
      confidence: "high",
    });
  });
});

describe("compareStreamingStructuredOutputModes", () => {
  test("reports streamed timing and validation for loose and rigid output", async () => {
    const report = await compareStreamingStructuredOutputModes({
      systemPrompt: "Return answer and confidence.",
      loosePrompt: "Say ok with confidence.",
      rigidPrompt: 'Return strict JSON: {"answer":"ok","confidence":"high"}.',
      routing: { modelId: "gemma4:e2b" },
      models,
      now: buildClock([0, 10, 30, 90, 0, 10, 40, 100]),
      fetchFn: buildFakeStreamingStructuredOutputFetch(),
    });

    expect(report.map(streamingSummary)).toEqual([
      {
        mode: "loose-streaming",
        streamed: true,
        validation_ok: false,
        total_latency_ms: 90,
        time_to_first_token_ms: 30,
        generation_ms: 60,
        time_per_output_token_ms: 30,
        output_tokens: 3,
      },
      {
        mode: "rigid-streaming",
        streamed: true,
        validation_ok: true,
        total_latency_ms: 100,
        time_to_first_token_ms: 40,
        generation_ms: 60,
        time_per_output_token_ms: 20,
        output_tokens: 4,
      },
    ]);
    expect(report[1].parsed).toEqual({
      answer: "ok",
      confidence: "high",
    });
  });
});

function summary(report: StructuredOutputReport) {
  return {
    mode: report.mode,
    provider: report.provider,
    model: report.model,
    json_object_requested: report.json_object_requested,
    validation_ok: report.validation.ok,
    validation_errors: report.validation.errors,
    total_latency_ms: report.total_latency_ms,
  };
}

function streamingSummary(report: StreamingStructuredOutputReport) {
  return {
    mode: report.mode,
    streamed: report.streamed,
    validation_ok: report.validation.ok,
    total_latency_ms: report.total_latency_ms,
    time_to_first_token_ms: report.time_to_first_token_ms,
    generation_ms: report.generation_ms,
    time_per_output_token_ms: report.time_per_output_token_ms,
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

function buildFakeStructuredOutputFetch(): typeof fetch {
  let call = 0;
  return async (_input, init) => {
    call += 1;
    const body = JSON.parse(String(init?.body));
    if (call === 1) {
      expect(body.response_format).toBeUndefined();
      return Response.json({
        choices: [{
          message: { content: "The answer is ok." },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
    }

    expect(body.response_format).toEqual({ type: "json_object" });
    return Response.json({
      choices: [{
        message: {
          content: JSON.stringify({ answer: "ok", confidence: "high" }),
        },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 11, completion_tokens: 4 },
    });
  };
}

function buildFakeStreamingStructuredOutputFetch(): typeof fetch {
  let call = 0;
  return async () => {
    call += 1;
    const body = call === 1
      ? [
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" with high confidence"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":3}}\n\n',
        "data: [DONE]\n\n",
      ].join("")
      : [
        'data: {"choices":[{"delta":{"content":"{\\"answer\\":"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"\\"ok\\",\\"confidence\\":\\"high\\"}"},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":4}}\n\n',
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
