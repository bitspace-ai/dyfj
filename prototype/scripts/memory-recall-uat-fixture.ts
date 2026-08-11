import {
  createMcpHandler,
  McpServer,
} from "npm:@modelcontextprotocol/server@2.0.0";
import { z } from "npm:zod@4.4.3";

const HOST = "127.0.0.1";
const DEFAULT_PORT = 43_137;
const FIXTURE_TOOL = "fixture-search";

function fixtureServer(onToolCall: () => void): McpServer {
  const server = new McpServer(
    { name: "dyfj-memory-recall-uat", version: "1.0.0" },
    { capabilities: { extensions: { "dyfj.uat": {} } } },
  );
  server.registerTool(
    FIXTURE_TOOL,
    { inputSchema: z.object({ query: z.string() }) },
    () => {
      onToolCall();
      return {
        content: [{ type: "text" as const, text: "fixture-result" }],
      };
    },
  );
  return server;
}

export function fixturePort(args: string[]): number {
  const index = args.indexOf("--port");
  if (index < 0) return DEFAULT_PORT;
  const raw = args[index + 1];
  const port = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error("--port must be an integer from 0 through 65535");
  }
  return port;
}

export async function settleFixtureShutdown(
  shutdownHttp: () => Promise<void>,
  closeMcp: () => Promise<void>,
): Promise<boolean> {
  const results = await Promise.allSettled([shutdownHttp(), closeMcp()]);
  return results.every((result) => result.status === "fulfilled");
}

export async function runMemoryRecallUatFixture(
  args: string[] = Deno.args,
): Promise<void> {
  let calls = 0;
  const mcp = createMcpHandler(
    () => fixtureServer(() => console.log(`fixture tool calls: ${++calls}`)),
    { legacy: "reject" },
  );
  const http = Deno.serve(
    {
      hostname: HOST,
      port: fixturePort(args),
      onListen: ({ port }) =>
        console.log(`memory recall UAT fixture: http://${HOST}:${port}/mcp`),
    },
    (request) => mcp.fetch(request),
  );

  let closing: Promise<boolean> | undefined;
  const close = (): Promise<boolean> => {
    if (closing !== undefined) return closing;
    closing = settleFixtureShutdown(
      () => http.shutdown(),
      () => mcp.close(),
    );
    return closing;
  };
  const onSignal = () => void close();
  Deno.addSignalListener("SIGINT", onSignal);
  Deno.addSignalListener("SIGTERM", onSignal);
  try {
    await http.finished;
  } finally {
    Deno.removeSignalListener("SIGINT", onSignal);
    Deno.removeSignalListener("SIGTERM", onSignal);
    if (!await close()) {
      throw new Error("memory recall UAT fixture failed to shut down");
    }
  }
}

if (import.meta.main) await runMemoryRecallUatFixture();
