// Serve the workbench JSON-RPC seam over a Unix domain socket. UDS is
// the canonical `loopback` transport — full clearance, gated by filesystem perms
// — per the transport-seam contract. Wires the read-only methods plus `turn`,
// which runs an agentic turn over the engine's shared turn entry and streams text
// deltas + runtime events back as `stream` notifications. Server-initiated
// `approval` requests carry mutating-tool, budget, and exact ACP permission
// option decisions over the same duplex seam.

import {
  defaultLocalWorkbenchModels,
  loadWorkbenchModels,
  withDefaultLocalWorkbenchModels,
  type WorkbenchModel,
} from "./providers/mod.ts";
import type { IdeaPacketRegistry } from "./idea-packet.ts";
import {
  countWorkbenchSessionEvents,
  fetchWorkbenchSessionEvents,
  fetchWorkbenchSessionRecord,
  fetchWorkbenchSessionWorkspaceRecord,
  listWorkbenchSessions,
  type WorkbenchProjectSessions,
  type WorkbenchSessionSummary,
} from "./store/mod.ts";
import {
  type RpcContext,
  RpcError,
  RpcErrorCode,
  type RpcHandlers,
  serveUnixJsonRpc,
} from "./transport/mod.ts";
import { runExternalAgentWorkbenchRuntime } from "./external-agent-runtime.ts";
import type { PermissionLevel, WorkbenchConfig } from "./config/mod.ts";
import {
  budgetCeilingApprovalRequest,
  type BudgetCeilingVerdict,
  runawayAnomalyApprovalRequest,
} from "./budget/mod.ts";
import type {
  TurnStreamFrame,
  WorkbenchAuthContext,
  WorkbenchSessionEvent,
} from "./contract/mod.ts";
import { isSupersedingRetryStarted, summarizeError } from "./contract/mod.ts";
import {
  engineConfigToTurnDeps,
  executeTurn,
  type ExternalAgentRunner,
  isValidTurnId,
  resolveTurnFromBody,
  runWorkbenchRuntime,
  SessionOwners,
  type TurnRequestBody,
  type TurnRuntime,
  type TurnTicket,
} from "./engine/mod.ts";
import type { CommandDefinition, ToolApprovalVerdict } from "./tools/mod.ts";
import type {
  AcpPermissionPrompt,
  AcpPermissionSelection,
} from "./contract/mod.ts";
import { AcpSessionHandleMap } from "./acp-session-map.ts";
import type { EventInsert, Store } from "./store/mod.ts";
import { asRecord } from "./server/rpc/params.ts";
import { toApprovalVerdict } from "./server/rpc/approval.ts";
import { buildLegacyExtensionHandlers } from "./server/rpc/legacy-extensions.ts";
import { buildRuntimeHandlers } from "./server/rpc/runtime.ts";
import { buildSurfaceHandlers } from "./server/rpc/surface.ts";
import { buildModelsHandlers } from "./server/rpc/models.ts";
import { buildToolsHandlers } from "./server/rpc/tools.ts";
import { buildSessionsHandlers } from "./server/rpc/sessions.ts";
import {
  buildEventsHandlers,
  type SessionEventsRequest,
} from "./server/rpc/events.ts";

export interface WorkbenchUnixServerOptions {
  /**
   * The store behind every default reader, writer and the turn runtime.
   * `serveWorkbenchUnix` requires it; a handler builder whose defaults are all
   * overridden may omit it.
   */
  store?: Store;
  runRuntime?: TurnRuntime;
  /**
   * The engine's session owners (turn locks, budget scopes, cancel signals).
   * `serveWorkbenchUnix` builds one and shares it between the turn handlers
   * and the runtime; a handler builder without one builds its own.
   */
  owners?: SessionOwners;
  loadModels?: () => Promise<WorkbenchModel[]>;
  listSessions?: (
    options: { project?: string; limit?: number },
  ) => Promise<WorkbenchProjectSessions[]>;
  fetchSessionEvents?: (
    input: SessionEventsRequest,
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
  frictionEventWriter?: (event: EventInsert) => Promise<void> | void;
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

function requireStore(options: WorkbenchUnixServerOptions): Store {
  if (options.store === undefined) {
    throw new Error("No store is configured");
  }
  return options.store;
}

// Degrade to the local defaults if the registry is unavailable, preserving
// the local-first posture instead of an empty list.
async function loadPickerModels(
  store: () => Store,
): Promise<WorkbenchModel[]> {
  try {
    return withDefaultLocalWorkbenchModels(
      await loadWorkbenchModels(store().models),
    );
  } catch {
    return defaultLocalWorkbenchModels();
  }
}

// The cataloged method surface: the default store-backed readers, resolved
// once and handed to each namespace's RPC module under server/rpc/.
export function buildWorkbenchHandlers(
  options: WorkbenchUnixServerOptions = {},
): RpcHandlers {
  const store = () => requireStore(options);
  const loadModels = options.loadModels ?? (() => loadPickerModels(store));
  const listSessions = options.listSessions ??
    ((query: { project?: string; limit?: number }) =>
      listWorkbenchSessions({ ...query, sessions: store().sessions }));
  const fetchSessionEvents = options.fetchSessionEvents ??
    ((input: SessionEventsRequest) =>
      fetchWorkbenchSessionEvents({ ...input, events: store().events }));
  const fetchSessionRecord = options.fetchSessionRecord ??
    ((input: { sessionId: string }) =>
      fetchWorkbenchSessionRecord({ ...input, sessions: store().sessions }));
  const fetchSessionWorkspaceRecord = options.fetchSessionWorkspaceRecord ??
    ((input: { sessionId: string }) =>
      fetchWorkbenchSessionWorkspaceRecord({
        ...input,
        sessions: store().sessions,
      }));
  const countSessionEvents = options.countSessionEvents ??
    ((input: { sessionId: string }) =>
      countWorkbenchSessionEvents({ ...input, events: store().events }));
  const frictionEventWriter = options.frictionEventWriter ??
    (async (event: EventInsert) => {
      await store().journal.commit({ events: [event] });
    });
  return {
    ...buildRuntimeHandlers({ ...options, loadModels }),
    ...buildSurfaceHandlers({ ...options, loadModels, listSessions }),
    ...buildModelsHandlers({ loadModels }),
    ...buildToolsHandlers(options),
    ...buildSessionsHandlers({
      listSessions,
      fetchSessionRecord,
      fetchSessionWorkspaceRecord,
      countSessionEvents,
    }),
    ...buildEventsHandlers({ fetchSessionEvents }),

    ...buildLegacyExtensionHandlers({
      ...options,
      fetchSessionEvents,
      fetchSessionWorkspaceRecord,
      frictionEventWriter,
    }),
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

// The production turn runtime: the engine with its external-agent runner bound
// here, at the composition root, so the engine never imports the ACP runner.
function composeTurnRuntime(
  store: () => Store,
  owners: SessionOwners,
  acpSessions?: AcpSessionHandleMap,
): TurnRuntime {
  const externalAgentRunner: ExternalAgentRunner = {
    run: (input) =>
      runExternalAgentWorkbenchRuntime(input, {
        store: store(),
        sessionMap: acpSessions,
      }),
  };
  return (input) =>
    runWorkbenchRuntime(input, {
      store: store(),
      // The session owners hold each session's budget scope, so ceiling
      // confirmations persist for their scope periods across turns.
      budgetScopes: owners,
      externalAgentRunner,
    });
}

// The `turn` method: run an agentic turn over the engine's shared turn entry —
// lock/resume/clearance/paid — streaming intermediate text
// deltas and runtime events back as `stream` notifications on this connection.
// The final receipt is the RPC result; errors propagate as RPC errors.
export function buildTurnHandlers(
  options: WorkbenchUnixServerOptions = {},
): RpcHandlers {
  const store = () => requireStore(options);
  // The engine's session owners: turn locks, budget scopes and cancel
  // signals. The connection map below only records which turn each
  // connection is running.
  const owners = options.owners ?? new SessionOwners();
  const runRuntime = options.runRuntime ?? composeTurnRuntime(store, owners);
  const fetchSessionEvents = options.fetchSessionEvents ??
    ((input: SessionEventsRequest) =>
      fetchWorkbenchSessionEvents({ ...input, events: store().events }));
  const engineDeps = resolveEngineTurnDeps(options);
  const activeTurns = new Map<RpcContext, Map<string, TurnTicket>>();

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
      const activeTurn = owners.admit();
      const abortIfApprovalWasInterrupted = (response: unknown): void => {
        if (!approvalWasAborted(response)) return;
        activeTurn.abort();
        throw activeTurn.signal.reason;
      };
      const rejectStaleApprovalAfterCancellation = (): void => {
        if (activeTurn.signal.aborted) {
          throw activeTurn.signal.reason;
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
            ? activeTurn.signal
            : AbortSignal.any([activeTurn.signal, signal]),
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
          owners,
          ticket: activeTurn,
          authContext: UDS_LOOPBACK_AUTH,
          loopback: true,
          runRuntime,
          fetchSessionEvents,
          ...engineDeps,
          externalMcpCommands: options.externalMcpCommands,
          approver: {
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
                    reason:
                      "budget ceiling approval failed (no client approver?)",
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
                      reason:
                        "anomaly halt approval failed (no client approver?)",
                    };
                  },
                ),
          },
          frames: {
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
      if (activeTurn === undefined || !activeTurn.cancel()) {
        return { cancelled: false, reason: "no_active_turn" };
      }
      return { cancelled: true };
    },
  };
}

export interface WorkbenchUnixServer {
  readonly socketPath: string;
  close(options?: { disconnectPeers?: boolean }): Promise<void>;
}

export async function serveWorkbenchUnix(
  socketPath: string,
  options: WorkbenchUnixServerOptions & { store: Store },
): Promise<WorkbenchUnixServer> {
  const acpSessions = options.acpSessions ?? new AcpSessionHandleMap();
  // One set of session owners per engine, shared by the turn handlers and
  // the runtime they run.
  const owners = options.owners ?? new SessionOwners();
  const serverOptions: WorkbenchUnixServerOptions = {
    ...options,
    owners,
    runRuntime: options.runRuntime ??
      composeTurnRuntime(() => options.store, owners, acpSessions),
  };
  const handlers: RpcHandlers = {
    ...buildWorkbenchHandlers(serverOptions),
    ...buildTurnHandlers(serverOptions),
  };
  const transport = await serveUnixJsonRpc(socketPath, {
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

  return {
    socketPath,
    async close(options: { disconnectPeers?: boolean } = {}) {
      let shutdownError: unknown;
      try {
        await acpSessions.shutdown();
      } catch (error) {
        shutdownError = error;
      }
      await transport.close(options);
      if (shutdownError !== undefined) throw shutdownError;
    },
  };
}
