// Thin Unix-socket JSON-RPC client for the workbench CLI/TUI/GUI (BIT-230).
// Engine-free: imports only the protocol core + peer, never the runtime — so the
// client binary stays small and can migrate to Rust under the same contract.

import { JsonRpcPeer } from "./jsonrpc-peer";

export interface UnixClient {
  request(method: string, params?: unknown): Promise<unknown>;
  close(): void;
}

export async function connectUnixClient(socketPath: string): Promise<UnixClient> {
  const conn = await Deno.connect({ transport: "unix", path: socketPath });
  const peer = new JsonRpcPeer(conn);
  void peer.run();
  return {
    request: (method, params) => peer.request(method, params),
    close: () => peer.close(),
  };
}
