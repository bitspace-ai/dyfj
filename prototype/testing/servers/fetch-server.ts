/**
 * A loopback HTTP server that answers through a fetch-style handler
 * (`Request` in, `Response` out), on `node:http`. It is the one listener under
 * the test servers in this directory.
 *
 * - It binds 127.0.0.1 on an ephemeral port and resolves once it is listening,
 *   because the port is known only then.
 * - Each request's `signal` aborts when the client goes away before the
 *   response has been sent in full, so a handler can hold a reply until then.
 * - A response body that errors mid-stream cuts the connection, so the client
 *   sees a broken body rather than a clean end.
 * - `close` stops accepting, lets every exchange in flight finish, then closes
 *   the remaining connections and resolves once the listener is down.
 */

import {
  createServer,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";

export type FetchHandler = (request: Request) => Response | Promise<Response>;

export interface FetchServerOptions {
  /** Answers a request whose handler threw; by default logs it, then 500. */
  onError?: (error: unknown) => Response;
}

export interface FetchServer {
  port: number;
  close(): Promise<void>;
}

function defaultOnError(error: unknown): Response {
  console.error(error);
  return new Response("Internal Server Error", { status: 500 });
}

function toRequest(
  incoming: IncomingMessage,
  port: number,
  signal: AbortSignal,
): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      headers.append(name, item);
    }
  }
  const method = incoming.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  const host = incoming.headers.host ?? `127.0.0.1:${port}`;
  return new Request(`http://${host}${incoming.url ?? "/"}`, {
    method,
    headers,
    signal,
    ...(hasBody
      ? {
        body: Readable.toWeb(incoming) as ReadableStream<Uint8Array>,
        duplex: "half",
      }
      : {}),
  } as RequestInit);
}

function responseHeaders(response: Response): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {};
  for (const [name, value] of response.headers) {
    const existing = headers[name];
    headers[name] = existing === undefined
      ? value
      : [...(Array.isArray(existing) ? existing : [String(existing)]), value];
  }
  return headers;
}

/**
 * Settles once `outgoing` can take more writes or has closed, whichever comes
 * first. A client that leaves while the buffer is full closes the response
 * without draining it, so waiting on `drain` alone would never settle.
 */
export function drainOrClose(
  outgoing: Pick<ServerResponse, "once" | "off">,
): Promise<void> {
  return new Promise((resolve) => {
    const settle = () => {
      outgoing.off("drain", settle);
      outgoing.off("close", settle);
      resolve();
    };
    outgoing.once("drain", settle);
    outgoing.once("close", settle);
  });
}

async function send(response: Response, outgoing: ServerResponse) {
  outgoing.writeHead(response.status, responseHeaders(response));
  if (response.body === null) {
    outgoing.end();
    return;
  }
  const reader = response.body.getReader();
  const cancel = () => void reader.cancel().catch(() => undefined);
  outgoing.once("close", cancel);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (outgoing.destroyed) return;
      if (!outgoing.write(value)) await drainOrClose(outgoing);
      if (outgoing.destroyed) return;
    }
    outgoing.end();
  } catch (error) {
    outgoing.destroy(error as Error);
  } finally {
    outgoing.off("close", cancel);
  }
}

export async function serveFetch(
  handler: FetchHandler,
  options: FetchServerOptions = {},
): Promise<FetchServer> {
  const onError = options.onError ?? defaultOnError;
  const inFlight = new Set<Promise<void>>();
  let port = 0;
  const server = createServer((incoming, outgoing) => {
    const controller = new AbortController();
    const exchange = new Promise<void>((resolve) => {
      outgoing.once("close", () => {
        if (!outgoing.writableFinished) controller.abort();
        resolve();
      });
    });
    inFlight.add(exchange);
    void exchange.then(() => inFlight.delete(exchange));
    void (async () => {
      let response: Response;
      try {
        response = await handler(toRequest(incoming, port, controller.signal));
      } catch (error) {
        response = onError(error);
      }
      await send(response, outgoing);
    })().catch((error) => outgoing.destroy(error as Error));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;
  return {
    port,
    async close() {
      const closed = new Promise<void>((resolve) =>
        server.close(() => resolve())
      );
      server.closeIdleConnections();
      await Promise.all(inFlight);
      server.closeAllConnections();
      await closed;
    },
  };
}
