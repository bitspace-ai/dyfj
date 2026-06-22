// A bidirectional JSON-RPC 2.0 endpoint over a byte-stream connection — a Deno
// UDS conn locally, a TCP/WebSocket conn remotely. Symmetric: both the
// server peer and the client peer use this. Each registers handlers for the
// requests it answers and calls request()/notify() for the messages it
// initiates. The server-initiated request() carries the mid-turn `approval`
// round-trip for the approval keystone. Built on the pure jsonrpc.ts core.

import {
  classify,
  dispatchRequest,
  encodeFrame,
  FrameDecoder,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcResponse,
  notification,
  type RpcContext,
  RpcError,
  type RpcHandlers,
} from "./jsonrpc";

export interface JsonRpcPeerOptions {
  /** Incoming requests (and matching notifications) are dispatched here. */
  handlers?: RpcHandlers;
  /** Called for malformed frames and invalid messages; never throws back. */
  onParseError?: (detail: string) => void;
  /** Partial-frame buffer bound (DoS guard, important once remote). */
  maxFrameBytes?: number;
}

const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

export class JsonRpcPeer {
  readonly #conn: Deno.Conn;
  readonly #handlers: RpcHandlers;
  readonly #decoder: FrameDecoder;
  readonly #onParseError?: (detail: string) => void;
  readonly #pending = new Map<JsonRpcId, Pending>();
  #nextId = 0;
  #closed = false;
  #writeChain: Promise<void> = Promise.resolve();

  constructor(conn: Deno.Conn, options: JsonRpcPeerOptions = {}) {
    this.#conn = conn;
    this.#handlers = options.handlers ?? {};
    this.#onParseError = options.onParseError;
    this.#decoder = new FrameDecoder(
      options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
    );
  }

  // conn.write() may write fewer bytes than requested, so a large frame must be
  // written in a loop — otherwise a big response is truncated on the wire and the
  // peer's FrameDecoder waits forever for the missing newline.
  async #writeAll(bytes: Uint8Array): Promise<void> {
    let offset = 0;
    while (offset < bytes.length) {
      offset += await this.#conn.write(
        offset === 0 ? bytes : bytes.subarray(offset),
      );
    }
  }

  // Writes are serialized so concurrent notify()/request()/responses never
  // interleave partial frames on the wire.
  #write(message: JsonRpcMessage): Promise<void> {
    const bytes = encodeFrame(message);
    const result = this.#writeChain.then(() => this.#writeAll(bytes));
    this.#writeChain = result.catch(() => {});
    return result;
  }

  notify(method: string, params?: unknown): Promise<void> {
    return this.#write(notification(method, params));
  }

  // Initiate a request to the peer; resolves with its result, or rejects with an
  // RpcError if the peer returns an error response.
  request(method: string, params?: unknown): Promise<unknown> {
    const id = `p${++this.#nextId}`;
    const message: JsonRpcRequest = params === undefined
      ? { jsonrpc: "2.0", id, method }
      : { jsonrpc: "2.0", id, method, params };
    return new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#write(message).catch((err) => {
        this.#pending.delete(id);
        reject(err);
      });
    });
  }

  // Read loop; resolves when the connection closes.
  async run(): Promise<void> {
    const buf = new Uint8Array(4096);
    const decoder = new TextDecoder();
    try {
      while (!this.#closed) {
        let n: number | null;
        try {
          n = await this.#conn.read(buf);
        } catch {
          break; // connection closed under us
        }
        if (n === null) break;
        for (
          const frame of this.#decoder.push(decoder.decode(buf.subarray(0, n)))
        ) {
          if (!frame.ok) {
            this.#onParseError?.(frame.error ?? "parse error");
            continue;
          }
          // Handle concurrently: never block the read loop on a slow handler, or
          // a long-running `turn` would wedge `turn/cancel` and every other
          // request on the connection. Writes stay serialized via #write.
          void this.#handle(frame.message as JsonRpcMessage).catch((err) => {
            this.#onParseError?.(`handler error: ${(err as Error)?.message}`);
          });
        }
      }
    } finally {
      this.#failPending(new Error("connection closed"));
    }
  }

  // A context bound to this connection, so a handler can stream notifications and
  // issue server-initiated requests (e.g. the mid-turn approval) while it runs.
  #context(): RpcContext {
    return {
      notify: (method, params) => this.notify(method, params),
      request: (method, params) => this.request(method, params),
    };
  }

  async #handle(message: JsonRpcMessage): Promise<void> {
    switch (classify(message)) {
      case "request": {
        const response = await dispatchRequest(
          message as JsonRpcRequest,
          this.#handlers,
          this.#context(),
        );
        await this.#write(response);
        return;
      }
      case "response": {
        const response = message as JsonRpcResponse;
        if (response.id === null) return;
        const pending = this.#pending.get(response.id);
        if (!pending) return;
        this.#pending.delete(response.id);
        if ("result" in response) {
          pending.resolve(response.result);
        } else {
          pending.reject(
            new RpcError(
              response.error.code,
              response.error.message,
              response.error.data,
            ),
          );
        }
        return;
      }
      case "notification": {
        const handler = this.#handlers[(message as { method: string }).method];
        if (handler) {
          try {
            await handler(
              (message as { params?: unknown }).params,
              this.#context(),
            );
          } catch {
            // Notifications never error back to the sender.
          }
        }
        return;
      }
      case "invalid":
        this.#onParseError?.("invalid message");
        return;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#conn.close();
    } catch {
      // already closed
    }
    this.#failPending(new Error("connection closed"));
  }

  #failPending(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}
