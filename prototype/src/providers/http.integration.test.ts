// The `HttpTransport` conformance suite against the real adapter: the
// platform `fetch`, talking to a loopback server that answers from the
// suite's script. Integration tier: it binds a real socket.

import { httpTransportConformance } from "../../testing/conformance/http-transport.ts";
import { startScriptedHttpServer } from "../../testing/servers/scripted-http-server.ts";

httpTransportConformance({
  name: "fetch",
  make(script) {
    const server = startScriptedHttpServer(script);
    return Promise.resolve({
      transport: (url: string, init: RequestInit) => fetch(url, init),
      baseUrl: server.baseUrl,
      requests: () => server.requests,
      close: () => server.close(),
    });
  },
});
