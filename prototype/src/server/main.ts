/**
 * server/ (L5): the engine server's composition root
 * (specs/01-architecture.md §7).
 *
 * `dyfj start` runs this file on Node. It is the only place that reads the
 * resolved config, resolves secrets, builds the store, the external MCP
 * commands, the session owners, the turn runtime and the ACP session map,
 * builds the static extension list (`extensions.ts`), wires the RPC method
 * modules under `rpc/` (one per namespace) and the extensions' methods, and
 * binds the socket. `serveWorkbenchUnix` is the composition
 * without the boot: the tests build a server from it over their own store.
 *
 * UDS is the canonical `loopback` transport: full clearance, gated by
 * filesystem permissions. Server-initiated `approval` requests carry
 * mutating-tool, budget, and exact ACP permission option decisions over the
 * same duplex seam; `stream` notifications carry text deltas and runtime
 * events.
 *
 * Allowed dependencies: every lower layer. Nothing imports `server/`.
 */

import process from "node:process";
import {
  defaultLocalWorkbenchModels,
  loadWorkbenchModelsWithLocalDefaults,
  type WorkbenchModel,
} from "../providers/mod.ts";
import {
  checkColumnsAtBoot,
  countWorkbenchSessionEvents,
  createDoltPool,
  DoltStore,
  type EventInsert,
  fetchWorkbenchSessionEvents,
  fetchWorkbenchSessionLastRun,
  fetchWorkbenchSessionRecord,
  fetchWorkbenchSessionWorkspaceRecord,
  listWorkbenchSessions,
  type SessionLastRun,
  type Store,
  type WorkbenchProjectSessions,
  type WorkbenchSessionSummary,
} from "../store/mod.ts";
import {
  ensureSocketDir,
  resolveSocketPath,
  type RpcHandlers,
  serveUnixJsonRpc,
} from "../transport/mod.ts";
import { runExternalAgentWorkbenchRuntime } from "../external-agent-runtime.ts";
import {
  type CodeFingerprint,
  codeFingerprint,
  type Env,
  loadConfig,
  loadMcpServersConfig,
  loadNetworkAllow,
  loadSecretsConfig,
  type PermissionLevel,
  processEnv,
  prototypeSourceDir,
  readNameserverNetGrants,
  type RuntimePolicy,
  unavailableSecretPointers,
  type WorkbenchConfig,
} from "../config/mod.ts";
import { summarizeError, type WorkbenchSessionEvent } from "../contract/mod.ts";
import {
  type ExternalAgentRunner,
  runWorkbenchRuntime,
  SessionOwners,
  type TurnRuntime,
} from "../engine/mod.ts";
import {
  buildExternalMcpCommands,
  type CommandDefinition,
  formatExternalMcpDiagnostic,
  RootAnchors,
} from "../tools/mod.ts";
import { AcpSessionHandleMap } from "../acp-session-map.ts";
import { composeBoot } from "./boot.ts";
import { installRuntimeSigintHandler } from "./sigint.ts";
import { AUTOSTARTED_IDLE_GRACE_MS, RuntimeLifetime } from "./lifetime.ts";
import { createFrictionExtension } from "../extensions/friction/mod.ts";
import { createIdeaPacketExtensions } from "../extensions/ideas/mod.ts";
import {
  buildLinearIssueCreationCommand,
  createLinearExtension,
  type LinearCommands,
} from "../extensions/linear/mod.ts";
import {
  buildExtensionHandlers,
  type Extension,
  rpcToolApprover,
} from "./extensions.ts";
import {
  buildRuntimeHandlers,
  type WorkbenchUnavailableSecret,
} from "./rpc/runtime.ts";
import { buildSurfaceHandlers } from "./rpc/surface.ts";
import { buildModelsHandlers } from "./rpc/models.ts";
import { buildToolsHandlers } from "./rpc/tools.ts";
import { buildSessionsHandlers } from "./rpc/sessions.ts";
import {
  buildEventsHandlers,
  type SessionEventsRequest,
} from "./rpc/events.ts";
import { buildTurnHandlers } from "./rpc/turn.ts";

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
  fetchSessionLastRun?: (
    input: { sessionId: string },
  ) => Promise<SessionLastRun | null>;
  fetchSessionRecord?: (
    input: { sessionId: string },
  ) => Promise<WorkbenchSessionSummary | null>;
  fetchSessionWorkspaceRecord?: (
    input: { sessionId: string },
  ) => Promise<{ exists: boolean; workspace: string | null }>;
  onParseError?: (detail: string) => void;
  /** Callback invoked when a client sends a runtime/stop RPC request. */
  onShutdown?: () => Promise<void> | void;
  /**
   * Invoked after the runtime/stop RPC has been answered, unless a
   * conditional stop was declined. `0` means the shutdown callback succeeded;
   * `1` means it failed. The runtime process
   * uses this to exit with a matching status after the client has the result.
   */
  onStopComplete?: (code: 0 | 1) => Promise<void> | void;
  /**
   * Whether the runtime was started via background autostart. An autostarted
   * runtime calls `onIdle` once no client has been connected for the grace.
   */
  autostarted?: boolean;
  /**
   * Stop the runtime, for an autostarted one whose last client left more
   * than the grace ago. The server has stopped counting clients by then; the
   * callback runs the same shutdown as `runtime/stop` and SIGINT.
   */
  onIdle?: () => Promise<void> | void;
  /** The grace an autostarted runtime waits; 10 s when omitted. */
  idleGraceMs?: number;
  /** The code this runtime loaded at boot, for `runtime/status`. */
  fingerprint?: CodeFingerprint;
  /** Secret pointers that failed to resolve at start, for `runtime/status`. */
  unavailableSecrets?: readonly WorkbenchUnavailableSecret[];
  /** The boot's external MCP lines, for `runtime/status`. */
  externalMcp?: readonly string[];
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
  /**
   * The runtime's egress, spawn and env policy, composed at boot. Provider
   * calls, memory recall and the ACP runner's spawns are checked against it;
   * the base policy when omitted.
   */
  policy?: RuntimePolicy;
  /**
   * Where turns read their env-derived defaults and the native runtime its
   * environment; the process env when omitted, as the boot leaves it.
   */
  env?: Env;
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
    return await loadWorkbenchModelsWithLocalDefaults(store().models);
  } catch {
    return defaultLocalWorkbenchModels();
  }
}

// The static extension list (specs/01-architecture.md §6), every extension
// enabled by default. Built once per server, so each engine owns its
// extensions' state (the idea/packet registry lives in memory for its life,
// and friction's post queue). The linear extension resolves the Linear
// commands the others reach through `ExtensionDeps.linear`.
function composeExtensions(
  options: WorkbenchUnixServerOptions,
  frictionEventWriter: (event: EventInsert) => Promise<void> | void,
): { extensions: Extension[]; linear: LinearCommands } {
  const linear = createLinearExtension(options.externalMcpCommands ?? []);
  return {
    extensions: [
      ...createIdeaPacketExtensions(),
      createFrictionExtension({
        issueId: options.frictionIssueId,
        now: options.frictionNow,
        writeEvent: frictionEventWriter,
        permissionLevel: options.engineConfig?.permissionLevel ??
          options.permissionLevel ?? "strict",
      }),
      linear,
    ],
    linear: linear.linear,
  };
}

// The cataloged method surface: the default store-backed readers, resolved
// once and handed to each namespace's RPC module under server/rpc/ and to each
// extension, with the turn methods bound to the engine's session owners and
// turn runtime.
function buildHandlers(
  options: WorkbenchUnixServerOptions,
  owners: SessionOwners,
  runRuntime: TurnRuntime,
  lifetime: RuntimeLifetime,
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
  const fetchSessionLastRun = options.fetchSessionLastRun ??
    ((input: { sessionId: string }) =>
      fetchWorkbenchSessionLastRun({ ...input, events: store().events }));
  const countSessionEvents = options.countSessionEvents ??
    ((input: { sessionId: string }) =>
      countWorkbenchSessionEvents({ ...input, events: store().events }));
  const frictionEventWriter = options.frictionEventWriter ??
    (async (event: EventInsert) => {
      await store().journal.commit({ events: [event] });
    });
  const { extensions, linear } = composeExtensions(
    options,
    frictionEventWriter,
  );
  return {
    ...buildRuntimeHandlers({
      ...options,
      loadModels,
      activity: () => ({
        clients: lifetime.clients,
        inFlightTurns: owners.inFlightTurns,
      }),
    }),
    ...buildSurfaceHandlers({ ...options, loadModels, listSessions }),
    ...buildModelsHandlers({ loadModels }),
    ...buildToolsHandlers(options),
    ...buildSessionsHandlers({
      listSessions,
      fetchSessionRecord,
      fetchSessionWorkspaceRecord,
      fetchSessionLastRun,
      countSessionEvents,
    }),
    ...buildEventsHandlers({ fetchSessionEvents }),

    ...buildExtensionHandlers(extensions, {
      fetchSessionEvents,
      fetchSessionWorkspaceRecord,
      linear,
      toolApprover: rpcToolApprover,
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
  env?: Env,
  policy?: RuntimePolicy,
): TurnRuntime {
  const externalAgentRunner: ExternalAgentRunner = {
    run: (input) =>
      runExternalAgentWorkbenchRuntime(input, {
        store: store(),
        sessionMap: acpSessions,
        ...(policy === undefined ? {} : { runPolicy: policy }),
      }),
  };
  // One set of workspace-root anchors per engine: a root anchored by the
  // first turn that touches it stays pinned for the engine's lifetime.
  const rootAnchors = new RootAnchors();
  return (input) =>
    runWorkbenchRuntime(input, {
      store: store(),
      // The session owners hold each session's budget scope, so ceiling
      // confirmations persist for their scope periods across turns.
      budgetScopes: owners,
      rootAnchors,
      externalAgentRunner,
      ...(env === undefined ? {} : { env }),
      ...(policy === undefined ? {} : { policy }),
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
  const acpSessions = options.acpSessions ??
    new AcpSessionHandleMap(
      options.policy === undefined ? {} : { runPolicy: options.policy },
    );
  // One set of session owners per engine, shared by the turn handlers and
  // the runtime they run.
  const owners = options.owners ?? new SessionOwners();
  const runRuntime = options.runRuntime ??
    composeTurnRuntime(
      () => options.store,
      owners,
      acpSessions,
      options.env,
      options.policy,
    );
  const lifetime = new RuntimeLifetime({
    autostarted: options.autostarted === true,
    inFlightTurns: () => owners.inFlightTurns,
    graceMs: options.idleGraceMs,
    onIdle: () => {
      Promise.resolve()
        .then(() => options.onIdle?.())
        .catch((err) =>
          options.onParseError?.(`onIdle error: ${summarizeError(err)}`)
        );
    },
  });
  // Assigned once the socket is bound, before any request can arrive.
  let stopAccepting = () => {};
  const onShutdown = options.onShutdown;
  const handlers = buildHandlers(
    {
      ...options,
      // A `runtime/stop` shutdown first stops admitting connections. The stop
      // handler calls this in the same synchronous step as its `ifSoleClient`
      // check, which rpc/runtime.test.ts enforces, and no connection is
      // admitted after `stopAccepting()`, which transport/uds-listener.test.ts
      // enforces.
      ...(onShutdown === undefined ? {} : {
        onShutdown: () => {
          stopAccepting();
          return onShutdown();
        },
      }),
    },
    owners,
    runRuntime,
    lifetime,
  );
  const transport = await serveUnixJsonRpc(socketPath, {
    handlers,
    onConnectionsChanged: (count) => lifetime.clientsChanged(count),
    onParseError: options.onParseError,
    onRequestSettled: async (req, res) => {
      if (req.method !== "runtime/stop") return;
      // A conditional stop (`ifSoleClient`) that was declined left the
      // runtime serving; only a stop or a failed stop ends it.
      if (
        "result" in res &&
        (res.result as { status?: unknown } | null)?.status === "declined"
      ) {
        return;
      }
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

  stopAccepting = () => transport.stopAccepting();
  lifetime.start();

  return {
    socketPath,
    async close(options: { disconnectPeers?: boolean } = {}) {
      lifetime.dispose();
      // Closing the transport first stops admitting connections before the
      // ACP cleanup is awaited; one not yet admitted is closed, as if it had
      // arrived after the stop. The asking client's
      // connection stays open for its answer when `disconnectPeers` is false.
      const transportClosed = transport.close(options);
      let shutdownError: unknown;
      try {
        await acpSessions.shutdown();
      } catch (error) {
        shutdownError = error;
      }
      await transportClosed;
      if (shutdownError !== undefined) throw shutdownError;
    },
  };
}

// Boot the engine: resolve config and secrets, build the store, check its
// columns, and serve over the default per-user socket until stopped.
async function main(): Promise<void> {
  const socketPath = resolveSocketPath();
  const autostarted = process.argv.slice(2).includes("--autostarted");
  ensureSocketDir(socketPath);
  // The code this process loaded, recorded before anything else can change
  // under it; clients compare it with their working tree.
  const fingerprint = await codeFingerprint(prototypeSourceDir());

  // Engine config (defaults → ~/.dyfj/config.toml → env), resolved once at the
  // boundary and passed into the runtime; a malformed config fails the boot loudly.
  const config = await loadConfig();

  // Resolve declared secret pointers into the process env BEFORE the runtime
  // reads them (providers via getEnv, recall via DYFJ_MEMORY_MCP_TOKEN). env wins;
  // presence-only logging; a locked/unavailable pointer degrades that provider
  // fail-closed rather than hanging on a prompt. No [secrets] section → no-op, so
  // a plain local-only boot is unchanged.
  const secretsConfig = await loadSecretsConfig();
  const mcpServers = await loadMcpServersConfig({}, secretsConfig);
  // The runtime policy, composed from the same sources the launcher composes
  // its grants from, and enforced at every seam below: the secrets resolver,
  // MCP discovery and calls, the Dolt pool, provider calls, memory recall and
  // the ACP runner. An insecure memory endpoint fails the boot here.
  const { policy, resolvedSecrets, doltConnection } = await composeBoot({
    env: processEnv,
    mcpServers,
    secrets: secretsConfig,
    networkAllow: await loadNetworkAllow(),
    nameserverGrants: await readNameserverNetGrants(),
  });
  const externalMcp = await buildExternalMcpCommands(
    mcpServers,
    resolvedSecrets.named,
    // The Linear extension builds the bounded issue-creation command.
    { buildIssueCreationCommand: buildLinearIssueCreationCommand, policy },
  );
  // The same lines go to `runtime/status`, so `dyfj status` shows them too.
  const externalMcpLines = externalMcp.diagnostics.map(
    formatExternalMcpDiagnostic,
  );
  for (const line of externalMcpLines) console.error(line);

  // The runtime's one store over one Dolt pool. Connections open on first use,
  // so the boot does not wait for (or require) a running sql-server.
  const store = new DoltStore(createDoltPool(doltConnection, policy));

  // Boot-time column check: a reachable database that predates a migration in
  // schema/migrations/ fails the boot loudly, naming the missing columns. A
  // database that cannot be reached or used yet (connection, authentication,
  // unknown database, or no answer within the bound) is left to fail on first
  // use, as before; any other failure of the check fails the boot too.
  try {
    await checkColumnsAtBoot(store);
  } catch (error) {
    await store.close().catch(() => {});
    throw error;
  }

  let resolveCloseServer!: (close: () => Promise<void>) => void;
  const closeServerReady = new Promise<() => Promise<void>>((resolve) => {
    resolveCloseServer = resolve;
  });
  // What a pending shutdown waits on, for a repeated Ctrl-C to report. Only
  // the shutdown below advances it.
  let shutdownStage = "the runtime to finish starting";
  installRuntimeSigintHandler({
    autostarted,
    close: async () => await (await closeServerReady)(),
    signals: {
      add: (handler) => {
        process.on("SIGINT", handler);
      },
    },
    exit: (code) => process.exit(code),
    say: (line) => console.error(line),
    waitingOn: () => shutdownStage,
  });

  let serverInstance:
    | { close(options?: { disconnectPeers?: boolean }): Promise<void> }
    | undefined;

  const closeRuntime = async (
    options?: { disconnectPeers?: boolean },
  ) => {
    if (serverInstance) await serverInstance.close(options);
  };

  // The store (and its pool) belongs to this composition root. It closes once,
  // after the server, whichever shutdown path runs first.
  let storeClosed: Promise<void> | undefined;
  const closeStore = () => (storeClosed ??= store.close());

  const shutdown = async (
    options?: { disconnectPeers?: boolean },
  ) => {
    try {
      shutdownStage =
        "the server to close its client connections and warm ACP sessions";
      await closeRuntime(options);
    } catch (error) {
      // A closed-resource error from the runtime's own handles is tolerated.
      // The node:net listener swallows its own close errors, so only a runtime
      // resource elsewhere in the close path (the runners) can raise it. The
      // runner leaf of the Node runtime track removes this branch.
      if (!(error instanceof Error && error.name === "BadResource")) {
        // The server's close failure is the one to report.
        await closeStore().catch(() => {});
        throw error;
      }
    }
    shutdownStage = "the Dolt store's connection pool to close";
    await closeStore();
  };

  try {
    const server = await serveWorkbenchUnix(socketPath, {
      onParseError: (detail) => console.error(`[uds] ${detail}`),
      store,
      engineConfig: config,
      policy,
      externalMcpCommands: externalMcp.commands,
      frictionIssueId: processEnv.get("DYFJ_FRICTION_ISSUE_ID")?.trim() ||
        undefined,
      autostarted,
      fingerprint,
      unavailableSecrets: unavailableSecretPointers(resolvedSecrets),
      externalMcp: externalMcpLines,
      onShutdown: () => shutdown({ disconnectPeers: false }),
      // The same shutdown SIGINT runs: close the server (which reaps the
      // warm ACP sessions and their children), then the store.
      onIdle: async () => {
        console.error(
          `dyfj runtime: no client for ${
            AUTOSTARTED_IDLE_GRACE_MS / 1000
          } s; stopping`,
        );
        let code = 0;
        try {
          await shutdown();
        } catch (error) {
          console.error(
            `dyfj runtime: shutdown failed: ${summarizeError(error)}`,
          );
          code = 1;
        }
        process.exit(code);
      },
      onStopComplete: (code) => {
        process.exit(code);
      },
    });
    serverInstance = server;
    resolveCloseServer(() => shutdown());
    console.error(
      `dyfj runtime: JSON-RPC over UDS at ${socketPath}  ${
        autostarted
          ? `(autostarted; stops ${
            AUTOSTARTED_IDLE_GRACE_MS / 1000
          } s after its last client disconnects)`
          : "(ctrl-c to stop)"
      }`,
    );
    console.error(
      `dyfj runtime: code ${fingerprint.head.slice(0, 12)} · ${
        fingerprint.contentHash.slice(0, 19)
      }`,
    );
  } catch (error) {
    resolveCloseServer(() => Promise.reject(error));
    await closeStore().catch(() => {});
    throw error;
  }
}

if (import.meta.main) await main();
