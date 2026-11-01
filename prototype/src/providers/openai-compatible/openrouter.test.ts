// OpenRouter price discipline through runWorkbenchTurn: every request carries
// the row's price as `provider.max_price`, so it runs at or below the catalog
// price or not at all; the cost OpenRouter billed replaces the catalog
// estimate when its usage covers the call; and the refusal is named.

import { assertAlmostEqual } from "../../../testing/assertions/almost-equal.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MapEnv } from "../../../testing/fakes/map-env.ts";
import { ScriptedHttpTransport } from "../../../testing/fakes/scripted-http-transport.ts";
import { OPENROUTER_MAX_PRICE_REFUSED } from "../../../testing/providers/failure-fixtures.ts";
import {
  ProviderPriceCapRefusedError,
  runWorkbenchTurn,
  type WorkbenchModel,
} from "../mod.ts";

const kimi: WorkbenchModel = {
  slug: "moonshotai/kimi-k3.1-pro",
  displayName: "Kimi K3.1 Pro",
  provider: "openrouter",
  api: "openai-completions",
  baseUrl: "https://openrouter.ai/api/v1",
  tier: 2,
  costInput: 2.0,
  costOutput: 10.0,
  costCacheRead: 0.2,
  capabilities: ["text", "code", "reasoning"],
};
const gpt: WorkbenchModel = {
  slug: "gpt-test",
  displayName: "GPT test",
  provider: "openai",
  api: "openai-completions",
  baseUrl: "https://api.openai.com/v1",
  tier: 2,
  costInput: 5,
  costOutput: 30,
  capabilities: ["text", "code", "reasoning"],
};
const env = new MapEnv({
  OPENROUTER_API_KEY: "sk-or-key",
  OPENAI_API_KEY: "sk-test-key",
});
const getEnv = (name: string) => env.get(name);

function json(body: unknown): ScriptedHttpTransport {
  return new ScriptedHttpTransport([{
    respond: { body: JSON.stringify(body) },
  }]);
}

const done = {
  choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
};

function run(
  model: WorkbenchModel,
  transport: ScriptedHttpTransport,
  stream = false,
) {
  return runWorkbenchTurn({
    systemPrompt: "system",
    prompt: "hello",
    routing: { modelId: model.slug },
    models: [model],
    getEnv,
    fetchFn: transport.fetch,
    ...(stream ? { onTextDelta: () => {} } : {}),
  });
}

describe("OpenRouter routing preferences", () => {
  it("caps the upstream price at the row's input and output rates", async () => {
    const transport = json({
      ...done,
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    });
    await run(kimi, transport);
    const body = JSON.parse(transport.requests[0].body);
    assert.deepStrictEqual(body.provider, {
      max_price: { prompt: 2.0, completion: 10.0 },
    });
  });

  it("sends no routing preferences to other hosted providers", async () => {
    const transport = json({
      ...done,
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    });
    await run(gpt, transport);
    const body = JSON.parse(transport.requests[0].body);
    assert.strictEqual(Object.hasOwn(body, "provider"), false);
  });
});

describe("OpenRouter billed cost", () => {
  it("records the cost OpenRouter billed in place of the catalog estimate", async () => {
    const transport = json({
      ...done,
      // The catalog estimate for these tokens is $0.000390.
      usage: { prompt_tokens: 100, completion_tokens: 19, cost: 0.0000260667 },
    });
    const result = await run(kimi, transport);
    assert.deepStrictEqual(result.usage.cost, {
      total: 0.0000260667,
      basis: "provider_billed",
    });
  });

  it("records the billed cost from the final streamed usage frame", async () => {
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
              usage: { prompt_tokens: 100, completion_tokens: 1, cost: 0.00042 },
            })
          }\n` +
          "data: [DONE]\n",
      },
    }]);
    const result = await run(kimi, transport, true);
    assert.deepStrictEqual(result.usage.cost, {
      total: 0.00042,
      basis: "provider_billed",
    });
  });

  it("falls back to the catalog estimate, labelled, when no cost comes back", async () => {
    const transport = json({
      ...done,
      usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 },
    });
    const result = await run(kimi, transport);
    assertAlmostEqual(result.usage.cost.total, 2.0 + 10.0, 5e-6);
    assert.strictEqual(result.usage.cost.basis, "catalog_estimate");
  });

  it("ignores a cost that is not a finite non-negative number", async () => {
    const transport = json({
      ...done,
      usage: { prompt_tokens: 1_000_000, completion_tokens: 0, cost: "free" },
    });
    const result = await run(kimi, transport);
    assertAlmostEqual(result.usage.cost.total, 2.0, 5e-6);
    assert.strictEqual(result.usage.cost.basis, "catalog_estimate");
  });

  it("estimates when output arrived after the last billed usage frame", async () => {
    // The interim frame's cost covers one completion token; the text after
    // it was received but not billed in any frame this reader saw.
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: `data: ${
          JSON.stringify({
            choices: [{ delta: { content: "a" }, finish_reason: null }],
            usage: { prompt_tokens: 1_000_000, completion_tokens: 1, cost: 0.1 },
          })
        }\n` +
          `data: ${
            JSON.stringify({
              choices: [{ delta: { content: "x".repeat(400) }, finish_reason: "stop" }],
            })
          }\n` +
          "data: [DONE]\n",
      },
    }]);
    const result = await run(kimi, transport, true);
    assert.strictEqual(result.usage.cost.basis, "catalog_estimate");
    assert.ok(result.usage.cost.total > 2.0);
  });

  it("estimates when a later frame raised the completion count without a cost", async () => {
    const transport = new ScriptedHttpTransport([{
      respond: {
        body: `data: ${
          JSON.stringify({
            choices: [{ delta: { content: "ok" }, finish_reason: null }],
            usage: { prompt_tokens: 1_000_000, completion_tokens: 1, cost: 0.1 },
          })
        }\n` +
          `data: ${
            JSON.stringify({
              choices: [{ delta: { content: "" }, finish_reason: "stop" }],
              usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 },
            })
          }\n` +
          "data: [DONE]\n",
      },
    }]);
    const result = await run(kimi, transport, true);
    assert.strictEqual(result.usage.cost.basis, "catalog_estimate");
    assertAlmostEqual(result.usage.cost.total, 2.0 + 10.0, 5e-6);
  });

  it("does not read a cost field from another provider as billed", async () => {
    const transport = json({
      ...done,
      usage: { prompt_tokens: 1_000_000, completion_tokens: 0, cost: 0.01 },
    });
    const result = await run(gpt, transport);
    assertAlmostEqual(result.usage.cost.total, 5, 5e-6);
    assert.strictEqual(result.usage.cost.basis, "catalog_estimate");
  });
});

describe("OpenRouter price-cap refusal", () => {
  it("fails closed with a named error that states the cap", async () => {
    const transport = new ScriptedHttpTransport([{
      respond: {
        status: OPENROUTER_MAX_PRICE_REFUSED.status,
        body: OPENROUTER_MAX_PRICE_REFUSED.body,
      },
    }]);
    const error = await run(kimi, transport).then(
      () => assert.fail("the turn should fail"),
      (e: unknown) => e,
    );
    assert.ok(error instanceof ProviderPriceCapRefusedError);
    assert.strictEqual(error.kind, "price_cap_refused");
    assert.match(
      error.message,
      /^openrouter: no upstream at or below \$2 \/ \$10 per M for moonshotai\/kimi-k3\.1-pro /,
    );
    assert.ok(!error.message.includes(OPENROUTER_MAX_PRICE_REFUSED.foreignText));
    assert.strictEqual(transport.requests.length, 1);
  });
});
