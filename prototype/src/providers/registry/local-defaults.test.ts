// Unit tests for the built-in local model defaults and their overlay onto the
// registry catalog.

import {
  assertArrayIncludes,
  assertEquals,
  assertExists,
  assertObjectMatch,
  assertStrictEquals,
} from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import {
  defaultLocalWorkbenchModels,
  withDefaultLocalWorkbenchModels,
} from "../mod.ts";
import { providerTestModels } from "../../../testing/builders/models.ts";

const models = [...providerTestModels];
describe("defaultLocalWorkbenchModels", () => {
  it("provides a zero-cost Tier 0 local default served by llama.cpp", () => {
    const defaults = defaultLocalWorkbenchModels();

    assertObjectMatch(defaults[0], {
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
    assertArrayIncludes(defaults[0].capabilities, [
      "text",
      "code",
      "reasoning",
      "tools",
    ]);
  });

  it("provides zero-cost Tier 0 local fallback models", () => {
    const defaults = defaultLocalWorkbenchModels();
    const laguna = defaults.find((m) => m.slug === "laguna-xs-2.1");
    const muse = defaults.find((m) => m.slug === "muse-glimmer:30b");
    const qwen36 = defaults.find((m) => m.slug === "qwen3.6:35b-a3b");

    assertExists(laguna);
    assertObjectMatch(laguna, {
      slug: "laguna-xs-2.1",
      provider: "ollama",
      tier: 0,
      costInput: 0,
      costOutput: 0,
      architecture: "moe",
      totalParamsB: 33.4,
      activeParamsB: 3.0,
      recommendedQuant: "Q4_K_M",
      residentRamGiB: 20.0,
      reasoningEffortControl: false,
    });
    assertArrayIncludes(laguna.capabilities, [
      "text",
      "code",
      "reasoning",
      "tools",
      "thinking",
      "long-context",
    ]);

    assertExists(muse);
    assertObjectMatch(muse, {
      slug: "muse-glimmer:30b",
      provider: "ollama",
      tier: 0,
      costInput: 0,
      costOutput: 0,
      architecture: "dense",
      totalParamsB: 27.9,
      activeParamsB: 27.9,
      recommendedQuant: "Q4_K_M",
      residentRamGiB: 23.0,
      reasoningEffortControl: true,
    });

    assertExists(qwen36);
    assertObjectMatch(qwen36, {
      slug: "qwen3.6:35b-a3b",
      provider: "ollama",
      tier: 0,
      costInput: 0,
      costOutput: 0,
      architecture: "moe",
      totalParamsB: 36.0,
      activeParamsB: 3.0,
      recommendedQuant: "Q4_K_M",
      residentRamGiB: 24.0,
      reasoningEffortControl: false,
    });
  });
});

describe("withDefaultLocalWorkbenchModels", () => {
  it("overlays the measured local default when the registry lacks it", () => {
    const merged = withDefaultLocalWorkbenchModels([{
      ...models[0],
      slug: "gemma4:26b",
      displayName: "Gemma 4 latest",
    }]);

    assertEquals(merged.slice(0, 3).map((model) => model.slug), [
      "llama-cpp/qwen3.6-35b-a3b",
      "qwen3.6:35b-a3b",
      "muse-glimmer:30b",
    ]);
    const slugs = merged.map((model) => model.slug);
    assertArrayIncludes(slugs, ["laguna-xs-2.1"]);
    assertArrayIncludes(slugs, ["muse-glimmer:30b"]);
    assertArrayIncludes(slugs, ["deepseek-r1:32b"]);
    assertArrayIncludes(slugs, ["mistral-small:24b-instruct-2501-q4_K_M"]);
    assertStrictEquals(
      merged.filter((model) => model.slug === "gemma4:26b").length,
      1,
    );
    assertStrictEquals(merged[merged.length - 1].displayName, "Gemma 4 latest");
  });

  it("does not restore a built-in row the catalog lists as inactive", () => {
    const merged = withDefaultLocalWorkbenchModels(
      [{ ...models[0], slug: "gemma4:26b" }],
      ["qwen3.6:35b-a3b"],
    );

    const slugs = merged.map((model) => model.slug);
    assertStrictEquals(slugs.includes("qwen3.6:35b-a3b"), false);
    assertArrayIncludes(slugs, ["muse-glimmer:30b"]);
  });

  it("does not duplicate the default when the registry already has it", () => {
    const merged = withDefaultLocalWorkbenchModels(models);

    assertStrictEquals(
      merged.filter((model) => model.slug === "laguna-xs-2.1").length,
      1,
    );
  });
});
