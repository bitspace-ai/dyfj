/**
 * The built-in local model rows, overlaid on the catalog when it lacks them.
 */
import type { WorkbenchModel } from "../types.ts";
import { loadWorkbenchModels } from "./catalog.ts";

export function defaultLocalWorkbenchModels(): WorkbenchModel[] {
  return [
    {
      slug: "llama-cpp/qwen3.6-35b-a3b",
      displayName: "Qwen3.6 35B-A3B (llama.cpp)",
      provider: "llama-cpp",
      api: "openai-completions",
      baseUrl: "http://localhost:8080/v1",
      tier: 0,
      costInput: 0,
      costOutput: 0,
      capabilities: ["text", "code", "reasoning", "tools"],
      contextWindow: 32768,
      maxOutputTokens: 8192,
      modality: "local",
      architecture: "moe",
      totalParamsB: 35.0,
      activeParamsB: 3.0,
      recommendedQuant: "UD-Q4_K_XL",
      residentRamGiB: 24.0,
      reasoningEffortControl: false,
    },
  ];
}

/**
 * Prepend the built-in local rows the catalog has no row for. A slug in
 * `inactiveSlugs` has a catalog row the operator deactivated, so its built-in
 * row is not restored. A slug the catalog no longer holds at all is restored,
 * which is why a retired family must be removed from the built-in list too:
 * an absent row is not an inactive one.
 */
export function withDefaultLocalWorkbenchModels(
  models: WorkbenchModel[],
  inactiveSlugs: readonly string[] = [],
): WorkbenchModel[] {
  const defaultModels = defaultLocalWorkbenchModels()
    .filter((model) =>
      !models.some((existing) => existing.slug === model.slug) &&
      !inactiveSlugs.includes(model.slug)
    );
  return [...defaultModels, ...models];
}

/**
 * The active catalog with the built-in local rows overlaid where the catalog
 * has no row, active or inactive, for them.
 */
export async function loadWorkbenchModelsWithLocalDefaults(
  models: {
    listActive(): Promise<Record<string, string>[]>;
    listInactiveSlugs(): Promise<string[]>;
  },
): Promise<WorkbenchModel[]> {
  const [active, inactiveSlugs] = await Promise.all([
    loadWorkbenchModels(models),
    models.listInactiveSlugs(),
  ]);
  return withDefaultLocalWorkbenchModels(active, inactiveSlugs);
}
