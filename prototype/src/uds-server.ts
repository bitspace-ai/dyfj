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
import { type RpcHandlers, serveUnixJsonRpc } from "./transport/mod.ts";
import { runExternalAgentWorkbenchRuntime } from "./external-agent-runtime.ts";
import type { PermissionLevel, WorkbenchConfig } from "./config/mod.ts";
import { summarizeError, type WorkbenchSessionEvent } from "./contract/mod.ts";
import {
  type ExternalAgentRunner,
  runWorkbenchRuntime,
  SessionOwners,
  type TurnRuntime,
} from "./engine/mod.ts";
import type { CommandDefinition } from "./tools/mod.ts";
import { AcpSessionHandleMap } from "./acp-session-map.ts";
import type { EventInsert, Store } from "./store/mod.ts";
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
import { buildTurnHandlers } from "./server/rpc/turn.ts";

export interface WorkbenchUnixServerOptions {
  /**
   * The store behind every default reader, writer and the turn runtime.
   * `serveWorkbenchUnix` requires it.
   */
  store?: Store;
  runRuntime?: TurnRuntime;
  /**
   * The engine's session owners (turn locks, budget scopes, cancel signals).
   * `serveWorkbenchUnix` builds one when omitted and shares it between the
   * turn handlers and the runtime.
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
// once and handed to each namespace's RPC module under server/rpc/, with the
// turn methods bound to the engine's session owners and turn runtime.
function buildHandlers(
  options: WorkbenchUnixServerOptions,
  owners: SessionOwners,
  runRuntime: TurnRuntime,
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
    ...buildTurnHandlers({
      ...options,
      owners,
      runRuntime,
      fetchSessionEvents,
    }),
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
  const runRuntime = options.runRuntime ??
    composeTurnRuntime(() => options.store, owners, acpSessions);
  const handlers = buildHandlers(options, owners, runRuntime);
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
