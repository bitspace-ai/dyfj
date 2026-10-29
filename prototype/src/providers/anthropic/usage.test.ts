// Anthropic prompt-cache metering through runWorkbenchTurn: a call's cache
// cost comes from the catalog row's own cache rates, not a hard-coded
// multiplier, and a row without them falls back to its input rate.

import { assertAlmostEqual } from "../../../testing/assertions/almost-equal.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MapEnv } from "../../../testing/fakes/map-env.ts";
import { ScriptedHttpTransport } from "../../../testing/fakes/scripted-http-transport.ts";
import { runWorkbenchTurn, type WorkbenchModel } from "../mod.ts";

const env = new MapEnv({ ANTHROPIC_API_KEY: "test-key-not-real" });
const getEnv = (name: string) => env.get(name);

// Claude Sonnet 5.5's catalog row, prices per million tokens.
const sonnet: WorkbenchModel = {
  slug: "claude-sonnet-5-5",
  displayName: "Claude Sonnet 5.5",
  provider: "anthropic",
  api: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
  tier: 1,
  costInput: 2,
  costOutput: 10,
  costCacheRead: 0.1,
  costCacheWrite: 2.5,
  capabilities: ["text", "code"],
};

// 1M of each, so every term is exactly its per-million rate.
const oneMillionOfEach = {
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  usage: {
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
    cache_read_input_tokens: 1_000_000,
    cache_creation_input_tokens: 1_000_000,
  },
};

function priced(model: WorkbenchModel): Promise<number> {
  const transport = new ScriptedHttpTransport([{
    respond: { body: JSON.stringify(oneMillionOfEach) },
  }]);
  return runWorkbenchTurn({
    systemPrompt: "system",
    prompt: "hello",
    routing: { modelId: model.slug },
    models: [model],
    getEnv,
    fetchFn: transport.fetch,
  }).then((result) => {
    transport.assertDone();
    assert.partialDeepStrictEqual(result.usage, {
      input: 1_000_000,
      cacheRead: 1_000_000,
      cacheWrite: 1_000_000,
      output: 1_000_000,
    });
    return result.usage.cost.total;
  });
}

describe("Anthropic prompt-cache metering", () => {
  it("prices cache traffic at the catalog row's rates", async () => {
    // 2 (input) + 0.10 (cache read) + 2.50 (cache write) + 10 (output).
    assertAlmostEqual(await priced(sonnet), 14.6, 5e-12);
  });

  it("prices a second row's different rates, so no multiplier is baked in", async () => {
    // A row whose cache read is 0.5x input rather than 0.1x: a hard-coded
    // 0.1x multiplier would price this at 5 + 0.5 + 6.25 + 25 = 36.75.
    const opusWithOddCacheRead: WorkbenchModel = {
      ...sonnet,
      slug: "claude-opus-5",
      displayName: "Claude Opus 5",
      costInput: 5,
      costOutput: 25,
      costCacheRead: 2.5,
      costCacheWrite: 6.25,
    };
    // 5 (input) + 2.50 (cache read) + 6.25 (cache write) + 25 (output).
    assertAlmostEqual(await priced(opusWithOddCacheRead), 38.75, 5e-12);
  });

  it("prices cache traffic at the input rate when the row has no cache price", async () => {
    const { costCacheRead: _r, costCacheWrite: _w, ...unpriced } = sonnet;
    // Fallback: every term prices at its own base rate, so with 1M of each
    // the cache terms equal input: 2 + 2 + 2 + 10 = 16.
    assertAlmostEqual(await priced(unpriced), 16, 5e-12);
  });
});
