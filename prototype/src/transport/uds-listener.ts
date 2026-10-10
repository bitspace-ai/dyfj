// Server side of the Unix-socket transport: bind the socket safely, accept
// connections, and run one JsonRpcPeer per connection over a shared handler
// map. Engine-free: the caller supplies the handlers, so this module knows
// nothing about the methods it serves.

import { lstatSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { SocketHost } from "./connection.ts";
import { JsonRpcPeer, type JsonRpcPeerOptions } from "./jsonrpc-peer.ts";
import type { RpcHandlers } from "./jsonrpc.ts";
import { nodeSocketHost } from "./node-socket.ts";

export interface UnixJsonRpcServerOptions {
  /** Requests and notifications on every connection are dispatched here. */
  handlers: RpcHandlers;
  /** Passed to each connection's peer. */
  onParseError?: JsonRpcPeerOptions["onParseError"];
  /** Passed to each connection's peer. */
  onRequestSettled?: JsonRpcPeerOptions["onRequestSettled"];
  /** The socket implementation; defaults to the node:net adapter. */
  host?: SocketHost;
}

export interface UnixJsonRpcServer {
  readonly socketPath: string;
  /**
   * Stop accepting, close every open connection unless `disconnectPeers` is
   * false, and remove the socket file.
   */
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
export async function assertSocketBindable(
  socketPath: string,
  host: SocketHost = nodeSocketHost,
): Promise<void> {
  let isSocket: boolean;
  try {
    isSocket = lstatSync(socketPath).isSocket();
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return;
    throw err;
  }
  if (!isSocket) {
    throw new Error(
      `refusing to bind: ${socketPath} exists and is not a socket`,
    );
  }
  let live;
  try {
    live = await host.connect(socketPath);
  } catch {
    // Nothing answered: a stale socket from an unclean exit. Clear it.
    rmSync(socketPath);
    return;
  }
  live.close();
  throw new Error(
    `refusing to bind: a live runtime is already serving on ${socketPath} ` +
      `(inspect with: dyfj status; stop it before starting another)`,
  );
}

// Bind `socketPath` (after assertSocketBindable) and serve JSON-RPC on it
// until close(). Each accepted connection gets its own peer; all peers share
// the one handler map.
export async function serveUnixJsonRpc(
  socketPath: string,
  options: UnixJsonRpcServerOptions,
): Promise<UnixJsonRpcServer> {
  const host = options.host ?? nodeSocketHost;
  await assertSocketBindable(socketPath, host);

  const listener = await host.listen(socketPath);
  const peers = new Set<JsonRpcPeer>();

  (async () => {
    for (;;) {
      let conn;
      try {
        conn = await listener.accept();
      } catch {
        break; // listener failed
      }
      if (conn === null) break; // listener closed
      const peer = new JsonRpcPeer(conn, {
        handlers: options.handlers,
        onParseError: options.onParseError,
        onRequestSettled: options.onRequestSettled,
      });
      peers.add(peer);
      // The read loop ends when the client disconnects. Once the requests it
      // already sent are answered, close this side too, so a finished
      // connection releases its resources when it ends.
      peer.run().then(() => peer.settled()).finally(() => {
        peers.delete(peer);
        peer.close();
      });
    }
  })();

  return {
    socketPath,
    async close(closeOptions: { disconnectPeers?: boolean } = {}) {
      try {
        listener.close();
      } catch {
        // already closed
      }
      if (closeOptions.disconnectPeers !== false) {
        for (const peer of peers) peer.close();
        peers.clear();
      }
      try {
        await rm(socketPath);
      } catch {
        // already gone
      }
    },
  };
}
