/**
 * DYFJ Workbench — Cost-aware model router
 *
 * Replaces the hardcoded `localModel` in index.ts with a Dolt-backed
 * registry and three-tier consent policy:
 *
 *   Tier 0 — Local (Ollama)  — always free, no consent
 *   Tier 1 — API Light       — session-grant: prompt once, sticky
 *   Tier 2 — API Heavy       — per-call: prompt every time + cost estimate
 *
 * selectModel() and toPiAiModel() are pure functions — no I/O, fully testable.
 * checkConsent() accepts an injectable promptFn for testing.
 * routedStream() is the public entry point for callers.
 *
 * NOTE: Heuristics in selectModel() are v1 placeholders. They will be
 * replaced with data-driven thresholds once the events table has enough
 * model_selected + model_response signal to score routing quality.
 */

import { stream } from "@mariozechner/pi-ai";
import type { Api, Context, Model } from "@mariozechner/pi-ai";
import type { AssistantMessageEventStream } from "@mariozechner/pi-ai";
import { createInterface } from "readline";
import {
  doltQuery,
  writeModelSelectedEvent,
  generateULID,
  generateTraceId,
  generateSpanId,
} from "./utils";
import { BudgetTracker, BudgetExceededError } from "./budget";
export { BudgetExceededError } from "./budget";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RouterModel {
  slug: string;
  displayName: string;
  provider: string;
  api: string;
  baseUrl: string;
  tier: 0 | 1 | 2;
  contextWindow: number;
  maxTokens: number;
  /** USD per million tokens — matches pi-ai Model.cost unit */
  costInput: number;
  costOutput: number;
  costCacheRead: number;
  costCacheWrite: number;
  reasoning: boolean;
  capabilities: string[];
}

export type ModelRegistry = Map<string, RouterModel>;

export interface RoutingOptions {
  /** Pin to a specific model slug. Overrides all heuristics. */
  modelId?: string;
  /** Pin to a specific tier. Uses tier default model. */
  tier?: 0 | 1 | 2;
  /** Task hint — guides Tier 0 heuristics. */
  hint?: "code" | "chat" | "reasoning";
  /** Estimated context size in tokens — used for long-context routing. */
  contextLength?: number;
}

export interface SelectionResult {
  selected: RouterModel;
  /** Tier 0 model slugs considered before this choice. Empty for explicit selections. */
  considered: string[];
  /** Human-readable reason for selection — stored in model_selected event. */
  reason: string;
}

export interface RoutedStreamResult {
  stream: AssistantMessageEventStream;
  selectedModel: RouterModel;
  selection: SelectionResult;
}

/** Injectable prompt function — defaults to stdin/stdout. Swap in tests. */
export type PromptFn = (message: string) => Promise<boolean>;

// ── Errors ────────────────────────────────────────────────────────────────────

export class ConsentDeclinedError extends Error {
  constructor(public readonly slug: string) {
    super(`Consent declined for model: ${slug}`);
    this.name = "ConsentDeclinedError";
  }
}

export class ModelNotFoundError extends Error {
  constructor(public readonly slug: string) {
    super(`Model not found in registry: ${slug}`);
    this.name = "ModelNotFoundError";
  }
}

// ── Registry ──────────────────────────────────────────────────────────────────

/** Module-level cache — loaded once per process, cleared between tests. */
let _registry: ModelRegistry | null = null;

/** Clear the in-memory registry cache. Used in tests and CLI tooling. */
export function clearRegistryCache(): void {
  _registry = null;
}

/** Load active models from Dolt. Cached for the lifetime of the process. */
export async function loadModelRegistry(): Promise<ModelRegistry> {
  if (_registry) return _registry;

  const rows = await doltQuery(
    "SELECT slug, display_name, provider, api, base_url, tier, " +
      "context_window, max_output_tokens, " +
      "cost_input, cost_output, cost_cache_read, cost_cache_write, " +
      "reasoning, capabilities " +
      "FROM models WHERE active = TRUE ORDER BY tier, slug;"
  );

  _registry = parseRegistryFromRows(rows);
  return _registry;
}

/**
 * Parse Dolt query rows into a ModelRegistry.
 * Exported for unit testing — keeps loadModelRegistry() as a thin I/O wrapper.
 */
export function parseRegistryFromRows(rows: Record<string, string>[]): ModelRegistry {
  const registry: ModelRegistry = new Map();

  for (const row of rows) {
    const tier = parseInt(row.tier, 10);
    if (tier !== 0 && tier !== 1 && tier !== 2) continue; // guard

    const model: RouterModel = {
      slug:          row.slug,
      displayName:   row.display_name,
      provider:      row.provider,
      api:           row.api,
      baseUrl:       row.base_url ?? "",
      tier:          tier as 0 | 1 | 2,
      contextWindow: parseInt(row.context_window, 10),
      maxTokens:     parseInt(row.max_output_tokens, 10),
      costInput:     parseFloat(row.cost_input  || "0"),
      costOutput:    parseFloat(row.cost_output || "0"),
      costCacheRead: parseFloat(row.cost_cache_read  || "0"),
      costCacheWrite:parseFloat(row.cost_cache_write || "0"),
      // Dolt outputs BOOLEAN as '1'/'0' in CSV
      reasoning:     row.reasoning === "1" || row.reasoning === "true",
      capabilities:  row.capabilities ? (JSON.parse(row.capabilities) as string[]) : [],
    };

    registry.set(model.slug, model);
  }

  return registry;
}

// ── Model selection ───────────────────────────────────────────────────────────

/**
 * Default model slug per tier — used when tier is explicitly requested
 * or as fallback targets in heuristics.
 *
 * v1 PLACEHOLDER: These defaults will be driven by the scorecard once
 * the events table has enough data to validate routing quality.
 */
export const TIER_DEFAULTS: Record<0 | 1 | 2, string> = {
  0: "gemma4",
  1: "claude-haiku-4-5",
  2: "claude-opus-4-5",
};

/**
 * Select a model from the registry based on routing options.
 *
 * Pure function — no I/O, fully deterministic given the same registry
 * and options. Heuristics are Tier 0 only; explicit modelId/tier bypass them.
 *
 * Throws ModelNotFoundError if the requested model/tier-default isn't in
 * the registry (e.g., model was deactivated or slug was misspelled).
 */
export function selectModel(
  registry: ModelRegistry,
  options: RoutingOptions
): SelectionResult {
  // 1. Explicit model ID — unconditional override
  if (options.modelId !== undefined) {
    const model = registry.get(options.modelId);
    if (!model) throw new ModelNotFoundError(options.modelId);
    return { selected: model, considered: [], reason: "explicit_model_id" };
  }

  // 2. Explicit tier — use tier's default model
  if (options.tier !== undefined) {
    const slug = TIER_DEFAULTS[options.tier];
    const model = registry.get(slug);
    if (!model) throw new ModelNotFoundError(slug);
    return { selected: model, considered: [], reason: "explicit_tier" };
  }

  // 3. Heuristics — Tier 0 only
  //
  // v1 PLACEHOLDER: These are educated guesses, not validated rules.
  // Replace thresholds with data-driven values from the events/reflections
  // tables once the scorecard infrastructure exists.
  const considered = [
    TIER_DEFAULTS[0],
    "qwen3:32b",
    "qwen3:30b-a3b",
  ].filter(s => registry.has(s));

  if (options.contextLength !== undefined && options.contextLength > 100_000) {
    // gemma4 has 128K context — best local option for long inputs
    const model = registry.get(TIER_DEFAULTS[0]);
    if (!model) throw new ModelNotFoundError(TIER_DEFAULTS[0]);
    return { selected: model, considered, reason: "context_length_gt_100k" };
  }

  if (options.hint === "code") {
    // qwen3:32b leads LiveCodeBench among open-weight local models
    const model = registry.get("qwen3:32b") ?? registry.get(TIER_DEFAULTS[0]);
    if (!model) throw new ModelNotFoundError("qwen3:32b");
    return {
      selected: model,
      considered,
      reason: model.slug === "qwen3:32b" ? "hint_code" : "hint_code_fallback_gemma4",
    };
  }

  if (options.hint === "chat") {
    // qwen3:30b-a3b MoE — lower active params, lower latency for chat
    const model = registry.get("qwen3:30b-a3b") ?? registry.get(TIER_DEFAULTS[0]);
    if (!model) throw new ModelNotFoundError("qwen3:30b-a3b");
    return {
      selected: model,
      considered,
      reason: model.slug === "qwen3:30b-a3b" ? "hint_chat_speed" : "hint_chat_fallback_gemma4",
    };
  }

  // 4. Default — gemma4: reasoning generalist, 128K context, Apache 2.0
  const model = registry.get(TIER_DEFAULTS[0]);
  if (!model) throw new ModelNotFoundError(TIER_DEFAULTS[0]);
  return { selected: model, considered, reason: "default" };
}

// ── Consent gate ──────────────────────────────────────────────────────────────

/** Module-level session consent state. Reset between tests via resetSessionConsent(). */
const sessionConsent = { tier1Granted: false };

/** Reset session consent state. Call in tests to isolate consent behaviour. */
export function resetSessionConsent(): void {
  sessionConsent.tier1Granted = false;
}

/** Read current Tier 1 session consent state (for testing assertions). */
export function getSessionConsent(): Readonly<typeof sessionConsent> {
  return { ...sessionConsent };
}

/**
 * Check whether the user consents to using the given model.
 *
 * - Tier 0: always returns true, no prompt
 * - Tier 1: prompts once per session; subsequent calls return true without prompting
 * - Tier 2: prompts on every call with a cost estimate
 *
 * @param model              The model to check consent for
 * @param estimatedTokens    Optional estimated input token count (for cost display)
 * @param promptFn           Injectable prompt — defaults to stdin/stdout. Swap in tests.
 */
export async function checkConsent(
  model: RouterModel,
  estimatedTokens?: number,
  promptFn?: PromptFn
): Promise<boolean> {
  if (model.tier === 0) return true;

  const doPrompt = promptFn ?? defaultPromptYN;

  if (model.tier === 1) {
    if (sessionConsent.tier1Granted) return true;
    const granted = await doPrompt(
      `⬆  Escalate to ${model.displayName}? ` +
        `($${model.costInput.toFixed(2)}/$${model.costOutput.toFixed(2)} per MTok in/out). ` +
        `Permission applies for this session. [y/N] `
    );
    if (granted) sessionConsent.tier1Granted = true;
    return granted;
  }

  if (model.tier === 2) {
    const estimateStr =
      estimatedTokens !== undefined
        ? ` (~$${((estimatedTokens / 1_000_000) * model.costInput).toFixed(4)} est.)`
        : "";
    return doPrompt(
      `⬆⬆ Escalate to ${model.displayName}?${estimateStr} ` +
        `($${model.costInput.toFixed(2)}/$${model.costOutput.toFixed(2)} per MTok). ` +
        `This prompt appears every call. [y/N] `
    );
  }

  return false; // unknown tier — deny
}

async function defaultPromptYN(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) =>
    rl.question(message, resolve)
  );
  rl.close();
  return answer.trim().toLowerCase().startsWith("y");
}

// ── Model conversion ──────────────────────────────────────────────────────────

/**
 * Convert a RouterModel (from Dolt) to a pi-ai Model object.
 * Cost values are USD per MTok — same unit as pi-ai's generated models.
 */
export function toPiAiModel(model: RouterModel): Model<Api> {
  return {
    id:            model.slug,
    name:          model.displayName,
    api:           model.api as Api,
    provider:      model.provider,
    baseUrl:       model.baseUrl,
    reasoning:     model.reasoning,
    input:         ["text", "image"],
    cost: {
      input:      model.costInput,
      output:     model.costOutput,
      cacheRead:  model.costCacheRead,
      cacheWrite: model.costCacheWrite,
    },
    contextWindow: model.contextWindow,
    maxTokens:     model.maxTokens,
  };
}

/**
 * Resolve the API key for a RouterModel's provider.
 * Ollama uses the literal string "ollama" (pi-ai convention for local endpoints).
 * API providers read from environment variables.
 */
export function getApiKey(model: RouterModel): string | undefined {
  switch (model.provider) {
    case "ollama":    return "ollama";
    case "anthropic": return process.env.ANTHROPIC_API_KEY;
    case "google":    return process.env.GEMINI_API_KEY;
    case "openai":    return process.env.OPENAI_API_KEY;
    default:          return undefined;
  }
}

// ── Estimate helpers ──────────────────────────────────────────────────────────

/**
 * Rough token estimate for a Context — used for cost display in consent prompts.
 * Approximation: 1 token ≈ 4 characters. Good enough for budget warnings.
 */
export function estimateContextTokens(context: Context): number {
  const parts: string[] = [];

  if (context.systemPrompt) parts.push(context.systemPrompt);

  for (const msg of context.messages) {
    if (msg.role === "user") {
      parts.push(
        Array.isArray(msg.content)
          ? msg.content
              .filter((c): c is { type: "text"; text: string } => c.type === "text")
              .map(c => c.text)
              .join("")
          : String(msg.content)
      );
    } else if (msg.role === "assistant") {
      parts.push(
        msg.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map(c => c.text)
          .join("")
      );
    }
  }

  return Math.ceil(parts.join(" ").length / 4);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Route a context to the most appropriate model and start a stream.
 *
 * Handles model selection, consent gate, telemetry (model_selected event),
 * and stream initiation. Returns the stream together with metadata about
 * which model was selected and why.
 *
 * Throws:
 *   - ConsentDeclinedError if the user declines an API escalation
 *   - ModelNotFoundError if the requested/heuristic model isn't in the registry
 *
 * Fallback (Tier 0 failure → Tier 1 escalation):
 *   The caller observes the stream for error events. If the stream errors and
 *   a fallback is desired, call routedStream() again with { tier: 1 } options.
 *   Transparent auto-fallback is deferred to a future iteration.
 */
export async function routedStream(
  context: Context,
  options: RoutingOptions,
  sessionId: string,
  traceId: string,
  promptFn?: PromptFn,
  budgetTracker?: BudgetTracker,
): Promise<RoutedStreamResult> {
  const selectionStart = Date.now();
  const registry = await loadModelRegistry();
  const selection = selectModel(registry, options);
  const { selected } = selection;

  const consented = await checkConsent(
    selected,
    estimateContextTokens(context),
    promptFn
  );
  if (!consented) throw new ConsentDeclinedError(selected.slug);

  // Budget guard — after consent so we don't burn a prompt on a call that
  // would exceed limits anyway. Tier 0 is always free; skip the check.
  if (budgetTracker && selected.tier > 0) {
    const check = budgetTracker.checkPreCall(
      selected.tier,
      selected.costInput,
      estimateContextTokens(context),
    );
    if (!check.allowed) {
      throw new BudgetExceededError(
        check.reason!,
        check.estimatedCost,
        check.reason === "per_call_limit" ? check.perCallLimitUsd : check.sessionLimitUsd,
        check.sessionCostSoFar,
      );
    }
  }

  await writeModelSelectedEvent({
    selected:   selected.slug,
    considered: selection.considered,
    reason:     selection.reason,
    sessionId,
    traceId,
    durationMs: Date.now() - selectionStart,
  });

  const piModel = toPiAiModel(selected);
  const apiKey  = getApiKey(selected);
  const eventStream = stream(piModel, context, { apiKey });

  return { stream: eventStream, selectedModel: selected, selection };
}
