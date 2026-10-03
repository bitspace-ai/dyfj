import type {
  CommandDefinition,
  CommandExecutionContext,
  CommandTraceContext,
  JsonSchemaObject,
} from "../definition.ts";
import { CommandExecutionError } from "../definition.ts";
import type {
  McpConfiguredTool,
  McpHttpServerConfig,
} from "../../config/mod.ts";
import {
  type ExternalMcpDeps,
  formatUntrustedMcpResult,
  type McpCallResult,
} from "../mcp/transport.ts";
import { type DnsResolver, systemDnsResolver } from "./dns.ts";
import {
  FETCH_TIMEOUT_MS,
  MAX_EXTRACTED_CHARS_PER_FETCH,
  MAX_EXTRACTED_CHARS_PER_TURN,
  MAX_FETCH_CALLS_PER_TURN,
  MAX_SEARCH_CALLS_PER_TURN,
  MAX_SESSION_TURNS_CAP,
} from "./web-limits.ts";
import {
  assertPublicDnsResolution,
  assertPublicHttpsUrl,
} from "./web-url-safety.ts";

export {
  MAX_EXTRACTED_CHARS_PER_FETCH,
  MAX_FETCH_CALLS_PER_TURN,
  MAX_SEARCH_CALLS_PER_TURN,
} from "./web-limits.ts";

export interface WebSearchResultItem {
  id?: string;
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

export interface TurnWebState {
  searchCount: number;
  fetchCount: number;
  extractedChars: number;
  sourceUrlMap: Map<string, string>;
  lastActivity: number;
}

function createTurnWebState(): TurnWebState {
  return {
    searchCount: 0,
    fetchCount: 0,
    extractedChars: 0,
    sourceUrlMap: new Map<string, string>(),
    lastActivity: Date.now(),
  };
}

export interface WebToolsSessionState {
  turns: Map<string, TurnWebState>;
  getTurnState(traceId?: string): TurnWebState;
  reset(traceId?: string): void;
}

export function createWebToolsSessionState(): WebToolsSessionState {
  const turns = new Map<string, TurnWebState>();

  return {
    turns,
    getTurnState(traceId?: string): TurnWebState {
      const now = Date.now();

      // Clean up stale turn states older than 5 minutes
      for (const [key, t] of turns.entries()) {
        if (now - t.lastActivity > 300_000) {
          turns.delete(key);
        }
      }

      const key = traceId && traceId.trim() ? traceId.trim() : "__default__";
      let turn = turns.get(key);

      if (turn) {
        if (key === "__default__" && now - turn.lastActivity > 60_000) {
          // Auto-reset untraced default state after 60s of inactivity
          turn = createTurnWebState();
          turns.set(key, turn);
        }
        turn.lastActivity = now;
        return turn;
      }

      // Evict least recently active entry when creating a new key at capacity
      if (turns.size >= MAX_SESSION_TURNS_CAP) {
        let lruTraceId: string | undefined;
        let earliestTimestamp = Infinity;
        for (const [id, t] of turns.entries()) {
          if (t.lastActivity < earliestTimestamp) {
            earliestTimestamp = t.lastActivity;
            lruTraceId = id;
          }
        }
        if (lruTraceId !== undefined) turns.delete(lruTraceId);
      }

      turn = createTurnWebState();
      turns.set(key, turn);
      return turn;
    },
    reset(traceId?: string): void {
      if (traceId && traceId.trim()) {
        turns.delete(traceId.trim());
      } else {
        turns.clear();
      }
    },
  };
}

/** Reset turn-scoped state container. */
export function resetWebToolsTurnState(
  state: WebToolsSessionState,
  traceId?: string,
): void {
  state.reset(traceId);
}

/** Parse and normalize raw search tool results into standard WebSearchResultItems. */
export function normalizeSearchResults(
  rawResult: unknown,
  limit?: number,
): WebSearchResultItem[] {
  let parsed: unknown = rawResult;
  if (typeof rawResult === "string") {
    try {
      parsed = JSON.parse(rawResult);
    } catch {
      const trimmed = rawResult.trim();
      if (!trimmed) return [];
      return [{
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
        if (limit && items.length >= limit) break;
      }
    }
  } else if (typeof parsed === "object" && parsed !== null) {
    const obj = parsed as Record<string, unknown>;
    // Tavily shape: { results: [...] }
    if (Array.isArray(obj.results)) {
      for (const entry of obj.results) {
        if (typeof entry === "object" && entry !== null) {
          items.push(entry as Record<string, unknown>);
          if (limit && items.length >= limit) break;
        }
      }
    } else if (Array.isArray(obj.organic_results)) {
      for (const entry of obj.organic_results) {
        if (typeof entry === "object" && entry !== null) {
          items.push(entry as Record<string, unknown>);
          if (limit && items.length >= limit) break;
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

    const id = url ? `s${rank}` : undefined;
    normalized.push({
      ...(id ? { id } : {}),
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

function traceContextFor(
  context: CommandExecutionContext,
): { traceContext?: CommandTraceContext } {
  return context.traceId !== undefined && context.spanId !== undefined
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
    : {};
}

/** Remap conventional search parameter names if present in discovered schema. */
function upstreamSearchArguments(
  query: string,
  limit: number,
  discoveredSchema: JsonSchemaObject | undefined,
): Record<string, unknown> {
  const searchProps = (discoveredSchema?.properties ??
    {}) as Record<string, unknown>;
  const upstreamArgs: Record<string, unknown> = {};

  if ("query" in searchProps) {
    upstreamArgs.query = query;
  } else if ("q" in searchProps) {
    upstreamArgs.q = query;
  } else if ("search_query" in searchProps) {
    upstreamArgs.search_query = query;
  } else {
    upstreamArgs.query = query;
  }

  if ("limit" in searchProps) {
    upstreamArgs.limit = limit;
  } else if ("max_results" in searchProps) {
    upstreamArgs.max_results = limit;
  } else if ("count" in searchProps) {
    upstreamArgs.count = limit;
  } else if ("num_results" in searchProps) {
    upstreamArgs.num_results = limit;
  }
  return upstreamArgs;
}

/** Remap conventional URL property names if present in discovered schema. */
function upstreamFetchArguments(
  canonicalUrl: string,
  discoveredSchema: JsonSchemaObject | undefined,
): Record<string, unknown> {
  const fetchProps = (discoveredSchema?.properties ??
    {}) as Record<string, unknown>;
  const upstreamFetchArgs: Record<string, unknown> = {};

  if ("urls" in fetchProps) {
    upstreamFetchArgs.urls = [canonicalUrl];
  } else if ("url" in fetchProps) {
    upstreamFetchArgs.url = canonicalUrl;
  } else if ("link" in fetchProps) {
    upstreamFetchArgs.link = canonicalUrl;
  } else if ("target_url" in fetchProps) {
    upstreamFetchArgs.target_url = canonicalUrl;
  } else {
    upstreamFetchArgs.url = canonicalUrl;
  }
  return upstreamFetchArgs;
}

function formatSearchResults(
  query: string,
  results: readonly WebSearchResultItem[],
): string {
  return [
    `Search results for "${query}":\n`,
    ...results.map((item) => {
      const idLabel = item.id ? ` (ID: ${item.id})` : "";
      const dateStr = item.publishedDate
        ? ` (Date: ${item.publishedDate})`
        : "";
      const urlStr = item.url ? `URL: ${item.url}\n` : "";
      return `[${item.rank}]${idLabel} ${item.title}${dateStr}\n${urlStr}Snippet: ${item.snippet}\n`;
    }),
  ].join("\n");
}

/**
 * Incrementally materialize content blocks to bound allocation, marking the
 * text when it was cut at the per-fetch ceiling.
 */
function boundedFetchContent(result: McpCallResult): string {
  let rawContent = "";
  let wasTruncated = false;
  for (const item of result.content ?? []) {
    let itemText = item.type === "text" && typeof item.text === "string"
      ? item.text
      : JSON.stringify(item);
    const remaining = MAX_EXTRACTED_CHARS_PER_FETCH - rawContent.length;
    if (remaining <= 0) {
      wasTruncated = true;
      break;
    }
    if (itemText.length > remaining) {
      itemText = itemText.slice(0, remaining);
      wasTruncated = true;
    }
    rawContent += (rawContent.length > 0 ? "\n" : "") + itemText;
  }

  if (wasTruncated || rawContent.length > MAX_EXTRACTED_CHARS_PER_FETCH) {
    const marker =
      `\n\n[Content truncated at ${MAX_EXTRACTED_CHARS_PER_FETCH.toLocaleString()} characters]`;
    const keepChars = Math.max(
      0,
      MAX_EXTRACTED_CHARS_PER_FETCH - marker.length,
    );
    rawContent = rawContent.slice(0, keepChars) + marker;
  }
  return rawContent;
}

/**
 * The fetch target from exactly one of `url` or a `sourceId` the active
 * turn's last search assigned.
 */
function resolveFetchTarget(
  args: Record<string, unknown>,
  turn: TurnWebState,
): string {
  const rawUrl = args.url;
  const rawSourceId = args.sourceId;

  const hasUrl = typeof rawUrl === "string" && rawUrl.trim().length > 0;
  const hasSourceId = typeof rawSourceId === "string" &&
    rawSourceId.trim().length > 0;

  if (hasUrl && hasSourceId) {
    throw new CommandExecutionError(
      "Provide either 'url' or 'sourceId' to web_fetch, not both.",
    );
  }

  if (hasSourceId) {
    const id = String(rawSourceId).trim();
    const resolved = turn.sourceUrlMap.get(id);
    if (!resolved) {
      throw new CommandExecutionError(
        `Source ID '${id}' was not found in recent search results. Provide a direct URL or run web_search first.`,
      );
    }
    return resolved;
  }
  if (hasUrl) return String(rawUrl).trim();
  throw new CommandExecutionError(
    "Either 'url' or 'sourceId' must be provided to web_fetch",
  );
}

interface WebCommandInput {
  server: McpHttpServerConfig;
  token: string;
  deps: ExternalMcpDeps;
  state: WebToolsSessionState;
  upstreamTool: string;
  configuredTool: McpConfiguredTool | undefined;
  discoveredSchema: JsonSchemaObject | undefined;
}

function defineWebSearchCommand(
  input: WebCommandInput,
): CommandDefinition<string> {
  const {
    server,
    token,
    deps,
    state,
    upstreamTool: searchToolName,
    configuredTool: configuredSearchTool,
  } = input;
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

  return {
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
      const turn = state.getTurnState(context.traceId);

      if (turn.searchCount >= MAX_SEARCH_CALLS_PER_TURN) {
        throw new CommandExecutionError(
          `Web search call limit exceeded (${MAX_SEARCH_CALLS_PER_TURN} calls per turn maximum).`,
        );
      }
      turn.searchCount++;

      const query = String(commandCall.arguments.query ?? "").trim();
      if (!query) {
        throw new CommandExecutionError("Search query must not be empty");
      }

      const rawLimit = Number(commandCall.arguments.limit ?? 5);
      const limit = Math.max(1, Math.min(10, isNaN(rawLimit) ? 5 : rawLimit));

      // Clear prior search mappings in this turn immediately on new search invocation
      turn.sourceUrlMap.clear();

      const call = deps.call;
      if (!call) {
        throw new CommandExecutionError("No MCP call delegate provided");
      }

      let callResult: McpCallResult;
      try {
        callResult = await call({
          server,
          token,
          tool: searchToolName,
          arguments: upstreamSearchArguments(
            query,
            limit,
            input.discoveredSchema,
          ),
          inputSchema: searchSchema,
          ...traceContextFor(context),
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

      const allNormalized: WebSearchResultItem[] = [];
      for (const item of callResult.content ?? []) {
        if (item.type === "text" && typeof item.text === "string") {
          allNormalized.push(...normalizeSearchResults(item.text, limit));
        } else {
          allNormalized.push(...normalizeSearchResults(item, limit));
        }
      }

      let validSourceIdIdx = 1;
      // Slice to requested limit and assign source IDs only when URL is present
      const normalized = allNormalized.slice(0, limit).map((item, idx) => {
        const hasUrl = Boolean(item.url && item.url.trim().length > 0);
        const id = hasUrl ? `s${validSourceIdIdx++}` : undefined;
        if (id && item.url) {
          turn.sourceUrlMap.set(id, item.url);
        }
        return {
          ...item,
          id,
          rank: idx + 1,
        };
      });

      if (normalized.length === 0) {
        return formatUntrustedMcpResult(
          `No search results found for query: "${query}"`,
        );
      }

      return formatUntrustedMcpResult(formatSearchResults(query, normalized));
    },
  };
}

function defineWebFetchCommand(
  input: WebCommandInput & {
    configuredTool: McpConfiguredTool;
    allowLoopbackHttpForTesting: boolean;
    resolver: DnsResolver;
  },
): CommandDefinition<string> {
  const {
    server,
    token,
    deps,
    state,
    upstreamTool: fetchToolName,
    configuredTool: configuredFetchTool,
    allowLoopbackHttpForTesting,
    resolver,
  } = input;
  const fetchSchema: JsonSchemaObject = {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The HTTPS URL to fetch and extract content from.",
      },
      sourceId: {
        type: "string",
        description:
          "The source ID from recent search results in the active turn (e.g. 's1', 's2').",
      },
    },
  };

  return {
    id: "web_fetch",
    title: "Web Page Fetch",
    description:
      "Fetch content from an HTTPS web page URL or a source ID from recent search results. " +
      "Returned content is untrusted external data.",
    inputSchema: fetchSchema,
    permission: {
      effects: [
        configuredFetchTool.effect === "write_external"
          ? "write.external"
          : "read.external",
        "emit.event",
      ],
      defaultDecision: configuredFetchTool.approval,
      resources: [`mcp:${server.id}/${fetchToolName}`],
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
        webCapability: { tool: "web_fetch", server: server.id },
      }),
    executor: async (commandCall, context) => {
      const turn = state.getTurnState(context.traceId);

      if (turn.fetchCount >= MAX_FETCH_CALLS_PER_TURN) {
        throw new CommandExecutionError(
          `Web fetch call limit exceeded (${MAX_FETCH_CALLS_PER_TURN} calls per turn maximum).`,
        );
      }
      turn.fetchCount++;

      const targetUrl = resolveFetchTarget(commandCall.arguments, turn);

      // Enforce syntactic HTTPS and private IP literal rejection on the target URL
      const parsedUrl = assertPublicHttpsUrl(
        targetUrl,
        allowLoopbackHttpForTesting,
      );

      const controller = new AbortController();
      const dnsTimeout = setTimeout(
        () => controller.abort(),
        FETCH_TIMEOUT_MS,
      );
      try {
        // Preflight DNS check for delegated fetch target with timeout
        await assertPublicDnsResolution(
          parsedUrl.hostname,
          allowLoopbackHttpForTesting,
          controller.signal,
          resolver,
        );
      } finally {
        clearTimeout(dnsTimeout);
      }

      const call = deps.call;
      if (!call) {
        throw new CommandExecutionError("No MCP call delegate provided");
      }

      let callResult: McpCallResult;
      try {
        callResult = await call({
          server,
          token,
          tool: fetchToolName,
          // Upstream receives the canonical parsed URL, never the raw input.
          arguments: upstreamFetchArguments(
            parsedUrl.toString(),
            input.discoveredSchema,
          ),
          inputSchema: fetchSchema,
          ...traceContextFor(context),
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

      const rawContent = boundedFetchContent(callResult);
      if (
        turn.extractedChars + rawContent.length >
          MAX_EXTRACTED_CHARS_PER_TURN
      ) {
        throw new CommandExecutionError(
          `Total extracted characters limit per turn exceeded (${MAX_EXTRACTED_CHARS_PER_TURN.toLocaleString()} chars maximum).`,
        );
      }
      turn.extractedChars += rawContent.length;

      return formatUntrustedMcpResult(rawContent);
    },
  };
}

/** Build standard `web_search` and `web_fetch` CommandDefinitions from a server configuration. */
export function defineWebCommands(
  server: McpHttpServerConfig,
  token: string,
  deps: ExternalMcpDeps = {},
  state: WebToolsSessionState = createWebToolsSessionState(),
  allowLoopbackHttpForTesting = false,
  discoveredSchemas: {
    searchSchema?: JsonSchemaObject;
    fetchSchema?: JsonSchemaObject;
  } = {},
  resolver: DnsResolver = systemDnsResolver,
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
    commands.push(defineWebSearchCommand({
      server,
      token,
      deps,
      state,
      upstreamTool: searchToolName,
      configuredTool: configuredSearchTool,
      discoveredSchema: discoveredSchemas.searchSchema,
    }));
  }

  // Register web_fetch command through configured fetchTool
  if (fetchToolName && configuredFetchTool) {
    commands.push(defineWebFetchCommand({
      server,
      token,
      deps,
      state,
      upstreamTool: fetchToolName,
      configuredTool: configuredFetchTool,
      discoveredSchema: discoveredSchemas.fetchSchema,
      allowLoopbackHttpForTesting,
      resolver,
    }));
  }

  return commands;
}
