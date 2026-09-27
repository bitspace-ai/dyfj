/**
 * The model catalog: parsing store rows into `WorkbenchModel`s, the pricing
 * rule that decides whether a model is routable, and access-modality
 * classification.
 */
import type { ModelAccessModality, WorkbenchModel } from "../types.ts";
import {
  isAllowedHostedProviderBaseUrl,
  isAllowedLocalProviderBaseUrl,
} from "../shared/base-url.ts";
import { openAICompatibleLocalProviders } from "../openai-compatible/providers.ts";

export const acpSubscriptionProviders: ReadonlySet<string> = new Set([
  "codex-chatgpt",
  "claude-acp",
  "grok-build",
  "cursor-agent",
  "gemini-antigravity",
]);

export function parseModelRegistryRows(
  rows: Record<string, string>[],
): WorkbenchModel[] {
  return rows.map((row) => {
    const tier = Number(row.tier);
    if (tier !== 0 && tier !== 1 && tier !== 2) {
      throw new Error(`Invalid model tier for ${row.slug}: ${row.tier}`);
    }

    const provider = row.provider;
    const baseUrl = row.base_url ?? "";

    return {
      slug: row.slug,
      displayName: row.display_name,
      provider,
      api: row.api,
      baseUrl,
      tier,
      costInput: toCatalogCost(row.cost_input),
      costOutput: toCatalogCost(row.cost_output),
      capabilities: parseCapabilities(row.capabilities),
      contextWindow: toCatalogLimit(row.context_window),
      maxOutputTokens: toCatalogLimit(row.max_output_tokens),
      modality: getModelAccessModality({ provider, baseUrl }),
      architecture: toCatalogArchitecture(row.architecture),
      totalParamsB: toCatalogDecimal(row.total_params_b),
      activeParamsB: toCatalogDecimal(row.active_params_b),
      recommendedQuant: toCatalogString(row.recommended_quant),
      residentRamGiB: toCatalogDecimal(row.resident_ram_gib),
      reasoningEffortControl: toCatalogBoolean(row.reasoning_effort_control),
    };
  });
}

function toCatalogString(
  value: string | undefined | null,
): string | undefined {
  if (!value) return undefined;
  const trimmed = String(value).trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toCatalogBoolean(
  value: string | boolean | number | undefined | null,
): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) && value !== 0;
  const trimmed = String(value).trim().toLowerCase();
  if (trimmed === "true" || trimmed === "t") return true;
  if (trimmed === "false" || trimmed === "f") return false;
  const num = Number(trimmed);
  return Number.isFinite(num) && num !== 0;
}

function toCatalogArchitecture(
  value: string | undefined | null,
): "dense" | "moe" | undefined {
  if (!value) return undefined;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "dense" || normalized === "moe") return normalized;
  return undefined;
}

function toCatalogDecimal(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : undefined;
}

/**
 * A catalog token limit is a positive integer or unknown. Zero/absent/garbage
 * — and fractional values like "0.5", which would otherwise floor to a
 * defined zero-token limit — all load as undefined, so nothing downstream
 * mistakes "nobody filled the column in" for a real (and absurdly small) limit.
 */
function toCatalogLimit(value: string | undefined): number | undefined {
  const limit = Number(value || "0");
  return Number.isSafeInteger(limit) && limit > 0 ? limit : undefined;
}

/**
 * A malformed catalog cost must land in the unpriced bucket (0), never as NaN:
 * NaN fails every budget comparison open — estimates, envelopes, and the
 * anomaly gate would all silently pass.
 */
function toCatalogCost(value: string | undefined): number {
  const cost = Number(value || "0");
  return Number.isFinite(cost) && cost >= 0 ? cost : 0;
}

/**
 * Whether a model carries the catalog pricing the cost posture requires to
 * route it. Tier 0 is free by declaration — zero IS its price. For a paid
 * tier, zero/absent cost means nobody priced the row (the schema default),
 * and an unpriced paid model is invisible to every spend control: estimates,
 * recorded actuals, the envelopes, and the anomaly hard stop all derive from
 * these numbers.
 */
export function modelHasCatalogPricing(model: WorkbenchModel): boolean {
  if (model.tier === 0 || model.modality === "subscription-oauth") return true;
  return model.costInput > 0 && model.costOutput > 0;
}

function parseCapabilities(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    // Dolt may return JSON arrays as an unquoted comma-separated display value.
  }
  return value
    .split(",")
    .map((item) => item.trim().replace(/^"|"$/g, ""))
    .filter((item) => item.length > 0);
}

/**
 * The active catalog, parsed. `models` is the store's model reader (declared
 * structurally: providers/ sits beside store/ and does not import it).
 */
export async function loadWorkbenchModels(
  models: { listActive(): Promise<Record<string, string>[]> },
): Promise<WorkbenchModel[]> {
  return parseModelRegistryRows(await models.listActive());
}

/**
 * Classify a model's access modality from its provider identifier and base URL.
 *
 * Modality categories:
 *  - "local": configured via Ollama or MLX-LM over an allowed loopback URL.
 *  - "frontier-hosted": canonical HTTPS direct vendor endpoints for Anthropic, OpenAI, or Google.
 *  - "aggregator-hosted": canonical HTTPS OpenRouter gateway endpoints.
 *  - "subscription-oauth": configured ACP runner adapters (codex-chatgpt, claude-acp, grok-build, cursor-agent, gemini-antigravity) with local, "acp", or empty base URLs.
 *  - "custom-hosted": other, proxy, or non-canonical provider endpoints.
 */
export function getModelAccessModality(model: {
  provider: string;
  baseUrl: string;
}): ModelAccessModality {
  if (
    openAICompatibleLocalProviders.has(model.provider) &&
    isAllowedLocalProviderBaseUrl(model.baseUrl)
  ) {
    return "local";
  }
  if (
    model.provider === "openrouter" &&
    isAllowedHostedProviderBaseUrl(model.baseUrl, "openrouter.ai", ["/api/v1"])
  ) {
    return "aggregator-hosted";
  }
  if (
    (model.provider === "anthropic" &&
      isAllowedHostedProviderBaseUrl(model.baseUrl, "api.anthropic.com", [
        "",
        "/",
      ])) ||
    (model.provider === "openai" &&
      isAllowedHostedProviderBaseUrl(model.baseUrl, "api.openai.com", [
        "/v1",
      ])) ||
    (model.provider === "xai" &&
      isAllowedHostedProviderBaseUrl(model.baseUrl, "api.x.ai", [
        "",
        "/",
        "/v1",
      ])) ||
    (model.provider === "google" &&
      isAllowedHostedProviderBaseUrl(
        model.baseUrl,
        "generativelanguage.googleapis.com",
        ["", "/"],
      ))
  ) {
    return "frontier-hosted";
  }
  if (
    acpSubscriptionProviders.has(model.provider) &&
    (model.baseUrl === "" ||
      model.baseUrl === "acp" ||
      isAllowedLocalProviderBaseUrl(model.baseUrl))
  ) {
    return "subscription-oauth";
  }
  return "custom-hosted";
}
