// Serve the workbench JSON-RPC seam over a Unix domain socket. UDS is
// the canonical `loopback` transport — full clearance, gated by filesystem perms
// — per the transport-seam contract. Wires the read-only methods plus `turn`,
// which runs an agentic turn over the shared turn-runner core and streams text
// deltas + runtime events back as `stream` notifications. Server-initiated
// `approval` requests carry mutating-tool, budget, and exact ACP permission
// option decisions over the same duplex seam.

import {
  defaultLocalWorkbenchModels,
  getModelAccessModality,
  isLocalWorkbenchModel,
  loadWorkbenchModels,
  modelHasCatalogPricing,
  selectWorkbenchModel,
  withDefaultLocalWorkbenchModels,
  type WorkbenchModel,
} from "./provider";
import {
  defaultIdeaPacketRegistry,
  draftWorkPacketFromContext,
  formatWorkPacketMarkdown,
  type IdeaPacketRegistry,
  markWorkbenchIdea,
  type WorkbenchIdea,
  type WorkbenchWorkPacket,
} from "./idea-packet";
import {
  compareSessionActivity,
  countWorkbenchSessionEvents,
  fetchWorkbenchSessionEvents,
  fetchWorkbenchSessionRecord,
  fetchWorkbenchSessionWorkspaceRecord,
  isValidAsOfTimestamp,
  listWorkbenchSessions,
  type WorkbenchProjectSessions,
  type WorkbenchSessionEvent,
  type WorkbenchSessionSummary,
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
import { isSupersedingRetryStarted, summarizeError } from "./turn-contract";
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
  type ConfirmToolApproval,
  createCommandRegistry,
  invokeCommandWithEvent,
  registerCoreCommands,
  type ToolApprovalVerdict,
} from "./commands";
import type { AcpPermissionPrompt, AcpPermissionSelection } from "./acp-client";
import { AcpSessionHandleMap } from "./acp-session-map";
import {
  FRICTION_SEVERITIES,
  type FrictionContext,
  type FrictionPostInput,
  FrictionStageError,
  postFriction,
  requireFrictionIssueIdentifier,
} from "./friction";
import { generateTraceId, writeEvent as writeDoltEvent } from "./utils";

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
  autostarted?: boolean;
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
    options: { project?: string; limit?: number },
  ) => Promise<WorkbenchProjectSessions[]>;
  fetchSessionEvents?: (
    input: {
      sessionId: string;
      eventId?: string;
      asOf?: string;
      limit?: number;
      order?: "asc" | "desc";
    },
  ) => Promise<WorkbenchSessionEvent[]>;
  countSessionEvents?: (
    input: { sessionId: string },
  ) => Promise<number>;
  fetchSessionRecord?: (
    input: { sessionId: string },
  ) => Promise<WorkbenchSessionSummary | null>;
  fetchSessionWorkspaceRecord?: (
    input: { sessionId: string },
  ) => Promise<{ exists: boolean; workspace: string | null }>;
  ideaPacketRegistry?: IdeaPacketRegistry;
  onParseError?: (detail: string) => void;
  /** Callback invoked when a client sends a runtime/stop RPC request. */
  onShutdown?: () => Promise<void> | void;
  /**
   * Invoked after the runtime/stop RPC has been answered. `0` means the
   * shutdown callback succeeded; `1` means it failed. The serve-unix process
   * uses this to exit with a matching status after the client has the result.
   */
  onStopComplete?: (code: 0 | 1) => Promise<void> | void;
  /** Whether the runtime was started via background autostart. */
  autostarted?: boolean;
  /** Boot-discovered external MCP commands available to this runtime. */
  externalMcpCommands?: readonly CommandDefinition[];
  /** Configured operator friction-checkpoint issue identifier. */
  frictionIssueId?: string;
  /** Injectable wall clock for deterministic friction receipt tests. */
  frictionNow?: () => Date;
  /** Injectable durable tool-receipt writer for friction/post tests. */
  frictionEventWriter?: (
    event: Record<string, unknown>,
  ) => Promise<void> | void;
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
  /** Process-owned ACP warm-session map. Created by the server when omitted. */
  acpSessions?: AcpSessionHandleMap;
}

// Degrade to the local defaults if the registry is unavailable, preserving
// the local-first posture instead of an empty list.
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

function sanitizeRpcIdentifier(
  val: unknown,
  fieldName: string,
  options: { required?: boolean; maxLen?: number } = {},
): string | undefined {
  const maxLen = options.maxLen ?? 256;
  if (val === undefined || val === null) {
    if (options.required) {
      throw new RpcError(
        RpcErrorCode.invalidParams,
        `${fieldName} is required`,
      );
    }
    return undefined;
  }
  if (typeof val !== "string") {
    throw new RpcError(
      RpcErrorCode.invalidParams,
      `${fieldName} must be a string`,
    );
  }
  if (val.length === 0 || val.length > maxLen) {
    throw new RpcError(
      RpcErrorCode.invalidParams,
      `${fieldName} must be between 1 and ${maxLen} characters`,
    );
  }
  if (val.trim().length === 0) {
    throw new RpcError(
      RpcErrorCode.invalidParams,
      `${fieldName} cannot be empty or whitespace-only`,
    );
  }
  if (/[\s\x00-\x1F\x7F-\x9F\x1B]/.test(val)) {
    throw new RpcError(
      RpcErrorCode.invalidParams,
      `${fieldName} cannot contain control characters or whitespace`,
    );
  }
  return val;
}

function stripAnsiEscapes(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b[()*+-./][0-9A-Za-z]/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "");
}

function sanitizeRpcString(
  val: unknown,
  fieldName: string,
  options: { required?: boolean; maxLen?: number; singleLine?: boolean } = {},
): string | undefined {
  const maxLen = options.maxLen ?? 256;
  if (val === undefined || val === null) {
    if (options.required) {
      throw new RpcError(
        RpcErrorCode.invalidParams,
        `${fieldName} is required`,
      );
    }
    return undefined;
  }
  if (typeof val !== "string") {
    throw new RpcError(
      RpcErrorCode.invalidParams,
      `${fieldName} must be a string`,
    );
  }
  if (val.length > maxLen * 2) {
    throw new RpcError(
      RpcErrorCode.invalidParams,
      `${fieldName} exceeds maximum length of ${maxLen} characters`,
    );
  }
  let s = stripAnsiEscapes(val);
  if (options.singleLine !== false) {
    s = s.replace(/[\r\n\t\x00-\x1F\x7F-\x9F]/g, " ").replace(/\s+/g, " ");
  } else {
    s = s.replace(/\r\n|\r/g, "\n").replace(/[\t\x00-\x08\x0B-\x0C\x0E-\x1F\x7F-\x9F]/g, " ");
  }
  const trimmed = s.trim();
  if (trimmed.length === 0) {
    throw new RpcError(
      RpcErrorCode.invalidParams,
      `${fieldName} cannot be empty or whitespace-only`,
    );
  }
  if (trimmed.length > maxLen) {
    throw new RpcError(
      RpcErrorCode.invalidParams,
      `${fieldName} exceeds maximum length of ${maxLen} characters`,
    );
  }
  return trimmed;
}

const METHOD_CATALOG = [
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
    ...(options.autostarted !== undefined
      ? { autostarted: options.autostarted }
      : {}),
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

// The cataloged method surface, reusing the shared runtime functions so the
// UDS handlers stay the single transport seam.
export function buildWorkbenchHandlers(
  options: WorkbenchUnixServerOptions = {},
): RpcHandlers {
  const loadModels = options.loadModels ?? loadPickerModels;
  const listSessions = options.listSessions ?? listWorkbenchSessions;
  const fetchSessionEvents = options.fetchSessionEvents ??
    fetchWorkbenchSessionEvents;
  let frictionQueue: Promise<void> = Promise.resolve();

  const withFrictionLock = async <T>(run: () => Promise<T>): Promise<T> => {
    const result = frictionQueue.then(run, run);
    frictionQueue = result.then(() => {}, () => {});
    return await result;
  };

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

    "runtime/stop": async () => {
      if (!options.onShutdown) {
        throw new RpcError(
          RpcErrorCode.internalError,
          "runtime shutdown is not configured on this server",
        );
      }
      try {
        await options.onShutdown();
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

    // `routable`, `local`, and `modality` are computed server-side (single sources:
    // modelHasCatalogPricing, isLocalWorkbenchModel, getModelAccessModality) so clients
    // can annotate rows without duplicating pricing, locality, or taxonomy rules.
    "models/list": async () => ({
      models: (await loadModels()).map((model) => ({
        ...model,
        routable: modelHasCatalogPricing(model),
        local: isLocalWorkbenchModel(model),
        modality: getModelAccessModality(model),
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
      const record = asRecord(params);
      const project = sanitizeRpcString(record.project, "project", {
        maxLen: 256,
      });
      if (
        record.limit !== undefined &&
        (typeof record.limit !== "number" ||
          !Number.isInteger(record.limit) ||
          record.limit <= 0)
      ) {
        throw new RpcError(
          RpcErrorCode.invalidParams,
          "sessions/list limit must be a positive integer",
        );
      }
      const limit = typeof record.limit === "number" && record.limit > 0
        ? Math.min(record.limit, 1000)
        : 100;
      const fetchLimit = Math.min(Math.max(limit * 4, 100), 1000);
      const projects = await listSessions({
        project,
        limit: fetchLimit,
      });
      const topSessions: Array<{
        projectIdx: number;
        session: WorkbenchSessionSummary;
      }> = [];
      for (let i = 0; i < projects.length; i++) {
        const p = projects[i];
        if (Array.isArray(p.sessions)) {
          for (let j = 0; j < p.sessions.length; j++) {
            const s = p.sessions[j];
            if (topSessions.length < limit) {
              topSessions.push({ projectIdx: i, session: s });
              topSessions.sort((a, b) => compareSessionActivity(a.session, b.session));
            } else if (
              compareSessionActivity(
                s,
                topSessions[topSessions.length - 1].session,
              ) < 0
            ) {
              topSessions[topSessions.length - 1] = { projectIdx: i, session: s };
              topSessions.sort((a, b) => compareSessionActivity(a.session, b.session));
            }
          }
        }
      }
      const projectMap = new Map<number, WorkbenchSessionSummary[]>();
      for (const item of topSessions) {
        let list = projectMap.get(item.projectIdx);
        if (!list) {
          list = [];
          projectMap.set(item.projectIdx, list);
        }
        list.push(item.session);
      }
      const boundedProjects: WorkbenchProjectSessions[] = [];
      for (let i = 0; i < projects.length && boundedProjects.length < limit; i++) {
        const matching = projectMap.get(i);
        if (matching && matching.length > 0) {
          boundedProjects.push({
            project: projects[i].project,
            sessions: matching,
          });
        } else if (project !== undefined) {
          boundedProjects.push({
            project: projects[i].project,
            sessions: [],
          });
        }
      }
      if (boundedProjects.length === 0 && topSessions.length === 0 && projects.length > 0) {
        return { projects: projects.slice(0, limit) };
      }
      return { projects: boundedProjects };
    },

    "events/query": async (params) => {
      const record = asRecord(params);
      const sessionId = sanitizeRpcIdentifier(record.sessionId, "sessionId", {
        required: true,
        maxLen: 256,
      })!;
      const asOf = sanitizeRpcString(record.asOf, "asOf", { maxLen: 64 });
      if (asOf !== undefined && !isValidAsOfTimestamp(asOf)) {
        throw new RpcError(
          RpcErrorCode.invalidParams,
          "events/query asOf must be a valid timestamp",
        );
      }
      if (
        record.limit !== undefined &&
        (typeof record.limit !== "number" ||
          !Number.isInteger(record.limit) ||
          record.limit <= 0 ||
          record.limit > 1000)
      ) {
        throw new RpcError(
          RpcErrorCode.invalidParams,
          "events/query limit must be a positive integer between 1 and 1000",
        );
      }
      const limit = typeof record.limit === "number" && record.limit > 0
        ? record.limit
        : 500;
      const fetched = await fetchSessionEvents({
        sessionId,
        asOf: typeof asOf === "string" ? asOf : undefined,
        limit,
      });
      return {
        events: Array.isArray(fetched) ? fetched.slice(0, limit) : [],
      };
    },

    "friction/post": async (params, ctx) => {
      const record = asRecord(params);
      const severity = sanitizeRpcString(record.severity, "severity", {
        required: true,
        maxLen: 16,
      });
      if (
        !FRICTION_SEVERITIES.includes(
          severity as (typeof FRICTION_SEVERITIES)[number],
        )
      ) {
        throw new RpcError(
          RpcErrorCode.invalidParams,
          `severity must be one of: ${FRICTION_SEVERITIES.join(", ")}`,
        );
      }
      if (typeof record.escaped !== "boolean") {
        throw new RpcError(
          RpcErrorCode.invalidParams,
          "escaped must be a boolean",
        );
      }
      const text = sanitizeRpcString(record.text, "text", {
        required: true,
        maxLen: 32_768,
        singleLine: false,
      })!;
      let context: FrictionContext | undefined;
      if (record.context !== undefined) {
        if (
          typeof record.context !== "object" || record.context === null ||
          Array.isArray(record.context)
        ) {
          throw new RpcError(
            RpcErrorCode.invalidParams,
            "context must be an object",
          );
        }
        const rawContext = record.context as Record<string, unknown>;
        const sessionId = sanitizeRpcIdentifier(
          rawContext.sessionId,
          "context.sessionId",
          { maxLen: 256 },
        );
        const model = sanitizeRpcString(rawContext.model, "context.model", {
          maxLen: 256,
        });
        const workspace = sanitizeRpcString(
          rawContext.workspace,
          "context.workspace",
          { maxLen: 4096 },
        );
        const command = sanitizeRpcString(
          rawContext.command,
          "context.command",
          { maxLen: 32_768 },
        );
        context = {
          ...(sessionId === undefined ? {} : { sessionId }),
          ...(model === undefined ? {} : { model }),
          ...(workspace === undefined ? {} : { workspace }),
          ...(command === undefined ? {} : { command }),
        };
      }

      let issueIdentifier: string;
      try {
        issueIdentifier = requireFrictionIssueIdentifier(
          options.frictionIssueId,
        );
      } catch (error) {
        const message = error instanceof FrictionStageError
          ? error.message
          : `friction/post failed: ${summarizeError(error)}`;
        throw new RpcError(RpcErrorCode.internalError, message);
      }

      const externalCommands = options.externalMcpCommands ?? [];
      const getIssueCommand = externalCommands.find((command) =>
        command.id === "mcp.linear.get_issue"
      );
      if (getIssueCommand === undefined) {
        throw new RpcError(
          RpcErrorCode.internalError,
          "get_issue failed: configured Linear tool is unavailable",
        );
      }
      const createCommentCommand = externalCommands.find((command) =>
        command.id === "mcp.linear.create_comment"
      );
      if (createCommentCommand === undefined) {
        throw new RpcError(
          RpcErrorCode.internalError,
          "create_comment failed: configured Linear tool is unavailable",
        );
      }
      const registry = createCommandRegistry([
        getIssueCommand,
        createCommentCommand,
      ]);
      const traceId = generateTraceId();
      const invoke = async (
        command: CommandDefinition,
        arguments_: Record<string, unknown>,
      ): Promise<unknown> => {
        const call = {
          commandId: command.id,
          callId: crypto.randomUUID(),
          caller: {
            principalId: "operator",
            principalType: "human" as const,
          },
          arguments: arguments_,
        };
        const confirmApproval: ConfirmToolApproval = (request) =>
          ctx.request("approval", request).then(
            toApprovalVerdict,
            () => ({
              decision: "deny" as const,
              reason: "approval request failed (no client approver?)",
            }),
          );
        const policyContext = {
          permissionLevel: options.engineConfig?.permissionLevel ??
            options.permissionLevel ?? "strict",
          loopback: true,
        } as const;
        const result = context?.sessionId === undefined
          ? await invokeCommandWithEvent(
            registry,
            call,
            {
              sessionId: "friction-unpersisted",
              traceId,
              writeEvent: () => {},
            },
            confirmApproval,
            policyContext,
          )
          : await invokeCommandWithEvent(
            registry,
            call,
            {
              sessionId: context.sessionId,
              traceId,
              writeEvent: async (event) => {
                try {
                  await (options.frictionEventWriter ?? writeDoltEvent)(event);
                } catch (error) {
                  const kind = error instanceof Error ? error.name : "unknown";
                  console.warn(`friction tool receipt write failed (${kind})`);
                }
              },
            },
            confirmApproval,
            policyContext,
          );
        if (result.isError) throw new Error(result.reason);
        return result.result;
      };

      try {
        return await withFrictionLock(() =>
          postFriction({
            issueIdentifier,
            request: {
              severity: severity as FrictionPostInput["severity"],
              escaped: record.escaped as boolean,
              text,
              ...(context === undefined ? {} : { context }),
            },
            getIssueCommand,
            createCommentCommand,
            invoke: {
              getIssue: (arguments_) => invoke(getIssueCommand, arguments_),
              createComment: (arguments_) =>
                invoke(createCommentCommand, arguments_),
            },
            now: options.frictionNow,
          })
        );
      } catch (error) {
        const message = error instanceof FrictionStageError
          ? error.message
          : `friction/post failed: ${summarizeError(error)}`;
        throw new RpcError(RpcErrorCode.internalError, message);
      }
    },

    "sessions/inspect": async (params) => {
      const record = asRecord(params);
      const sessionId = sanitizeRpcIdentifier(record.sessionId, "sessionId", {
        required: true,
        maxLen: 256,
      })!;
      const [session, workspaceRec, eventCount] = await Promise.all([
        (options.fetchSessionRecord ?? fetchWorkbenchSessionRecord)({
          sessionId,
        }),
        (options.fetchSessionWorkspaceRecord ??
          fetchWorkbenchSessionWorkspaceRecord)({ sessionId }),
        (options.countSessionEvents ?? countWorkbenchSessionEvents)({
          sessionId,
        }),
      ]);
      return {
        session,
        workspace: workspaceRec.workspace,
        exists: session !== null || workspaceRec.exists,
        eventCount,
      };
    },

    "ideas/mark": async (params) => {
      const record = asRecord(params);
      const sessionId = sanitizeRpcIdentifier(record.sessionId, "sessionId", {
        required: true,
        maxLen: 256,
      })!;
      const label = sanitizeRpcString(record.label, "label", {
        required: true,
        maxLen: 256,
      })!;
      const eventId = sanitizeRpcIdentifier(record.eventId, "eventId", {
        maxLen: 256,
      });
      const description = sanitizeRpcString(
        record.description,
        "description",
        { maxLen: 2000, singleLine: false },
      );
      let events: WorkbenchSessionEvent[] | undefined;
      try {
        events = eventId
          ? await fetchSessionEvents({ sessionId, eventId })
          : await fetchSessionEvents({ sessionId, limit: 20 });
      } catch (e) {
        if (eventId) {
          throw new RpcError(
            RpcErrorCode.invalidParams,
            summarizeError(e),
          );
        }
        events = undefined;
      }
      try {
        const idea = markWorkbenchIdea({
          sessionId,
          label,
          eventId,
          description,
          events,
          registry: options.ideaPacketRegistry ?? defaultIdeaPacketRegistry,
        });
        return { idea };
      } catch (e) {
        throw new RpcError(
          RpcErrorCode.invalidParams,
          summarizeError(e),
        );
      }
    },

    "ideas/list": async (params) => {
      const record = asRecord(params);
      const sessionId = sanitizeRpcIdentifier(record.sessionId, "sessionId", {
        required: true,
        maxLen: 256,
      })!;
      const reg = options.ideaPacketRegistry ?? defaultIdeaPacketRegistry;
      try {
        return { ideas: reg.listIdeas(sessionId) };
      } catch (e) {
        throw new RpcError(
          RpcErrorCode.invalidParams,
          summarizeError(e),
        );
      }
    },

    "ideas/get": async (params) => {
      const record = asRecord(params);
      const ideaId = sanitizeRpcIdentifier(record.ideaId, "ideaId", {
        required: true,
        maxLen: 256,
      })!;
      const reg = options.ideaPacketRegistry ?? defaultIdeaPacketRegistry;
      try {
        const idea = reg.getIdea(ideaId);
        return { idea };
      } catch (e) {
        throw new RpcError(
          RpcErrorCode.invalidParams,
          summarizeError(e),
        );
      }
    },

    "packets/draft": async (params) => {
      const record = asRecord(params);
      const sessionId = sanitizeRpcIdentifier(record.sessionId, "sessionId", {
        required: true,
        maxLen: 256,
      })!;
      const ideaId = sanitizeRpcIdentifier(record.ideaId, "ideaId", {
        maxLen: 256,
      });
      const eventId = sanitizeRpcIdentifier(record.eventId, "eventId", {
        maxLen: 256,
      });
      if (ideaId && eventId) {
        throw new RpcError(
          RpcErrorCode.invalidParams,
          "packets/draft cannot specify both ideaId and eventId",
        );
      }
      const issueId = sanitizeRpcIdentifier(record.issueId, "issueId", {
        maxLen: 256,
      });
      const title = sanitizeRpcString(record.title, "title", { maxLen: 256 });
      const operatorIntent = sanitizeRpcString(
        record.operatorIntent,
        "operatorIntent",
        { maxLen: 2000, singleLine: false },
      );
      const reg = options.ideaPacketRegistry ?? defaultIdeaPacketRegistry;
      const idea = ideaId ? reg.getIdea(ideaId) : null;
      if (ideaId && !idea) {
        throw new RpcError(
          RpcErrorCode.invalidParams,
          `idea "${ideaId}" not found`,
        );
      }
      if (idea && idea.sessionId !== sessionId) {
        throw new RpcError(
          RpcErrorCode.invalidParams,
          `idea "${ideaId}" belongs to session "${idea.sessionId}", not requested session "${sessionId}"`,
        );
      }
      const referencedEventId = eventId ?? idea?.eventId ?? undefined;
      let events: WorkbenchSessionEvent[] | undefined;
      try {
        events = referencedEventId
          ? await fetchSessionEvents({ sessionId, eventId: referencedEventId })
          : await fetchSessionEvents({ sessionId, limit: 50 });
      } catch (e) {
        if (referencedEventId) {
          throw new RpcError(
            RpcErrorCode.invalidParams,
            summarizeError(e),
          );
        }
        events = undefined;
      }
      let workspace: string | null = null;
      try {
        const workspaceRec = await (options.fetchSessionWorkspaceRecord ??
          fetchWorkbenchSessionWorkspaceRecord)({ sessionId });
        workspace = workspaceRec.workspace;
      } catch {
        workspace = null;
      }
      try {
        const packet = draftWorkPacketFromContext({
          sessionId,
          idea,
          ideaId,
          eventId,
          issueId,
          title,
          operatorIntent,
          events,
          workspace,
          registry: reg,
        });
        const markdown = formatWorkPacketMarkdown(packet);
        return { packet, markdown };
      } catch (e) {
        throw new RpcError(
          RpcErrorCode.invalidParams,
          summarizeError(e),
        );
      }
    },

    "packets/list": async (params) => {
      const record = asRecord(params);
      const sessionId = sanitizeRpcIdentifier(record.sessionId, "sessionId", {
        required: true,
        maxLen: 256,
      })!;
      const reg = options.ideaPacketRegistry ?? defaultIdeaPacketRegistry;
      try {
        return { packets: reg.listPackets(sessionId) };
      } catch (e) {
        throw new RpcError(
          RpcErrorCode.invalidParams,
          summarizeError(e),
        );
      }
    },

    "packets/get": async (params) => {
      const record = asRecord(params);
      const packetId = sanitizeRpcIdentifier(record.packetId, "packetId", {
        required: true,
        maxLen: 256,
      })!;
      const reg = options.ideaPacketRegistry ?? defaultIdeaPacketRegistry;
      try {
        const packet = reg.getPacket(packetId);
        const markdown = packet ? formatWorkPacketMarkdown(packet) : null;
        return { packet, markdown };
      } catch (e) {
        throw new RpcError(
          RpcErrorCode.invalidParams,
          summarizeError(e),
        );
      }
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

// The `turn` method: run an agentic turn over the shared turn-runner core —
// lock/resume/clearance/paid — streaming intermediate text
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
        // Stream frames carry the shared TurnStreamFrame union — one wire
        // shape for clients to consume. Deltas are
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
  close(options?: { disconnectPeers?: boolean }): Promise<void>;
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

  const acpSessions = options.acpSessions ?? new AcpSessionHandleMap();
  const serverOptions: WorkbenchUnixServerOptions = {
    ...options,
    runRuntime: options.runRuntime ??
      ((input) => runWorkbenchRuntime(input, { acpSessions })),
  };
  const handlers: RpcHandlers = {
    ...buildWorkbenchHandlers(serverOptions),
    ...buildTurnHandlers(serverOptions),
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
        onRequestSettled: async (req, res) => {
          if (req.method !== "runtime/stop") return;
          const code = "result" in res ? 0 : 1;
          try {
            await options.onStopComplete?.(code);
          } catch (err) {
            options.onParseError?.(
              `onStopComplete error: ${summarizeError(err)}`,
            );
          }
        },
      });
      peers.add(peer);
      peer.run().finally(() => peers.delete(peer));
    }
  })();

  return {
    socketPath,
    async close(options: { disconnectPeers?: boolean } = {}) {
      let shutdownError: unknown;
      try {
        await acpSessions.shutdown();
      } catch (error) {
        shutdownError = error;
      }
      try {
        listener.close();
      } catch {
        // already closed
      }
      if (options.disconnectPeers !== false) {
        for (const peer of peers) peer.close();
        peers.clear();
      }
      try {
        await Deno.remove(socketPath);
      } catch {
        // already gone
      }
      if (shutdownError !== undefined) throw shutdownError;
    },
  };
}
