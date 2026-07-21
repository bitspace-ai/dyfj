// JSON-RPC 2.0 protocol core for the Workbench transport seam.
//
// Hand-rolled (no SDK) so it stays small and ports to Rust line-for-line per the
// rust-core-sequencing thesis. Pure framing + classification + dispatch; entirely
// transport-agnostic — the UDS server peer, the CLI client, and the WS path all
// build on this. The wire shape and error codes follow the transport-seam contract.

import { DomainError, summarizeError } from "./turn-contract";

export const JSONRPC_VERSION = "2.0";

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: typeof JSONRPC_VERSION;
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: typeof JSONRPC_VERSION;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: typeof JSONRPC_VERSION;
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: typeof JSONRPC_VERSION;
  id: JsonRpcId | null;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcErrorResponse;
export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcResponse;

// JSON-RPC standard codes + the DYFJ fail-closed application range (see the
// transport-seam contract): these map the runtime's fail-closed semantics onto
// JSON-RPC error responses.
export const RpcErrorCode = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  // DYFJ application range
  paidNotApproved: -32010,
  budgetExceeded: -32011,
  modelUnavailable: -32012,
  remoteCannotSpend: -32013,
} as const;

// A typed error a method handler can throw; dispatchRequest maps it to a
// JSON-RPC error response carrying the same code/data. Every construction
// site passes an app-composed message (a validation reason, an unknown-tool
// name, an upstream error already sanitized by its own producer) — never a
// caught driver/dependency error's raw message — so it extends DomainError:
// summarizeError trusts its message enough to forward it.
export class RpcError extends DomainError {
  readonly code: number;
  readonly data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}

// --- framing: newline-delimited JSON (UDS local; identical messages ride WS
// text frames on the tailnet/browser path) ---

export function encodeFrame(message: JsonRpcMessage): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(message) + "\n");
}

export interface DecodedFrame {
  ok: boolean;
  message?: JsonRpcMessage;
  error?: string; // parse-error detail when ok === false
}

// Buffers partial input and yields one DecodedFrame per newline-terminated line.
// A malformed line is reported as { ok: false } rather than thrown, so a bad
// frame never tears down the connection loop.
export class FrameDecoder {
  #buf = "";
  readonly #maxBytes?: number;

  // maxBytes bounds the partial-line buffer so a newline-less stream cannot
  // exhaust memory once a remote transport is wired (the Codex forward item).
  // undefined = unbounded, which is fine for the trusted local UDS.
  constructor(maxBytes?: number) {
    this.#maxBytes = maxBytes;
  }

  push(chunk: string): DecodedFrame[] {
    this.#buf += chunk;
    const out: DecodedFrame[] = [];
    let i: number;
    while ((i = this.#buf.indexOf("\n")) >= 0) {
      const line = this.#buf.slice(0, i).trim();
      this.#buf = this.#buf.slice(i + 1);
      if (!line) continue;
      try {
        out.push({ ok: true, message: JSON.parse(line) as JsonRpcMessage });
      } catch (err) {
        out.push({ ok: false, error: (err as Error).message });
      }
    }
    if (this.#maxBytes !== undefined && this.#buf.length > this.#maxBytes) {
      out.push({ ok: false, error: `frame exceeds ${this.#maxBytes} bytes` });
      this.#buf = "";
    }
    return out;
  }
}

// --- classification ---

export type MessageKind = "request" | "notification" | "response" | "invalid";

export function classify(message: unknown): MessageKind {
  if (typeof message !== "object" || message === null) return "invalid";
  const m = message as Record<string, unknown>;
  if (m.jsonrpc !== JSONRPC_VERSION) return "invalid";
  const hasId = "id" in m &&
    (typeof m.id === "string" || typeof m.id === "number");
  if (typeof m.method === "string") return hasId ? "request" : "notification";
  if (hasId && ("result" in m || "error" in m)) return "response";
  return "invalid";
}

// --- envelope builders ---

export function success(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

export function failure(
  id: JsonRpcId | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcErrorResponse {
  const error: JsonRpcErrorObject = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: JSONRPC_VERSION, id, error };
}

export function notification(
  method: string,
  params?: unknown,
): JsonRpcNotification {
  const msg: JsonRpcNotification = { jsonrpc: JSONRPC_VERSION, method };
  if (params !== undefined) msg.params = params;
  return msg;
}

// --- request dispatch ---

// Context a handler receives so it can stream `notify` notifications and issue
// server-initiated `request`s (the mid-turn approval round-trip) while it runs.
// The peer supplies the concrete implementation bound to its connection; the
// pure core only declares the shape and a no-op default.
export interface RpcContext {
  notify(method: string, params?: unknown): Promise<void>;
  request(method: string, params?: unknown): Promise<unknown>;
}

export type RpcHandler = (
  params: unknown,
  ctx: RpcContext,
) => Promise<unknown> | unknown;
export type RpcHandlers = Record<string, RpcHandler>;

const NOOP_CONTEXT: RpcContext = {
  notify: () => Promise.resolve(),
  request: () => Promise.reject(new Error("no peer context for this request")),
};

// Run one request against the handler map, producing a response envelope. A
// thrown RpcError maps to its code; any other throw maps to internalError, so a
// handler bug becomes a clean error response rather than a dropped connection.
export async function dispatchRequest(
  req: JsonRpcRequest,
  handlers: RpcHandlers,
  ctx: RpcContext = NOOP_CONTEXT,
): Promise<JsonRpcResponse> {
  const handler = handlers[req.method];
  if (!handler) {
    return failure(
      req.id,
      RpcErrorCode.methodNotFound,
      `method not found: ${req.method}`,
    );
  }
  try {
    return success(req.id, await handler(req.params, ctx));
  } catch (err) {
    if (err instanceof RpcError) {
      // RpcError is a DomainError, so this is the capped-passthrough branch
      // of summarizeError, not the foreign one — existing short messages are
      // returned byte-identical; an unusually long one still gets the same
      // 500-byte cap every other DomainError gets, rather than bypassing it.
      return failure(req.id, err.code, summarizeError(err), err.data);
    }
    // A non-RpcError throw is, by definition, an error this handler did not
    // construct deliberately — a caught driver/dependency error whose
    // message can embed an arbitrary payload (the original defect's exact
    // shape: a rejected event-log INSERT's message quoting the whole
    // rejected value back). summarizeError renders it as class + byte count
    // only; a genuine internal error still gets a response, just not one
    // that can leak.
    return failure(
      req.id,
      RpcErrorCode.internalError,
      summarizeError(err),
    );
  }
}
