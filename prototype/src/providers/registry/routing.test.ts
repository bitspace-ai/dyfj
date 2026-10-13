// Unit tests for model routing: explicit, configured-default, tier, and hint
// selection, locality bounds, and catalog-pricing routability.

import { captureThrow } from "../../../testing/assertions/captured.ts";
import assert from "node:assert/strict";
import { describe, it } from "@std/testing/bdd";
import {
  defaultLocalWorkbenchModels,
  modelSupportsFastSpeed,
  selectWorkbenchModel,
  type WorkbenchModel,
  WorkbenchModelFastSpeedUnsupportedError,
  WorkbenchModelNotRoutableError,
} from "../mod.ts";
import { providerTestModels } from "../../../testing/builders/models.ts";

const models = [...providerTestModels];
describe("selectWorkbenchModel", () => {
  it("defaults to the local Qwen3.6 model on llama.cpp when available", () => {
    const selection = selectWorkbenchModel(defaultLocalWorkbenchModels(), {});

    assert.strictEqual(selection.selected.slug, "llama-cpp/qwen3.6-35b-a3b");
    assert.strictEqual(selection.selected.provider, "llama-cpp");
    assert.strictEqual(selection.reason, "default");
  });

  it("falls back to the Ollama Qwen 3.6 row when the llama.cpp row is absent", () => {
    const selection = selectWorkbenchModel(
      defaultLocalWorkbenchModels().filter((model) =>
        model.provider !== "llama-cpp"
      ),
      {},
    );

    assert.strictEqual(selection.selected.slug, "qwen3.6:35b-a3b");
    assert.strictEqual(selection.selected.provider, "ollama");
  });

  it("falls back to next preferred local model when primary default is not available", () => {
    const selection = selectWorkbenchModel(models, {});

    assert.strictEqual(selection.selected.slug, "laguna-xs-2.1");
    assert.strictEqual(selection.selected.provider, "ollama");
    assert.strictEqual(selection.reason, "default");
  });

  it("explicit model selection can select a local model by slug", () => {
    const selection = selectWorkbenchModel(defaultLocalWorkbenchModels(), {
      modelId: "gemma4:e2b",
    });

    assert.strictEqual(selection.selected.provider, "ollama");
    assert.strictEqual(selection.reason, "explicit_model_id");
  });

  it("explicit tier applies the local preference chain", () => {
    const selection = selectWorkbenchModel(models, { tier: 1 });

    assert.strictEqual(selection.selected.slug, "claude-haiku-4-5");
    assert.strictEqual(selection.reason, "explicit_tier");
  });

  it("unknown explicit model fails before inference", () => {
    assert.throws(() => selectWorkbenchModel(models, { modelId: "missing" }), (error: unknown) => error instanceof Error && error.message.includes("Model not found: missing"));
  });

  it("uses a local configured default model on a bare turn", () => {
    const selection = selectWorkbenchModel(models, {}, "gemma4:e2b");
    assert.strictEqual(selection.selected.slug, "gemma4:e2b");
    assert.strictEqual(selection.reason, "default_config");
  });

  it("uses a configured default model across local, subscription, and hosted routes on a bare turn", () => {
    const subscriptionModel: WorkbenchModel = {
      slug: "codex-chatgpt/gpt-5.6-sol",
      displayName: "GPT-5.6 Sol (Codex ChatGPT)",
      provider: "codex-chatgpt",
      api: "acp",
      baseUrl: "http://127.0.0.1:0",
      tier: 2,
      costInput: 0,
      costOutput: 0,
      capabilities: ["text", "code", "reasoning"],
      modality: "subscription-oauth",
    };

    const local = selectWorkbenchModel(models, {}, "gemma4:e2b");
    assert.strictEqual(local.selected.slug, "gemma4:e2b");
    assert.strictEqual(local.reason, "default_config");

    const subscription = selectWorkbenchModel(
      [...models, subscriptionModel],
      {},
      "codex-chatgpt/gpt-5.6-sol",
    );
    assert.strictEqual(
      subscription.selected.slug,
      "codex-chatgpt/gpt-5.6-sol",
    );
    assert.strictEqual(subscription.reason, "default_config");

    const hosted = selectWorkbenchModel(models, {}, "claude-haiku-4-5");
    assert.strictEqual(hosted.selected.slug, "claude-haiku-4-5");
    assert.strictEqual(hosted.reason, "default_config");
  });

  it("validates fast speed tier option against model capabilities", () => {
    const fastCapableModel: WorkbenchModel = {
      slug: "codex-chatgpt/gpt-5.6-terra",
      displayName: "GPT-5.6 Terra (Codex ChatGPT)",
      provider: "codex-chatgpt",
      api: "acp",
      baseUrl: "http://127.0.0.1:0",
      tier: 2,
      costInput: 0,
      costOutput: 0,
      capabilities: ["text", "code", "reasoning", "fast-speed"],
      modality: "subscription-oauth",
    };

    assert.strictEqual(modelSupportsFastSpeed(fastCapableModel), true);
    assert.strictEqual(modelSupportsFastSpeed(models[0]), false);

    // Fast option succeeds on fast-capable model
    const selection = selectWorkbenchModel(
      [...models, fastCapableModel],
      { modelId: "codex-chatgpt/gpt-5.6-terra", fast: true },
    );
    assert.strictEqual(selection.selected.slug, "codex-chatgpt/gpt-5.6-terra");

    // Fast option throws on unsupported model
    assert.throws(
      () =>
        selectWorkbenchModel(
          [...models, fastCapableModel],
          { modelId: "gemma4:e2b", fast: true },
        ),
      WorkbenchModelFastSpeedUnsupportedError,
    );
  });

  it("WorkbenchModelFastSpeedUnsupportedError sanitizes control characters and bounds oversized slugs", () => {
    const errWithControl = new WorkbenchModelFastSpeedUnsupportedError(
      "bad\nslug\x00with\tctrl",
    );
    assert.strictEqual(
      errWithControl.message,
      'Model "bad slugwith ctrl" does not support fast speed tier',
    );

    const oversized = "a".repeat(200);
    const errOversized = new WorkbenchModelFastSpeedUnsupportedError(oversized);
    assert.ok(
      errOversized.message.length < 200,
      `expected message length < 200, got ${errOversized.message.length}`,
    );
    assert.strictEqual(errOversized.message.startsWith('Model "'), true);
    assert.ok(!errOversized.message.includes(oversized));
  });

  it("a mis-tiered hosted row is never the ambient default", () => {
    // Tier is catalog metadata; locality is decided by provider + loopback
    // base URL. A tier-0 row naming a hosted provider must not ride the
    // ambient default (tier-0 selection skips the paid-consent preflight).
    const misTiered: WorkbenchModel = {
      slug: "hosted-mistiered",
      displayName: "Hosted Mis-tiered",
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      tier: 0,
      costInput: 0,
      costOutput: 0,
      capabilities: ["text", "code"],
    };
    const selection = selectWorkbenchModel([misTiered, ...models], {});
    assert.strictEqual(selection.selected.slug, "laguna-xs-2.1");
    assert.ok(!selection.considered.includes("hosted-mistiered"));

    // With no genuinely local row at all, the ambient default fails closed
    // rather than routing the mis-tiered hosted row without consent.
    assert.throws(() => selectWorkbenchModel([misTiered], {}), (error: unknown) => error instanceof Error && error.message.includes("Model not found: tier:0"));
  });

  it("explicit tier 0 is locality-bounded too — a mis-tiered hosted row never routes", () => {
    // Tier 0 is the LOCAL tier and its selections skip the paid-consent
    // preflight, so even an explicit --tier 0 request must not land on a
    // hosted provider: the local candidate wins, and with no local candidate
    // the request fails closed instead of running hosted without consent.
    const misTiered: WorkbenchModel = {
      slug: "hosted-mistiered",
      displayName: "Hosted Mis-tiered",
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      tier: 0,
      costInput: 0,
      costOutput: 0,
      capabilities: ["text", "code"],
    };
    const selection = selectWorkbenchModel([misTiered, ...models], { tier: 0 });
    assert.strictEqual(selection.selected.slug, "laguna-xs-2.1");
    assert.strictEqual(selection.reason, "explicit_tier");
    assert.ok(!selection.considered.includes("hosted-mistiered"));

    assert.throws(() => selectWorkbenchModel([misTiered], { tier: 0 }), (error: unknown) => error instanceof Error && error.message.includes("Model not found: tier:0"));

    // Hosted tiers stay tier-based: explicit tier 1 still routes the priced
    // hosted row (and remains consent-gated downstream).
    const hosted = selectWorkbenchModel([misTiered, ...models], { tier: 1 });
    assert.strictEqual(hosted.selected.slug, "claude-haiku-4-5");
  });

  it("hint routing is bounded by locality like the bare default", () => {
    // A hint names a capability, not a model — it is ambient routing, not a
    // hosted escalation, so a mis-tiered hosted row (tier 0, code-capable)
    // must not satisfy it even when no local row carries the capability.
    const misTieredCoder: WorkbenchModel = {
      slug: "hosted-mistiered-coder",
      displayName: "Hosted Mis-tiered Coder",
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      tier: 0,
      costInput: 0,
      costOutput: 0,
      capabilities: ["text", "code"],
    };
    const noLocalCoder = models.filter((model) => model.slug === "gemma4:e2b");
    const selection = selectWorkbenchModel(
      [misTieredCoder, ...noLocalCoder],
      { hint: "code" },
    );
    assert.strictEqual(selection.selected.slug, "gemma4:e2b");
    assert.strictEqual(selection.reason, "hint_code_fallback_local");
    assert.ok(!selection.considered.includes("hosted-mistiered-coder"));
  });

  it("a hosted configured default still routes when named explicitly", () => {
    const selection = selectWorkbenchModel(
      models,
      { modelId: "claude-haiku-4-5" },
      "claude-haiku-4-5",
    );
    assert.strictEqual(selection.selected.slug, "claude-haiku-4-5");
    assert.strictEqual(selection.reason, "explicit_model_id");
  });

  it("explicit modelId beats the configured default", () => {
    const selection = selectWorkbenchModel(
      models,
      { modelId: "laguna-xs-2.1" },
      "claude-haiku-4-5",
    );
    assert.strictEqual(selection.selected.slug, "laguna-xs-2.1");
    assert.strictEqual(selection.reason, "explicit_model_id");
  });

  it("a routing hint suppresses the configured default", () => {
    const selection = selectWorkbenchModel(
      models,
      { hint: "code" },
      "claude-haiku-4-5",
    );
    assert.notStrictEqual(selection.reason, "default_config");
    assert.strictEqual(selection.selected.tier, 0);
  });

  it("absent/empty default falls through to the local default", () => {
    assert.strictEqual(
      selectWorkbenchModel(models, {}, null).reason,
      "default",
    );
    assert.strictEqual(selectWorkbenchModel(models, {}, "").reason, "default");
  });

  it("an unknown configured default fails before inference", () => {
    assert.throws(() => selectWorkbenchModel(models, {}, "nope"), (error: unknown) => error instanceof Error && error.message.includes("Model not found: nope"));
  });
});

describe("explicit tier preference", () => {
  it("tier 0 honors the local preference chain over list order", () => {
    const tierZero: WorkbenchModel[] = [
      {
        slug: "laguna-xs-2.1",
        displayName: "Laguna XS 2.1",
        provider: "ollama",
        api: "openai-completions",
        baseUrl: "http://localhost:11434/v1",
        tier: 0,
        costInput: 0,
        costOutput: 0,
        capabilities: ["text"],
      },
      {
        slug: "qwen3.6:35b-a3b",
        displayName: "Qwen3.6 35B (MoE)",
        provider: "ollama",
        api: "openai-completions",
        baseUrl: "http://localhost:11434/v1",
        tier: 0,
        costInput: 0,
        costOutput: 0,
        capabilities: ["text", "code", "reasoning"],
      },
    ];
    const selection = selectWorkbenchModel(tierZero, { tier: 0 });
    assert.strictEqual(selection.selected.slug, "qwen3.6:35b-a3b");
    assert.strictEqual(selection.reason, "explicit_tier");
    assert.deepStrictEqual(selection.considered, [
      "laguna-xs-2.1",
      "qwen3.6:35b-a3b",
    ]);
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

  it("explicit modelId selection of an unpriced paid model throws the named error", () => {
    assert.throws(
      () =>
        selectWorkbenchModel([...models, unpriced], {
          modelId: "gpt-6-preview",
        }),
      WorkbenchModelNotRoutableError,
    );
    const err = captureThrow(() =>
      selectWorkbenchModel([...models, unpriced], { modelId: "gpt-6-preview" })
    );
    assert.match((err as Error).message, /no catalog pricing/);
  });

  it("an unpriced configured default throws WorkbenchModelNotRoutableError", () => {
    assert.throws(() => selectWorkbenchModel([...models, unpriced], {}, "gpt-6-preview"), (error: unknown) => error instanceof Error && error.message.includes("Model not routable [gpt-6-preview]: no catalog pricing row"));
  });

  it("tier routing skips unpriced candidates and picks a priced one", () => {
    const pricedTier2: WorkbenchModel = {
      ...unpriced,
      slug: "claude-opus-4-8",
      displayName: "Claude Opus 4.8",
      provider: "anthropic",
      api: "anthropic-messages",
      costInput: 15,
      costOutput: 75,
    };
    const selection = selectWorkbenchModel(
      [...models, unpriced, pricedTier2],
      { tier: 2 },
    );
    assert.strictEqual(selection.selected.slug, "claude-opus-4-8");
    assert.deepStrictEqual(selection.considered, ["claude-opus-4-8"]); // unpriced not considered
  });

  it("a tier whose only candidates are unpriced names the catalog problem", () => {
    assert.throws(
      () => selectWorkbenchModel([...models, unpriced], { tier: 2 }),
      WorkbenchModelNotRoutableError,
    );
    const unpricedErr = captureThrow(() =>
      selectWorkbenchModel([...models, unpriced], { tier: 2 })
    );
    assert.match(
      (unpricedErr as Error).message,
      /all candidates unpriced: gpt-6-preview/,
    );
    // An empty tier is still a not-found, not a pricing complaint.
    const emptyErr = captureThrow(() =>
      selectWorkbenchModel(models, { tier: 2 })
    );
    assert.match((emptyErr as Error).message, /not found|tier:2/);
  });

  it("tier 0 routing is unaffected (free models stay routable)", () => {
    assert.strictEqual(
      selectWorkbenchModel([...models, unpriced], {}).selected.tier,
      0,
    );
  });
});
