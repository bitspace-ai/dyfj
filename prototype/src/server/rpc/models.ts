// The `models` namespace: the model catalog with the fields clients annotate
// rows from. `routable`, `local`, and `modality` are computed server-side
// (single sources: modelHasCatalogPricing, isLocalWorkbenchModel,
// getModelAccessModality) so clients can annotate rows without duplicating
// pricing, locality, or taxonomy rules.

import {
  getModelAccessModality,
  isLocalWorkbenchModel,
  modelHasCatalogPricing,
  modelTransmittedOutputCap,
  modelReasoningEffort,
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
}

export function buildModelsHandlers(deps: ModelsHandlerDeps): RpcHandlers {
  const loadCatalog = deps.loadCatalog ??
    (async (): Promise<PickerCatalog> => ({ models: await deps.loadModels() }));
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
          reasoningEffort: modelReasoningEffort(model),
          toolReasoningEffort: modelReasoningEffort(model, true),
        })),
        ...(catalog.unavailable === undefined
          ? {}
          : { catalogUnavailable: catalog.unavailable }),
      };
    },
  };
}
