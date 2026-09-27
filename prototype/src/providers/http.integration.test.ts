// The `HttpTransport` conformance suite against the real adapter: the
// platform `fetch`, talking to a loopback server that answers from the
// suite's script. Integration tier: it binds a real socket.

import { httpTransportConformance } from "../../testing/conformance/http-transport.ts";
import {
  type RecordedRequest,
  scriptedBody,
} from "../../testing/fakes/scripted-http-transport.ts";

httpTransportConformance({
  name: "fetch",
  make(script) {
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
    return Promise.resolve({
      transport: (url: string, init: RequestInit) => fetch(url, init),
      baseUrl: `http://127.0.0.1:${server.addr.port}`,
      requests: () => requests,
      close: () => server.shutdown(),
    });
  },
});
