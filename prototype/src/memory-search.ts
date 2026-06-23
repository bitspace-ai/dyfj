/**
 * External memory recall — vendor-neutral semantic search over an operator-
 * configured external memory that speaks MCP.
 *
 * DYFJ owns the capability (the `search_memory` tool); the backend is a config
 * value, not a vendor named in the code. Any memory system that exposes an MCP
 * search tool is reachable by pointing DYFJ_MEMORY_MCP_URL at it — DYFJ never
 * names the product behind it, so swapping the backing store is a config change
 * (or, for a non-MCP backend, one new adapter behind `MemorySearch`), never a
 * rename through the codebase. This is the protocol-as-firewall stance applied
 * to memory: bet on the protocol (MCP), keep vendor optionality.
 *
 * Config (environment; an unset URL disables the capability entirely):
 *   DYFJ_MEMORY_MCP_URL    the external memory MCP endpoint
 *   DYFJ_MEMORY_MCP_TOOL   the search tool to call on it (default "search")
 *   DYFJ_MEMORY_MCP_TOKEN  optional bearer for the endpoint
 *
 * Read-only: this invokes a search tool and returns its text. Capturing/writing
 * to the external memory is deliberately out of scope.
 */

import process from "node:process";

export interface MemorySearchConfig {
  /** The external memory MCP endpoint. */
  url: string;
  /** The search tool to call on that server (lowest-common-denominator: takes a query). */
  tool: string;
  /** Optional bearer token for the endpoint. */
  token?: string;
}

/** A bound recall function: natural-language query → formatted results text. */
export type MemorySearch = (query: string) => Promise<string>;

/**
 * Resolve recall config from the environment. Returns null when no endpoint is
 * configured, which disables the capability (the tool is never registered) —
 * so DYFJ carries no external-memory dependency until an operator opts in.
 */
export function memorySearchConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): MemorySearchConfig | null {
  const url = env.DYFJ_MEMORY_MCP_URL;
  if (url === undefined || url === "") return null;
  return {
    url,
    tool: env.DYFJ_MEMORY_MCP_TOOL ?? "search",
    token: env.DYFJ_MEMORY_MCP_TOKEN,
  };
}

/**
 * Build a recall function bound to the given config. Connects per call (stateless
 * and robust — no long-lived session to reconcile across turns) to the external
 * memory MCP server and invokes its configured search tool with `{ query }`,
 * returning the tool's text content.
 */
export function buildMemorySearch(config: MemorySearchConfig): MemorySearch {
  return async (query: string): Promise<string> => {
    // SDK imported lazily: this module must load under the node-based test
    // runner, which cannot resolve Deno `npm:` specifiers. The SDK is only
    // needed when a recall actually executes under the Deno runtime.
    const { Client } = await import(
      "npm:@modelcontextprotocol/sdk@1.29.0/client"
    );
    const { StreamableHTTPClientTransport } = await import(
      "npm:@modelcontextprotocol/sdk@1.29.0/client/streamableHttp"
    );
    const transport = new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: config.token
        ? { headers: { Authorization: `Bearer ${config.token}` } }
        : undefined,
    });
    const client = new Client({
      name: "dyfj-workbench-recall",
      version: "1.0.0",
    });
    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: config.tool,
        arguments: { query },
      });
      const content = (result.content ?? []) as Array<
        { type: string; text?: string }
      >;
      const text = content
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n")
        .trim();
      if (result.isError) {
        throw new Error(`recall tool '${config.tool}' returned error: ${text}`);
      }
      return text.length > 0 ? text : "No matching memories found.";
    } finally {
      await client.close().catch(() => {});
    }
  };
}
