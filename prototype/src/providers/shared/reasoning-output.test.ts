import assert from "node:assert/strict";
import { test } from "node:test";
import { ScriptedHttpTransport } from "../../../testing/fakes/scripted-http-transport.ts";
import {
  modelTransmittedOutputCap,
  runWorkbenchTurn,
  type WorkbenchModel,
} from "../mod.ts";

const providers = [
  ["openrouter", "https://openrouter.ai/api/v1"],
  ["openai", "https://api.openai.com/v1"],
  ["xai", "https://api.x.ai/v1"],
  ["anthropic", "https://api.anthropic.com"],
  ["google", "https://generativelanguage.googleapis.com"],
] as const;

function model(provider: string, baseUrl: string): WorkbenchModel {
  return {
    slug: "reasoning-model",
    displayName: "Reasoning model",
    provider,
    baseUrl,
    api: "test",
    tier: 1,
    costInput: 1,
    costOutput: 1,
    capabilities: ["text", "reasoning"],
    reasoningEffortControl: true,
    maxOutputTokens: 65_536,
  };
}

async function capture(
  subject: WorkbenchModel,
  maxOutputTokens?: number,
  withTools = false,
) {
  const response = subject.provider === "anthropic"
    ? {
      content: [{ type: "text", text: "answer" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 4 },
    }
    : subject.provider === "google"
    ? {
      candidates: [{
        content: { parts: [{ text: "answer" }] },
        finishReason: "STOP",
      }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4 },
    }
    : {
      choices: [{ message: { content: "answer" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 4 },
    };
  const transport = new ScriptedHttpTransport([{
    respond: { body: JSON.stringify(response) },
  }]);
  const result = await runWorkbenchTurn({
    systemPrompt: "system",
    prompt: "answer",
    models: [subject],
    routing: { modelId: subject.slug },
    getEnv: () => "canary-provider-key",
    fetchFn: transport.fetch,
    maxOutputTokens,
    ...(withTools
      ? {
        tools: [{
          name: "lookup",
          description: "Look up a fact",
          parameters: { type: "object" },
        }],
      }
      : {}),
  });
  transport.assertDone();
  assert.equal(result.text, "answer");
  assert.equal(result.stopReason, "stop");
  return JSON.parse(transport.requests[0].body);
}

function wireCap(body: {
  max_completion_tokens?: number;
  max_tokens?: number;
  generationConfig?: { maxOutputTokens?: number };
}): number | undefined {
  return body.max_completion_tokens ?? body.max_tokens ??
    body.generationConfig?.maxOutputTokens;
}

for (const [provider, baseUrl] of providers) {
  test(`${provider} gives reasoning a larger cap and the provider's low-effort parameter`, async () => {
    const subject = model(provider, baseUrl);
    const body = await capture(subject);
    assert.equal(wireCap(body), 32_768);
    assert.equal(modelTransmittedOutputCap(subject), wireCap(body));
    if (provider === "openrouter") {
      assert.deepEqual(body.reasoning, { effort: "low" });
      assert.equal(body.reasoning_effort, undefined);
    } else if (provider === "anthropic") {
      assert.deepEqual(body.output_config, { effort: "low" });
      assert.equal(body.thinking, undefined);
    } else if (provider === "google") {
      assert.deepEqual(body.generationConfig.thinkingConfig, {
        thinkingLevel: "low",
      });
    } else {
      assert.equal(body.reasoning_effort, "low");
      assert.equal(body.reasoning, undefined);
    }
  });

  test(`${provider} preserves explicit caps and clamps defaults to the catalog`, async () => {
    const subject = model(provider, baseUrl);
    for (
      const [catalog, requested, expected] of [
        [65_536, 1024, 1024],
        [4096, undefined, 4096],
        [4096, 8192, 4096],
      ] as const
    ) {
      subject.maxOutputTokens = catalog;
      const body = await capture(subject, requested);
      assert.equal(wireCap(body), expected);
      assert.equal(modelTransmittedOutputCap(subject, requested), expected);
    }
  });
}

test("models without effort control get the larger cap without an invented reasoning parameter", async () => {
  for (const [provider, baseUrl] of providers.filter(([p]) => p !== "google")) {
    const subject = {
      ...model(provider, baseUrl),
      reasoningEffortControl: false,
    };
    const body = await capture(subject);
    assert.equal(wireCap(body), 32_768);
    assert.equal(body.reasoning, undefined);
    assert.equal(body.reasoning_effort, undefined);
    assert.equal(body.output_config, undefined);
  }
});

test("OpenAI keeps none effort on tool calls and uses low effort for the answer", async () => {
  const subject = model("openai", "https://api.openai.com/v1");
  assert.equal(
    (await capture(subject, undefined, true)).reasoning_effort,
    "none",
  );
  assert.equal((await capture(subject)).reasoning_effort, "low");
});

test("non-reasoning hosted requests retain their default caps", async () => {
  for (const [provider, baseUrl] of providers) {
    const subject = {
      ...model(provider, baseUrl),
      capabilities: ["text"],
      reasoningEffortControl: false,
    };
    assert.equal(
      wireCap(await capture(subject)),
      provider === "anthropic" ? 16_000 : 8192,
    );
  }
});

test("local reasoning requests keep the server's cap and receive no hosted effort parameter", async () => {
  const subject = {
    ...model("llama-cpp", "http://127.0.0.1:8080/v1"),
    tier: 0 as const,
  };
  const body = await capture(subject);
  assert.equal(wireCap(body), undefined);
  assert.equal(modelTransmittedOutputCap(subject), undefined);
  assert.equal(body.reasoning_effort, undefined);
  assert.equal(body.reasoning, undefined);
});
