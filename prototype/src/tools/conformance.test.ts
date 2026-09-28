// The tool conformance kit over every tool the catalog can register: the
// builtins, with every dependency supplied, and the commands the external MCP
// adapter derives from configuration (a generic read tool, a generic write
// tool, bounded Linear issue creation, and the web search and fetch
// capabilities). No executor runs and nothing reaches the network: discovery
// and calls are injected.

import { assertEquals } from "@std/assert";
import { toolConformance } from "../../testing/conformance/tool.ts";
import { parseMcpServersConfig } from "../config/mod.ts";
import saveIssueSchema from "../linear-save-issue-schema.fixture.ts";
import { buildExternalMcpCommands } from "../mcp-tools.ts";
import { buildToolCatalog } from "./mod.ts";

const builtins = buildToolCatalog({
  readMemory: () => "memory",
  searchMemory: () => "recall",
}, {
  allowedMemorySlugs: ["kit-memory"],
  workspaceRoot: "/kit-workspace",
});

const discovered = {
  get_issue: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string" } },
    additionalProperties: false,
  },
  create_comment: {
    type: "object",
    required: ["issueId", "body"],
    properties: { issueId: { type: "string" }, body: { type: "string" } },
  },
  save_issue: saveIssueSchema,
  web_search: {
    type: "object",
    required: ["query"],
    properties: { query: { type: "string" }, max_results: { type: "integer" } },
  },
  web_extract: {
    type: "object",
    required: ["urls"],
    properties: { urls: { type: "array", items: { type: "string" } } },
  },
} as const;

const external = await buildExternalMcpCommands(
  parseMcpServersConfig({
    mcp: {
      servers: [{
        id: "linear",
        transport: "streamable_http",
        url: "https://mcp.linear.invalid/mcp",
        minimum_clearance: "loopback",
        auth: { type: "bearer", secret: "linear_mcp" },
        tools: [
          { name: "get_issue", effect: "read", approval: "allow" },
          { name: "create_comment", effect: "write_external", approval: "ask" },
          { name: "save_issue", effect: "write_external", approval: "ask" },
        ],
        linear_issue_creation: {
          team_id: "team_kit_01",
          projects: { "Kit Project": "project_kit_01" },
        },
      }, {
        id: "web",
        transport: "streamable_http",
        url: "https://mcp.web.invalid/mcp",
        minimum_clearance: "remote",
        auth: { type: "bearer", secret: "web_mcp" },
        tools: [
          { name: "web_search", effect: "read", approval: "allow" },
          { name: "web_extract", effect: "read", approval: "allow" },
        ],
        capabilities: { search_tool: "web_search", fetch_tool: "web_extract" },
      }],
    },
  }, "/kit/config.toml"),
  { linear_mcp: "kit-token", web_mcp: "kit-token" },
  {
    discover: ({ server }) =>
      Promise.resolve({
        revision: "2026-07-28",
        tools: server.tools.map(({ name }) => ({
          name,
          inputSchema: discovered[name as keyof typeof discovered],
        })),
      }),
    call: () => Promise.reject(new Error("the kit never runs an executor")),
  },
);

Deno.test("the kit's external MCP fixture derives every command shape", () => {
  assertEquals(external.commands.map((command) => command.id), [
    "mcp.linear.get_issue",
    "mcp.linear.create_comment",
    "mcp.linear.create_issue",
    "web_search",
    "web_fetch",
  ]);
});

Deno.test("the kit covers every builtin tool", () => {
  assertEquals(builtins.list().map((command) => command.id), [
    "memory.read",
    "memory.search",
    "read_file",
    "list_files",
    "grep_files",
    "glob_files",
    "write_file",
    "edit_file",
    "bash",
    "git",
  ]);
});

toolConformance({ name: "builtin", catalog: builtins });
toolConformance({
  name: "external MCP",
  catalog: buildToolCatalog({}, {}, external.commands, []),
});
