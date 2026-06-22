// Thin Unix-socket JSON-RPC client for the workbench CLI/TUI/GUI.
// Engine-free: imports only the protocol core + peer, never the runtime — so the
// client binary stays small and can migrate to Rust under the same contract.

import { JsonRpcPeer } from "./jsonrpc-peer";
import type { RpcHandlers } from "./jsonrpc";

export interface UnixClient {
  request(method: string, params?: unknown): Promise<unknown>;
  close(): void;
}

export interface ToolApprovalVerdict {
  decision: "approve" | "deny";
  reason?: string;
}

export interface UnixClientOptions {
  /**
   * Handle `stream` notifications the server emits during a streaming `turn`
   * (the params are a TurnStreamFrame). Registered as the peer's `stream`
   * notification handler for the lifetime of the connection.
   */
  onStream?: (params: unknown) => void;
  /**
   * Answer the server's mid-turn `approval` request (the operator approving a
   * mutating tool). Registered as the peer's `approval` request handler; the
   * returned verdict is sent back as the response. Without it the peer has no
   * `approval` handler, so the server's request fails and it denies — fail-closed.
   */
  onApproval?: (
    request: unknown,
  ) => Promise<ToolApprovalVerdict> | ToolApprovalVerdict;
}

export async function connectUnixClient(
  socketPath: string,
  options: UnixClientOptions = {},
): Promise<UnixClient> {
  const handlers: RpcHandlers = {};
  const onStream = options.onStream;
  if (onStream) {
    handlers.stream = (params) => {
      onStream(params);
    };
  }
  const onApproval = options.onApproval;
  if (onApproval) {
    handlers.approval = (params) => onApproval(params);
  }
  const conn = await Deno.connect({ transport: "unix", path: socketPath });
  const peer = new JsonRpcPeer(conn, { handlers });
  void peer.run();
  return {
    request: (method, params) => peer.request(method, params),
    close: () => peer.close(),
  };
}
