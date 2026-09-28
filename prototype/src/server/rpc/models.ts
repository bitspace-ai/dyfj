// The `models` namespace: the model catalog with the fields clients annotate
// rows from. `routable`, `local`, and `modality` are computed server-side
// (single sources: modelHasCatalogPricing, isLocalWorkbenchModel,
// getModelAccessModality) so clients can annotate rows without duplicating
// pricing, locality, or taxonomy rules.

import {
  getModelAccessModality,
  isLocalWorkbenchModel,
  modelHasCatalogPricing,
  type WorkbenchModel,
} from "../../providers/mod.ts";
import type { RpcHandlers } from "../../transport/mod.ts";

export interface ModelsHandlerDeps {
  loadModels: () => Promise<WorkbenchModel[]>;
}

export function buildModelsHandlers(deps: ModelsHandlerDeps): RpcHandlers {
  return {
    "models/list": async () => ({
      models: (await deps.loadModels()).map((model) => ({
        ...model,
        routable: modelHasCatalogPricing(model),
        local: isLocalWorkbenchModel(model),
        modality: getModelAccessModality(model),
      })),
    }),
  };
}
