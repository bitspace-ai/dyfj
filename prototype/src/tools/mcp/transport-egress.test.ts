import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { composeRuntimePolicy } from "../../config/mod.ts";
import type { McpHttpServerConfig } from "../../config/mod.ts";
import { discoverMcpTools } from "./adapter.ts";
import { buildMemorySearch } from "./memory-search.ts";
import { boundedMcpFetch, createMcpClient } from "./transport.ts";

const BLOCKED = "https://mcp.blocked.example.test/mcp";
const REFUSED = /network egress to "mcp\.blocked\.example\.test:443" refused/;

/** Every message on the error and its cause chain, joined. */
function chainText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < 8; depth++) {
    parts.push(current.message);
    current = current.cause;
  }
  return parts.join("\n");
}

function blockedServer(): McpHttpServerConfig {
  return {
    id: "blocked",
    url: BLOCKED,
    tools: [],
  } as unknown as McpHttpServerConfig;
}

describe("MCP HTTP transport egress", () => {
  it("the bounded fetch refuses a host outside the policy by default", async () => {
    await assert.rejects(
      boundedMcpFetch(1_000)(BLOCKED, { method: "POST" }),
      (error: unknown) => REFUSED.test(chainText(error)),
    );
  });

  it("the SDK client's default fetch refuses a host outside the policy", async () => {
    const { client, transport } = await createMcpClient({
      url: BLOCKED,
      clientName: "egress-test",
      requestInit: {},
      probeTimeoutMs: 1_000,
    });
    try {
      await assert.rejects(
        client.connect(transport, { timeout: 2_000 }),
        (error: unknown) => REFUSED.test(chainText(error)),
      );
    } finally {
      await client.close().catch(() => {});
    }
  });

  it("discovery refuses a server outside the injected policy", async () => {
    await assert.rejects(
      discoverMcpTools({ server: blockedServer(), token: "t" }),
      (error: unknown) => REFUSED.test(chainText(error)),
    );
  });

  it("discovery admits the server once the policy is composed from it", async () => {
    // The composed policy allows the host, so the request reaches the
    // network and fails there (the name does not resolve), not at the guard.
    await assert.rejects(
      discoverMcpTools(
        { server: blockedServer(), token: "t" },
        composeRuntimePolicy({ mcpServers: [blockedServer()] }),
      ),
      (error: unknown) => !REFUSED.test(chainText(error)),
    );
  });

  it("memory recall refuses an endpoint outside the policy by default", async () => {
    const search = buildMemorySearch({ url: BLOCKED, tool: "search" });
    await assert.rejects(
      search("q"),
      (error: unknown) => REFUSED.test(chainText(error)),
    );
  });
});
