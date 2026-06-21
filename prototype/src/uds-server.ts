// Serve the workbench JSON-RPC seam over a Unix domain socket (BIT-230). UDS is
// the canonical `loopback` transport — full clearance, gated by filesystem perms
// — per the transport-seam contract. This slice wires the read-only methods;
// `turn` streaming and the server-initiated `approval` request land with BIT-116.

import {
  defaultLocalWorkbenchModels,
  loadWorkbenchModels,
  type WorkbenchModel,
  withDefaultLocalWorkbenchModels,
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

export interface WorkbenchUnixServerOptions {
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
      if (asOf !== undefined && (typeof asOf !== "string" || !isValidAsOfTimestamp(asOf))) {
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
    throw new Error(`refusing to bind: ${socketPath} exists and is not a socket`);
  }
  Deno.removeSync(socketPath);
}

export function serveWorkbenchUnix(
  socketPath: string,
  options: WorkbenchUnixServerOptions = {},
): WorkbenchUnixServer {
  clearStaleSocket(socketPath);

  const handlers = buildReadHandlers(options);
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
