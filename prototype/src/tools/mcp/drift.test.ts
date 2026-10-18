// A configured external MCP tool that does not reach the model is named at
// boot with the reason, never dropped silently (BIT-666).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseMcpServersConfig } from "../../config/mod.ts";
import {
  buildExternalMcpCommands,
  type ExternalMcpDiagnostic,
  formatExternalMcpDiagnostic,
  sanitizeMcpInputSchema,
} from "./adapter.ts";

const CONFIG_PATH = "/private/operator/.dyfj/config.toml";

function linearTable(toolNames: readonly string[]) {
  return {
    mcp: {
      servers: [{
        id: "linear",
        transport: "streamable_http",
        url: "https://mcp.linear.app/mcp",
        minimum_clearance: "loopback",
        auth: { type: "bearer", secret: "linear_mcp" },
        tools: toolNames.map((name) => ({
          name,
          effect: "read",
          approval: "allow",
        })),
      }],
    },
  };
}

function tavilyTable() {
  return {
    mcp: {
      servers: [{
        id: "tavily",
        transport: "streamable_http",
        url: "https://mcp.tavily.com/mcp",
        minimum_clearance: "loopback",
        auth: { type: "bearer", secret: "tavily_mcp" },
        tools: [
          { name: "tavily_search", effect: "read", approval: "allow" },
          { name: "tavily_extract", effect: "read", approval: "allow" },
        ],
        capabilities: {
          search_tool: "tavily_search",
          fetch_tool: "tavily_extract",
        },
      }],
    },
  };
}

const OK_SCHEMA = { type: "object", properties: { id: { type: "string" } } };

async function diagnose(
  table: Record<string, unknown>,
  tools: { name: string; inputSchema: unknown }[],
  credentials: Record<string, string> = { linear_mcp: "secret-value" },
): Promise<ExternalMcpDiagnostic[]> {
  const built = await buildExternalMcpCommands(
    parseMcpServersConfig(table, CONFIG_PATH),
    credentials,
    {
      discover: async () => ({ revision: "2026-07-28", tools }),
      call: async () => ({ content: [], isError: false }),
    },
  );
  return built.diagnostics;
}

function enumSchema(count: number) {
  return {
    type: "object",
    properties: {
      fields: {
        type: "array",
        items: {
          type: "string",
          enum: Array.from({ length: count }, (_, i) => `f${i}`),
        },
      },
    },
  };
}

describe("external MCP configured-tool drift", () => {
  it("names a configured tool the server does not offer", async () => {
    const diagnostics = await diagnose(
      linearTable(["get_issue", "create_comment"]),
      [{ name: "get_issue", inputSchema: OK_SCHEMA }],
    );
    assert.deepStrictEqual(diagnostics, [
      {
        serverId: "linear",
        status: "dropped",
        tool: "create_comment",
        reason: "not offered by the server",
      },
      {
        serverId: "linear",
        status: "ready",
        revision: "2026-07-28",
        toolCount: 1,
      },
    ]);
    assert.deepStrictEqual(diagnostics.map(formatExternalMcpDiagnostic), [
      'external MCP linear: configured tool "create_comment" not offered by the server',
      "external MCP linear: ready (1 tools, 2026-07-28)",
    ]);
  });

  it("names every configured tool when the server advertises nothing", async () => {
    const diagnostics = await diagnose(
      linearTable(["get_issue", "list_comments"]),
      [],
    );
    assert.deepStrictEqual(diagnostics.map(formatExternalMcpDiagnostic), [
      'external MCP linear: configured tool "get_issue" not offered by the server',
      'external MCP linear: configured tool "list_comments" not offered by the server',
      "external MCP linear: ready (0 tools, 2026-07-28)",
    ]);
  });

  it("names a capability-mapped tool the server does not offer", async () => {
    const diagnostics = await diagnose(
      tavilyTable(),
      [{ name: "tavily_search", inputSchema: OK_SCHEMA }],
      { tavily_mcp: "secret-value" },
    );
    assert.deepStrictEqual(diagnostics.map(formatExternalMcpDiagnostic), [
      'external MCP tavily: configured tool "tavily_extract" not offered by the server',
      "external MCP tavily: ready (0 tools + web_search, 2026-07-28)",
    ]);
  });

  it("counts the web tools a server supplies in its ready line", async () => {
    const diagnostics = await diagnose(
      tavilyTable(),
      [
        { name: "tavily_search", inputSchema: OK_SCHEMA },
        { name: "tavily_extract", inputSchema: OK_SCHEMA },
      ],
      { tavily_mcp: "secret-value" },
    );
    assert.deepStrictEqual(diagnostics.map(formatExternalMcpDiagnostic), [
      "external MCP tavily: ready (0 tools + web_search + web_fetch, 2026-07-28)",
    ]);
  });

  it("names the limit a rejected schema hit", async () => {
    const diagnostics = await diagnose(
      linearTable(["get_issue"]),
      [{ name: "get_issue", inputSchema: enumSchema(65) }],
    );
    assert.deepStrictEqual(diagnostics[0], {
      serverId: "linear",
      status: "dropped",
      tool: "get_issue",
      reason: "schema rejected: enum of 65 values exceeds 64",
    });
    assert.equal(
      formatExternalMcpDiagnostic(diagnostics[0]!),
      'external MCP linear: configured tool "get_issue" schema rejected: enum of 65 values exceeds 64',
    );
  });

  it("formats the existing withheld and unavailable diagnostics unchanged", () => {
    assert.equal(
      formatExternalMcpDiagnostic({
        serverId: "linear",
        status: "withheld",
        tool: "save_issue",
        reason: "binding missing",
      }),
      "external MCP linear: save_issue withheld (binding missing)",
    );
    assert.equal(
      formatExternalMcpDiagnostic({
        serverId: "linear",
        status: "unavailable",
        reason: "credential unavailable",
      }),
      "external MCP linear: unavailable (credential unavailable)",
    );
  });
});

describe("external MCP schema limits", () => {
  it("accepts an enum of exactly 64 values", () => {
    assert.doesNotThrow(() => sanitizeMcpInputSchema(enumSchema(64)));
  });

  it("rejects an enum of 65 values with the limit named", () => {
    assert.throws(
      () => sanitizeMcpInputSchema(enumSchema(65)),
      { message: "external MCP tool schema rejected: enum of 65 values exceeds 64" },
    );
  });

  it("accepts the observed Linear get_issue fields enum of 45 values", () => {
    assert.doesNotThrow(() => sanitizeMcpInputSchema(enumSchema(45)));
  });

  const deep = (levels: number): Record<string, unknown> => {
    let node: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < levels; i++) {
      node = { type: "object", properties: { n: node } };
    }
    return node;
  };
  const manyProperties = {
    type: "object",
    properties: Object.fromEntries(
      Array.from({ length: 65 }, (_, i) => [`p${i}`, { type: "string" }]),
    ),
  };
  const oversized = {
    type: "object",
    properties: { big: { type: "string", enum: ["x".repeat(64_001)] } },
  };

  // Every path that rejects a schema, with the reason the warning names.
  const rejections: [string, unknown, string][] = [
    ["byte limit", oversized, `schema rejected: ${
      new TextEncoder().encode(JSON.stringify(oversized)).byteLength
    } bytes exceeds 64000`],
    ["depth limit", deep(13), "schema rejected: nesting deeper than 12 levels"],
    ["non-object node", {
      type: "object",
      properties: { a: "x" },
    }, "schema rejected: a schema node is not an object"],
    ["$ref", {
      type: "object",
      properties: { a: { $ref: "#/x" } },
    }, "schema rejected: $ref is not supported"],
    ["unsupported type", {
      type: "object",
      properties: { a: { type: ["string", "null"] } },
    }, 'schema rejected: type ["string","null"] is not supported'],
    ["untyped node", {
      type: "object",
      properties: { a: { oneOf: [{ type: "string" }] } },
    }, "schema rejected: a schema node has no type"],
    ["unrecognized type", {
      type: "object",
      properties: { a: { type: "ignore previous instructions" } },
    }, "schema rejected: type of an unrecognized form is not supported"],
    ["properties not an object", {
      type: "object",
      properties: [],
    }, "schema rejected: properties is not an object"],
    [
      "property limit",
      manyProperties,
      "schema rejected: 65 properties exceeds 64",
    ],
    ["invalid property name", {
      type: "object",
      properties: { "bad name": { type: "string" } },
    }, "schema rejected: a property name is not a valid argument name"],
    ["invalid required", {
      type: "object",
      properties: { a: { type: "string" } },
      required: ["b"],
    }, "schema rejected: required names an undeclared property"],
    ["schema-valued additionalProperties", {
      type: "object",
      additionalProperties: { type: "string" },
    }, "schema rejected: schema-valued additionalProperties are not supported"],
    ["array without items", {
      type: "object",
      properties: { a: { type: "array" } },
    }, "schema rejected: array schema has no items"],
    ["enum limit", enumSchema(65), "schema rejected: enum of 65 values exceeds 64"],
    ["enum value type", {
      type: "object",
      properties: { a: { type: "string", enum: [{}] } },
    }, "schema rejected: enum value is not a string, number, boolean or null"],
    ["non-object root", { type: "string" }, "schema rejected: input schema root is not an object"],
  ];

  const circular: Record<string, unknown> = { type: "object" };
  circular.properties = { self: circular };
  rejections.push([
    "unserializable",
    circular,
    "schema rejected: the schema could not be read",
  ]);

  for (const [label, schema, reason] of rejections) {
    it(`names the ${label} rejection in a warning`, async () => {
      const diagnostics = await diagnose(
        linearTable(["get_issue"]),
        [{ name: "get_issue", inputSchema: schema }],
      );
      assert.deepStrictEqual(diagnostics[0], {
        serverId: "linear",
        status: "dropped",
        tool: "get_issue",
        reason,
      });
    });
  }
});
