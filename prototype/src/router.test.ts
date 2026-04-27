/**
 * Unit tests for src/router.ts
 *
 * All tests are pure / mock-based — no Dolt connection, no Ollama, no API calls.
 * selectModel() is a pure function; checkConsent() uses an injectable promptFn.
 * parseDoltCsv() is tested in utils.test.ts.
 */

import { test, expect, describe, beforeEach } from "bun:test";
import {
  selectModel,
  checkConsent,
  toPiAiModel,
  getApiKey,
  parseRegistryFromRows,
  resetSessionConsent,
  getSessionConsent,
  estimateContextTokens,
  TIER_DEFAULTS,
  ConsentDeclinedError,
  ModelNotFoundError,
  BudgetExceededError,
} from "./router";
import type { RouterModel, ModelRegistry, RoutingOptions } from "./router";
import { BudgetTracker } from "./budget";
import type { Context } from "@mariozechner/pi-ai";

// ── Test fixtures ─────────────────────────────────────────────────────────────

function makeModel(overrides: Partial<RouterModel> = {}): RouterModel {
  return {
    slug:          "gemma4",
    displayName:   "Gemma 4 27B",
    provider:      "ollama",
    api:           "openai-completions",
    baseUrl:       "http://localhost:11434/v1",
    tier:          0,
    contextWindow: 131072,
    maxTokens:     8192,
    costInput:     0,
    costOutput:    0,
    costCacheRead: 0,
    costCacheWrite:0,
    reasoning:     true,
    capabilities:  ["text", "reasoning"],
    ...overrides,
  };
}

const MOCK_REGISTRY: ModelRegistry = new Map([
  ["gemma4",           makeModel()],
  ["gemma4:e2b",       makeModel({ slug: "gemma4:e2b", displayName: "Gemma 4 2B" })],
  ["qwen3:32b",        makeModel({ slug: "qwen3:32b",       displayName: "Qwen3 32B",         capabilities: ["text","code","reasoning"] })],
  ["qwen3:30b-a3b",    makeModel({ slug: "qwen3:30b-a3b",   displayName: "Qwen3 30B-A3B",      capabilities: ["text","code","chat"] })],
  ["claude-haiku-4-5", makeModel({ slug: "claude-haiku-4-5", displayName: "Claude Haiku 4.5", provider: "anthropic", api: "anthropic-messages", baseUrl: "https://api.anthropic.com", tier: 1, costInput: 1, costOutput: 5, costCacheRead: 0.1, costCacheWrite: 1.25, contextWindow: 200000, maxTokens: 64000 })],
  ["claude-opus-4-5",  makeModel({ slug: "claude-opus-4-5",  displayName: "Claude Opus 4.5",  provider: "anthropic", api: "anthropic-messages", baseUrl: "https://api.anthropic.com", tier: 2, costInput: 5, costOutput: 25, costCacheRead: 0.5, costCacheWrite: 6.25, contextWindow: 200000, maxTokens: 64000 })],
  ["gemini-2.5-flash", makeModel({ slug: "gemini-2.5-flash", displayName: "Gemini 2.5 Flash", provider: "google",    api: "google-generative-ai", baseUrl: "https://generativelanguage.googleapis.com/v1beta", tier: 1, costInput: 0.3, costOutput: 2.5, costCacheRead: 0.075, costCacheWrite: 0, contextWindow: 1048576, maxTokens: 65536, reasoning: true })],
  ["gemini-2.5-pro",   makeModel({ slug: "gemini-2.5-pro",   displayName: "Gemini 2.5 Pro",   provider: "google",    api: "google-generative-ai", baseUrl: "https://generativelanguage.googleapis.com/v1beta", tier: 2, costInput: 1.25, costOutput: 10, costCacheRead: 0.31, costCacheWrite: 0, contextWindow: 1048576, maxTokens: 65536, reasoning: true })],
]);

// ── selectModel ───────────────────────────────────────────────────────────────

describe("selectModel", () => {
  test("default (no options) → gemma4", () => {
    const { selected, reason } = selectModel(MOCK_REGISTRY, {});
    expect(selected.slug).toBe("gemma4");
    expect(reason).toBe("default");
  });

  test("default includes Tier 0 models in considered list", () => {
    const { considered } = selectModel(MOCK_REGISTRY, {});
    expect(considered).toContain("gemma4");
    expect(considered).toContain("qwen3:32b");
    expect(considered).toContain("qwen3:30b-a3b");
  });

  test("hint:code → qwen3:32b", () => {
    const { selected, reason } = selectModel(MOCK_REGISTRY, { hint: "code" });
    expect(selected.slug).toBe("qwen3:32b");
    expect(reason).toBe("hint_code");
  });

  test("hint:code without qwen3:32b → falls back to gemma4", () => {
    const registryWithoutQwen = new Map(MOCK_REGISTRY);
    registryWithoutQwen.delete("qwen3:32b");
    const { selected, reason } = selectModel(registryWithoutQwen, { hint: "code" });
    expect(selected.slug).toBe("gemma4");
    expect(reason).toBe("hint_code_fallback_gemma4");
  });

  test("hint:chat → qwen3:30b-a3b", () => {
    const { selected, reason } = selectModel(MOCK_REGISTRY, { hint: "chat" });
    expect(selected.slug).toBe("qwen3:30b-a3b");
    expect(reason).toBe("hint_chat_speed");
  });

  test("hint:chat without qwen3:30b-a3b → falls back to gemma4", () => {
    const r = new Map(MOCK_REGISTRY);
    r.delete("qwen3:30b-a3b");
    const { selected, reason } = selectModel(r, { hint: "chat" });
    expect(selected.slug).toBe("gemma4");
    expect(reason).toBe("hint_chat_fallback_gemma4");
  });

  test("contextLength > 100K → gemma4 (long-context heuristic)", () => {
    const { selected, reason } = selectModel(MOCK_REGISTRY, { contextLength: 100_001 });
    expect(selected.slug).toBe("gemma4");
    expect(reason).toBe("context_length_gt_100k");
  });

  test("contextLength exactly 100K → does NOT trigger long-context heuristic → default gemma4", () => {
    const { selected, reason } = selectModel(MOCK_REGISTRY, { contextLength: 100_000 });
    expect(selected.slug).toBe("gemma4");
    expect(reason).toBe("default"); // falls through to default, not long-context
  });

  test("explicit modelId → that exact model", () => {
    const { selected, reason, considered } = selectModel(MOCK_REGISTRY, { modelId: "qwen3:32b" });
    expect(selected.slug).toBe("qwen3:32b");
    expect(reason).toBe("explicit_model_id");
    expect(considered).toHaveLength(0);
  });

  test("explicit modelId (API model) → returns it regardless of tier", () => {
    const { selected } = selectModel(MOCK_REGISTRY, { modelId: "claude-opus-4-5" });
    expect(selected.slug).toBe("claude-opus-4-5");
    expect(selected.tier).toBe(2);
  });

  test("explicit tier 0 → TIER_DEFAULTS[0]", () => {
    const { selected, reason } = selectModel(MOCK_REGISTRY, { tier: 0 });
    expect(selected.slug).toBe(TIER_DEFAULTS[0]);
    expect(reason).toBe("explicit_tier");
  });

  test("explicit tier 1 → TIER_DEFAULTS[1]", () => {
    const { selected, reason } = selectModel(MOCK_REGISTRY, { tier: 1 });
    expect(selected.slug).toBe(TIER_DEFAULTS[1]);
    expect(reason).toBe("explicit_tier");
  });

  test("explicit tier 2 → TIER_DEFAULTS[2]", () => {
    const { selected, reason } = selectModel(MOCK_REGISTRY, { tier: 2 });
    expect(selected.slug).toBe(TIER_DEFAULTS[2]);
    expect(reason).toBe("explicit_tier");
  });

  test("unknown modelId → throws ModelNotFoundError", () => {
    expect(() => selectModel(MOCK_REGISTRY, { modelId: "nonexistent-model" }))
      .toThrow(ModelNotFoundError);
  });

  test("ModelNotFoundError carries the slug", () => {
    try {
      selectModel(MOCK_REGISTRY, { modelId: "nonexistent-model" });
    } catch (e) {
      expect(e).toBeInstanceOf(ModelNotFoundError);
      expect((e as ModelNotFoundError).slug).toBe("nonexistent-model");
    }
  });

  test("explicit tier with missing default → throws ModelNotFoundError", () => {
    const emptyRegistry: ModelRegistry = new Map();
    expect(() => selectModel(emptyRegistry, { tier: 0 })).toThrow(ModelNotFoundError);
  });
});

// ── checkConsent ──────────────────────────────────────────────────────────────

describe("checkConsent", () => {
  // Reset session consent before each test so Tier 1 sticky state doesn't bleed
  beforeEach(() => resetSessionConsent());

  test("Tier 0 → always true, promptFn never called", async () => {
    let callCount = 0;
    const prompt = async (_msg: string) => { callCount++; return true; };
    const result = await checkConsent(MOCK_REGISTRY.get("gemma4")!, undefined, prompt);
    expect(result).toBe(true);
    expect(callCount).toBe(0);
  });

  test("Tier 1 → calls promptFn with model name and cost", async () => {
    let capturedMessage = "";
    const prompt: (msg: string) => Promise<boolean> = async (msg) => {
      capturedMessage = msg;
      return true;
    };
    const haiku = MOCK_REGISTRY.get("claude-haiku-4-5")!;
    const result = await checkConsent(haiku, undefined, prompt);
    expect(result).toBe(true);
    expect(capturedMessage).toContain("Claude Haiku 4.5");
    expect(capturedMessage).toContain("1.00"); // costInput
    expect(capturedMessage).toContain("5.00"); // costOutput
  });

  test("Tier 1 → granted sets session sticky", async () => {
    const haiku = MOCK_REGISTRY.get("claude-haiku-4-5")!;
    await checkConsent(haiku, undefined, async () => true);
    expect(getSessionConsent().tier1Granted).toBe(true);
  });

  test("Tier 1 → declined does NOT set session sticky", async () => {
    const haiku = MOCK_REGISTRY.get("claude-haiku-4-5")!;
    const result = await checkConsent(haiku, undefined, async () => false);
    expect(result).toBe(false);
    expect(getSessionConsent().tier1Granted).toBe(false);
  });

  test("Tier 1 → second call uses session sticky, promptFn not called again", async () => {
    const haiku = MOCK_REGISTRY.get("claude-haiku-4-5")!;
    let callCount = 0;
    const prompt = async () => { callCount++; return true; };

    await checkConsent(haiku, undefined, prompt); // first call — prompts
    await checkConsent(haiku, undefined, prompt); // second call — sticky, no prompt

    expect(callCount).toBe(1);
  });

  test("Tier 2 → always calls promptFn (no session sticky)", async () => {
    const opus = MOCK_REGISTRY.get("claude-opus-4-5")!;
    let callCount = 0;
    const prompt = async () => { callCount++; return true; };

    await checkConsent(opus, undefined, prompt);
    await checkConsent(opus, undefined, prompt);

    expect(callCount).toBe(2);
  });

  test("Tier 2 → declined → returns false", async () => {
    const opus = MOCK_REGISTRY.get("claude-opus-4-5")!;
    const result = await checkConsent(opus, undefined, async () => false);
    expect(result).toBe(false);
  });

  test("Tier 2 → includes cost estimate in prompt when token count provided", async () => {
    const opus = MOCK_REGISTRY.get("claude-opus-4-5")!;
    let msg = "";
    await checkConsent(opus, 50_000, async (m) => { msg = m; return false; });
    // 50K tokens * $5/MTok = $0.25 input cost estimate
    expect(msg).toContain("0.2500");
  });

  test("Tier 1 sticky reset between tests (beforeEach isolation)", async () => {
    // If sticky bled from prior test, this would return true without prompting
    const haiku = MOCK_REGISTRY.get("claude-haiku-4-5")!;
    let prompted = false;
    await checkConsent(haiku, undefined, async () => { prompted = true; return false; });
    expect(prompted).toBe(true); // confirms sticky was reset
  });

  test("resetSessionConsent() clears Tier 1 grant", async () => {
    const haiku = MOCK_REGISTRY.get("claude-haiku-4-5")!;
    await checkConsent(haiku, undefined, async () => true); // grant
    expect(getSessionConsent().tier1Granted).toBe(true);
    resetSessionConsent();
    expect(getSessionConsent().tier1Granted).toBe(false);
  });
});

// ── toPiAiModel ───────────────────────────────────────────────────────────────

describe("toPiAiModel", () => {
  test("maps all required pi-ai Model fields", () => {
    const m = toPiAiModel(MOCK_REGISTRY.get("gemma4")!);
    expect(m.id).toBe("gemma4");
    expect(m.name).toBe("Gemma 4 27B");
    expect(m.api).toBe("openai-completions");
    expect(m.provider).toBe("ollama");
    expect(m.baseUrl).toBe("http://localhost:11434/v1");
    expect(m.reasoning).toBe(true);
    expect(m.contextWindow).toBe(131072);
    expect(m.maxTokens).toBe(8192);
  });

  test("passes cost values through unchanged (USD per MTok)", () => {
    const haiku = toPiAiModel(MOCK_REGISTRY.get("claude-haiku-4-5")!);
    expect(haiku.cost.input).toBe(1);
    expect(haiku.cost.output).toBe(5);
    expect(haiku.cost.cacheRead).toBe(0.1);
    expect(haiku.cost.cacheWrite).toBe(1.25);
  });

  test("Tier 0 model has zero costs", () => {
    const m = toPiAiModel(MOCK_REGISTRY.get("gemma4")!);
    expect(m.cost.input).toBe(0);
    expect(m.cost.output).toBe(0);
  });

  test("sets correct baseUrl for Anthropic", () => {
    const m = toPiAiModel(MOCK_REGISTRY.get("claude-opus-4-5")!);
    expect(m.baseUrl).toBe("https://api.anthropic.com");
  });

  test("sets correct api discriminant for Google", () => {
    const m = toPiAiModel(MOCK_REGISTRY.get("gemini-2.5-flash")!);
    expect(m.api).toBe("google-generative-ai");
  });

  test("includes text and image in input array", () => {
    const m = toPiAiModel(MOCK_REGISTRY.get("gemma4")!);
    expect(m.input).toContain("text");
    expect(m.input).toContain("image");
  });
});

// ── getApiKey ─────────────────────────────────────────────────────────────────

describe("getApiKey", () => {
  test("ollama → returns literal 'ollama'", () => {
    expect(getApiKey(MOCK_REGISTRY.get("gemma4")!)).toBe("ollama");
  });

  test("anthropic → reads ANTHROPIC_API_KEY from env", () => {
    const original = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-123";
    try {
      expect(getApiKey(MOCK_REGISTRY.get("claude-haiku-4-5")!)).toBe("sk-ant-test-123");
    } finally {
      if (original === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = original;
    }
  });

  test("anthropic → returns undefined if ANTHROPIC_API_KEY not set", () => {
    const original = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(getApiKey(MOCK_REGISTRY.get("claude-opus-4-5")!)).toBeUndefined();
    } finally {
      if (original !== undefined) process.env.ANTHROPIC_API_KEY = original;
    }
  });

  test("google → reads GEMINI_API_KEY from env", () => {
    const original = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "AIza-test-456";
    try {
      expect(getApiKey(MOCK_REGISTRY.get("gemini-2.5-flash")!)).toBe("AIza-test-456");
    } finally {
      if (original === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = original;
    }
  });

  test("unknown provider → returns undefined", () => {
    const m = makeModel({ provider: "mystery-provider" });
    expect(getApiKey(m)).toBeUndefined();
  });
});

// ── parseRegistryFromRows ──────────────────────────────────────────────────────

describe("parseRegistryFromRows", () => {
  // Representative rows as mysql2 returns them (Record<string, string>[])
  const SAMPLE_ROWS: Record<string, string>[] = [
    { slug: "gemma4", display_name: "Gemma 4 27B", provider: "ollama", api: "openai-completions", base_url: "http://localhost:11434/v1", tier: "0", context_window: "131072", max_output_tokens: "8192", cost_input: "0.000000", cost_output: "0.000000", cost_cache_read: "0.000000", cost_cache_write: "0.000000", reasoning: "1", capabilities: '["text","reasoning"]' },
    { slug: "claude-haiku-4-5", display_name: "Claude Haiku 4.5", provider: "anthropic", api: "anthropic-messages", base_url: "https://api.anthropic.com", tier: "1", context_window: "200000", max_output_tokens: "64000", cost_input: "1.000000", cost_output: "5.000000", cost_cache_read: "0.100000", cost_cache_write: "1.250000", reasoning: "1", capabilities: '["text","code","vision"]' },
    { slug: "claude-opus-4-5", display_name: "Claude Opus 4.5", provider: "anthropic", api: "anthropic-messages", base_url: "https://api.anthropic.com", tier: "2", context_window: "200000", max_output_tokens: "64000", cost_input: "5.000000", cost_output: "25.000000", cost_cache_read: "0.500000", cost_cache_write: "6.250000", reasoning: "1", capabilities: '["text","code","reasoning","vision"]' },
  ];

  test("returns a Map keyed by slug", () => {
    const registry = parseRegistryFromRows(SAMPLE_ROWS);
    expect(registry).toBeInstanceOf(Map);
    expect(registry.has("gemma4")).toBe(true);
    expect(registry.has("claude-haiku-4-5")).toBe(true);
    expect(registry.has("claude-opus-4-5")).toBe(true);
  });

  test("parses tier as number", () => {
    const registry = parseRegistryFromRows(SAMPLE_ROWS);
    expect(registry.get("gemma4")!.tier).toBe(0);
    expect(registry.get("claude-haiku-4-5")!.tier).toBe(1);
    expect(registry.get("claude-opus-4-5")!.tier).toBe(2);
  });

  test("parses cost values as floats", () => {
    const registry = parseRegistryFromRows(SAMPLE_ROWS);
    const haiku = registry.get("claude-haiku-4-5")!;
    expect(haiku.costInput).toBe(1.0);
    expect(haiku.costOutput).toBe(5.0);
    expect(haiku.costCacheRead).toBe(0.1);
    expect(haiku.costCacheWrite).toBe(1.25);
  });

  test("parses reasoning as boolean from '1'", () => {
    const registry = parseRegistryFromRows(SAMPLE_ROWS);
    expect(registry.get("gemma4")!.reasoning).toBe(true);
  });

  test("parses capabilities as string array from JSON column", () => {
    const registry = parseRegistryFromRows(SAMPLE_ROWS);
    const caps = registry.get("gemma4")!.capabilities;
    expect(Array.isArray(caps)).toBe(true);
    expect(caps).toContain("text");
    expect(caps).toContain("reasoning");
  });

  test("parses contextWindow and maxTokens as numbers", () => {
    const registry = parseRegistryFromRows(SAMPLE_ROWS);
    const gemma = registry.get("gemma4")!;
    expect(gemma.contextWindow).toBe(131072);
    expect(gemma.maxTokens).toBe(8192);
  });

  test("skips rows with invalid tier values", () => {
    const badRows: Record<string, string>[] = [
      { slug: "bad-model", display_name: "Bad", provider: "ollama", api: "openai-completions", base_url: "http://localhost:11434/v1", tier: "99", context_window: "1000", max_output_tokens: "1000", cost_input: "0", cost_output: "0", cost_cache_read: "0", cost_cache_write: "0", reasoning: "0", capabilities: "[]" },
    ];
    const registry = parseRegistryFromRows(badRows);
    expect(registry.has("bad-model")).toBe(false);
  });

  test("returns empty registry for empty rows", () => {
    const registry = parseRegistryFromRows([]);
    expect(registry.size).toBe(0);
  });
});

// ── estimateContextTokens ─────────────────────────────────────────────────────

describe("estimateContextTokens", () => {
  const makeContext = (text: string): Context => ({
    systemPrompt: text,
    messages: [],
  });

  test("returns 0 for empty context", () => {
    expect(estimateContextTokens({ messages: [] })).toBe(0);
  });

  test("estimates ~1 token per 4 chars", () => {
    const ctx = makeContext("1234"); // 4 chars → 1 token
    expect(estimateContextTokens(ctx)).toBe(1);
  });

  test("includes system prompt in estimate", () => {
    const ctx: Context = {
      systemPrompt: "You are a helpful assistant.", // 27 chars ≈ 7 tokens
      messages: [],
    };
    expect(estimateContextTokens(ctx)).toBeGreaterThan(0);
  });

  test("includes user message text in estimate", () => {
    const ctx: Context = {
      messages: [
        { role: "user", content: [{ type: "text", text: "Hello there!" }], timestamp: 0 },
      ],
    };
    expect(estimateContextTokens(ctx)).toBeGreaterThan(0);
  });

  test("handles string user content (not array)", () => {
    const ctx: Context = {
      messages: [
        { role: "user", content: "Direct string content", timestamp: 0 },
      ],
    };
    expect(estimateContextTokens(ctx)).toBeGreaterThan(0);
  });

  test("larger context → larger estimate", () => {
    const short = makeContext("Hi");
    const long  = makeContext("A".repeat(1000));
    expect(estimateContextTokens(long)).toBeGreaterThan(estimateContextTokens(short));
  });
});

// ── Error classes ─────────────────────────────────────────────────────────────

describe("ConsentDeclinedError", () => {
  test("carries slug and correct name", () => {
    const e = new ConsentDeclinedError("claude-opus-4-5");
    expect(e.slug).toBe("claude-opus-4-5");
    expect(e.name).toBe("ConsentDeclinedError");
    expect(e).toBeInstanceOf(Error);
  });
});

describe("ModelNotFoundError", () => {
  test("carries slug and correct name", () => {
    const e = new ModelNotFoundError("mystery-model");
    expect(e.slug).toBe("mystery-model");
    expect(e.name).toBe("ModelNotFoundError");
    expect(e).toBeInstanceOf(Error);
  });
});

// ── TIER_DEFAULTS ─────────────────────────────────────────────────────────────

describe("TIER_DEFAULTS", () => {
  test("defines defaults for all three tiers", () => {
    expect(TIER_DEFAULTS[0]).toBe("gemma4");
    expect(TIER_DEFAULTS[1]).toBe("claude-haiku-4-5");
    expect(TIER_DEFAULTS[2]).toBe("claude-opus-4-5");
  });
});

// ── BudgetExceededError re-export ──────────────────────────────────────────────────

describe("BudgetExceededError (re-exported from router)", () => {
  test("is the same class as the one from budget.ts", () => {
    // Ensures callers only need to import from router, not budget
    const e = new BudgetExceededError("per_call_limit", 0.12, 0.10, 0.05);
    expect(e).toBeInstanceOf(BudgetExceededError);
    expect(e.name).toBe("BudgetExceededError");
  });
});

// ── routedStream() budget guard (unit-level) ────────────────────────────────
// These tests exercise checkPreCall() and BudgetExceededError integration
// using BudgetTracker directly — no Dolt, no Ollama, no API.

describe("BudgetTracker.checkPreCall() → BudgetExceededError contract", () => {
  test("per_call_limit breach produces correct error fields", () => {
    const tracker = new BudgetTracker("sess", "trace", {
      sessionLimitUsd: 1.00,
      perCallLimitUsd: 0.01, // very tight
    });
    // $5/MTok × 50_000 tokens = $0.25 >> $0.01 per-call limit
    const check = tracker.checkPreCall(2, 5.0, 50_000);
    expect(check.allowed).toBe(false);
    expect(check.reason).toBe("per_call_limit");

    const err = new BudgetExceededError(
      check.reason!,
      check.estimatedCost,
      check.perCallLimitUsd,
      check.sessionCostSoFar,
    );
    expect(err.reason).toBe("per_call_limit");
    expect(err.limitUsd).toBe(0.01);
    expect(err.estimatedCost).toBeCloseTo(0.25);
  });

  test("session_limit breach produces correct error fields", () => {
    const tracker = new BudgetTracker("sess", "trace", {
      sessionLimitUsd: 0.10,
      perCallLimitUsd: 0.10,
    });
    // Simulate $0.09 spent
    tracker.record({ input: 10, output: 5, cost: { total: 0.09 } }, 1);
    // New call estimates $0.05 → $0.14 > $0.10 session limit
    const check = tracker.checkPreCall(1, 1.0, 50_000);
    expect(check.allowed).toBe(false);
    expect(check.reason).toBe("session_limit");

    const err = new BudgetExceededError(
      check.reason!,
      check.estimatedCost,
      check.sessionLimitUsd,
      check.sessionCostSoFar,
    );
    expect(err.reason).toBe("session_limit");
    expect(err.limitUsd).toBe(0.10);
    expect(err.sessionCostSoFar).toBeCloseTo(0.09);
  });

  test("Tier 0 with zero-limit budget is always allowed", () => {
    const tracker = new BudgetTracker("sess", "trace", {
      sessionLimitUsd: 0,
      perCallLimitUsd: 0,
    });
    const check = tracker.checkPreCall(0, 999, 1_000_000);
    expect(check.allowed).toBe(true);
  });
});


