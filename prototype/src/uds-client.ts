// Thin Unix-socket JSON-RPC client for the workbench CLI/TUI/GUI.
// Engine-free: imports only the protocol core + peer, never the runtime — so the
// client binary stays small and can migrate to Rust under the same contract.

import { JsonRpcPeer } from "./jsonrpc-peer";
import type { RpcHandlers } from "./jsonrpc";

export interface UnixClient {
  request(
    method: string,
    params?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown>;
  close(): void;
}

export type ToolApprovalVerdict =
  | { decision: "approve" | "deny" | "abort"; reason?: string }
  | { decision: "select"; optionId: string };

export interface UnixClientOptions {
  /**
   * Handle `stream` notifications the server emits during a streaming `turn`
   * (the params are a TurnStreamFrame). Registered as the peer's `stream`
   * notification handler for the lifetime of the connection.
   */
  onStream?: (params: unknown) => void;
  /**
   * Answer the server's mid-turn `approval` request (a mutating tool, budget
   * gate, or exact ACP permission option). Registered as the peer's `approval`
   * request handler; the returned verdict is sent back as the response. Without
   * it the peer has no `approval` handler, so the server fails closed.
   */
  onApproval?: (
    request: unknown,
  ) => Promise<ToolApprovalVerdict> | ToolApprovalVerdict;
}

export async function connectUnixClient(
  socketPath: string,
  options: UnixClientOptions = {},
  signal?: AbortSignal,
): Promise<UnixClient> {
  if (signal?.aborted) {
    throw signal.reason ??
      new DOMException("The operation was aborted", "AbortError");
  }
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
  let conn: Deno.Conn;
  if (signal) {
    let onAbort: (() => void) | undefined;
    const abortPromise = new Promise<never>((_, reject) => {
      onAbort = () =>
        reject(
          signal.reason ??
            new DOMException("The operation was aborted", "AbortError"),
        );
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      conn = await Promise.race([
        Deno.connect({ transport: "unix", path: socketPath }),
        abortPromise,
      ]);
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  } else {
    conn = await Deno.connect({ transport: "unix", path: socketPath });
  }
  const peer = new JsonRpcPeer(conn, { handlers });
  void peer.run();
  return {
    request: (method, params, reqSignal) =>
      peer.request(method, params, reqSignal),
    close: () => peer.close(),
  };
}
