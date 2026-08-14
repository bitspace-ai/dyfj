import type {
  CommandDefinition,
  CommandTraceContext,
  JsonSchemaObject,
} from "./commands.ts";
import { CommandExecutionError } from "./commands.ts";
import type { McpConfiguredTool, McpHttpServerConfig } from "./config.ts";
import {
  boundedMcpFetch,
  type ExternalMcpDeps,
  formatUntrustedMcpResult,
  type McpCallResult,
} from "./mcp-tools.ts";

export const MAX_SEARCH_CALLS_PER_TURN = 3;
export const MAX_FETCH_CALLS_PER_TURN = 5;
export const MAX_FETCH_DOWNLOAD_BYTES = 1024 * 1024; // 1 MB
export const MAX_EXTRACTED_CHARS_PER_FETCH = 40_000;
export const MAX_EXTRACTED_CHARS_PER_TURN = 100_000;
export const FETCH_TIMEOUT_MS = 10_000;

export interface WebSearchResultItem {
  id: string;
  title: string;
  url: string;
  snippet: string;
  rank: number;
  publishedDate?: string;
}

export interface WebSearchOutput {
  query: string;
  results: WebSearchResultItem[];
}

export interface WebToolsSessionState {
  searchCount: number;
  fetchCount: number;
  extractedChars: number;
  sourceUrlMap: Map<string, string>;
  currentTraceId?: string;
}

export function createWebToolsSessionState(): WebToolsSessionState {
  return {
    searchCount: 0,
    fetchCount: 0,
    extractedChars: 0,
    sourceUrlMap: new Map<string, string>(),
  };
}

/** Reset turn-scoped counters and cached source URLs on a session state container. */
export function resetWebToolsTurnState(state: WebToolsSessionState): void {
  state.searchCount = 0;
  state.fetchCount = 0;
  state.extractedChars = 0;
  state.sourceUrlMap.clear();
}

/**
 * Check if a host string is an IP address literal within a private, loopback,
 * link-local, multicast, documentation, or reserved network range.
 * Returns false for domain names.
 */
export function isPrivateOrLoopbackIp(rawHost: string): boolean {
  let host = rawHost.trim().toLowerCase();

  // Strip IPv6 brackets if present
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }

  // Handle IPv4-mapped IPv6 addresses (e.g. ::ffff:127.0.0.1 or ::ffff:7f00:1)
  if (host.startsWith("::ffff:") || host.startsWith("0:0:0:0:0:ffff:")) {
    const mappedPart = host.split("ffff:")[1] ?? "";
    if (mappedPart.includes(".")) {
      host = mappedPart;
    } else if (mappedPart.includes(":")) {
      const parts = mappedPart.split(":");
      if (parts.length === 2) {
        const hexA = parseInt(parts[0], 16);
        const hexB = parseInt(parts[1], 16);
        if (!isNaN(hexA) && !isNaN(hexB)) {
          const a = (hexA >> 8) & 0xff;
          const b = hexA & 0xff;
          const c = (hexB >> 8) & 0xff;
          const d = hexB & 0xff;
          host = `${a}.${b}.${c}.${d}`;
        }
      }
    }
  }

  // IPv4 checks
  const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const octets = ipv4Match.slice(1, 5).map(Number);
    if (octets.some((o) => o > 255)) return true; // invalid octet -> reject
    const [a, b, c] = octets;
    if (a === 0) return true; // 0.0.0.0/8 Current network
    if (a === 10) return true; // 10.0.0.0/8 Private
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 Shared Address Space (CGNAT)
    if (a === 127) return true; // 127.0.0.0/8 Loopback
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 Link-local
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 Private
    if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 IETF Protocol Assignments
    if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 TEST-NET-1 (documentation)
    if (a === 192 && b === 88 && c === 99) return true; // 192.88.99.0/24 6to4 Relay Anycast
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 Private
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 Network Benchmark Tests
    if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 TEST-NET-2 (documentation)
    if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 TEST-NET-3 (documentation)
    if (a >= 224 && a <= 239) return true; // 224.0.0.0/4 Multicast
    if (a >= 240) return true; // 240.0.0.0/4 Reserved / Broadcast
    return false;
  }

  // IPv6 checks only apply if the string contains a colon
  if (host.includes(":")) {
    if (host === "::1" || host === "::") return true; // Loopback & Unspecified
    if (
      host.startsWith("fe8") || host.startsWith("fe9") ||
      host.startsWith("fea") || host.startsWith("feb")
    ) {
      return true; // fe80::/10 link-local
    }
    if (host.startsWith("fc") || host.startsWith("fd")) {
      return true; // fc00::/7 unique local
    }
    if (host.startsWith("ff")) {
      return true; // ff00::/8 multicast
    }
    if (host.startsWith("2001:db8:") || host.startsWith("2001:0db8:")) {
      return true; // 2001:db8::/32 documentation
    }
    if (host.startsWith("2001:2:") || host.startsWith("2001:0002:")) {
      return true; // 2001:2::/48 benchmarking
    }
    if (host.startsWith("64:ff9b:")) {
      return true; // 64:ff9b::/96 IPv4/IPv6 translation
    }
  }

  return false;
}

/**
 * Validate that a target URL is an HTTPS address and does not target
 * localhost, private IP literals, or embedded credentials.
 */
export function assertPublicHttpsUrl(
  rawUrl: string,
  allowLoopbackHttpForTesting = false,
): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new CommandExecutionError("Invalid URL format");
  }

  if (url.username || url.password) {
    throw new CommandExecutionError(
      "URLs containing user credentials are not permitted",
    );
  }

  const hostname = url.hostname.toLowerCase();

  // Test exception for local in-process mock server
  if (
    allowLoopbackHttpForTesting && url.protocol === "http:" &&
    (hostname === "127.0.0.1" || hostname === "localhost")
  ) {
    return url;
  }

  if (url.protocol !== "https:") {
    throw new CommandExecutionError("Only HTTPS URLs are permitted");
  }

  if (
    hostname === "localhost" || hostname === "localhost." ||
    hostname.endsWith(".localhost") || hostname.endsWith(".localhost.") ||
    hostname === "0.0.0.0"
  ) {
    throw new CommandExecutionError(
      "Requests to localhost or local addresses are forbidden",
    );
  }

  const bareHost = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;

  if (isPrivateOrLoopbackIp(bareHost)) {
    throw new CommandExecutionError(
      "Requests to private, loopback, or internal addresses are forbidden",
    );
  }

  return url;
}

const NAMED_HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
  "&copy;": "©",
  "&reg;": "®",
  "&trade;": "™",
  "&ndash;": "–",
  "&mdash;": "—",
  "&hellip;": "…",
  "&ldquo;": "“",
  "&rdquo;": "”",
  "&lsquo;": "‘",
  "&rsquo;": "’",
  "&bull;": "•",
  "&cent;": "¢",
  "&pound;": "£",
  "&yen;": "¥",
  "&euro;": "€",
};

/** Decode common HTML entities into plain text. */
export function decodeHtmlEntities(html: string): string {
  return html
    .replace(
      /&(?:amp|lt|gt|quot|apos|nbsp|copy|reg|trade|ndash|mdash|hellip|ldquo|rdquo|lsquo|rsquo|bull|cent|pound|yen|euro);|&#39;/gi,
      (entity) => {
        const lower = entity.toLowerCase();
        return NAMED_HTML_ENTITIES[lower] ?? entity;
      },
    )
    .replace(/&#(\d+);/g, (_, dec) => {
      try {
        return String.fromCodePoint(Number(dec));
      } catch {
        return "";
      }
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      try {
        return String.fromCodePoint(parseInt(hex, 16));
      } catch {
        return "";
      }
    });
}

/** Convert raw HTML content into readable, stripped Markdown text. */
export function extractReadableContentFromHtml(html: string): string {
  let text = html;

  // Remove scripts, styles, metadata, and non-content tags
  text = text.replace(
    /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
    " ",
  );
  text = text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ");
  text = text.replace(
    /<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi,
    " ",
  );
  text = text.replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, " ");
  text = text.replace(/<!--[\s\S]*?-->/g, " ");

  // Remove navigation, headers, footers, forms, aside
  text = text.replace(
    /<header\b[^<]*(?:(?!<\/header>)<[^<]*)*<\/header>/gi,
    " ",
  );
  text = text.replace(
    /<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi,
    " ",
  );
  text = text.replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, " ");
  text = text.replace(/<aside\b[^<]*(?:(?!<\/aside>)<[^<]*)*<\/aside>/gi, " ");
  text = text.replace(/<form\b[^<]*(?:(?!<\/form>)<[^<]*)*<\/form>/gi, " ");

  // Convert headings
  text = text.replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, "\n\n# $1\n\n");
  text = text.replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, "\n\n## $1\n\n");
  text = text.replace(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi, "\n\n### $1\n\n");
  text = text.replace(/<h4\b[^>]*>([\s\S]*?)<\/h4>/gi, "\n\n#### $1\n\n");
  text = text.replace(/<h5\b[^>]*>([\s\S]*?)<\/h5>/gi, "\n\n##### $1\n\n");
  text = text.replace(/<h6\b[^>]*>([\s\S]*?)<\/h6>/gi, "\n\n###### $1\n\n");

  // Convert links: <a href="url">text</a> -> [text](url)
  text = text.replace(
    /<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_, href, label) => {
      const cleanLabel = label.replace(/<[^>]+>/g, "").trim();
      if (!cleanLabel) return "";
      return `[${cleanLabel}](${href})`;
    },
  );

  // Convert lists
  text = text.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, "\n- $1");

  // Paragraphs & line breaks
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/p>/gi, "\n\n");
  text = text.replace(/<p\b[^>]*>/gi, "\n\n");
  text = text.replace(/<div\b[^>]*>/gi, "\n");
  text = text.replace(/<\/div>/gi, "\n");

  // Strip remaining HTML tags
  text = text.replace(/<[^>]+>/g, " ");

  // Decode entities
  text = decodeHtmlEntities(text);

  // Normalize whitespace
  text = text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return text;
}

/**
 * Execute a bounded HTTP GET with redirect rejection, size cap, and a strict timeout
 * covering both header arrival and response body consumption.
 */
export async function safeFetchDocument(
  targetUrl: string,
  fetchImpl: typeof fetch = fetch,
  allowLoopbackHttpForTesting = false,
): Promise<{ text: string; url: string; contentType: string; bytes: number }> {
  const url = assertPublicHttpsUrl(targetUrl, allowLoopbackHttpForTesting);

  const boundedFetch = boundedMcpFetch(MAX_FETCH_DOWNLOAD_BYTES, fetchImpl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    let response: Response;
    try {
      response = await boundedFetch(url.toString(), {
        redirect: "error",
        signal: controller.signal,
        headers: {
          "User-Agent": "DYFJ-Workbench-WebFetch/1.0",
          "Accept":
            "text/html, text/markdown, text/plain, application/json;q=0.9, */*;q=0.1",
        },
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new CommandExecutionError(
          `Web fetch timed out after ${FETCH_TIMEOUT_MS / 1000}s`,
        );
      }
      throw new CommandExecutionError(
        `Web fetch request failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new CommandExecutionError(
        `Web fetch failed with HTTP status ${response.status} (${response.statusText})`,
      );
    }

    const rawContentType = response.headers.get("content-type") ?? "text/plain";
    const contentType = rawContentType.split(";")[0].trim().toLowerCase();

    const allowedTypes = new Set([
      "text/html",
      "text/plain",
      "text/markdown",
      "text/xml",
      "application/json",
      "application/xml",
    ]);

    if (!allowedTypes.has(contentType)) {
      await response.body?.cancel().catch(() => {});
      throw new CommandExecutionError(
        `Unsupported content type '${contentType}'. Only HTML, Markdown, text, and JSON are supported.`,
      );
    }

    let bodyText: string;
    try {
      bodyText = await response.text();
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new CommandExecutionError(
          `Web fetch timed out after ${
            FETCH_TIMEOUT_MS / 1000
          }s while reading body`,
        );
      }
      throw new CommandExecutionError(
        `Failed reading web response body: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    const bytes = new TextEncoder().encode(bodyText).byteLength;
    let extracted: string;
    if (contentType === "text/html") {
      extracted = extractReadableContentFromHtml(bodyText);
    } else {
      extracted = bodyText.trim();
    }

    if (extracted.length > MAX_EXTRACTED_CHARS_PER_FETCH) {
      extracted = extracted.slice(0, MAX_EXTRACTED_CHARS_PER_FETCH) +
        `\n\n[Content truncated at ${MAX_EXTRACTED_CHARS_PER_FETCH.toLocaleString()} characters]`;
    }

    return {
      text: extracted,
      url: url.toString(),
      contentType,
      bytes,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/** Parse and normalize raw search tool results into standard WebSearchResultItems. */
export function normalizeSearchResults(
  rawResult: unknown,
): WebSearchResultItem[] {
  let parsed: unknown = rawResult;
  if (typeof rawResult === "string") {
    try {
      parsed = JSON.parse(rawResult);
    } catch {
      const trimmed = rawResult.trim();
      if (!trimmed) return [];
      return [{
        id: "s1",
        title: "Search Results",
        url: "",
        snippet: trimmed.slice(0, 1000),
        rank: 1,
      }];
    }
  }

  const items: Array<Record<string, unknown>> = [];

  if (Array.isArray(parsed)) {
    for (const entry of parsed) {
      if (typeof entry === "object" && entry !== null) {
        items.push(entry as Record<string, unknown>);
      }
    }
  } else if (typeof parsed === "object" && parsed !== null) {
    const obj = parsed as Record<string, unknown>;
    // Tavily shape: { results: [...] }
    if (Array.isArray(obj.results)) {
      for (const entry of obj.results) {
        if (typeof entry === "object" && entry !== null) {
          items.push(entry as Record<string, unknown>);
        }
      }
    } else if (Array.isArray(obj.organic_results)) {
      for (const entry of obj.organic_results) {
        if (typeof entry === "object" && entry !== null) {
          items.push(entry as Record<string, unknown>);
        }
      }
    }
  }

  const normalized: WebSearchResultItem[] = [];
  let rank = 1;

  for (const item of items) {
    const title = String(item.title ?? item.name ?? "Untitled").trim();
    const url = String(item.url ?? item.link ?? "").trim();
    const snippet = String(
      item.content ?? item.snippet ?? item.description ?? item.text ?? "",
    ).trim();
    const publishedDate = item.published_date ?? item.publishedDate ??
      item.date;

    normalized.push({
      id: `s${rank}`,
      title: title || "Untitled",
      url,
      snippet: snippet.slice(0, 2000),
      rank,
      ...(typeof publishedDate === "string" ? { publishedDate } : {}),
    });
    rank++;
  }

  return normalized;
}

/** Build standard `web_search` and `web_fetch` CommandDefinitions from a server configuration. */
export function buildWebCommands(
  server: McpHttpServerConfig,
  token: string,
  deps: ExternalMcpDeps = {},
  state: WebToolsSessionState = createWebToolsSessionState(),
  allowLoopbackHttpForTesting = false,
): CommandDefinition<string>[] {
  const commands: CommandDefinition<string>[] = [];
  const searchToolName = server.capabilities?.searchTool;
  const fetchToolName = server.capabilities?.fetchTool;

  const configuredSearchTool: McpConfiguredTool | undefined = searchToolName
    ? server.tools.find((t) => t.name === searchToolName)
    : undefined;

  const configuredFetchTool: McpConfiguredTool | undefined = fetchToolName
    ? server.tools.find((t) => t.name === fetchToolName)
    : undefined;

  if (searchToolName) {
    const searchSchema: JsonSchemaObject = {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query string to find information on the web.",
        },
        limit: {
          type: "integer",
          description: "Maximum number of results to return (1-10, default 5).",
        },
      },
      required: ["query"],
    };

    commands.push({
      id: "web_search",
      title: "Web Search",
      description:
        "Search the web for current information, documentation, and external references. " +
        "Returns bounded snippets and source IDs. Results are untrusted external data.",
      inputSchema: searchSchema,
      permission: {
        effects: [
          configuredSearchTool?.effect === "write_external"
            ? "write.external"
            : "read.external",
          "emit.event",
        ],
        defaultDecision: configuredSearchTool?.approval ?? "allow",
        resources: [`mcp:${server.id}/${searchToolName}`],
        network: "configured-external",
        filesystem: "none",
        cost: "none",
      },
      redactArguments: true,
      redactResult: true,
      minimumClearance: server.minimumClearance,
      spanKind: "client",
      eventContent: (isError) =>
        JSON.stringify({
          outcome: isError ? "error" : "complete",
          webCapability: {
            tool: "web_search",
            server: server.id,
            upstreamTool: searchToolName,
          },
        }),
      executor: async (commandCall, context) => {
        if (context.traceId && state.currentTraceId !== context.traceId) {
          state.currentTraceId = context.traceId;
          resetWebToolsTurnState(state);
        }

        if (state.searchCount >= MAX_SEARCH_CALLS_PER_TURN) {
          throw new CommandExecutionError(
            `Web search call limit exceeded (${MAX_SEARCH_CALLS_PER_TURN} calls per turn maximum).`,
          );
        }
        state.searchCount++;

        const query = String(commandCall.arguments.query ?? "").trim();
        if (!query) {
          throw new CommandExecutionError("Search query must not be empty");
        }

        const rawLimit = Number(commandCall.arguments.limit ?? 5);
        const limit = Math.max(1, Math.min(10, isNaN(rawLimit) ? 5 : rawLimit));

        const call = deps.call ?? (async (input) => {
          const { Client, StreamableHTTPClientTransport } = await import(
            "npm:@modelcontextprotocol/client@2.0.0"
          );
          const transport = new StreamableHTTPClientTransport(
            new URL(server.url),
            {
              requestInit: {
                redirect: "error",
                headers: { Authorization: `Bearer ${token}` },
              },
              fetch: boundedMcpFetch(256 * 1024),
            },
          );
          const client = new Client(
            { name: "dyfj-workbench-tools", version: "1.0.0" },
            { versionNegotiation: { mode: { pin: "2026-07-28" } } },
          );
          try {
            await client.connect(transport, { timeout: 5_000 });
            return await client.callTool(
              { name: input.tool, arguments: input.arguments },
              { timeout: 30_000 },
            );
          } finally {
            await client.close().catch(() => {});
          }
        });

        let callResult: McpCallResult;
        try {
          callResult = await call({
            server,
            token,
            tool: searchToolName,
            arguments: {
              query,
              q: query,
              limit,
              max_results: limit,
              count: limit,
            },
            inputSchema: searchSchema,
            ...(context.traceId !== undefined && context.spanId !== undefined
              ? {
                traceContext: {
                  traceId: context.traceId,
                  spanId: context.spanId,
                  traceFlags: context.traceFlags ?? 0,
                  ...(context.traceState === undefined
                    ? {}
                    : { traceState: context.traceState }),
                },
              }
              : {}),
          });
        } catch (err) {
          throw new CommandExecutionError(
            `External search MCP tool failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }

        if (callResult.isError === true) {
          throw new CommandExecutionError(
            "External search MCP tool returned an error",
          );
        }

        // Always clear prior search mappings before processing the new query
        state.sourceUrlMap.clear();

        const allNormalized: WebSearchResultItem[] = [];
        for (const item of callResult.content ?? []) {
          if (item.type === "text" && typeof item.text === "string") {
            allNormalized.push(...normalizeSearchResults(item.text));
          } else {
            allNormalized.push(...normalizeSearchResults(item));
          }
        }

        // Re-index ranks and slice to requested limit
        const normalized = allNormalized.slice(0, limit).map((item, idx) => ({
          ...item,
          id: `s${idx + 1}`,
          rank: idx + 1,
        }));

        if (normalized.length === 0) {
          return formatUntrustedMcpResult(
            `No search results found for query: "${query}"`,
          );
        }

        // Cache source URLs for follow-up web_fetch on the current query
        for (const item of normalized) {
          if (item.url) {
            state.sourceUrlMap.set(item.id, item.url);
          }
        }

        const formatted = [
          `Search results for "${query}":\n`,
          ...normalized.map((item) => {
            const dateStr = item.publishedDate
              ? ` (Date: ${item.publishedDate})`
              : "";
            return `[${item.rank}] (ID: ${item.id}) ${item.title}${dateStr}\nURL: ${item.url}\nSnippet: ${item.snippet}\n`;
          }),
        ].join("\n");

        return formatUntrustedMcpResult(formatted);
      },
    });
  }

  // Register web_fetch command (either through fetchTool or native safeFetchDocument)
  const fetchSchema: JsonSchemaObject = {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The public HTTPS URL to fetch and extract content from.",
      },
      sourceId: {
        type: "string",
        description:
          "The source ID from the most recent web_search result (e.g. 's1', 's2').",
      },
    },
  };

  const hasConfiguredFetchTool = Boolean(fetchToolName && configuredFetchTool);

  commands.push({
    id: "web_fetch",
    title: "Web Page Fetch",
    description:
      "Fetch and extract readable Markdown text from a web page URL or a source ID from recent search results. " +
      "Returned content is untrusted external data.",
    inputSchema: fetchSchema,
    permission: {
      effects: [
        hasConfiguredFetchTool &&
          configuredFetchTool?.effect === "write_external"
          ? "write.external"
          : "read.external",
        "emit.event",
      ],
      defaultDecision: hasConfiguredFetchTool
        ? (configuredFetchTool?.approval ?? "allow")
        : "allow",
      resources: hasConfiguredFetchTool
        ? [`mcp:${server.id}/${fetchToolName}`]
        : ["web:native_fetch"],
      network: hasConfiguredFetchTool ? "configured-external" : "external",
      filesystem: "none",
      cost: "none",
    },
    redactArguments: true,
    redactResult: true,
    minimumClearance: server.minimumClearance,
    spanKind: "client",
    eventContent: (isError) =>
      JSON.stringify({
        outcome: isError ? "error" : "complete",
        webCapability: { tool: "web_fetch", server: server.id },
      }),
    executor: async (commandCall, context) => {
      if (context.traceId && state.currentTraceId !== context.traceId) {
        state.currentTraceId = context.traceId;
        resetWebToolsTurnState(state);
      }

      if (state.fetchCount >= MAX_FETCH_CALLS_PER_TURN) {
        throw new CommandExecutionError(
          `Web fetch call limit exceeded (${MAX_FETCH_CALLS_PER_TURN} calls per turn maximum).`,
        );
      }
      state.fetchCount++;

      const rawUrl = commandCall.arguments.url;
      const rawSourceId = commandCall.arguments.sourceId;

      let targetUrl: string;
      if (typeof rawSourceId === "string" && rawSourceId.trim()) {
        const id = rawSourceId.trim();
        const resolved = state.sourceUrlMap.get(id);
        if (!resolved) {
          throw new CommandExecutionError(
            `Source ID '${id}' was not found in recent search results. Provide a direct URL or run web_search first.`,
          );
        }
        targetUrl = resolved;
      } else if (typeof rawUrl === "string" && rawUrl.trim()) {
        targetUrl = rawUrl.trim();
      } else {
        throw new CommandExecutionError(
          "Either 'url' or 'sourceId' must be provided to web_fetch",
        );
      }

      // Enforce syntactic HTTPS and private-address rejection on the target URL
      assertPublicHttpsUrl(targetUrl, allowLoopbackHttpForTesting);

      // If upstream fetchTool is declared on the server, delegate to it
      if (fetchToolName && configuredFetchTool) {
        const call = deps.call ?? (async (input) => {
          const { Client, StreamableHTTPClientTransport } = await import(
            "npm:@modelcontextprotocol/client@2.0.0"
          );
          const transport = new StreamableHTTPClientTransport(
            new URL(server.url),
            {
              requestInit: {
                redirect: "error",
                headers: { Authorization: `Bearer ${token}` },
              },
              fetch: boundedMcpFetch(256 * 1024),
            },
          );
          const client = new Client(
            { name: "dyfj-workbench-tools", version: "1.0.0" },
            { versionNegotiation: { mode: { pin: "2026-07-28" } } },
          );
          try {
            await client.connect(transport, { timeout: 5_000 });
            return await client.callTool(
              { name: input.tool, arguments: input.arguments },
              { timeout: 30_000 },
            );
          } finally {
            await client.close().catch(() => {});
          }
        });

        let callResult: McpCallResult;
        try {
          callResult = await call({
            server,
            token,
            tool: fetchToolName,
            arguments: {
              url: targetUrl,
              link: targetUrl,
              sourceId: rawSourceId,
            },
            inputSchema: fetchSchema,
            ...(context.traceId !== undefined && context.spanId !== undefined
              ? {
                traceContext: {
                  traceId: context.traceId,
                  spanId: context.spanId,
                  traceFlags: context.traceFlags ?? 0,
                  ...(context.traceState === undefined
                    ? {}
                    : { traceState: context.traceState }),
                },
              }
              : {}),
          });
        } catch (err) {
          throw new CommandExecutionError(
            `External fetch MCP tool failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }

        if (callResult.isError === true) {
          throw new CommandExecutionError(
            "External fetch MCP tool returned an error",
          );
        }

        let rawContent = (callResult.content ?? []).map((item) =>
          item.type === "text" && typeof item.text === "string"
            ? item.text
            : JSON.stringify(item)
        ).join("\n");

        if (rawContent.length > MAX_EXTRACTED_CHARS_PER_FETCH) {
          rawContent = rawContent.slice(0, MAX_EXTRACTED_CHARS_PER_FETCH) +
            `\n\n[Content truncated at ${MAX_EXTRACTED_CHARS_PER_FETCH.toLocaleString()} characters]`;
        }

        if (
          state.extractedChars + rawContent.length >
            MAX_EXTRACTED_CHARS_PER_TURN
        ) {
          throw new CommandExecutionError(
            `Total extracted characters limit per turn exceeded (${MAX_EXTRACTED_CHARS_PER_TURN.toLocaleString()} chars maximum).`,
          );
        }
        state.extractedChars += rawContent.length;

        return formatUntrustedMcpResult(rawContent);
      }

      // Default: Safe native document fetch
      const doc = await safeFetchDocument(
        targetUrl,
        fetch,
        allowLoopbackHttpForTesting,
      );

      if (
        state.extractedChars + doc.text.length > MAX_EXTRACTED_CHARS_PER_TURN
      ) {
        throw new CommandExecutionError(
          `Total extracted characters limit per turn exceeded (${MAX_EXTRACTED_CHARS_PER_TURN.toLocaleString()} chars maximum).`,
        );
      }
      state.extractedChars += doc.text.length;

      const formatted = [
        `URL: ${doc.url}`,
        `Content-Type: ${doc.contentType}`,
        `Bytes: ${doc.bytes.toLocaleString()}`,
        "---",
        doc.text,
      ].join("\n");

      return formatUntrustedMcpResult(formatted);
    },
  });

  return commands;
}
