// Serve the workbench JSON-RPC seam over a Unix domain socket. UDS is
// the canonical `loopback` transport — full clearance, gated by filesystem perms
// — per the transport-seam contract. Wires the read-only methods plus `turn`,
// which runs an agentic turn over the shared turn-runner core and streams text
// deltas + runtime events back as `stream` notifications. The server-initiated
// `approval` request (mutating tools) lands with the mutating-tools slice.

import {
  defaultLocalWorkbenchModels,
  loadWorkbenchModels,
  modelHasCatalogPricing,
  withDefaultLocalWorkbenchModels,
  type WorkbenchModel,
} from "./provider";
import {
  fetchWorkbenchSessionEvents,
  isValidAsOfTimestamp,
  listWorkbenchSessions,
  type WorkbenchProjectSessions,
  type WorkbenchSessionEvent,
} from "./sessions";
import { RpcError, RpcErrorCode, type RpcHandlers } from "./jsonrpc";
import { JsonRpcPeer } from "./jsonrpc-peer";
import { runWorkbenchRuntime, type WorkbenchAuthContext } from "./workbench";
import type { PermissionLevel, WorkbenchConfig } from "./config";
import {
  budgetCeilingApprovalRequest,
  type BudgetCeilingVerdict,
  runawayAnomalyApprovalRequest,
} from "./budget";
import type { TurnStreamFrame } from "./turn-contract";
import {
  engineConfigToTurnDeps,
  executeTurn,
  resolveTurnFromBody,
  type TurnRequestBody,
  type WorkbenchHttpRuntime,
} from "./turn-runner";
import {
  type CommandDefinition,
  createCommandRegistry,
  registerCoreCommands,
  type ToolApprovalVerdict,
} from "./commands";

export interface WorkbenchToolSummary {
  id: string;
  title: string;
  description: string;
  inputSchema: CommandDefinition["inputSchema"];
  permission: CommandDefinition["permission"];
  redactResult: boolean;
}

export type WorkbenchMethodKind = "read" | "interactive";

export interface WorkbenchMethodSummary {
  id: string;
  namespace: string;
  kind: WorkbenchMethodKind;
}

export interface WorkbenchRuntimeStatus {
  transport: "uds";
  clearance: "loopback";
  methods: string[];
  methodCatalog: WorkbenchMethodSummary[];
  defaultCompanionModel: string | null;
  permissionLevel: PermissionLevel;
  approvePaidDefault: boolean;
  defaultSessionBudgetUsd: number;
  defaultPerCallBudgetUsd: number;
  defaultDailyBudgetUsd: number;
  models: { total: number; local: number; hosted: number };
}

export interface WorkbenchSurfaceSnapshot {
  generatedAt: string;
  runtime: WorkbenchRuntimeStatus;
  models: WorkbenchModel[];
  projects: WorkbenchProjectSessions[];
  tools: WorkbenchToolSummary[];
}

export interface WorkbenchUnixServerOptions {
  runRuntime?: WorkbenchHttpRuntime;
  loadModels?: () => Promise<WorkbenchModel[]>;
  listSessions?: (
    options: { project?: string },
  ) => Promise<WorkbenchProjectSessions[]>;
  fetchSessionEvents?: (
    input: { sessionId: string; asOf?: string },
  ) => Promise<WorkbenchSessionEvent[]>;
  onParseError?: (detail: string) => void;
  /** Engine default companion model (config), applied to bare turns. */
  defaultCompanionModel?: string | null;
  /** Operator permission posture (config); the seam is always loopback. */
  permissionLevel?: PermissionLevel;
  /** Loaded engine config (companion, posture, budget defaults, anomaly multiples). */
  engineConfig?: Pick<
    WorkbenchConfig,
    | "defaultCompanionModel"
    | "permissionLevel"
    | "approvePaidDefault"
    | "defaultSessionBudgetUsd"
    | "defaultPerCallBudgetUsd"
    | "defaultDailyBudgetUsd"
    | "anomalyTurnMultiple"
    | "anomalyScopeMultiple"
  >;
}

// Mirrors http.ts loadPickerModels: degrade to the local defaults if the registry
// is unavailable, preserving the local-first posture instead of an empty list.
async function loadPickerModels(): Promise<WorkbenchModel[]> {
  try {
    return withDefaultLocalWorkbenchModels(await loadWorkbenchModels());
  } catch {
    return defaultLocalWorkbenchModels();
  }
}

function asRecord(params: unknown): Record<string, unknown> {
  return typeof params === "object" && params !== null
    ? params as Record<string, unknown>
    : {};
}

const METHOD_CATALOG = [
  { id: "runtime/status", namespace: "runtime", kind: "read" },
  { id: "surface/snapshot", namespace: "surface", kind: "read" },
  { id: "models/list", namespace: "models", kind: "read" },
  { id: "sessions/list", namespace: "sessions", kind: "read" },
  { id: "events/query", namespace: "events", kind: "read" },
  { id: "tools/list", namespace: "tools", kind: "read" },
  { id: "tools/inspect", namespace: "tools", kind: "read" },
  { id: "turn", namespace: "turn", kind: "interactive" },
] as const satisfies readonly WorkbenchMethodSummary[];

const METHOD_IDS = METHOD_CATALOG.map((method) => method.id);

function runtimeStatus(
  options: WorkbenchUnixServerOptions,
  models: WorkbenchModel[],
): WorkbenchRuntimeStatus {
  return {
    transport: "uds",
    clearance: "loopback",
    methods: [...METHOD_IDS],
    methodCatalog: METHOD_CATALOG.map((method) => ({ ...method })),
    defaultCompanionModel: options.engineConfig?.defaultCompanionModel ??
      options.defaultCompanionModel ??
      null,
    permissionLevel: options.engineConfig?.permissionLevel ??
      options.permissionLevel ??
      "strict",
    approvePaidDefault: options.engineConfig?.approvePaidDefault ?? false,
    defaultSessionBudgetUsd: options.engineConfig?.defaultSessionBudgetUsd ?? 1,
    defaultPerCallBudgetUsd: options.engineConfig?.defaultPerCallBudgetUsd ??
      0.1,
    defaultDailyBudgetUsd: options.engineConfig?.defaultDailyBudgetUsd ?? 25,
    models: {
      total: models.length,
      local: models.filter((model) => model.tier === 0).length,
      hosted: models.filter((model) => model.tier > 0).length,
    },
  };
}

function projectCommand(command: CommandDefinition): WorkbenchToolSummary {
  return {
    id: command.id,
    title: command.title,
    description: command.description,
    inputSchema: command.inputSchema,
    permission: command.permission,
    redactResult: command.redactResult === true,
  };
}

function buildToolCatalog(params: unknown): WorkbenchToolSummary[] {
  const record = asRecord(params);
  const workspaceRoot = typeof record.workspace === "string"
    ? record.workspace
    : undefined;
  const registry = createCommandRegistry();
  registerCoreCommands(registry, { workspaceRoot });
  return registry.list().map(projectCommand);
}

// The cataloged method surface, reusing the same runtime functions the REST
// endpoints use so the two transports stay in parity.
export function buildWorkbenchHandlers(
  options: WorkbenchUnixServerOptions = {},
): RpcHandlers {
  const loadModels = options.loadModels ?? loadPickerModels;
  const listSessions = options.listSessions ?? listWorkbenchSessions;
  const fetchSessionEvents = options.fetchSessionEvents ??
    fetchWorkbenchSessionEvents;

  return {
    "runtime/status": async () => {
      const models = await loadModels();
      return { runtime: runtimeStatus(options, models) };
    },

    "surface/snapshot": async (params) => {
      const record = asRecord(params);
      const project = record.project;
      const [models, projects] = await Promise.all([
        loadModels(),
        listSessions({
          project: typeof project === "string" ? project : undefined,
        }),
      ]);
      return {
        generatedAt: new Date().toISOString(),
        runtime: runtimeStatus(options, models),
        models,
        projects,
        tools: buildToolCatalog(params),
      } satisfies WorkbenchSurfaceSnapshot;
    },

    // `routable` is computed server-side (single source: modelHasCatalogPricing)
    // so clients can annotate unpriced rows without duplicating the pricing rule.
    "models/list": async () => ({
      models: (await loadModels()).map((model) => ({
        ...model,
        routable: modelHasCatalogPricing(model),
      })),
    }),

    "tools/list": async (params) => ({ tools: buildToolCatalog(params) }),

    "tools/inspect": async (params) => {
      const record = asRecord(params);
      const commandId = record.commandId ?? record.id;
      if (typeof commandId !== "string") {
        throw new RpcError(
          RpcErrorCode.invalidParams,
          "tools/inspect requires a string commandId",
        );
      }
      const tool = buildToolCatalog(params).find((candidate) =>
        candidate.id === commandId
      );
      if (tool === undefined) {
        throw new RpcError(
          RpcErrorCode.invalidParams,
          `unknown tool: ${commandId}`,
        );
      }
      return { tool };
    },

    "sessions/list": async (params) => {
      const project = asRecord(params).project;
      return {
        projects: await listSessions({
          project: typeof project === "string" ? project : undefined,
        }),
      };
    },

    "events/query": async (params) => {
      const record = asRecord(params);
      const sessionId = record.sessionId;
      if (typeof sessionId !== "string") {
        throw new RpcError(
          RpcErrorCode.invalidParams,
          "events/query requires a string sessionId",
        );
      }
      const asOf = record.asOf;
      if (
        asOf !== undefined &&
        (typeof asOf !== "string" || !isValidAsOfTimestamp(asOf))
      ) {
        throw new RpcError(
          RpcErrorCode.invalidParams,
          "events/query asOf must be a valid timestamp",
        );
      }
      return {
        events: await fetchSessionEvents({
          sessionId,
          asOf: typeof asOf === "string" ? asOf : undefined,
        }),
      };
    },
  };
}

// UDS is the canonical loopback transport: a connection is authenticated by the
// OS as the local user via the socket's filesystem permissions (the 0700 parent
// dir owned by the operator), and carries full loopback clearance. Paid
// escalation and budget overrides therefore remain available — but, exactly as
// on the HTTP loopback path, only with an explicit per-turn opt-in in the params
//; the shared turn core enforces that, not this binding.
const UDS_LOOPBACK_AUTH: WorkbenchAuthContext = {
  transport: "loopback",
  authnStatus: "authenticated",
  authnMechanism: "local_user",
  authnIssuerRef: "local_os",
  authzBasis: "policy:loopback-uds",
};

// Parse the client's response to an `approval` request into a verdict. Anything
// that is not an explicit approve denies — fail-closed.
function toApprovalVerdict(response: unknown): ToolApprovalVerdict {
  const r = typeof response === "object" && response !== null
    ? response as Record<string, unknown>
    : {};
  if (r.decision === "approve") return { decision: "approve" };
  return {
    decision: "deny",
    reason: typeof r.reason === "string"
      ? r.reason
      : "operator denied the tool call",
  };
}

// Shared by the budget-ceiling and runaway-anomaly approvals: same verdict
// shape, but a reasonless denial must name the gate that was declined.
function toBudgetCeilingVerdict(
  response: unknown,
  fallbackReason = "operator declined the budget ceiling",
): BudgetCeilingVerdict {
  const r = typeof response === "object" && response !== null
    ? response as Record<string, unknown>
    : {};
  if (r.decision === "approve") return { decision: "approve" };
  return {
    decision: "deny",
    reason: typeof r.reason === "string" ? r.reason : fallbackReason,
  };
}

function resolveEngineTurnDeps(
  options: WorkbenchUnixServerOptions,
): ReturnType<typeof engineConfigToTurnDeps> {
  if (options.engineConfig !== undefined) {
    return engineConfigToTurnDeps(options.engineConfig);
  }
  return {
    defaultCompanionModel: options.defaultCompanionModel,
    permissionLevel: options.permissionLevel,
  };
}

// The `turn` method: run an agentic turn over the shared turn-runner core — the
// SAME lock/resume/clearance/paid path as HTTP — streaming intermediate text
// deltas and runtime events back as `stream` notifications on this connection.
// The final receipt is the RPC result; errors propagate as RPC errors.
export function buildTurnHandlers(
  options: WorkbenchUnixServerOptions = {},
): RpcHandlers {
  const runRuntime = options.runRuntime ?? runWorkbenchRuntime;
  const fetchSessionEvents = options.fetchSessionEvents ??
    fetchWorkbenchSessionEvents;
  const engineDeps = resolveEngineTurnDeps(options);

  return {
    turn: async (params, ctx) => {
      const resolved = resolveTurnFromBody(
        asRecord(params) as TurnRequestBody,
        true,
        { approvePaidDefault: engineDeps.approvePaidDefault },
      );
      if ("error" in resolved) {
        throw new RpcError(RpcErrorCode.invalidParams, resolved.error);
      }
      return await executeTurn(resolved, {
        authContext: UDS_LOOPBACK_AUTH,
        loopback: true,
        runRuntime,
        fetchSessionEvents,
        ...engineDeps,
        // mid-turn approval over the duplex channel — the server asks
        // the connected client to approve a mutating tool or budget ceiling;
        // the client's response is the verdict. A failed request (no client
        // approver, dropped connection) denies, fail-closed.
        confirmToolApproval: (request) =>
          ctx.request("approval", request).then(
            toApprovalVerdict,
            (): ToolApprovalVerdict => ({
              decision: "deny",
              reason: "approval request failed (no client approver?)",
            }),
          ),
        confirmBudgetCeiling: (warning) =>
          ctx.request("approval", budgetCeilingApprovalRequest(warning)).then(
            toBudgetCeilingVerdict,
            (): BudgetCeilingVerdict => ({
              decision: "deny",
              reason: "budget ceiling approval failed (no client approver?)",
            }),
          ),
        confirmRunawayAnomaly: (warning) =>
          ctx.request("approval", runawayAnomalyApprovalRequest(warning)).then(
            (response) =>
              toBudgetCeilingVerdict(
                response,
                "operator declined the anomaly halt",
              ),
            (): BudgetCeilingVerdict => ({
              decision: "deny",
              reason: "anomaly halt approval failed (no client approver?)",
            }),
          ),
        // Stream frames mirror the HTTP SSE frame shape (TurnStreamFrame) so a
        // client can reuse one frame handler across both transports.
        onTextDelta: (text) =>
          void ctx.notify(
            "stream",
            { t: "delta", text } satisfies TurnStreamFrame,
          ),
        // Returned, not voided: the runtime awaits this handler to decide
        // whether the superseding-retry signal actually reached the client. A
        // discarded promise would report success for a notification that never
        // landed, letting a replacement reply stream to a consumer that never
        // reset — and would strand the rejection as an unhandled one besides.
        onRuntimeEvent: (event) =>
          ctx.notify(
            "stream",
            { t: "event", event } satisfies TurnStreamFrame,
          ),
      });
    },
  };
}

export interface WorkbenchUnixServer {
  readonly socketPath: string;
  close(): Promise<void>;
}

/**
 * Assert the socket path is bindable, clearing a stale socket from a prior
 * unclean exit — but only if the path is actually a socket, never an
 * arbitrary file/dir, and never while a live runtime still answers on it.
 * Silently unlinking a live runtime's socket orphans it: the old process
 * keeps running (holding its Dolt pool) but becomes unreachable, and clients
 * silently land on whichever process bound last.
 */
export async function assertSocketBindable(socketPath: string): Promise<void> {
  let info: Deno.FileInfo;
  try {
    info = Deno.lstatSync(socketPath);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return;
    throw err;
  }
  if (!info.isSocket) {
    throw new Error(
      `refusing to bind: ${socketPath} exists and is not a socket`,
    );
  }
  let live: Deno.UnixConn;
  try {
    live = await Deno.connect({ transport: "unix", path: socketPath });
  } catch {
    // Nothing answered: a stale socket from an unclean exit. Clear it.
    Deno.removeSync(socketPath);
    return;
  }
  live.close();
  throw new Error(
    `refusing to bind: a live runtime is already serving on ${socketPath} ` +
      `(inspect with: dyfj status; stop it before starting another)`,
  );
}

export async function serveWorkbenchUnix(
  socketPath: string,
  options: WorkbenchUnixServerOptions = {},
): Promise<WorkbenchUnixServer> {
  await assertSocketBindable(socketPath);

  const handlers: RpcHandlers = {
    ...buildWorkbenchHandlers(options),
    ...buildTurnHandlers(options),
  };
  const listener = Deno.listen({ transport: "unix", path: socketPath });
  const peers = new Set<JsonRpcPeer>();

  (async () => {
    for (;;) {
      let conn: Deno.Conn;
      try {
        conn = await listener.accept();
      } catch {
        break; // listener closed
      }
      const peer = new JsonRpcPeer(conn, {
        handlers,
        onParseError: options.onParseError,
      });
      peers.add(peer);
      peer.run().finally(() => peers.delete(peer));
    }
  })();

  return {
    socketPath,
    async close() {
      try {
        listener.close();
      } catch {
        // already closed
      }
      for (const peer of peers) peer.close();
      peers.clear();
      try {
        await Deno.remove(socketPath);
      } catch {
        // already gone
      }
    },
  };
}
