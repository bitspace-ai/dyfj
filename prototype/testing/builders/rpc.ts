// Drive an RPC handler map the way the server dispatches a request, without a
// socket: the same `dispatchRequest` the UDS listener runs, so a handler's
// thrown RpcError becomes the error response a client would receive.
// `rpcFailure` returns that response's error object for inspection.

import {
  dispatchRequest,
  type JsonRpcErrorObject,
  type RpcContext,
  type RpcHandlers,
} from "../../src/transport/mod.ts";

/**
 * The result of a successful call. On an error response it throws a plain
 * `Error` naming the code and message; use `rpcFailure` to assert on them.
 */
export async function callRpc(
  handlers: RpcHandlers,
  method: string,
  params?: unknown,
  ctx?: RpcContext,
): Promise<unknown> {
  const response = await dispatchRequest(
    { jsonrpc: "2.0", id: 1, method, params },
    handlers,
    ctx,
  );
  if ("error" in response) {
    throw new Error(
      `${method} failed (${response.error.code}): ${response.error.message}`,
    );
  }
  return response.result;
}

/** The error object of a failed call; throws if the call succeeded. */
export async function rpcFailure(
  handlers: RpcHandlers,
  method: string,
  params?: unknown,
  ctx?: RpcContext,
): Promise<JsonRpcErrorObject> {
  const response = await dispatchRequest(
    { jsonrpc: "2.0", id: 1, method, params },
    handlers,
    ctx,
  );
  if (!("error" in response)) {
    throw new Error(`${method} succeeded; expected an error response`);
  }
  return response.error;
}
