// Unit tests for the built-in local model defaults and their overlay onto the
// registry catalog.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  defaultLocalWorkbenchModels,
  withDefaultLocalWorkbenchModels,
} from "../mod.ts";
import { providerTestModels } from "../../../testing/builders/models.ts";

const models = [...providerTestModels];
describe("defaultLocalWorkbenchModels", () => {
  it("provides a zero-cost Tier 0 local default served by llama.cpp", () => {
    const defaults = defaultLocalWorkbenchModels();

    assert.strictEqual(defaults.length, 1);
    assert.partialDeepStrictEqual(defaults[0], {
      slug: "llama-cpp/qwen3.6-35b-a3b",
      provider: "llama-cpp",
      api: "openai-completions",
      baseUrl: "http://localhost:8080/v1",
      tier: 0,
      costInput: 0,
      costOutput: 0,
      architecture: "moe",
      contextWindow: 32768,
      totalParamsB: 35.0,
      activeParamsB: 3.0,
      recommendedQuant: "UD-Q4_K_XL",
      residentRamGiB: 24.0,
      reasoningEffortControl: false,
    });
    assert.deepStrictEqual(
      [
        "text",
        "code",
        "reasoning",
        "tools",
      ].filter((item) => !defaults[0].capabilities.includes(item)),
      [],
    );
  });

  it("carries no Ollama row: the catalog trim removed every Ollama model", () => {
    const defaults = defaultLocalWorkbenchModels();

    assert.deepStrictEqual(
      defaults.filter((model) => model.provider === "ollama"),
      [],
    );
  });
});

describe("withDefaultLocalWorkbenchModels", () => {
  it("overlays the measured local default when the registry lacks it", () => {
    const merged = withDefaultLocalWorkbenchModels([{
      ...models[0],
      slug: "local-stand-in",
      displayName: "Local stand-in",
    }]);

    assert.strictEqual(merged[0].slug, "llama-cpp/qwen3.6-35b-a3b");
    assert.strictEqual(
      merged.filter((model) => model.slug === "llama-cpp/qwen3.6-35b-a3b")
        .length,
      1,
    );
    assert.strictEqual(merged[merged.length - 1].displayName, "Local stand-in");
  });

  it("does not restore a built-in row the catalog lists as inactive", () => {
    const merged = withDefaultLocalWorkbenchModels(
      [{ ...models[0], slug: "local-stand-in" }],
      ["llama-cpp/qwen3.6-35b-a3b"],
    );

    const slugs = merged.map((model) => model.slug);
    assert.strictEqual(slugs.includes("llama-cpp/qwen3.6-35b-a3b"), false);
  });

  it("does not duplicate the default when the registry already has it", () => {
    const merged = withDefaultLocalWorkbenchModels(defaultLocalWorkbenchModels());

    assert.strictEqual(
      merged.filter((model) => model.slug === "llama-cpp/qwen3.6-35b-a3b")
        .length,
      1,
    );
  });
});
