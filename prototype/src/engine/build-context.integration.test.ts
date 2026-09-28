/**
 * Integration test for the companion context's external-memory recall: a
 * loopback MCP server stands in for the memory service, and the recall tool
 * `buildContext` registers is invoked through the turn's command registry.
 * The protocol it negotiates must reach the client as a structured
 * `memoryRecallNegotiated` frame on the turn's event channel.
 */
import { assert, assertEquals } from "@std/assert";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { startLoopbackHttp } from "../../testing/servers/mcp-server.ts";
import { enginePorts } from "../../testing/builders/engine.ts";
import type { WorkbenchRuntimeEvent } from "../contract/mod.ts";
import { createCommandRegistry } from "../tools/mod.ts";
import { buildContext } from "./build-context.ts";
import { openSession } from "./open-session.ts";
import type { WorkbenchRuntimeInput } from "./runtime-types.ts";
import { newTurnState } from "./turn-state.ts";

const FIXTURE_TOOL = "fixture-search";

function fixtureServer(): McpServer {
  const server = new McpServer(
    { name: "fixture-memory", version: "1.2.3" },
    { capabilities: { extensions: { "fixture.extension": {} } } },
  );
  server.registerTool(
    FIXTURE_TOOL,
    { inputSchema: z.object({ query: z.string() }) },
    ({ query }: { query: string }) => ({
      content: [{ type: "text" as const, text: `match:${query}` }],
    }),
  );
  return server;
}

Deno.test("recall negotiation reaches the client as a structured frame", async () => {
  const mcp = createMcpHandler(fixtureServer, { legacy: "reject" });
  const http = startLoopbackHttp((request) => mcp.fetch(request));
  try {
    const fakes = enginePorts({
      env: {
        DYFJ_MEMORY_MCP_URL: http.url,
        DYFJ_MEMORY_MCP_TOOL: FIXTURE_TOOL,
      },
    });
    const frames: WorkbenchRuntimeEvent[] = [];
    const input: WorkbenchRuntimeInput = {
      mode: "turn",
      prompt: "exercise recall",
      routingOptions: {},
      onRuntimeEvent: (event) => void frames.push(event),
    };
    const session = await openSession(input, fakes.ports);
    const state = newTurnState(session, createCommandRegistry());
    await buildContext(state, input, fakes.ports);

    const recall = state.commandRegistry.lookup("memory.search");
    assert(recall !== undefined);
    const answer = await recall.executor(
      { commandId: "memory.search", arguments: { query: "needle" } } as never,
      {} as never,
    );
    assertEquals(answer, "match:needle");
    assertEquals(
      frames.filter((frame) => frame.type === "memoryRecallNegotiated"),
      [{
        type: "memoryRecallNegotiated",
        sessionId: session.sessionId,
        era: "modern",
        revision: "2026-07-28",
        server: { name: "fixture-memory", version: "1.2.3" },
        extensions: ["fixture.extension"],
      }],
    );
  } finally {
    await mcp.close();
    await http.close();
  }
});

Deno.test("a remote turn is never offered external-memory recall", async () => {
  const fakes = enginePorts({
    env: { DYFJ_MEMORY_MCP_URL: "http://127.0.0.1:9/mcp" },
  });
  const input: WorkbenchRuntimeInput = {
    mode: "turn",
    prompt: "exercise recall",
    routingOptions: {},
    authContext: {
      transport: "remote",
      authnStatus: "authenticated",
      authnMechanism: "api_key",
      authnIssuerRef: "test_issuer",
      authzBasis: "bearer_token",
    },
  };
  const session = await openSession(input, fakes.ports);
  const state = newTurnState(session, createCommandRegistry());
  await buildContext(state, input, fakes.ports);
  assertEquals(state.commandRegistry.lookup("memory.search"), undefined);
});
