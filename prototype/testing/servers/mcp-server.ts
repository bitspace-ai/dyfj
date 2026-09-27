/**
 * Loopback streamable-HTTP MCP server for integration and golden tests.
 *
 * Stands in for a third-party MCP service at the network boundary: it binds
 * 127.0.0.1 on an ephemeral port and serves `/mcp` from an SDK `McpServer`
 * the caller builds. It never reaches the network and never imports runtime
 * code, so tests that use it stay black-box.
 *
 * - `startLoopbackMcpServer` wires a caller-built server behind the SDK's
 *   stateless handler (legacy transports rejected). An optional `handle` hook
 *   sees every request first, to record it, rewrite it, or answer it itself.
 * - `startLoopbackHttp` is the bare listener, for tests that script raw HTTP
 *   (redirects, malformed bodies) or own their MCP handler's lifecycle.
 */

import { createMcpHandler, type McpServer } from "@modelcontextprotocol/server";

export type McpHandler = ReturnType<typeof createMcpHandler>;

export interface LoopbackHttp {
  /** The server's `/mcp` endpoint. */
  url: string;
  close(): Promise<void>;
}

export interface LoopbackMcpServer extends LoopbackHttp {
  /** Closes the MCP handler and shuts the listener down. */
  close(): Promise<void>;
}

export function startLoopbackHttp(
  handler: (request: Request) => Response | Promise<Response>,
): LoopbackHttp {
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    handler,
  );
  const { port } = server.addr as Deno.NetAddr;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () => server.shutdown(),
  };
}

export function startLoopbackMcpServer(
  build: () => McpServer,
  handle: (request: Request, mcp: McpHandler) => Response | Promise<Response> =
    (request, mcp) => mcp.fetch(request),
): LoopbackMcpServer {
  const mcp = createMcpHandler(build, { legacy: "reject" });
  const http = startLoopbackHttp((request) => handle(request, mcp));
  return {
    url: http.url,
    close: async () => {
      await Promise.all([mcp.close(), http.close()]);
    },
  };
}
