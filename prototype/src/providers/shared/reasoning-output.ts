import type { WorkbenchModel } from "../types.ts";

export const DEFAULT_REASONING_EFFORT = "low";

/** Reasoning and the answer share the provider's total output budget. */
export function hostedDefaultOutputTokens(
  model: WorkbenchModel,
  fallback: number,
): number {
  return model.capabilities.includes("reasoning") ? 32_768 : fallback;
}

/** Low effort is advisory; it does not reserve a fixed number of answer tokens. */
export function modelReasoningEffort(
  model: WorkbenchModel,
  withTools = false,
): "low" | "none" | undefined {
  // Gemini's adapter already requests low thinking for its supported 3.x models.
  if (model.provider === "google") return DEFAULT_REASONING_EFFORT;
  if (!model.reasoningEffortControl) return undefined;
  switch (model.provider) {
    case "openai":
      return withTools ? "none" : DEFAULT_REASONING_EFFORT;
    case "openrouter":
    case "xai":
    case "anthropic":
      return DEFAULT_REASONING_EFFORT;
    default:
      return undefined;
  }
}
