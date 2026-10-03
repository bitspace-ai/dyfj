/**
 * Model selection: explicit model, explicit tier, configured default, and the
 * locality-bounded ambient and hint routes.
 */
import type {
  WorkbenchModel,
  WorkbenchRoutingOptions,
  WorkbenchSelection,
} from "../types.ts";
import {
  WorkbenchModelFastSpeedUnsupportedError,
  WorkbenchModelNotFoundError,
  WorkbenchModelNotRoutableError,
} from "../errors.ts";
import { isAllowedLocalProviderBaseUrl } from "../shared/base-url.ts";
import { openAICompatibleLocalProviders } from "../openai-compatible/providers.ts";
import { modelHasCatalogPricing } from "./catalog.ts";

export function modelSupportsFastSpeed(model: WorkbenchModel): boolean {
  return model.capabilities?.includes("fast-speed") ?? false;
}

export function selectWorkbenchModel(
  models: WorkbenchModel[],
  options: WorkbenchRoutingOptions,
  defaultModelId?: string | null,
): WorkbenchSelection {
  const finalize = (
    selected: WorkbenchModel,
    considered: string[],
    reason: string,
  ): WorkbenchSelection => {
    if (options.fast === true && !modelSupportsFastSpeed(selected)) {
      throw new WorkbenchModelFastSpeedUnsupportedError(selected.slug);
    }
    return { selected, considered, reason };
  };
  if (options.modelId !== undefined) {
    const selected = models.find((model) => model.slug === options.modelId);
    if (!selected) throw new WorkbenchModelNotFoundError(options.modelId);
    if (!modelHasCatalogPricing(selected)) {
      throw new WorkbenchModelNotRoutableError(selected.slug);
    }
    return finalize(selected, [], "explicit_model_id");
  }

  if (options.tier !== undefined) {
    const tierModels = models.filter((model) => model.tier === options.tier);
    // Tier 0 is the LOCAL tier: even when named explicitly, its candidates
    // must be genuinely local (on-machine provider over loopback). Tier-0
    // selection is exempt from the paid-consent preflight, so a mis-tiered
    // hosted row here would run hosted inference without consent. Hosted
    // tiers (1/2) stay tier-based and consent-gated as before.
    const candidates = options.tier === 0
      ? tierModels.filter(isLocalWorkbenchModel)
      : tierModels;
    const routable = candidates.filter(modelHasCatalogPricing);
    const selected = preferredModelFrom(routable);
    if (!selected) {
      // Distinguish "no eligible models at this tier" from "candidates exist
      // but none are priced" — the second needs a catalog fix, not a
      // different request. Tier-0 rows excluded for locality are treated as
      // not found, never silently routed.
      if (candidates.length > 0) {
        throw new WorkbenchModelNotRoutableError(
          `tier:${options.tier} — all candidates unpriced: ${
            candidates.map((model) => model.slug).join(", ")
          }`,
        );
      }
      throw new WorkbenchModelNotFoundError(`tier:${options.tier}`);
    }
    return finalize(
      selected,
      routable.map((model) => model.slug),
      "explicit_tier",
    );
  }

  // No explicit modelId or tier. If the request also gave no hint and the engine
  // has a configured default companion model (config ~/.dyfj/config.toml /
  // DYFJ_WORKBENCH_MODEL), use it when it exists in the catalog and carries
  // valid pricing. When defaultModelId is absent, null, or empty, bare turns
  // fall through to the registry's default local tier-0 companion.
  if (
    options.hint === undefined &&
    defaultModelId !== undefined &&
    defaultModelId !== null &&
    defaultModelId !== ""
  ) {
    const configured = models.find((model) => model.slug === defaultModelId);
    if (!configured) throw new WorkbenchModelNotFoundError(defaultModelId);
    if (!modelHasCatalogPricing(configured)) {
      throw new WorkbenchModelNotRoutableError(configured.slug);
    }
    return finalize(configured, [], "default_config");
  }

  // Ambient candidates — the bare default AND the hint paths below — must be
  // genuinely local: tier 0 AND an on-machine provider over loopback (the same
  // test the compression call uses). Tier alone is catalog metadata: a
  // mis-tiered hosted row must never ride ambient routing, because tier-0
  // selection is exempt from the paid-consent preflight and the ambient
  // posture promises these turns stay on-machine. A hint names a capability,
  // not a model — it is not a hosted escalation, so it gets the same locality
  // bound as the bare default. Only explicit tier routing above stays
  // tier-based: the operator named the tier, and those selections still pass
  // the pricing/consent gates.
  const localModels = models.filter(
    (model) => model.tier === 0 && isLocalWorkbenchModel(model),
  );
  const considered = localModels.map((model) => model.slug);

  if (options.hint === "code") {
    const selected = localModels.find((model) =>
      model.capabilities.includes("code")
    ) ??
      localModels.find((model) => model.slug === "gemma4:e2b") ??
      localModels.find((model) => model.slug === "gemma4") ??
      localModels[0];
    if (!selected) throw new WorkbenchModelNotFoundError("tier:0");
    return finalize(
      selected,
      considered,
      selected.capabilities.includes("code")
        ? "hint_code"
        : "hint_code_fallback_local",
    );
  }

  const selected = preferredModelFrom(localModels);
  if (!selected) throw new WorkbenchModelNotFoundError("tier:0");
  return finalize(selected, considered, "default");
}

// One preference chain for any "pick from this set" selection, so explicit
// tier requests honor the same local ordering (Qwen 3.6 MoE on llama.cpp, then
// on Ollama) as the default route instead of falling back to list order.
function preferredModelFrom(
  candidates: WorkbenchModel[],
): WorkbenchModel | undefined {
  return candidates.find((model) =>
    model.slug === "llama-cpp/qwen3.6-35b-a3b"
  ) ??
    candidates.find((model) => model.slug === "qwen3.6:35b-a3b") ??
    candidates.find((model) => model.slug === "muse-glimmer:30b") ??
    candidates.find((model) =>
      model.slug === "mistral-small:24b-instruct-2501-q4_K_M"
    ) ??
    candidates.find((model) => model.slug === "deepseek-r1:32b") ??
    candidates.find((model) => model.slug === "laguna-xs-2.1") ??
    candidates.find((model) => model.slug === "gemma4:26b") ??
    candidates.find((model) => model.slug === "gemma4:e2b") ??
    candidates[0];
}

/**
 * Whether a model runs ON-MACHINE: a local OpenAI-compatible provider reached
 * over a loopback base URL. Tier is only metadata and does not guarantee the
 * request stays local (a tier-0 row could name a hosted provider), so locality
 * is decided here rather than by pricing.
 *
 * What this bounds, precisely: the compression CALL routes only to a model that
 * satisfies this, so GENERATING a summary is never a hosted request and never
 * paid inference. It does NOT bound where the summary then goes — that re-enters
 * the conversation and is sent to the ACTIVE session model like the turns it
 * replaced, which may be hosted. Ordinarily that discloses nothing new, since
 * those verbatim turns already went to that same model. Two honest caveats: the
 * summary is pinned past the recent-turns cap, so its gist outlives the turns it
 * replaced; and a mid-session model switch can carry that gist to a provider
 * which never saw the originals.
 */
export function isLocalWorkbenchModel(model: WorkbenchModel): boolean {
  return openAICompatibleLocalProviders.has(model.provider) &&
    isAllowedLocalProviderBaseUrl(model.baseUrl);
}
