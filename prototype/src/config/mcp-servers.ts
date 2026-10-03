/**
 * The `[mcp]` section: bounded, HTTP-only external MCP server declarations.
 */

import { processEnv } from "./env.ts";
import type { SecretsConfig } from "./secrets-config.ts";
import {
  configFilePath,
  configLabel,
  defaultParseToml,
  type LoadConfigDeps,
  readConfigFile,
} from "./toml.ts";

export type McpMinimumClearance = "loopback" | "remote";
export type McpConfiguredToolEffect = "read" | "write_external";
export type McpConfiguredToolApproval = "allow" | "ask";

export interface McpConfiguredTool {
  name: string;
  effect: McpConfiguredToolEffect;
  approval: McpConfiguredToolApproval;
}

export interface McpServerCapabilities {
  searchTool?: string;
  fetchTool?: string;
}

/** Operator-owned IDs used by the bounded native Linear issue-creation tool. */
export interface LinearIssueCreationBinding {
  teamId: string;
  /** Exact model-visible project name to stable Linear project ID. */
  projects: Readonly<Record<string, string>>;
}

export interface McpHttpServerConfig {
  id: string;
  transport: "streamable_http";
  url: string;
  minimumClearance: McpMinimumClearance;
  auth: { type: "bearer"; secret: string };
  tools: McpConfiguredTool[];
  capabilities?: McpServerCapabilities;
  linearIssueCreation?: LinearIssueCreationBinding;
}

const MCP_SERVER_ID = /^[a-z][a-z0-9_-]{0,31}$/;
const MCP_TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MCP_SECRET_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_MCP_SERVERS = 8;
const MAX_MCP_TOOLS_PER_SERVER = 32;
const MAX_LINEAR_PROJECTS = 64;
const LINEAR_CONFIG_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}(?![\s\S])/;

function assertSecureMcpServerUrl(value: unknown, where: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `config: MCP server url must be a non-empty string in ${where}`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`config: MCP server url is not a valid URL in ${where}`);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error(
      `config: MCP server url must not include credentials in ${where}`,
    );
  }
  if (parsed.hostname.includes(",")) {
    throw new Error(
      `config: MCP server hostname must not contain a comma in ${where}`,
    );
  }
  const loopback = parsed.hostname === "::1" || parsed.hostname === "[::1]" ||
    /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(parsed.hostname);
  if (
    parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)
  ) {
    throw new Error(
      `config: MCP server url must use https (plain http is allowed only for loopback) in ${where}`,
    );
  }
  return value;
}

function exactObject(
  value: unknown,
  label: string,
  keys: readonly string[],
  where: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`config: ${label} must be a table in ${where}`);
  }
  const object = value as Record<string, unknown>;
  const allowed = new Set(keys);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      throw new Error(`config: ${label}.${key} is not recognized in ${where}`);
    }
  }
  return object;
}

function parseMcpTools(
  rawTools: unknown[],
  where: string,
): McpConfiguredTool[] {
  const toolNames = new Set<string>();
  const tools: McpConfiguredTool[] = [];
  for (const rawTool of rawTools) {
    const tool = exactObject(
      rawTool,
      "[[mcp.servers.tools]]",
      ["name", "effect", "approval"],
      where,
    );
    if (typeof tool.name !== "string" || !MCP_TOOL_NAME.test(tool.name)) {
      throw new Error(`config: MCP tool name is invalid in ${where}`);
    }
    if (toolNames.has(tool.name)) {
      throw new Error(`config: duplicate MCP tool name in ${where}`);
    }
    toolNames.add(tool.name);
    if (tool.effect !== "read" && tool.effect !== "write_external") {
      throw new Error(
        `config: MCP tool effect must be read or write_external in ${where}`,
      );
    }
    if (tool.approval !== "allow" && tool.approval !== "ask") {
      throw new Error(
        `config: MCP tool approval must be allow or ask in ${where}`,
      );
    }
    if (tool.effect === "write_external" && tool.approval !== "ask") {
      throw new Error(
        `config: MCP write_external tools must use approval ask in ${where}`,
      );
    }
    tools.push({
      name: tool.name,
      effect: tool.effect,
      approval: tool.approval,
    });
  }
  return tools;
}

function parseMcpCapabilities(
  rawCapabilities: unknown,
  toolNames: ReadonlySet<string>,
  where: string,
): McpServerCapabilities {
  const rawCaps = exactObject(
    rawCapabilities,
    "[[mcp.servers]].capabilities",
    ["search_tool", "fetch_tool"],
    where,
  );
  if (
    rawCaps.search_tool !== undefined &&
    (typeof rawCaps.search_tool !== "string" ||
      !MCP_TOOL_NAME.test(rawCaps.search_tool) ||
      !toolNames.has(rawCaps.search_tool))
  ) {
    throw new Error(
      `config: MCP capabilities.search_tool must be a declared tool in ${where}`,
    );
  }
  if (
    rawCaps.fetch_tool !== undefined &&
    (typeof rawCaps.fetch_tool !== "string" ||
      !MCP_TOOL_NAME.test(rawCaps.fetch_tool) ||
      !toolNames.has(rawCaps.fetch_tool))
  ) {
    throw new Error(
      `config: MCP capabilities.fetch_tool must be a declared tool in ${where}`,
    );
  }
  if (
    rawCaps.search_tool === "create_issue" ||
    rawCaps.fetch_tool === "create_issue" ||
    rawCaps.search_tool === "save_issue" ||
    rawCaps.fetch_tool === "save_issue"
  ) {
    throw new Error(
      `config: create_issue cannot be a search or fetch capability; use linear_issue_creation (also required for save_issue) in ${where}`,
    );
  }
  if (
    rawCaps.search_tool === undefined && rawCaps.fetch_tool === undefined
  ) {
    throw new Error(
      `config: MCP capabilities must declare search_tool or fetch_tool in ${where}`,
    );
  }
  return {
    ...(rawCaps.search_tool === undefined
      ? {}
      : { searchTool: rawCaps.search_tool }),
    ...(rawCaps.fetch_tool === undefined
      ? {}
      : { fetchTool: rawCaps.fetch_tool }),
  };
}

function parseLinearIssueCreation(
  rawLinearIssueCreation: unknown,
  tools: readonly McpConfiguredTool[],
  minimumClearance: McpMinimumClearance,
  where: string,
): LinearIssueCreationBinding {
  const rawBinding = exactObject(
    rawLinearIssueCreation,
    "[[mcp.servers]].linear_issue_creation",
    ["team_id", "projects"],
    where,
  );
  if (
    typeof rawBinding.team_id !== "string" ||
    !LINEAR_CONFIG_ID.test(rawBinding.team_id)
  ) {
    throw new Error(
      `config: Linear issue team_id must be a stable ID in ${where}`,
    );
  }
  if (
    typeof rawBinding.projects !== "object" ||
    rawBinding.projects === null || Array.isArray(rawBinding.projects)
  ) {
    throw new Error(
      `config: Linear issue projects must be an exact-name to ID table in ${where}`,
    );
  }
  const projectEntries = Object.entries(
    rawBinding.projects as Record<string, unknown>,
  );
  if (
    projectEntries.length === 0 ||
    projectEntries.length > MAX_LINEAR_PROJECTS
  ) {
    throw new Error(
      `config: Linear issue projects must contain 1-${MAX_LINEAR_PROJECTS} entries in ${where}`,
    );
  }
  const projects: Record<string, string> = Object.create(null);
  for (const [name, id] of projectEntries) {
    if (
      name.length === 0 || name.length > 200 || name.trim().length === 0
    ) {
      throw new Error(
        `config: Linear issue project names must be 1-200 UTF-16 code units and not whitespace-only in ${where}`,
      );
    }
    if (typeof id !== "string" || !LINEAR_CONFIG_ID.test(id)) {
      throw new Error(
        `config: Linear issue project IDs must be stable IDs in ${where}`,
      );
    }
    projects[name] = id;
  }
  const creationTools = tools.filter((tool) =>
    tool.name === "create_issue" || tool.name === "save_issue"
  );
  const createIssue = creationTools[0];
  if (
    creationTools.length !== 1 || createIssue === undefined ||
    createIssue.effect !== "write_external" ||
    createIssue.approval !== "ask"
  ) {
    throw new Error(
      `config: Linear issue creation requires create_issue as write_external with approval ask, or save_issue with the same policy; configure exactly one in ${where}`,
    );
  }
  if (minimumClearance !== "loopback") {
    throw new Error(
      `config: Linear issue creation requires minimum_clearance loopback in ${where}`,
    );
  }
  return {
    teamId: rawBinding.team_id,
    projects,
  };
}

/**
 * Parse one `[[mcp.servers]]` entry. Checks run in a fixed order (identity,
 * transport, url, clearance, auth, tools, capabilities, Linear binding), so
 * the first error reported for a bad entry stays stable. `ids` is the set of
 * ids already seen in this file; the caller owns it.
 */
function parseMcpServer(
  rawServer: unknown,
  ids: ReadonlySet<string>,
  where: string,
  secrets: SecretsConfig | null | undefined,
): McpHttpServerConfig {
  const server = exactObject(
    rawServer,
    "[[mcp.servers]]",
    [
      "id",
      "transport",
      "url",
      "minimum_clearance",
      "auth",
      "tools",
      "capabilities",
      "linear_issue_creation",
    ],
    where,
  );
  if (typeof server.id !== "string" || !MCP_SERVER_ID.test(server.id)) {
    throw new Error(
      `config: MCP server id must match ${MCP_SERVER_ID} in ${where}`,
    );
  }
  if (ids.has(server.id)) {
    throw new Error(`config: duplicate MCP server id in ${where}`);
  }
  if (server.transport !== "streamable_http") {
    throw new Error(
      `config: MCP transport must be streamable_http in ${where}`,
    );
  }
  const url = assertSecureMcpServerUrl(server.url, where);
  // "remote" is reserved for a future gateway client, not a shipped remote transport.
  if (
    server.minimum_clearance !== "loopback" &&
    server.minimum_clearance !== "remote"
  ) {
    throw new Error(
      `config: MCP minimum_clearance must be loopback or remote in ${where}`,
    );
  }
  const auth = exactObject(
    server.auth,
    "[[mcp.servers]].auth",
    ["type", "secret"],
    where,
  );
  if (auth.type !== "bearer") {
    throw new Error(`config: MCP auth type must be bearer in ${where}`);
  }
  if (typeof auth.secret !== "string" || !MCP_SECRET_NAME.test(auth.secret)) {
    throw new Error(
      `config: MCP auth secret must name [secrets.named] in ${where}`,
    );
  }
  if (
    secrets !== undefined && !Object.hasOwn(secrets?.named ?? {}, auth.secret)
  ) {
    throw new Error(
      `config: MCP auth secret ${auth.secret} is not declared in [secrets.named] in ${where}`,
    );
  }
  if (!Array.isArray(server.tools) || server.tools.length === 0) {
    throw new Error(
      `config: MCP tools must be a non-empty array in ${where}`,
    );
  }
  if (server.tools.length > MAX_MCP_TOOLS_PER_SERVER) {
    throw new Error(
      `config: MCP tools exceed ${MAX_MCP_TOOLS_PER_SERVER} entries in ${where}`,
    );
  }
  const tools = parseMcpTools(server.tools, where);
  const toolNames = new Set(tools.map((tool) => tool.name));
  const capabilities = server.capabilities === undefined
    ? undefined
    : parseMcpCapabilities(server.capabilities, toolNames, where);
  const linearIssueCreation = server.linear_issue_creation === undefined
    ? undefined
    : parseLinearIssueCreation(
      server.linear_issue_creation,
      tools,
      server.minimum_clearance,
      where,
    );
  return {
    id: server.id,
    transport: "streamable_http",
    url,
    minimumClearance: server.minimum_clearance,
    auth: { type: "bearer", secret: auth.secret },
    tools,
    ...(capabilities === undefined ? {} : { capabilities }),
    ...(linearIssueCreation === undefined ? {} : { linearIssueCreation }),
  };
}

/** Parse the bounded HTTP-only external MCP capability declaration. */
export function parseMcpServersConfig(
  table: Record<string, unknown> | null,
  path: string,
  secrets?: SecretsConfig | null,
): McpHttpServerConfig[] {
  if (table === null || table.mcp === undefined) return [];
  const where = configLabel(path);
  const mcp = exactObject(table.mcp, "[mcp]", ["servers"], where);
  const rawServers = mcp.servers;
  if (!Array.isArray(rawServers)) {
    throw new Error(
      `config: [mcp].servers must be an array of tables in ${where}`,
    );
  }
  if (rawServers.length > MAX_MCP_SERVERS) {
    throw new Error(
      `config: [mcp].servers exceeds ${MAX_MCP_SERVERS} entries in ${where}`,
    );
  }
  const ids = new Set<string>();
  const configured: McpHttpServerConfig[] = [];
  for (const rawServer of rawServers) {
    const server = parseMcpServer(rawServer, ids, where, secrets);
    ids.add(server.id);
    configured.push(server);
  }
  return configured;
}

export async function loadMcpServersConfig(
  deps: LoadConfigDeps = {},
  secrets?: SecretsConfig | null,
): Promise<McpHttpServerConfig[]> {
  const env = deps.env ?? processEnv;
  const readTextFile = deps.readTextFile ?? Deno.readTextFile;
  const parseToml = deps.parseToml ?? defaultParseToml;
  const path = configFilePath(env);
  const table = await readConfigFile(path, readTextFile, parseToml);
  return parseMcpServersConfig(table, path, secrets);
}
