/**
 * Raw JSON-RPC 2.0 client for the engine's Unix socket, written against the
 * wire (newline-delimited JSON) rather than against runtime modules, so it
 * keeps working through any internal move.
 *
 * It records every message it receives, in arrival order, and answers
 * server-initiated requests (the mid-turn `approval` round trip) with a
 * scripted approver, recording each request with its answer.
 */

import { createConnection, type Socket } from "node:net";

export type Approver = (request: unknown) => unknown;

export type RpcOutcome = { result?: unknown; error?: unknown };

const decoder = new TextDecoder();

const denyAll: Approver = () => ({
  decision: "deny",
  reason: "golden client does not approve",
});

export class RawRpcClient {
  readonly received: unknown[] = [];
  readonly approvals: Array<{ request: unknown; response: unknown }> = [];
  #conn: Socket;
  #nextId = 1;
  #pending = new Map<number, (outcome: RpcOutcome) => void>();
  #listeners: Array<(message: Record<string, unknown>) => void> = [];
  #reader: Promise<void>;
  #approver: Approver;
  #closing = false;

  private constructor(conn: Socket, approver: Approver) {
    this.#conn = conn;
    this.#approver = approver;
    this.#reader = this.#read();
  }

  static async connect(
    socket: string,
    approver: Approver = denyAll,
  ): Promise<RawRpcClient> {
    const conn = await new Promise<Socket>((resolve, reject) => {
      const pending = createConnection({ path: socket });
      pending.once("error", reject);
      pending.once("connect", () => {
        pending.off("error", reject);
        resolve(pending);
      });
    });
    return new RawRpcClient(conn, approver);
  }

  async #write(message: unknown): Promise<void> {
    const line = JSON.stringify(message) + "\n";
    await new Promise<void>((resolve, reject) => {
      this.#conn.write(line, (error) => error ? reject(error) : resolve());
    });
  }

  async #read(): Promise<void> {
    let buffer = "";
    try {
      for await (const chunk of this.#conn as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let index: number;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (line.trim().length === 0) continue;
          await this.#dispatch(JSON.parse(line) as Record<string, unknown>);
        }
      }
    } catch (error) {
      // Closing the connection interrupts the pending read; anything else
      // is a real failure of the wire.
      if (!this.#closing) throw error;
    } finally {
      for (const settle of this.#pending.values()) {
        settle({ error: "connection closed" });
      }
      this.#pending.clear();
    }
  }

  async #dispatch(message: Record<string, unknown>): Promise<void> {
    this.received.push(message);
    for (const listener of this.#listeners) listener(message);
    if (typeof message.method === "string" && message.id !== undefined) {
      const response = this.#approver(message.params);
      this.approvals.push({ request: message.params, response });
      await this.#write({ jsonrpc: "2.0", id: message.id, result: response });
      return;
    }
    if (typeof message.id === "number" && message.method === undefined) {
      const settle = this.#pending.get(message.id);
      if (settle === undefined) return;
      this.#pending.delete(message.id);
      settle(
        message.error !== undefined
          ? { error: message.error }
          : { result: message.result },
      );
    }
  }

  onMessage(listener: (message: Record<string, unknown>) => void): void {
    this.#listeners.push(listener);
  }

  /** Send a request and settle with its result, or its error object. */
  async call(method: string, params?: unknown): Promise<RpcOutcome> {
    const id = this.#nextId++;
    const settled = new Promise<RpcOutcome>((resolve) => {
      this.#pending.set(id, resolve);
    });
    await this.#write({
      jsonrpc: "2.0",
      id,
      method,
      ...(params === undefined ? {} : { params }),
    });
    return await settled;
  }

  async close(): Promise<void> {
    this.#closing = true;
    const closed = new Promise<void>((resolve) => {
      if (this.#conn.closed) resolve();
      else this.#conn.once("close", () => resolve());
    });
    // Destroying an already closed socket is a no-op.
    this.#conn.destroy();
    await this.#reader;
    await closed;
  }
}
