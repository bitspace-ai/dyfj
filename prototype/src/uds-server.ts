// Serve the workbench JSON-RPC seam over a Unix domain socket. UDS is
// the canonical `loopback` transport — full clearance, gated by filesystem perms
// — per the transport-seam contract. Wires the read-only methods plus `turn`,
// which runs an agentic turn over the shared turn-runner core and streams text
// deltas + runtime events back as `stream` notifications. Server-initiated
// `approval` requests carry mutating-tool, budget, and exact ACP permission
// option decisions over the same duplex seam.

import {
  defaultLocalWorkbenchModels,
  isLocalWorkbenchModel,
  loadWorkbenchModels,
  modelHasCatalogPricing,
  selectWorkbenchModel,
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
import {
  type RpcContext,
  RpcError,
  RpcErrorCode,
  type RpcHandlers,
} from "./jsonrpc";
import { JsonRpcPeer } from "./jsonrpc-peer";
import { runWorkbenchRuntime, type WorkbenchAuthContext } from "./workbench";
import {
  AGENT_DEFAULTS,
  type PermissionLevel,
  type WorkbenchConfig,
} from "./config";
import {
  budgetCeilingApprovalRequest,
  type BudgetCeilingVerdict,
  runawayAnomalyApprovalRequest,
} from "./budget";
import type { TurnStreamFrame } from "./turn-contract";
import { isSupersedingRetryStarted } from "./turn-contract";
import {
  engineConfigToTurnDeps,
  executeTurn,
  isValidTurnId,
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
import type { AcpPermissionPrompt, AcpPermissionSelection } from "./acp-client";

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
  /** Boot-discovered external MCP commands available to this runtime. */
  externalMcpCommands?: readonly CommandDefinition[];
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
    | "trustWorkspaceInstructions"
    | "defaultSessionBudgetUsd"
    | "defaultPerCallBudgetUsd"
    | "defaultDailyBudgetUsd"
    | "anomalyTurnMultiple"
    | "anomalyScopeMultiple"
    | "maxToolSteps"
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
  { id: "runtime/liveness", namespace: "runtime", kind: "read" },
  { id: "runtime/status", namespace: "runtime", kind: "read" },
  { id: "surface/snapshot", namespace: "surface", kind: "read" },
  { id: "models/list", namespace: "models", kind: "read" },
  { id: "sessions/list", namespace: "sessions", kind: "read" },
  { id: "events/query", namespace: "events", kind: "read" },
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
    // No routable bare-turn model (empty registry, misconfigured default) —
    // status must still answer; the turn path reports the real error.
    return null;
  }
}

function runtimeStatus(
  options: WorkbenchUnixServerOptions,
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

function buildToolCatalog(
  params: unknown,
  externalMcpCommands: readonly CommandDefinition[] = [],
): WorkbenchToolSummary[] {
  const record = asRecord(params);
  const workspaceRoot = typeof record.workspace === "string"
    ? record.workspace
    : undefined;
  const registry = createCommandRegistry();
  registerCoreCommands(registry, { workspaceRoot });
  for (const command of externalMcpCommands) registry.register(command);
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
    "runtime/liveness": () => {
      return {
        status: "ok",
        transport: "uds",
        clearance: "loopback",
      };
    },

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
        tools: buildToolCatalog(params, options.externalMcpCommands),
      } satisfies WorkbenchSurfaceSnapshot;
    },

    // `routable` and `local` are computed server-side (single sources:
    // modelHasCatalogPricing, isLocalWorkbenchModel) so clients can annotate
    // rows without duplicating the pricing or locality rules.
    "models/list": async () => ({
      models: (await loadModels()).map((model) => ({
        ...model,
        routable: modelHasCatalogPricing(model),
        local: isLocalWorkbenchModel(model),
      })),
    }),

    "tools/list": async (params) => ({
      tools: buildToolCatalog(params, options.externalMcpCommands),
    }),

    "tools/inspect": async (params) => {
      const record = asRecord(params);
      const commandId = record.commandId ?? record.id;
      if (typeof commandId !== "string") {
        throw new RpcError(
          RpcErrorCode.invalidParams,
          "tools/inspect requires a string commandId",
        );
      }
      const tool = buildToolCatalog(params, options.externalMcpCommands).find((
        candidate,
      ) => candidate.id === commandId);
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

function approvalWasAborted(response: unknown): boolean {
  return typeof response === "object" &&
    response !== null &&
    (response as Record<string, unknown>).decision === "abort";
}

const ACP_TOOL_KINDS = new Set([
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
  "other",
]);

function terminalAcpToolKind(value: string | undefined): string {
  return value !== undefined && ACP_TOOL_KINDS.has(value)
    ? value
    : "(not supplied)";
}

function rejectedAcpPermissionSelection(
  prompt: AcpPermissionPrompt,
): AcpPermissionSelection {
  const rejection =
    prompt.options.find((option) =>
      option.kind === "reject_once" && option.optionId.length > 0
    ) ?? prompt.options.find((option) =>
      option.kind === "reject_always" && option.optionId.length > 0
    );
  return { optionId: rejection?.optionId ?? null, source: "policy" };
}

function toAcpPermissionSelection(
  response: unknown,
  prompt: AcpPermissionPrompt,
): AcpPermissionSelection {
  const record = typeof response === "object" && response !== null
    ? response as Record<string, unknown>
    : {};
  if (
    record.decision === "select" && typeof record.optionId === "string" &&
    record.optionId.length > 0
  ) {
    return { optionId: record.optionId, source: "operator" };
  }
  return rejectedAcpPermissionSelection(prompt);
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
  const activeTurns = new Map<
    RpcContext,
    Map<
      string,
      {
        abortController: AbortController;
        acceptingCancellation: boolean;
      }
    >
  >();

  return {
    turn: async (params, ctx) => {
      const resolved = resolveTurnFromBody(
        asRecord(params) as TurnRequestBody,
        true,
        {
          approvePaidDefault: engineDeps.approvePaidDefault,
          trustWorkspaceInstructions: engineDeps.trustWorkspaceInstructions,
        },
      );
      if ("error" in resolved) {
        throw new RpcError(RpcErrorCode.invalidParams, resolved.error);
      }
      const turnId = resolved.runtimeInput.turnId;
      const activeKey = turnId ?? crypto.randomUUID();
      const abortController = new AbortController();
      const activeTurn = {
        abortController,
        acceptingCancellation: true,
      };
      const abortIfApprovalWasInterrupted = (response: unknown): void => {
        if (!approvalWasAborted(response)) return;
        abortController.abort();
        throw abortController.signal.reason;
      };
      const rejectStaleApprovalAfterCancellation = (): void => {
        if (abortController.signal.aborted) {
          throw abortController.signal.reason;
        }
      };
      const requestApproval = (
        request: unknown,
        signal?: AbortSignal,
      ): Promise<unknown> =>
        ctx.request(
          "approval",
          request,
          signal === undefined
            ? abortController.signal
            : AbortSignal.any([abortController.signal, signal]),
        );
      let contextTurns = activeTurns.get(ctx);
      if (contextTurns?.size) {
        throw new RpcError(
          RpcErrorCode.invalidParams,
          "connection already has an active turn",
        );
      }
      if (contextTurns === undefined) {
        contextTurns = new Map();
        activeTurns.set(ctx, contextTurns);
      }
      contextTurns.set(activeKey, activeTurn);
      if (turnId !== undefined) {
        resolved.runtimeInput.onCancellationClosed = () => {
          activeTurn.acceptingCancellation = false;
        };
      }
      resolved.runtimeInput.abortSignal = abortController.signal;
      // A client that drops mid-turn makes every subsequent notify reject.
      // Deltas and status events are best-effort, so their send failures are
      // swallowed and logged once per turn rather than once per frame (a
      // tool-heavy turn would otherwise flood the log). The superseding-retry
      // signal is the exception — handled fail-closed below.
      let streamNotifyFailureLogged = false;
      const noteStreamNotifyFailure = (err: unknown): void => {
        if (streamNotifyFailureLogged) return;
        streamNotifyFailureLogged = true;
        // Log the error's class, not its message: a Unix-socket write error can
        // carry the socket path, and this warning channel is path-free by
        // convention. Sends continue best-effort; only repeated warnings are
        // suppressed this turn.
        const kind = err instanceof Error ? err.name : "unknown";
        console.warn(
          `stream notify failed (${kind}) — client likely disconnected; ` +
            `further failures this turn will not be logged`,
        );
      };
      try {
      return await executeTurn(resolved, {
        authContext: UDS_LOOPBACK_AUTH,
        loopback: true,
        runRuntime,
        fetchSessionEvents,
        ...engineDeps,
        externalMcpCommands: options.externalMcpCommands,
        // mid-turn approval over the duplex channel — the server asks
        // the connected client to approve a mutating tool or budget ceiling;
        // the client's response is the verdict. A failed request (no client
        // approver, dropped connection) denies, fail-closed.
        confirmToolApproval: (request, signal) =>
          requestApproval(request, signal).then(
            (response) => {
              abortIfApprovalWasInterrupted(response);
              rejectStaleApprovalAfterCancellation();
              return toApprovalVerdict(response);
            },
            (): ToolApprovalVerdict => {
              rejectStaleApprovalAfterCancellation();
              return {
                decision: "deny",
                reason: "approval request failed (no client approver?)",
              };
            },
          ),
        confirmExternalAgentPermission: (prompt, signal) =>
          requestApproval({
            kind: "external_agent_permission",
            title: prompt.toolCall.title,
            arguments: {
              "ACP tool": prompt.toolCall.name ?? "(not supplied)",
              "ACP kind": terminalAcpToolKind(prompt.toolCall.kind),
              "Requested input": prompt.toolCall.inputSummary,
            },
            options: prompt.options,
          }, signal).then(
            (response) => {
              abortIfApprovalWasInterrupted(response);
              rejectStaleApprovalAfterCancellation();
              return toAcpPermissionSelection(response, prompt);
            },
            (): AcpPermissionSelection => {
              rejectStaleApprovalAfterCancellation();
              return rejectedAcpPermissionSelection(prompt);
            },
          ),
        confirmBudgetCeiling: (warning) =>
          requestApproval(budgetCeilingApprovalRequest(warning)).then(
            (response) => {
              abortIfApprovalWasInterrupted(response);
              rejectStaleApprovalAfterCancellation();
              return toBudgetCeilingVerdict(response);
            },
            (): BudgetCeilingVerdict => {
              rejectStaleApprovalAfterCancellation();
              return {
                decision: "deny",
                reason: "budget ceiling approval failed (no client approver?)",
              };
            },
          ),
        confirmRunawayAnomaly: (warning) =>
            requestApproval(runawayAnomalyApprovalRequest(warning))
              .then(
            (response) => {
              abortIfApprovalWasInterrupted(response);
              rejectStaleApprovalAfterCancellation();
              return toBudgetCeilingVerdict(
                response,
                "operator declined the anomaly halt",
              );
            },
            (): BudgetCeilingVerdict => {
              rejectStaleApprovalAfterCancellation();
              return {
                decision: "deny",
                reason: "anomaly halt approval failed (no client approver?)",
              };
            },
          ),
        // Stream frames mirror the HTTP SSE frame shape (TurnStreamFrame) so a
        // client can reuse one frame handler across both transports. Deltas are
        // best-effort: a dropped one costs some rendered text, not correctness,
        // so the notify promise is observed (not left to reject unhandled) but
        // its failure is only logged, never surfaced to the runtime.
        onTextDelta: (text) => {
          ctx.notify(
            "stream",
            { t: "delta", text } satisfies TurnStreamFrame,
          ).catch(noteStreamNotifyFailure);
        },
        // Safety-critical signals are the events whose delivery the runtime
        // must observe: a superseding retry resets rendered text, while an
        // unparsed-markup warning prevents an unqualified success. Their send
        // failures are returned so the runtime can fail closed. Every other
        // runtime event is a fire-and-forget notification — a failed send is
        // nothing to report, and returning its rejection would only make the
        // runtime's best-effort emitter warn once per event (a flood on a
        // tool-heavy turn after the client drops). So swallow those, logging once.
        onRuntimeEvent: (event) => {
          const sent = ctx.notify(
            "stream",
            { t: "event", event } satisfies TurnStreamFrame,
          );
          if (
            isSupersedingRetryStarted(event) ||
            event.type === "unparsedToolCallMarkupDetected"
          ) return sent;
          return sent.catch(noteStreamNotifyFailure);
        },
      });
      } finally {
        const contextTurns = activeTurns.get(ctx);
        if (contextTurns?.get(activeKey) === activeTurn) {
          contextTurns.delete(activeKey);
          if (contextTurns.size === 0) activeTurns.delete(ctx);
        }
      }
    },
    "turn/cancel": (params, ctx) => {
      const turnId = asRecord(params).turnId;
      if (!isValidTurnId(turnId)) {
        throw new RpcError(
          RpcErrorCode.invalidParams,
          "turnId must be a UUID",
        );
      }
      const activeTurn = activeTurns.get(ctx)?.get(turnId);
      if (
        activeTurn === undefined || !activeTurn.acceptingCancellation
      ) {
        return { cancelled: false, reason: "no_active_turn" };
      }
      activeTurn.acceptingCancellation = false;
      activeTurn.abortController.abort();
      return { cancelled: true };
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
