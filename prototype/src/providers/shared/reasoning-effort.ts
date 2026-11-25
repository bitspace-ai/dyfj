/**
 * Reasoning-effort capability: which models accept a reasoning effort, which
 * levels each provider API accepts, and the value a request actually sends.
 *
 * One implementation for every consumer — the provider adapters, route
 * resolution, `models/list`, the dispatch planner, the CLI and the Rust
 * REPL — so a client never hardcodes a slug prefix to decide whether a model
 * takes an effort.
 *
 * The operator-named levels are `config/schema.ts`'s four (the ones the Codex
 * route has always accepted). A provider that accepts more (OpenAI's
 * `minimal`, Anthropic's `max`) keeps them off this list: raising a model
 * above the list is a capability question for the catalog, not something a
 * client should guess.
 */
import {
  CODEX_REASONING_EFFORTS,
  type CodexReasoningEffort,
  codexReasoningEffortRefusal,
  isCodexReasoningEffort,
} from "../../config/mod.ts";
import type { WorkbenchModel } from "../types.ts";

/** The reasoning efforts an operator may name. */
export type ReasoningEffort = CodexReasoningEffort;

export const REASONING_EFFORTS: readonly ReasoningEffort[] =
  CODEX_REASONING_EFFORTS;

export const isReasoningEffort = isCodexReasoningEffort;

/** The refusal for a level outside `REASONING_EFFORTS`. */
export const reasoningEffortRefusal = codexReasoningEffortRefusal;

/**
 * The value a provider request carries: an operator-named level, or `none`,
 * which no operator names but OpenAI requires on a tool-bearing request.
 */
export type SentReasoningEffort = ReasoningEffort | "none";

/** What one model accepts, when it accepts anything. */
export interface ReasoningEffortSupport {
  /** The levels a text-only request may name. */
  readonly levels: readonly ReasoningEffort[];
  /**
   * The effort every tool-bearing request sends whatever the operator named.
   * OpenAI accepts no reasoning above `none` on a request that offers tools,
   * so this is a provider constraint, not a preference.
   */
  readonly toolEffort?: SentReasoningEffort;
}

/**
 * The levels each provider API accepts, checked against the provider's own
 * documentation on 2026-11-24. A provider absent from this table takes no
 * effort at all.
 */
const PROVIDER_LEVELS: Readonly<
  Record<string, readonly ReasoningEffort[]>
> = {
  // Codex ChatGPT (`model_reasoning_effort`), the original route.
  "codex-chatgpt": REASONING_EFFORTS,
  // `output_config.effort`: current Claude models take all four.
  anthropic: REASONING_EFFORTS,
  // `reasoning_effort`, model-dependent upstream: the levels the shipped
  // rows and the API family share.
  openai: REASONING_EFFORTS,
  // `reasoning_effort` (`reasoning.effort` on the Responses API).
  xai: REASONING_EFFORTS,
  // `reasoning.effort`: OpenRouter maps a level onto the nearest one its
  // upstream serves.
  openrouter: REASONING_EFFORTS,
  // `generationConfig.thinkingConfig.thinkingLevel`: Gemini 3.x tops out at
  // `high`; `xhigh` arrives with the Gemini 4 generation.
  google: ["low", "medium", "high"],
};

/**
 * Providers whose adapter sends a thinking level on every request, so the
 * catalog flag does not gate effort control: Gemini's `thinkingConfig` is part
 * of its request either way, and its 3.x rows are what the flag would name.
 */
const ALWAYS_SENDS_A_LEVEL: ReadonlySet<string> = new Set(["google"]);

/**
 * What this model accepts, or `undefined` when it takes no reasoning effort:
 * a catalog row without `reasoning_effort_control`, or a provider whose API
 * has no effort parameter.
 */
export function reasoningEffortSupport(
  model: WorkbenchModel,
): ReasoningEffortSupport | undefined {
  if (
    model.reasoningEffortControl !== true &&
    !ALWAYS_SENDS_A_LEVEL.has(model.provider)
  ) {
    return undefined;
  }
  const levels = PROVIDER_LEVELS[model.provider];
  if (levels === undefined || levels.length === 0) return undefined;
  return model.provider === "openai"
    ? { levels, toolEffort: "none" }
    : { levels };
}

/** Whether this model takes an operator-named reasoning effort at all. */
export function supportsReasoningEffort(model: WorkbenchModel): boolean {
  return reasoningEffortSupport(model) !== undefined;
}

/**
 * Why this model cannot run at `requested`, or `undefined` when it can. The
 * one message every caller shows, so the command line, the runtime and the
 * dispatch planner refuse a bad effort the same way.
 */
export function unsupportedReasoningEffort(
  model: WorkbenchModel,
  requested: unknown,
): string | undefined {
  if (requested === undefined) return undefined;
  const support = reasoningEffortSupport(model);
  if (support === undefined) {
    return `Model "${model.slug}" takes no reasoning effort: its catalog row ` +
      "does not enable reasoning effort control, or its provider API has no " +
      "effort parameter. Drop the effort, or choose a model whose row " +
      "enables it (`dyfj models` shows the supported levels)";
  }
  if (!isReasoningEffort(requested)) {
    return `reasoning effort must be low, medium, high, or xhigh`;
  }
  if (!support.levels.includes(requested)) {
    return `Model "${model.slug}" does not accept reasoning effort ` +
      `"${requested}"; it accepts ${
        support.levels.join(", ")
      }. Choose one of those, or drop the effort`;
  }
  return undefined;
}

/**
 * The effort a request for this model sends: the operator's level when it
 * names one and the model accepts it, otherwise the model's default. A
 * tool-bearing OpenAI request sends `none` whatever the operator named,
 * because the provider accepts no reasoning above `none` there.
 * `undefined` when the model takes no effort, so no parameter is invented.
 */
export function modelReasoningEffort(
  model: WorkbenchModel,
  requested?: string,
  withTools = false,
): SentReasoningEffort | undefined {
  const support = reasoningEffortSupport(model);
  if (support === undefined) return undefined;
  if (withTools && support.toolEffort !== undefined) {
    return support.toolEffort;
  }
  if (isReasoningEffort(requested) && support.levels.includes(requested)) {
    return requested;
  }
  return DEFAULT_REASONING_EFFORT;
}

/** The effort a request sends when the operator names none. */
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "low";

/** Reasoning and the answer share the provider's total output budget. */
export function hostedDefaultOutputTokens(
  model: WorkbenchModel,
  fallback: number,
): number {
  return model.capabilities.includes("reasoning") ? 32_768 : fallback;
}
