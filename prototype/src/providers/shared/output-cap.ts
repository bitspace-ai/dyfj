/**
 * The output-token cap a request carries.
 */
import type { WorkbenchModel } from "../types.ts";

/**
 * A caller's requested cap, else the adapter's default ceiling, each bounded
 * by the catalog `maxOutputTokens`; with neither, the catalog limit (which may
 * be unknown).
 */
export function outputCap(
  model: WorkbenchModel,
  requestedOutputTokens: number | undefined,
  defaultOutputTokens: number | undefined,
): number | undefined {
  const catalog = model.maxOutputTokens;
  if (requestedOutputTokens !== undefined) {
    return Math.min(catalog ?? Infinity, requestedOutputTokens);
  }
  if (defaultOutputTokens !== undefined) {
    return Math.min(catalog ?? Infinity, defaultOutputTokens);
  }
  return catalog;
}
