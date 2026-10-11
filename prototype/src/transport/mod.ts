/**
 * transport/ (L2): the JSON-RPC 2.0 process seam over Unix sockets.
 *
 * Responsibility: the JSON-RPC codec (envelope types and builders, error
 * codes, newline-delimited framing, message classification), request
 * dispatch, the duplex connection peer, the byte-stream connection ports and
 * their node:net adapter (the only module that imports node:net), socket-path
 * resolution, and the two socket ends: the client connect (`connectUnixClient`) and the server
 * bind/accept loop (`serveUnixJsonRpc`), and the request-parameter
 * sanitizers every method module runs its params through. Method handlers are
 * supplied by the caller; nothing here knows what a method does. The wire
 * format is also spoken by the Rust REPL client in `core/dyfj-repl`, so
 * framing, method names, error codes and socket-path resolution must stay
 * byte-identical.
 *
 * Allowed dependencies: `kernel/`, `contract/`, `config/` (the `Env` port).
 */

export {
  classify,
  type DecodedFrame,
  dispatchRequest,
  encodeFrame,
  failure,
  FrameDecoder,
  JSONRPC_VERSION,
  type JsonRpcErrorObject,
  type JsonRpcErrorResponse,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcSuccess,
  type MessageKind,
  notification,
  request,
  type RpcContext,
  RpcError,
  RpcErrorCode,
  type RpcHandler,
  type RpcHandlers,
  success,
} from "./jsonrpc.ts";
export {
  asRecord,
  sanitizeRpcIdentifier,
  sanitizeRpcString,
} from "./rpc-params.ts";
export type {
  ByteConnection,
  ConnectionListener,
  SocketHost,
} from "./connection.ts";
export { nodeSocketHost } from "./node-socket.ts";
export { JsonRpcPeer, type JsonRpcPeerOptions } from "./jsonrpc-peer.ts";
export { ensureSocketDir, resolveSocketPath } from "./uds-path.ts";
export {
  connectUnixClient,
  type ToolApprovalVerdict,
  type UnixClient,
  type UnixClientOptions,
} from "./uds-client.ts";
export {
  assertSocketBindable,
  serveUnixJsonRpc,
  type UnixJsonRpcServer,
  type UnixJsonRpcServerOptions,
} from "./uds-listener.ts";
