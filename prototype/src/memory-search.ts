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
 *   DYFJ_MEMORY_MCP_URL           the external memory MCP endpoint
 *   DYFJ_MEMORY_MCP_TOOL          the search tool to call on it (default "search")
 *   DYFJ_MEMORY_MCP_TOKEN         optional token for the endpoint
 *   DYFJ_MEMORY_MCP_TOKEN_HEADER  optional header name to carry the token; when
 *                                 unset the token is sent as `Authorization:
 *                                 Bearer <token>`, when set the raw token is
 *                                 sent under the named header (backends that
 *                                 authenticate with a custom header stay a
 *                                 config change, not a code change)
 *
 * Read-only: this invokes a search tool and returns its text. Capture/write
 * flows should use separate capability contracts.
 */

import process from "node:process";

export interface MemorySearchConfig {
  /** The external memory MCP endpoint. */
  url: string;
  /** The search tool to call on that server (lowest-common-denominator: takes a query). */
  tool: string;
  /** Optional token for the endpoint. */
  token?: string;
  /**
   * Optional header name to carry the token. Unset → `Authorization: Bearer
   * <token>`; set → the raw token under this header. Meaningless without a
   * token.
   */
  tokenHeader?: string;
}

/** A bound recall function: natural-language query → formatted results text. */
export type MemorySearch = (query: string) => Promise<string>;

/** Loopback hosts, the only place plain-http recall is tolerable. */
export function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "::1" ||
    hostname === "[::1]" || hostname.startsWith("127.");
}

/**
 * Reject any recall endpoint that would carry the token and the private
 * queries in cleartext: https everywhere, plain http only to loopback. Throws
 * so misconfiguration fails closed and loudly — the alternative is silently
 * shipping a credential over the network.
 */
export function assertSecureMemoryUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("DYFJ_MEMORY_MCP_URL is not a valid URL");
  }
  if (parsed.protocol === "https:") return;
  if (parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname)) {
    return;
  }
  throw new Error(
    "DYFJ_MEMORY_MCP_URL must be https (plain http is allowed only for loopback hosts)",
  );
}

/**
 * Resolve recall config from the environment. Returns null when no endpoint is
 * configured, which disables the capability (the tool is never registered) —
 * so DYFJ carries no external-memory dependency until an operator opts in.
 * A configured-but-insecure endpoint throws instead of resolving.
 */
export function memorySearchConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): MemorySearchConfig | null {
  const url = env.DYFJ_MEMORY_MCP_URL;
  if (url === undefined || url === "") return null;
  assertSecureMemoryUrl(url);
  const tokenHeader = env.DYFJ_MEMORY_MCP_TOKEN_HEADER;
  return {
    url,
    tool: env.DYFJ_MEMORY_MCP_TOOL ?? "search",
    token: env.DYFJ_MEMORY_MCP_TOKEN,
    tokenHeader: tokenHeader === "" ? undefined : tokenHeader,
  };
}

/**
 * The auth headers a recall connection sends: nothing without a token, the
 * standard `Authorization: Bearer` scheme by default, or the raw token under
 * the operator-configured header name when the backend authenticates with a
 * custom header.
 */
export function memoryAuthHeaders(
  config: MemorySearchConfig,
): Record<string, string> | undefined {
  if (config.token === undefined || config.token === "") return undefined;
  if (config.tokenHeader !== undefined) {
    return { [config.tokenHeader]: config.token };
  }
  return { Authorization: `Bearer ${config.token}` };
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
    // The .js suffix is load-bearing: the SDK's exports map is a bare
    // `./*` → `./dist/esm/*` wildcard, so an extensionless subpath resolves
    // to a file that does not exist (ERR_MODULE_NOT_FOUND at recall time).
    const { StreamableHTTPClientTransport } = await import(
      "npm:@modelcontextprotocol/sdk@1.29.0/client/streamableHttp.js"
    );
    const headers = memoryAuthHeaders(config);
    const transport = new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: headers ? { headers } : undefined,
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
