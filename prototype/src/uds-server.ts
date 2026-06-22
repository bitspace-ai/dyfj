// Serve the workbench JSON-RPC seam over a Unix domain socket. UDS is
// the canonical `loopback` transport — full clearance, gated by filesystem perms
// — per the transport-seam contract. Wires the read-only methods plus `turn`,
// which runs an agentic turn over the shared turn-runner core and streams text
// deltas + runtime events back as `stream` notifications. The server-initiated
// `approval` request (mutating tools) lands with the mutating-tools slice.

import {
  defaultLocalWorkbenchModels,
  loadWorkbenchModels,
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
import type { TurnStreamFrame } from "./turn-contract";
import {
  executeTurn,
  resolveTurnFromBody,
  type TurnRequestBody,
  type WorkbenchHttpRuntime,
} from "./turn-runner";
import type { ToolApprovalVerdict } from "./commands";

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

// The read-only method surface, reusing the same runtime functions the REST
// endpoints use so the two transports stay in parity.
export function buildReadHandlers(
  options: WorkbenchUnixServerOptions = {},
): RpcHandlers {
  const loadModels = options.loadModels ?? loadPickerModels;
  const listSessions = options.listSessions ?? listWorkbenchSessions;
  const fetchSessionEvents = options.fetchSessionEvents ??
    fetchWorkbenchSessionEvents;

  return {
    "models/list": async () => ({ models: await loadModels() }),

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

  return {
    turn: async (params, ctx) => {
      const resolved = resolveTurnFromBody(
        asRecord(params) as TurnRequestBody,
        true,
      );
      if ("error" in resolved) {
        throw new RpcError(RpcErrorCode.invalidParams, resolved.error);
      }
      return await executeTurn(resolved, {
        authContext: UDS_LOOPBACK_AUTH,
        loopback: true,
        runRuntime,
        fetchSessionEvents,
        // mid-turn approval over the duplex channel — the server asks
        // the connected client to approve a mutating tool; the client's response
        // is the verdict. A failed request (no client approver, dropped
        // connection) denies, fail-closed.
        confirmToolApproval: (request) =>
          ctx.request("approval", request).then(
            toApprovalVerdict,
            (): ToolApprovalVerdict => ({
              decision: "deny",
              reason: "approval request failed (no client approver?)",
            }),
          ),
        // Stream frames mirror the HTTP SSE frame shape (TurnStreamFrame) so a
        // client can reuse one frame handler across both transports.
        onTextDelta: (text) =>
          void ctx.notify(
            "stream",
            { t: "delta", text } satisfies TurnStreamFrame,
          ),
        onRuntimeEvent: (event) =>
          void ctx.notify(
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

// Clear a stale socket from a prior unclean exit — but only if the path is
// actually a socket, never an arbitrary file/dir (the Codex hardening item).
function clearStaleSocket(socketPath: string): void {
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
  Deno.removeSync(socketPath);
}

export function serveWorkbenchUnix(
  socketPath: string,
  options: WorkbenchUnixServerOptions = {},
): WorkbenchUnixServer {
  clearStaleSocket(socketPath);

  const handlers: RpcHandlers = {
    ...buildReadHandlers(options),
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
