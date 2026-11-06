/**
 * The runtime's model catalog as the picker and the `workbench.models` tool
 * see it (BIT-817): the active catalog with the built-in local rows overlaid,
 * or, when the catalog cannot be loaded, the built-in local rows alone and a
 * summarized reason. `models/list` and the tool read the catalog through this
 * one loader; the tool prints at most its first 200 rows.
 */

import { summarizeError } from "../contract/mod.ts";
import {
  defaultLocalWorkbenchModels,
  getModelAccessModality,
  isLocalWorkbenchModel,
  loadWorkbenchModelsWithLocalDefaults,
  modelHasCatalogPricing,
  type WorkbenchModel,
} from "../providers/mod.ts";
import type { ModelReader } from "../store/mod.ts";
import {
  type CatalogListing,
  type CatalogModelRow,
  MAX_LISTED_MODELS,
} from "../tools/mod.ts";

export interface ModelCatalog {
  models: WorkbenchModel[];
  /** Present only when `models` are the fallback rows: why the catalog failed. */
  unavailable?: string;
}

/**
 * Load the catalog. Never throws: a failure, including one resolving the
 * reader, returns the built-in local rows with the summarized reason.
 */
export async function loadModelCatalog(
  models: () => ModelReader,
): Promise<ModelCatalog> {
  try {
    return { models: await loadWorkbenchModelsWithLocalDefaults(models()) };
  } catch (error) {
    return {
      models: defaultLocalWorkbenchModels(),
      unavailable: summarizeError(error),
    };
  }
}

/** One catalog row reduced to the fields the tool may show. */
export function catalogModelRow(model: WorkbenchModel): CatalogModelRow {
  return {
    slug: model.slug,
    displayName: model.displayName,
    provider: model.provider,
    tier: model.tier,
    costInput: model.costInput,
    costOutput: model.costOutput,
    routable: modelHasCatalogPricing(model),
    local: isLocalWorkbenchModel(model),
    modality: getModelAccessModality(model),
  };
}

/**
 * The catalog as `workbench.models` receives it: the rows it prints and the
 * catalog's row count, without the failure reason.
 */
export function catalogListing(catalog: ModelCatalog): CatalogListing {
  return {
    models: catalog.models.slice(0, MAX_LISTED_MODELS).map(catalogModelRow),
    total: catalog.models.length,
    ...(catalog.unavailable === undefined ? {} : { fallback: true }),
  };
}
