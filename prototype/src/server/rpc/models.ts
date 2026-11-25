// The `models` namespace: the model catalog with the fields clients annotate
// rows from. `routable`, `local`, and `modality` are computed server-side
// (single sources: modelHasCatalogPricing, isLocalWorkbenchModel,
// getModelAccessModality) so clients can annotate rows without duplicating
// pricing, locality, or taxonomy rules.

import {
  getModelAccessModality,
  isLocalWorkbenchModel,
  modelHasCatalogPricing,
  modelReasoningEffort,
  modelTransmittedOutputCap,
  reasoningEffortSupport,
  type WorkbenchModel,
} from "../../providers/mod.ts";
import type { RpcHandlers } from "../../transport/mod.ts";

/**
 * The catalog as the picker sees it: the models, and, when the catalog could
 * not be loaded and `models` are the built-in local rows, the summarized
 * reason.
 */
export interface PickerCatalog {
  models: WorkbenchModel[];
  unavailable?: string;
}

export interface ModelsHandlerDeps {
  loadModels: () => Promise<WorkbenchModel[]>;
  /** Preferred over `loadModels` when given: it also says why it fell back. */
  loadCatalog?: () => Promise<PickerCatalog>;
  /**
   * The configured `[codex] reasoning_effort`, which is the effort a Codex
   * turn runs at when the request names none. A native model's unset default
   * is `low`, which is what `modelReasoningEffort` reports; a Codex row's is
   * this value, so the two are never confused.
   */
  codexReasoningEffort?: string;
}

/** The provider whose rows take the runtime's configured effort as default. */
const CODEX_PROVIDER = "codex-chatgpt";

export function buildModelsHandlers(deps: ModelsHandlerDeps): RpcHandlers {
  const loadCatalog = deps.loadCatalog ??
    (async (): Promise<PickerCatalog> => ({ models: await deps.loadModels() }));
  const defaultEffort = (model: WorkbenchModel) =>
    model.provider === CODEX_PROVIDER &&
        reasoningEffortSupport(model) !== undefined
      ? deps.codexReasoningEffort ?? "medium"
      : modelReasoningEffort(model);
  return {
    // `catalogUnavailable` is present only over a fallback catalog, so a
    // client can say that the list is incomplete, and why the catalog failed
    // as far as its summary says.
    "models/list": async () => {
      const catalog = await loadCatalog();
      return {
        models: catalog.models.map((model) => ({
          ...model,
          routable: modelHasCatalogPricing(model),
          local: isLocalWorkbenchModel(model),
          modality: getModelAccessModality(model),
          defaultOutputTokens: modelTransmittedOutputCap(model),
          reasoningEffort: defaultEffort(model),
          // A Codex request has no tool-call effort constraint, so its
          // tool-bearing value is its default; only OpenAI narrows it.
          toolReasoningEffort: model.provider === CODEX_PROVIDER
            ? defaultEffort(model)
            : modelReasoningEffort(model, undefined, true),
          // The levels this model accepts, so a client never hardcodes a slug
          // prefix to decide whether `/effort` and `--effort` apply.
          ...(reasoningEffortSupport(model) === undefined
            ? {}
            : { reasoningEfforts: reasoningEffortSupport(model)!.levels }),
        })),
        ...(catalog.unavailable === undefined
          ? {}
          : { catalogUnavailable: catalog.unavailable }),
      };
    },
  };
}
