// Server side of the Unix-socket transport: bind the socket safely, accept
// connections, and run one JsonRpcPeer per connection over a shared handler
// map. Engine-free: the caller supplies the handlers, so this module knows
// nothing about the methods it serves.

import { JsonRpcPeer, type JsonRpcPeerOptions } from "./jsonrpc-peer.ts";
import type { RpcHandlers } from "./jsonrpc.ts";

export interface UnixJsonRpcServerOptions {
  /** Requests and notifications on every connection are dispatched here. */
  handlers: RpcHandlers;
  /** Passed to each connection's peer. */
  onParseError?: JsonRpcPeerOptions["onParseError"];
  /** Passed to each connection's peer. */
  onRequestSettled?: JsonRpcPeerOptions["onRequestSettled"];
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

// Bind `socketPath` (after assertSocketBindable) and serve JSON-RPC on it
// until close(). Each accepted connection gets its own peer; all peers share
// the one handler map.
export async function serveUnixJsonRpc(
  socketPath: string,
  options: UnixJsonRpcServerOptions,
): Promise<UnixJsonRpcServer> {
  await assertSocketBindable(socketPath);

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
        handlers: options.handlers,
        onParseError: options.onParseError,
        onRequestSettled: options.onRequestSettled,
      });
      peers.add(peer);
      peer.run().finally(() => peers.delete(peer));
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
        await Deno.remove(socketPath);
      } catch {
        // already gone
      }
    },
  };
}
