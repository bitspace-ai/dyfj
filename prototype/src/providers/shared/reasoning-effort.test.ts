/**
 * The reasoning-effort capability contract: which models take an effort,
 * which levels each provider accepts, the value a request sends, and the one
 * refusal message every caller shows.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkbenchModel } from "../types.ts";
import {
  DEFAULT_REASONING_EFFORT,
  isReasoningEffort,
  modelReasoningEffort,
  reasoningEffortRefusal,
  reasoningEffortSupport,
  supportsReasoningEffort,
  unsupportedReasoningEffort,
} from "./reasoning-effort.ts";

function model(overrides: Partial<WorkbenchModel> = {}): WorkbenchModel {
  return {
    slug: "deepseek/deepseek-v4.1-flash-1017",
    displayName: "DeepSeek V4.1 Flash",
    provider: "openrouter",
    api: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1",
    tier: 1,
    costInput: 0.3,
    costOutput: 1.2,
    capabilities: ["text", "code", "reasoning"],
    reasoningEffortControl: true,
    ...overrides,
  };
}

test("a row without effort control takes no reasoning effort", () => {
  const plain = model({ reasoningEffortControl: false });
  assert.equal(reasoningEffortSupport(plain), undefined);
  assert.equal(supportsReasoningEffort(plain), false);
  assert.equal(modelReasoningEffort(plain, "high"), undefined);
  assert.match(
    unsupportedReasoningEffort(plain, "high") ?? "",
    /takes no reasoning effort/,
  );
});

test("a provider API with no effort parameter takes none even when the row enables it", () => {
  const local = model({ provider: "llama-cpp", tier: 0 });
  assert.equal(reasoningEffortSupport(local), undefined);
  assert.equal(modelReasoningEffort(local, "high"), undefined);
});

test("each provider advertises the levels its API accepts", () => {
  // OpenRouter's own levels are per model, so its base row is the pair every
  // OpenRouter reasoning model honours.
  assert.deepEqual(reasoningEffortSupport(model())?.levels, ["low", "high"]);
  for (const provider of ["openai", "xai", "anthropic"]) {
    assert.deepEqual(
      reasoningEffortSupport(model({ provider }))?.levels,
      ["low", "medium", "high", "xhigh"],
      provider,
    );
  }
  // Gemini 3.x thinking levels top out at `high`.
  assert.deepEqual(
    reasoningEffortSupport(model({ provider: "google" }))?.levels,
    ["low", "medium", "high"],
  );
});

test("an OpenRouter row takes the levels its own model accepts, not the provider's", () => {
  // DeepSeek, Kimi and GLM publish only low and high.
  for (
    const slug of [
      "deepseek/deepseek-v4.1-flash-1017",
      "moonshotai/kimi-k3.1-pro",
      "z-ai/glm-5.3",
    ]
  ) {
    assert.deepEqual(
      reasoningEffortSupport(model({ slug }))?.levels,
      ["low", "high"],
      slug,
    );
    assert.match(
      unsupportedReasoningEffort(model({ slug }), "medium") ?? "",
      /does not accept reasoning effort "medium"; it accepts low, high/,
      slug,
    );
  }
  // A slug the table does not name gets the pair every OpenRouter reasoning
  // model accepts, and nothing above it.
  assert.deepEqual(
    reasoningEffortSupport(model({ slug: "vendor/unlisted-model" }))?.levels,
    ["low", "high"],
  );
  // The Meta Muse rows report the whole range in OpenRouter's metadata, so
  // they take it.
  for (
    const slug of ["meta/muse-glimmer-30b", "meta/muse-spark-1.3"]
  ) {
    assert.deepEqual(
      reasoningEffortSupport(model({ slug }))?.levels,
      ["low", "medium", "high", "xhigh"],
      slug,
    );
    assert.equal(unsupportedReasoningEffort(model({ slug }), "xhigh"), undefined);
    assert.equal(modelReasoningEffort(model({ slug }), "xhigh"), "xhigh");
  }
});

test("the default is low when the operator names none", () => {
  assert.equal(DEFAULT_REASONING_EFFORT, "low");
  assert.equal(modelReasoningEffort(model()), "low");
  assert.equal(modelReasoningEffort(model(), undefined), "low");
});

test("an accepted level is what the request sends", () => {
  assert.equal(modelReasoningEffort(model(), "high"), "high");
  // A level the model does not accept is never sent: the model default is.
  assert.equal(modelReasoningEffort(model(), "xhigh"), "low");
  assert.equal(
    modelReasoningEffort(model({ provider: "openai", slug: "gpt-5.6-sol" }), "xhigh"),
    "xhigh",
  );
});

test("a level a provider does not accept is refused, never silently downgraded", () => {
  const gemini = model({ provider: "google" });
  assert.equal(modelReasoningEffort(gemini, "xhigh"), "low");
  assert.match(
    unsupportedReasoningEffort(gemini, "xhigh") ?? "",
    /does not accept reasoning effort "xhigh"; it accepts low, medium, high/,
  );
  assert.equal(unsupportedReasoningEffort(gemini, "high"), undefined);
  assert.equal(
    unsupportedReasoningEffort(model(), "max"),
    reasoningEffortRefusal("reasoning effort"),
  );
  assert.equal(unsupportedReasoningEffort(model(), undefined), undefined);
});

test("an OpenAI request that offers tools sends none whatever the operator named", () => {
  const openai = model({ provider: "openai", slug: "gpt-5.6-sol" });
  assert.equal(modelReasoningEffort(openai, "high", true), "none");
  assert.equal(modelReasoningEffort(openai, undefined, true), "none");
  assert.equal(modelReasoningEffort(openai, "high", false), "high");
  // The constraint is OpenAI's alone.
  assert.equal(modelReasoningEffort(model(), "high", true), "high");
});

test("the operator-named levels are the four the Codex route has always taken", () => {
  for (const level of ["low", "medium", "high", "xhigh"]) {
    assert.equal(isReasoningEffort(level), true, level);
  }
  for (const level of ["minimal", "max", "none", "HIGH", 3, undefined]) {
    assert.equal(isReasoningEffort(level), false, String(level));
  }
});
