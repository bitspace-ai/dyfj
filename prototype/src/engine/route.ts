/**
 * Route resolution: which model a turn runs on, whether that route needs paid
 * consent first, and which runner executes it (specs/01-architecture.md §5.1,
 * the `resolveRoute` stage). Native and external-agent (ACP) turns resolve
 * through this one module, so the paid-escalation preflight has a single
 * implementation.
 *
 * - `resolveRoute` chooses the runner before a turn starts: an explicit ACP
 *   runner, a catalog model whose API is ACP, or the native engine. An ACP
 *   route is fully resolved here, workspace trust and paid preflight included.
 * - `selectModelRoute` is the native turn's model selection. It runs inside
 *   the native turn, after the session and context are in place, because its
 *   failures are reported on that turn's receipt.
 * - `confirmPaidRoute` is the paid-escalation preflight both paths share: a
 *   banner for any tier above 0, then the consent handler's verdict.
 */
import {
  type AcpRunnerSelection,
  DomainError,
  type PaidEscalationVerdict,
  summarizeError,
  type WorkbenchRuntimeMode,
} from "../contract/mod.ts";
import {
  defaultLocalWorkbenchModels,
  loadWorkbenchModels,
  loadWorkbenchModelsWithLocalDefaults,
  selectWorkbenchModel,
  type WorkbenchModel,
  WorkbenchModelNotFoundError,
  WorkbenchModelNotRoutableError,
  type WorkbenchRoutingOptions,
  type WorkbenchSelection,
} from "../providers/mod.ts";
import { PaidEscalationDeclinedError } from "./errors.ts";

/** The catalog reader route resolution loads models through. */
export interface RouteModelReader {
  listActive(): Promise<Record<string, string>[]>;
  listInactiveSlugs(): Promise<string[]>;
}

export type ConfirmPaidEscalation = (
  banner: string,
) => Promise<PaidEscalationVerdict>;

export interface PaidEscalationPreflightInput {
  modelName: string;
  modelSlug: string;
  tier: 0 | 1 | 2;
  routingReason: string;
  estimatedCostUsd: number;
  sessionCostSoFarUsd: number;
  sessionLimitUsd: number;
  perCallLimitUsd: number;
}

export function formatMoney(value: number): string {
  return `$${value.toFixed(6)}`;
}

export function buildPaidEscalationPreflightBanner(
  input: PaidEscalationPreflightInput,
): string {
  const sessionHeadroom = Math.max(
    0,
    input.sessionLimitUsd - input.sessionCostSoFarUsd,
  );
  return [
    "Paid inference preflight",
    `Model:           ${input.modelName} (${input.modelSlug})`,
    `Tier:            ${input.tier}`,
    `Route:           ${input.routingReason}`,
    `Estimated cost:  ${formatMoney(input.estimatedCostUsd)}`,
    `Session spent:   ${formatMoney(input.sessionCostSoFarUsd)} / ${
      formatMoney(input.sessionLimitUsd)
    }`,
    `Session headroom: ${formatMoney(sessionHeadroom)}`,
    `Per-call limit:  ${formatMoney(input.perCallLimitUsd)}`,
  ].join("\n");
}

export function maybeBuildPaidEscalationPreflightBanner(
  input: PaidEscalationPreflightInput,
): string | null {
  if (input.tier === 0) return null;
  return buildPaidEscalationPreflightBanner(input);
}

/**
 * Default consent handler: deny. The core makes no TTY assumption —
 * drivers inject their own. A headless Workshop driver pre-approves or escalates
 * to an out-of-band operator.
 */
function denyPaidEscalation(): Promise<PaidEscalationVerdict> {
  return Promise.resolve({
    decision: "deny",
    reason: "no consent handler configured",
  });
}

/**
 * The paid-escalation preflight. A tier-0 route passes without a prompt; any
 * other tier shows the banner to the consent handler (deny when none is
 * configured) and throws `PaidEscalationDeclinedError` unless it approves.
 */
export async function confirmPaidRoute(
  input: PaidEscalationPreflightInput,
  confirm: ConfirmPaidEscalation | undefined,
): Promise<void> {
  const preflightBanner = maybeBuildPaidEscalationPreflightBanner(input);
  if (preflightBanner === null) return;
  const verdict = await (confirm ?? denyPaidEscalation)(preflightBanner);
  if (verdict.decision !== "approve") {
    throw new PaidEscalationDeclinedError(verdict);
  }
}

export function isNextWorkMode(mode: WorkbenchRuntimeMode): boolean {
  return mode === "next-work";
}

export function routeReasonForMode(
  reason: string,
  tier: 0 | 1 | 2,
  isNextWork: boolean,
): string {
  if (isNextWork && tier === 0 && reason === "default") {
    return "default_local_next_work";
  }
  return reason;
}

/** The route-relevant fields of a turn request. */
export interface RouteRequest {
  routingOptions: WorkbenchRoutingOptions;
  runner?: AcpRunnerSelection;
  defaultCompanionModel?: string | null;
  trustWorkspaceInstructions?: boolean;
  defaultSessionBudgetUsd?: number;
  defaultPerCallBudgetUsd?: number;
  approver?: { confirmPaidEscalation?: ConfirmPaidEscalation };
}

/**
 * Where a turn runs. An ACP route carries the runner profile and the routing
 * options the runner receives; a native route is resolved further inside the
 * native turn (`selectModelRoute`).
 */
export type ResolvedRoute =
  | { runner: "native" }
  | {
    runner: "acp";
    selection: AcpRunnerSelection;
    routingOptions: WorkbenchRoutingOptions;
  };

/** The model an ACP route bills against, for its paid preflight. */
interface AcpRouteModel {
  displayName: string;
  slug: string;
  tier: 0 | 1 | 2;
  routingReason: string;
}

/** The fixed descriptor an explicit Codex ChatGPT runner request bills as. */
const EXPLICIT_CODEX_CHATGPT_ROUTE: AcpRouteModel = {
  displayName: "GPT-5.6 Terra (Codex)",
  slug: "codex-chatgpt/gpt-5.6-terra",
  tier: 2,
  routingReason: "explicit_runner",
};

/**
 * The ACP route a catalog selection names, or null for a native model. The
 * catalog is loaded with the static local defaults as a fallback, and only
 * domain and routing errors propagate: any other failure (a registry load
 * error included) leaves the turn on the native route, which loads the
 * catalog again and reports its own failure.
 */
async function selectedAcpRoute(
  request: RouteRequest,
  models: RouteModelReader,
): Promise<
  {
    selection: AcpRunnerSelection;
    model: AcpRouteModel;
    routingOptions: WorkbenchRoutingOptions;
  } | null
> {
  try {
    const catalog = await loadWorkbenchModelsWithLocalDefaults(models).catch(
      () => defaultLocalWorkbenchModels(),
    );
    const selection = selectWorkbenchModel(
      catalog,
      request.routingOptions ?? {},
      request.defaultCompanionModel,
    );
    if (selection.selected.api !== "acp") return null;
    let profile: AcpRunnerSelection["profile"];
    if (selection.selected.provider === "codex-chatgpt") {
      profile = "codex-chatgpt";
    } else if (selection.selected.slug === "fixture") {
      profile = "fixture";
    } else {
      throw new DomainError(
        `Unsupported ACP runner: ${selection.selected.provider}`,
      );
    }
    return {
      selection: { kind: "acp", profile },
      model: {
        displayName: selection.selected.displayName,
        slug: selection.selected.slug,
        tier: selection.selected.tier,
        routingReason: selection.reason ?? "explicit_model_id",
      },
      routingOptions: {
        ...request.routingOptions,
        modelId: selection.selected.slug,
      },
    };
  } catch (error) {
    if (
      error instanceof DomainError ||
      error instanceof WorkbenchModelNotFoundError ||
      error instanceof WorkbenchModelNotRoutableError
    ) {
      throw error;
    }
    return null;
  }
}

/**
 * Choose the runner for a turn. An ACP route is checked for workspace trust
 * (Codex ChatGPT requires it) and passed through the paid preflight before it
 * is returned; the preflight has no spend to show yet, so it reports $0
 * against the default session and per-call limits.
 */
export async function resolveRoute(
  request: RouteRequest,
  models: RouteModelReader,
): Promise<ResolvedRoute> {
  let route: {
    selection: AcpRunnerSelection;
    model: AcpRouteModel | null;
    routingOptions: WorkbenchRoutingOptions;
  } | null;
  if (request.runner?.kind === "acp") {
    route = {
      selection: request.runner,
      model: request.runner.profile === "codex-chatgpt"
        ? EXPLICIT_CODEX_CHATGPT_ROUTE
        : null,
      routingOptions: request.routingOptions,
    };
  } else {
    route = await selectedAcpRoute(request, models);
  }
  if (route === null) return { runner: "native" };

  if (
    route.selection.profile === "codex-chatgpt" &&
    request.trustWorkspaceInstructions !== true
  ) {
    throw new DomainError(
      "codex-chatgpt requires explicit workspace trust",
    );
  }
  if (route.model !== null) {
    await confirmPaidRoute({
      modelName: route.model.displayName,
      modelSlug: route.model.slug,
      tier: route.model.tier,
      routingReason: route.model.routingReason,
      estimatedCostUsd: 0,
      sessionCostSoFarUsd: 0,
      sessionLimitUsd: request.defaultSessionBudgetUsd ?? 0,
      perCallLimitUsd: request.defaultPerCallBudgetUsd ?? 0,
    }, request.approver?.confirmPaidEscalation);
  }
  return {
    runner: "acp",
    selection: route.selection,
    routingOptions: route.routingOptions,
  };
}

/** A native turn's model route. */
export interface ModelRoute {
  /** The catalog the selection was made over; later calls route within it. */
  models: WorkbenchModel[];
  selection: WorkbenchSelection;
  /** The selection reason as the receipt and events report it. */
  routingReason: string;
}

/**
 * Select the model for a native turn. Ask and next-work turns fall back to the
 * static local tier-0 default when the catalog cannot be loaded (with a
 * console warning); a companion turn fails instead.
 */
export async function selectModelRoute(
  models: RouteModelReader,
  request: {
    mode: WorkbenchRuntimeMode;
    routingOptions: WorkbenchRoutingOptions;
    defaultCompanionModel?: string | null;
  },
): Promise<ModelRoute> {
  const isNextWork = isNextWorkMode(request.mode);
  const usesRepoAskContext = request.mode === "ask" || isNextWork;
  let catalog: WorkbenchModel[];
  try {
    catalog = usesRepoAskContext
      ? await loadWorkbenchModelsWithLocalDefaults(models)
      : await loadWorkbenchModels(models);
  } catch (err) {
    if (!usesRepoAskContext) throw err;
    // Provenance-summarized, never raw: a registry failure is typically a
    // driver error, and driver messages can embed registry data or
    // rejected values.
    console.warn(
      `Model registry unavailable; using static local Tier 0 default: ${
        summarizeError(err)
      }`,
    );
    catalog = defaultLocalWorkbenchModels();
  }
  const selection = selectWorkbenchModel(
    catalog,
    request.routingOptions,
    request.defaultCompanionModel,
  );
  return {
    models: catalog,
    selection,
    routingReason: routeReasonForMode(
      selection.reason,
      selection.selected.tier,
      isNextWork,
    ),
  };
}
