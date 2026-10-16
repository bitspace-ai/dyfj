import {
  createMcpHandler,
  McpServer,
} from "@modelcontextprotocol/server";
import process from "node:process";
import { z } from "zod";
import { serveFetch } from "../testing/servers/fetch-server.ts";

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
  args: string[] = process.argv.slice(2),
): Promise<void> {
  if (args.includes("--help")) {
    console.log(
      `usage: npm run memory-recall-uat-fixture -- [--port <n>]\n\nServes a fixture MCP memory server on http://${HOST}:<port>/mcp (port\n${DEFAULT_PORT} by default; 0 picks a free one) with one tool, ${FIXTURE_TOOL}.\nPoint DYFJ_MEMORY_MCP_URL at it to exercise memory recall. Stop it with Ctrl-C.`,
    );
    return;
  }
  let calls = 0;
  const mcp = createMcpHandler(
    () => fixtureServer(() => console.log(`fixture tool calls: ${++calls}`)),
    { legacy: "reject" },
  );
  const http = await serveFetch((request) => mcp.fetch(request), {
    port: fixturePort(args),
  });
  console.log(`memory recall UAT fixture: http://${HOST}:${http.port}/mcp`);

  let onSignal = () => {};
  await new Promise<void>((resolve) => {
    onSignal = resolve;
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  });
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  if (!await settleFixtureShutdown(() => http.close(), () => mcp.close())) {
    throw new Error("memory recall UAT fixture failed to shut down");
  }
}

if (import.meta.main) await runMemoryRecallUatFixture();
