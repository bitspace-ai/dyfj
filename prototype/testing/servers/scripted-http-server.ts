/**
 * Loopback HTTP server that answers from a `ScriptedResponse` script.
 *
 * The real-network counterpart of `ScriptedHttpTransport`: the same script
 * vocabulary, served from 127.0.0.1 on an ephemeral port, so the platform
 * `fetch` can be held to the `HttpTransport` conformance suite. It records
 * each request as the fake does and answers an unscripted request with 599.
 */

import {
  type RecordedRequest,
  scriptedBody,
  type ScriptedResponse,
} from "../fakes/scripted-http-transport.ts";

export interface ScriptedHttpServer {
  /** `http://127.0.0.1:<port>`. */
  baseUrl: string;
  /** Every request received, in arrival order. */
  requests: RecordedRequest[];
  close(): Promise<void>;
}

export function startScriptedHttpServer(
  script: readonly ScriptedResponse[],
): ScriptedHttpServer {
  const pending = [...script];
  const requests: RecordedRequest[] = [];
  const server = Deno.serve(
    {
      hostname: "127.0.0.1",
      port: 0,
      onListen() {},
      // A held-open body errors on the server side when the client aborts;
      // that is the case under test, not a failure worth logging.
      onError: () => new Response(null, { status: 500 }),
    },
    async (request) => {
      requests.push({
        url: request.url,
        method: request.method,
        headers: Object.fromEntries(request.headers.entries()),
        body: await request.text(),
      });
      const reply = pending.shift();
      if (reply === undefined) {
        return new Response("unscripted", { status: 599 });
      }
      if (reply.withholdHeaders) {
        // Answer only once the client has gone; it never sees this.
        await new Promise((resolve) =>
          request.signal.addEventListener("abort", resolve, { once: true })
        );
        return new Response(null, { status: 499 });
      }
      return new Response(scriptedBody(reply, request.signal), {
        status: reply.status ?? 200,
        headers: reply.headers,
      });
    },
  );
  return {
    baseUrl: `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`,
    requests,
    close: () => server.shutdown(),
  };
}
