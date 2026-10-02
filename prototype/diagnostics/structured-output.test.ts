import { assertEquals, assertStrictEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { ManualClock } from "../testing/fakes/manual-clock.ts";
import { ScriptedHttpTransport } from "../testing/fakes/scripted-http-transport.ts";
import {
  compareStreamingStructuredOutputModes,
  compareStructuredOutputModes,
  type StreamingStructuredOutputReport,
  type StructuredOutputReport,
} from "./structured-output.ts";
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

describe("compareStructuredOutputModes", () => {
  it("reports validation for prompt-only and JSON-object provider modes", async () => {
    const report = await compareStructuredOutputModes({
      systemPrompt: "Return JSON with answer and confidence.",
      prompt: "Say ok.",
      routing: { modelId: "gemma4:e2b" },
      models,
      now: new ManualClock({ readings: [0, 10, 50, 0, 10, 40] }).now,
      fetchFn: structuredOutputTransport().fetchLike,
    });

    assertEquals(report.map(summary), [
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
    assertEquals(report[1].parsed, {
      answer: "ok",
      confidence: "high",
    });
  });
});

describe("compareStreamingStructuredOutputModes", () => {
  it("reports streamed timing and validation for loose and rigid output", async () => {
    const report = await compareStreamingStructuredOutputModes({
      systemPrompt: "Return answer and confidence.",
      loosePrompt: "Say ok with confidence.",
      rigidPrompt: 'Return strict JSON: {"answer":"ok","confidence":"high"}.',
      routing: { modelId: "gemma4:e2b" },
      models,
      now: new ManualClock({ readings: [0, 10, 30, 90, 0, 10, 40, 100] }).now,
      fetchFn: streamingStructuredOutputTransport().fetchLike,
    });

    assertEquals(report.map(streamingSummary), [
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
    assertEquals(report[1].parsed, {
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

function structuredOutputTransport(): ScriptedHttpTransport {
  return new ScriptedHttpTransport([
    {
      expect: (request) =>
        assertStrictEquals(JSON.parse(request.body).response_format, undefined),
      respond: {
        body: JSON.stringify({
          choices: [{
            message: { content: "The answer is ok." },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      },
    },
    {
      expect: (request) =>
        assertEquals(JSON.parse(request.body).response_format, {
          type: "json_object",
        }),
      respond: {
        body: JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({ answer: "ok", confidence: "high" }),
            },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 11, completion_tokens: 4 },
        }),
      },
    },
  ]);
}

function streamingStructuredOutputTransport(): ScriptedHttpTransport {
  return new ScriptedHttpTransport([
    {
      respond: {
        body: [
          'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":" with high confidence"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":3}}\n\n',
          "data: [DONE]\n\n",
        ].join(""),
      },
    },
    {
      respond: {
        body: [
          'data: {"choices":[{"delta":{"content":"{\\"answer\\":"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"\\"ok\\",\\"confidence\\":\\"high\\"}"},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":4}}\n\n',
          "data: [DONE]\n\n",
        ].join(""),
      },
    },
  ]);
}
