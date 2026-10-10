// The node:net adapter for the connection ports: Unix-domain sockets. The one
// module that imports node:net (scripts/arch-layers.json confines it to
// transport/). A socket is push-style (events); the ports are pull-style, so
// each connection keeps a queue and pauses the socket while a chunk waits.
//
// Every socket opens with allowHalfOpen: true, at both ends. With the default,
// a socket ends its own write side when the other side sends FIN, so a reply
// to a request that arrived just before the FIN is lost.

import net from "node:net";
import type {
  ByteConnection,
  ConnectionListener,
  SocketHost,
} from "./connection.ts";

class NodeConnection implements ByteConnection {
  readonly #socket: net.Socket;
  readonly #chunks: Uint8Array[] = [];
  #ended = false;
  // The socket is gone, from either side: writes reject.
  #closed = false;
  // close() was called here: nothing buffered may be read any more.
  #released = false;
  #wake?: () => void;

  constructor(socket: net.Socket) {
    this.#socket = socket;
    socket.on("data", (chunk: Uint8Array) => {
      if (chunk.length === 0) return;
      this.#chunks.push(chunk);
      // One chunk in flight: the next read() resumes the socket.
      socket.pause();
      this.#signal();
    });
    socket.on("end", () => {
      this.#ended = true;
      this.#signal();
    });
    socket.on("close", () => {
      this.#ended = true;
      this.#closed = true;
      this.#signal();
    });
    // A socket error always ends the stream; reads see it as the end and
    // writes see it through their callback or the closed flag.
    socket.on("error", () => {
      this.#ended = true;
      this.#signal();
    });
  }

  #signal(): void {
    const wake = this.#wake;
    this.#wake = undefined;
    wake?.();
  }

  async read(): Promise<Uint8Array | null> {
    for (;;) {
      if (this.#released) return null;
      const chunk = this.#chunks.shift();
      if (chunk !== undefined) {
        if (this.#chunks.length === 0 && !this.#ended) this.#socket.resume();
        return chunk;
      }
      if (this.#ended) return null;
      await new Promise<void>((resolve) => this.#wake = resolve);
    }
  }

  write(bytes: Uint8Array): Promise<void> {
    if (this.#closed || this.#socket.destroyed) {
      return Promise.reject(new Error("connection closed"));
    }
    return new Promise<void>((resolve, reject) => {
      this.#socket.write(bytes, (error) => error ? reject(error) : resolve());
    });
  }

  close(): void {
    if (this.#released) return;
    this.#released = true;
    this.#closed = true;
    this.#ended = true;
    this.#chunks.length = 0;
    this.#socket.destroy();
    this.#signal();
  }
}

class NodeListener implements ConnectionListener {
  readonly #server: net.Server;
  readonly #accepted: ByteConnection[] = [];
  #closed = false;
  #wake?: () => void;

  constructor(server: net.Server) {
    this.#server = server;
    server.on("connection", (socket: net.Socket) => {
      const conn = new NodeConnection(socket);
      if (this.#closed) {
        conn.close();
        return;
      }
      this.#accepted.push(conn);
      this.#signal();
    });
  }

  #signal(): void {
    const wake = this.#wake;
    this.#wake = undefined;
    wake?.();
  }

  async accept(): Promise<ByteConnection | null> {
    for (;;) {
      if (this.#closed) return null;
      const conn = this.#accepted.shift();
      if (conn !== undefined) return conn;
      await new Promise<void>((resolve) => this.#wake = resolve);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#server.close();
    } catch {
      // already closed
    }
    for (const conn of this.#accepted.splice(0)) conn.close();
    this.#signal();
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ??
    new DOMException("The operation was aborted", "AbortError");
}

export const nodeSocketHost: SocketHost = {
  connect(path, signal) {
    return new Promise<ByteConnection>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortReason(signal));
        return;
      }
      const socket = net.createConnection({ path, allowHalfOpen: true });
      let aborted = false;
      let onAbort: (() => void) | undefined;
      const settle = () => {
        if (onAbort) signal?.removeEventListener("abort", onAbort);
      };
      socket.once("connect", () => {
        settle();
        if (aborted) {
          // The dial finished after the abort won: close the late connection
          // so the listener sees it end instead of holding it open.
          socket.destroy();
          return;
        }
        resolve(new NodeConnection(socket));
      });
      socket.once("error", (error) => {
        settle();
        if (!aborted) reject(error);
      });
      if (signal) {
        onAbort = () => {
          aborted = true;
          reject(abortReason(signal));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  },

  listen(path) {
    return new Promise<ConnectionListener>((resolve, reject) => {
      const server = net.createServer({ allowHalfOpen: true });
      server.once("error", reject);
      server.listen(path, () => {
        server.removeListener("error", reject);
        // Later errors have no caller to tell; the listener is already
        // handed out and a failed accept ends it.
        server.on("error", () => {});
        resolve(new NodeListener(server));
      });
    });
  },
};
