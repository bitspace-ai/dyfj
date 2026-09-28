// The `runtime` namespace: liveness, the runtime posture (`runtime/status`,
// which also carries the method catalog), and `runtime/stop`. The method
// catalog lives here because `runtime/status` is where clients read it; its
// order is the wire order of `methods` and `methodCatalog`.

import {
  isLocalWorkbenchModel,
  selectWorkbenchModel,
  type WorkbenchModel,
} from "../../providers/mod.ts";
import {
  AGENT_DEFAULTS,
  type PermissionLevel,
  type WorkbenchConfig,
} from "../../config/mod.ts";
import { summarizeError } from "../../contract/mod.ts";
import {
  RpcError,
  RpcErrorCode,
  type RpcHandlers,
} from "../../transport/mod.ts";

export type WorkbenchMethodKind = "read" | "interactive";

export interface WorkbenchMethodSummary {
  id: string;
  namespace: string;
  kind: WorkbenchMethodKind;
}

/**
 * What a bare turn (no model/tier/hint) would route to right now — the same
 * selection the turn path runs, resolved server-side so an engine-free client
 * can render an honest posture line without reimplementing routing.
 */
export interface WorkbenchDefaultTurnModel {
  slug: string;
  displayName: string;
  tier: 0 | 1 | 2;
  local: boolean;
  reason: string;
}

export interface WorkbenchRuntimeStatus {
  transport: "uds";
  clearance: "loopback";
  methods: string[];
  methodCatalog: WorkbenchMethodSummary[];
  defaultCompanionModel: string | null;
  /** Resolved bare-turn route; null when no model is currently routable. */
  defaultTurnModel: WorkbenchDefaultTurnModel | null;
  permissionLevel: PermissionLevel;
  approvePaidDefault: boolean;
  trustWorkspaceInstructions: boolean;
  defaultSessionBudgetUsd: number;
  defaultPerCallBudgetUsd: number;
  defaultDailyBudgetUsd: number;
  maxToolSteps: number;
  models: { total: number; local: number; hosted: number };
  autostarted?: boolean;
}

/** The engine posture `runtime/status` reports. */
export interface RuntimePosture {
  /** Loaded engine config; its fields win over the loose fallbacks below. */
  engineConfig?: Pick<
    WorkbenchConfig,
    | "defaultCompanionModel"
    | "permissionLevel"
    | "approvePaidDefault"
    | "trustWorkspaceInstructions"
    | "defaultSessionBudgetUsd"
    | "defaultPerCallBudgetUsd"
    | "defaultDailyBudgetUsd"
    | "maxToolSteps"
  >;
  defaultCompanionModel?: string | null;
  permissionLevel?: PermissionLevel;
  /** Whether the runtime was started via background autostart. */
  autostarted?: boolean;
}

export interface RuntimeHandlerDeps extends RuntimePosture {
  loadModels: () => Promise<WorkbenchModel[]>;
  /** Invoked by `runtime/stop`; absent means shutdown is not configured. */
  onShutdown?: () => Promise<void> | void;
}

export const METHOD_CATALOG = [
  { id: "runtime/liveness", namespace: "runtime", kind: "read" },
  { id: "runtime/status", namespace: "runtime", kind: "read" },
  { id: "runtime/stop", namespace: "runtime", kind: "interactive" },
  { id: "surface/snapshot", namespace: "surface", kind: "read" },
  { id: "models/list", namespace: "models", kind: "read" },
  { id: "sessions/list", namespace: "sessions", kind: "read" },
  { id: "sessions/inspect", namespace: "sessions", kind: "read" },
  { id: "events/query", namespace: "events", kind: "read" },
  { id: "friction/post", namespace: "friction", kind: "interactive" },
  { id: "ideas/mark", namespace: "ideas", kind: "interactive" },
  { id: "ideas/list", namespace: "ideas", kind: "read" },
  { id: "ideas/get", namespace: "ideas", kind: "read" },
  { id: "packets/draft", namespace: "packets", kind: "interactive" },
  { id: "packets/list", namespace: "packets", kind: "read" },
  { id: "packets/get", namespace: "packets", kind: "read" },
  { id: "tools/list", namespace: "tools", kind: "read" },
  { id: "tools/inspect", namespace: "tools", kind: "read" },
  { id: "turn", namespace: "turn", kind: "interactive" },
  { id: "turn/cancel", namespace: "turn", kind: "interactive" },
] as const satisfies readonly WorkbenchMethodSummary[];

const METHOD_IDS = METHOD_CATALOG.map((method) => method.id);

function resolveDefaultTurnModel(
  models: WorkbenchModel[],
  defaultCompanionModel: string | null,
): WorkbenchDefaultTurnModel | null {
  try {
    const { selected, reason } = selectWorkbenchModel(
      models,
      {},
      defaultCompanionModel,
    );
    return {
      slug: selected.slug,
      displayName: selected.displayName,
      tier: selected.tier,
      local: isLocalWorkbenchModel(selected),
      reason,
    };
  } catch {
    try {
      const { selected, reason } = selectWorkbenchModel(models, {}, null);
      return {
        slug: selected.slug,
        displayName: selected.displayName,
        tier: selected.tier,
        local: isLocalWorkbenchModel(selected),
        reason,
      };
    } catch {
      // No routable bare-turn model (empty registry) — status must still answer.
      return null;
    }
  }
}

export function runtimeStatus(
  options: RuntimePosture,
  models: WorkbenchModel[],
): WorkbenchRuntimeStatus {
  const defaultCompanionModel = options.engineConfig?.defaultCompanionModel ??
    options.defaultCompanionModel ??
    null;
  return {
    transport: "uds",
    clearance: "loopback",
    methods: [...METHOD_IDS],
    methodCatalog: METHOD_CATALOG.map((method) => ({ ...method })),
    defaultCompanionModel,
    defaultTurnModel: resolveDefaultTurnModel(models, defaultCompanionModel),
    permissionLevel: options.engineConfig?.permissionLevel ??
      options.permissionLevel ??
      "strict",
    approvePaidDefault: options.engineConfig?.approvePaidDefault ?? false,
    trustWorkspaceInstructions:
      options.engineConfig?.trustWorkspaceInstructions ?? false,
    defaultSessionBudgetUsd: options.engineConfig?.defaultSessionBudgetUsd ?? 1,
    defaultPerCallBudgetUsd: options.engineConfig?.defaultPerCallBudgetUsd ??
      0.1,
    defaultDailyBudgetUsd: options.engineConfig?.defaultDailyBudgetUsd ?? 25,
    maxToolSteps: options.engineConfig?.maxToolSteps ??
      AGENT_DEFAULTS.maxToolSteps,
    // Locality counts use the same provider+loopback classification as
    // `models/list[].local` and the bare-turn route — never the tier label,
    // which is catalog metadata a mis-tiered row can get wrong.
    models: {
      total: models.length,
      local: models.filter(isLocalWorkbenchModel).length,
      hosted: models.filter((model) => !isLocalWorkbenchModel(model)).length,
    },
    ...(options.autostarted !== undefined
      ? { autostarted: options.autostarted }
      : {}),
  };
}

export function buildRuntimeHandlers(deps: RuntimeHandlerDeps): RpcHandlers {
  return {
    "runtime/liveness": () => {
      return {
        status: "ok",
        transport: "uds",
        clearance: "loopback",
      };
    },

    "runtime/status": async () => {
      const models = await deps.loadModels();
      return { runtime: runtimeStatus(deps, models) };
    },

    "runtime/stop": async () => {
      if (!deps.onShutdown) {
        throw new RpcError(
          RpcErrorCode.internalError,
          "runtime shutdown is not configured on this server",
        );
      }
      try {
        await deps.onShutdown();
      } catch (error) {
        throw new RpcError(
          RpcErrorCode.internalError,
          `runtime shutdown failed: ${summarizeError(error)}`,
        );
      }
      return {
        status: "stopping",
      };
    },
  };
}
