// Unit tests for the model catalog: registry-row parsing, access modality,
// and catalog pricing.

import {
  assertEquals,
  assertObjectMatch,
  assertStrictEquals,
} from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import {
  getModelAccessModality,
  modelHasCatalogPricing,
  parseModelRegistryRows,
  type WorkbenchModel,
} from "../mod.ts";
import { providerTestModels } from "../../../testing/builders/models.ts";

const models = [...providerTestModels];
describe("parseModelRegistryRows", () => {
  it("parses active model rows from Dolt-shaped strings", () => {
    const parsed = parseModelRegistryRows([
      {
        slug: "gemma4",
        display_name: "Gemma 4 27B",
        provider: "ollama",
        api: "openai-completions",
        base_url: "http://localhost:11434/v1",
        tier: "0",
        cost_input: "0",
        cost_output: "0",
        capabilities: '["text","reasoning"]',
      },
    ]);

    assertObjectMatch(parsed[0], {
      slug: "gemma4",
      displayName: "Gemma 4 27B",
      tier: 0,
      capabilities: ["text", "reasoning"],
    });
  });

  it("parses catalog cache prices and omits unpriced ones", () => {
    const [priced, unpriced] = parseModelRegistryRows([
      {
        slug: "deepseek/deepseek-chat",
        display_name: "DeepSeek V3",
        provider: "openrouter",
        api: "openai-completions",
        base_url: "https://openrouter.ai/api/v1",
        tier: "1",
        cost_input: "0.257400",
        cost_output: "1.028700",
        cost_cache_read: "0.025740",
        cost_cache_write: "0.321750",
        capabilities: '["text"]',
      },
      {
        slug: "gemma4",
        display_name: "Gemma 4 27B",
        provider: "ollama",
        api: "openai-completions",
        base_url: "http://localhost:11434/v1",
        tier: "0",
        cost_input: "0",
        cost_output: "0",
        cost_cache_read: "0.000000",
        capabilities: '["text"]',
      },
    ]);

    assertObjectMatch(priced, {
      costCacheRead: 0.02574,
      costCacheWrite: 0.32175,
    });
    // A zero cache price is the schema default, not a price: leave it unset
    // so metering falls back to the input rate.
    assertStrictEquals("costCacheRead" in unpriced, false);
    assertStrictEquals("costCacheWrite" in unpriced, false);
  });

  it("accepts Dolt JSON display values for capabilities", () => {
    const parsed = parseModelRegistryRows([
      {
        slug: "gemma4",
        display_name: "Gemma 4 27B",
        provider: "ollama",
        api: "openai-completions",
        base_url: "http://localhost:11434/v1",
        tier: "0",
        cost_input: "0",
        cost_output: "0",
        capabilities: "text,reasoning",
      },
    ]);

    assertEquals(parsed[0].capabilities, ["text", "reasoning"]);
  });

  it("parses catalog token limits when the row declares them", () => {
    const parsed = parseModelRegistryRows([
      {
        slug: "gemma4",
        display_name: "Gemma 4 27B",
        provider: "ollama",
        api: "openai-completions",
        base_url: "http://localhost:11434/v1",
        tier: "0",
        cost_input: "0",
        cost_output: "0",
        capabilities: '["text"]',
        context_window: "131072",
        max_output_tokens: "8192",
      },
    ]);

    assertStrictEquals(parsed[0].contextWindow, 131072);
    assertStrictEquals(parsed[0].maxOutputTokens, 8192);
  });

  it("absent, zero, fractional, or malformed limits load as unknown, not as a tiny limit", () => {
    const base = {
      slug: "gemma4",
      display_name: "Gemma 4 27B",
      provider: "ollama",
      api: "openai-completions",
      base_url: "http://localhost:11434/v1",
      tier: "0",
      cost_input: "0",
      cost_output: "0",
      capabilities: '["text"]',
    };
    const [absent] = parseModelRegistryRows([base]);
    const [zero] = parseModelRegistryRows([
      { ...base, context_window: "0", max_output_tokens: "0" },
    ]);
    const [garbage] = parseModelRegistryRows([
      { ...base, context_window: "lots", max_output_tokens: "-1" },
    ]);
    // A fractional value must not floor into a defined zero-token limit.
    const [fractional] = parseModelRegistryRows([
      { ...base, context_window: "0.5", max_output_tokens: "0.9" },
    ]);

    for (const model of [absent, zero, garbage, fractional]) {
      assertStrictEquals(model.contextWindow, undefined);
      assertStrictEquals(model.maxOutputTokens, undefined);
    }
  });

  it("derives access modality across local, frontier, aggregator, and subscription providers", () => {
    const parsed = parseModelRegistryRows([
      {
        slug: "gemma4",
        display_name: "Gemma 4 27B",
        provider: "ollama",
        api: "openai-completions",
        base_url: "http://localhost:11434/v1",
        tier: "0",
        cost_input: "0",
        cost_output: "0",
        capabilities: '["text"]',
      },
      {
        slug: "claude-sonnet-4-6",
        display_name: "Claude Sonnet 4.6",
        provider: "anthropic",
        api: "anthropic-messages",
        base_url: "https://api.anthropic.com",
        tier: "1",
        cost_input: "3",
        cost_output: "15",
        capabilities: '["text","code"]',
      },
      {
        slug: "deepseek/deepseek-v4-flash",
        display_name: "DeepSeek V4 Flash",
        provider: "openrouter",
        api: "openai-completions",
        base_url: "https://openrouter.ai/api/v1",
        tier: "1",
        cost_input: "0.1",
        cost_output: "0.2",
        capabilities: '["text","code"]',
      },
      {
        slug: "chatgpt-subscription",
        display_name: "ChatGPT Plus",
        provider: "codex-chatgpt",
        api: "openai-completions",
        base_url: "",
        tier: "2",
        cost_input: "1",
        cost_output: "1",
        capabilities: '["text"]',
      },
    ]);

    assertStrictEquals(parsed[0].modality, "local");
    assertStrictEquals(parsed[1].modality, "frontier-hosted");
    assertStrictEquals(parsed[2].modality, "aggregator-hosted");
    assertStrictEquals(parsed[3].modality, "subscription-oauth");
  });

  it("parses execution and hardware profile fields when present and leaves undefined when absent", () => {
    const parsed = parseModelRegistryRows([
      {
        slug: "muse-glimmer:30b",
        display_name: "Muse Glimmer 30B",
        provider: "ollama",
        api: "openai-completions",
        base_url: "http://localhost:11434/v1",
        tier: "0",
        cost_input: "0",
        cost_output: "0",
        capabilities: '["text","code","reasoning","tools"]',
        context_window: "131072",
        max_output_tokens: "8192",
        architecture: "dense",
        total_params_b: "29.60",
        active_params_b: "29.60",
        recommended_quant: "Q4_K_XL",
        resident_ram_gib: "23.00",
        reasoning_effort_control: "1",
      },
      {
        slug: "mistral-small-4-119b-a6b",
        display_name: "Mistral Small 4 119B",
        provider: "ollama",
        api: "openai-completions",
        base_url: "http://localhost:11434/v1",
        tier: "0",
        cost_input: "0",
        cost_output: "0",
        capabilities: '["text","code","reasoning"]',
        architecture: "moe",
        total_params_b: "119.00",
        active_params_b: "6.50",
        recommended_quant: "Q4_K_M",
        resident_ram_gib: "62.00",
        reasoning_effort_control: "0",
      },
      {
        slug: "claude-sonnet-4-6",
        display_name: "Claude Sonnet 4.6",
        provider: "anthropic",
        api: "anthropic-messages",
        base_url: "https://api.anthropic.com",
        tier: "1",
        cost_input: "3",
        cost_output: "15",
        capabilities: '["text","code"]',
      },
    ]);

    assertStrictEquals(parsed[0].architecture, "dense");
    assertStrictEquals(parsed[0].totalParamsB, 29.6);
    assertStrictEquals(parsed[0].activeParamsB, 29.6);
    assertStrictEquals(parsed[0].recommendedQuant, "Q4_K_XL");
    assertStrictEquals(parsed[0].residentRamGiB, 23.0);
    assertStrictEquals(parsed[0].reasoningEffortControl, true);

    assertStrictEquals(parsed[1].architecture, "moe");
    assertStrictEquals(parsed[1].totalParamsB, 119.0);
    assertStrictEquals(parsed[1].activeParamsB, 6.5);
    assertStrictEquals(parsed[1].recommendedQuant, "Q4_K_M");
    assertStrictEquals(parsed[1].residentRamGiB, 62.0);
    assertStrictEquals(parsed[1].reasoningEffortControl, false);

    // Absent execution metadata leaves optional fields undefined, with default false reasoning control
    assertStrictEquals(parsed[2].architecture, undefined);
    assertStrictEquals(parsed[2].totalParamsB, undefined);
    assertStrictEquals(parsed[2].activeParamsB, undefined);
    assertStrictEquals(parsed[2].recommendedQuant, undefined);
    assertStrictEquals(parsed[2].residentRamGiB, undefined);
    assertStrictEquals(parsed[2].reasoningEffortControl, false);
  });

  it("parses various truthy and falsy boolean representations for reasoningEffortControl", () => {
    const row = (slug: string, reasoningEffortControl: string) => ({
      slug,
      display_name: slug.toUpperCase(),
      provider: "ollama",
      api: "openai-completions",
      base_url: "http://localhost:11434/v1",
      tier: "0",
      cost_input: "0",
      cost_output: "0",
      capabilities: '["text"]',
      reasoning_effort_control: reasoningEffortControl,
    });
    const parsed = parseModelRegistryRows([
      row("m1", "True"),
      row("m2", " true "),
      row("m3", "0"),
      row("m4", "1"),
      row("m5", "invalid"),
    ]);

    assertStrictEquals(parsed[0].reasoningEffortControl, true);
    assertStrictEquals(parsed[1].reasoningEffortControl, true);
    assertStrictEquals(parsed[2].reasoningEffortControl, false);
    assertStrictEquals(parsed[3].reasoningEffortControl, true);
    assertStrictEquals(parsed[4].reasoningEffortControl, false);
  });

  it("normalizes architecture case and whitespace while rejecting unrecognized values", () => {
    const row = (slug: string, architecture: string) => ({
      slug,
      display_name: slug.toUpperCase(),
      provider: "ollama",
      api: "openai-completions",
      base_url: "http://localhost:11434/v1",
      tier: "0",
      cost_input: "0",
      cost_output: "0",
      capabilities: '["text"]',
      architecture,
    });
    const parsed = parseModelRegistryRows([
      row("a1", " MoE "),
      row("a2", "DENSE"),
      row("a3", "transformer"),
    ]);

    assertStrictEquals(parsed[0].architecture, "moe");
    assertStrictEquals(parsed[1].architecture, "dense");
    assertStrictEquals(parsed[2].architecture, undefined);
  });

  it("trims recommendedQuant whitespace and maps whitespace-only to undefined", () => {
    const row = (slug: string, recommendedQuant: string) => ({
      slug,
      display_name: slug.toUpperCase(),
      provider: "ollama",
      api: "openai-completions",
      base_url: "http://localhost:11434/v1",
      tier: "0",
      cost_input: "0",
      cost_output: "0",
      capabilities: '["text"]',
      recommended_quant: recommendedQuant,
    });
    const parsed = parseModelRegistryRows([
      row("q1", " Q4_K_M "),
      row("q2", "   "),
    ]);

    assertStrictEquals(parsed[0].recommendedQuant, "Q4_K_M");
    assertStrictEquals(parsed[1].recommendedQuant, undefined);
  });
});

describe("getModelAccessModality", () => {
  const modality = (provider: string, baseUrl: string) =>
    getModelAccessModality({ provider, baseUrl });

  it("identifies loopback endpoints as local", () => {
    assertStrictEquals(
      modality("ollama", "http://127.0.0.1:11434/v1"),
      "local",
    );
    assertStrictEquals(
      modality("mlx-lm", "http://localhost:18080/v1"),
      "local",
    );
  });

  it("classifies non-loopback URLs for local providers as custom-hosted", () => {
    assertStrictEquals(
      modality("ollama", "https://remote-ollama.example.com/v1"),
      "custom-hosted",
    );
    assertStrictEquals(
      modality("litellm", "https://litellm.example.com/v1"),
      "custom-hosted",
    );
  });

  it("identifies openrouter as aggregator-hosted", () => {
    assertStrictEquals(
      modality("openrouter", "https://openrouter.ai/api/v1"),
      "aggregator-hosted",
    );
  });

  it("identifies direct vendor APIs as frontier-hosted", () => {
    assertStrictEquals(
      modality("anthropic", "https://api.anthropic.com"),
      "frontier-hosted",
    );
    assertStrictEquals(
      modality("openai", "https://api.openai.com/v1"),
      "frontier-hosted",
    );
    assertStrictEquals(
      modality("google", "https://generativelanguage.googleapis.com"),
      "frontier-hosted",
    );
    assertStrictEquals(
      modality("xai", "https://api.x.ai/v1"),
      "frontier-hosted",
    );
  });

  it("classifies non-canonical or proxy vendor endpoints as custom-hosted", () => {
    assertStrictEquals(
      modality("openai", "https://internal-proxy.example.com/v1"),
      "custom-hosted",
    );
    assertStrictEquals(
      modality("openai", "https://api.openai.com/badpath"),
      "custom-hosted",
    );
    assertStrictEquals(
      modality("anthropic", "http://localhost:8080"),
      "custom-hosted",
    );
    assertStrictEquals(
      modality("openrouter", "https://openrouter.ai/garbage"),
      "custom-hosted",
    );
    assertStrictEquals(
      modality("openrouter", "https://openrouter.proxy.corp/v1"),
      "custom-hosted",
    );
  });

  it("identifies local ACP subscription runner adapters as subscription-oauth", () => {
    assertStrictEquals(modality("codex-chatgpt", ""), "subscription-oauth");
    assertStrictEquals(
      modality("claude-acp", "http://127.0.0.1:18080/v1"),
      "subscription-oauth",
    );
    assertStrictEquals(modality("grok-build", "acp"), "subscription-oauth");
    assertStrictEquals(modality("cursor-agent", ""), "subscription-oauth");
    assertStrictEquals(
      modality("gemini-antigravity", "http://localhost:11434/v1"),
      "subscription-oauth",
    );
    assertStrictEquals(
      modality("codex-chatgpt", "https://remote-proxy.example.com"),
      "custom-hosted",
    );
    assertStrictEquals(
      modality("grok-build", "https://api.x.ai/v1"),
      "custom-hosted",
    );
  });
});

// ── catalog-row routability ───────────────────────────────────────────────────

describe("unpriced models are unroutable", () => {
  const unpriced: WorkbenchModel = {
    slug: "gpt-6-preview",
    displayName: "GPT-6 Preview",
    provider: "openai",
    api: "openai-completions",
    baseUrl: "https://api.openai.com/v1",
    tier: 2,
    costInput: 0, // schema default — nobody priced the row
    costOutput: 0,
    capabilities: ["text", "code"],
  };

  it("modelHasCatalogPricing: tier 0 zero-cost is priced (free by declaration)", () => {
    assertStrictEquals(modelHasCatalogPricing(models[0]), true); // tier 0, $0
    assertStrictEquals(modelHasCatalogPricing(models[2]), true); // tier 1, priced
    assertStrictEquals(modelHasCatalogPricing(unpriced), false); // tier 2, $0
    assertStrictEquals(
      modelHasCatalogPricing({ ...unpriced, costInput: 15 }),
      false,
    ); // half-priced
    assertStrictEquals(
      modelHasCatalogPricing({ ...unpriced, costInput: 15, costOutput: 75 }),
      true,
    );
    assertStrictEquals(
      modelHasCatalogPricing({
        ...unpriced,
        modality: "subscription-oauth",
        provider: "codex-chatgpt",
      }),
      true,
    ); // subscription-oauth tier 2 with $0 token cost is priced
  });

  it("malformed catalog costs parse to the unpriced bucket, never NaN", () => {
    const parsed = parseModelRegistryRows([
      {
        slug: "broken",
        display_name: "Broken Row",
        provider: "openai",
        api: "openai-completions",
        base_url: "https://api.openai.com/v1",
        tier: "2",
        cost_input: "garbage",
        cost_output: "-5",
        capabilities: "text",
      },
    ]);
    assertStrictEquals(parsed[0].costInput, 0);
    assertStrictEquals(parsed[0].costOutput, 0);
    assertStrictEquals(Number.isNaN(parsed[0].costInput), false);
  });
});
