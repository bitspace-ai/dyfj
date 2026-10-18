import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import saveIssueSchema from "../../extensions/linear/linear-save-issue-schema.fixture.ts";
import { buildLinearIssueCreationCommand } from "../../extensions/linear/mod.ts";
import {
  mcpServerNetGrants,
  parseMcpServersConfig,
  type SecretsConfig,
} from "../../config/mod.ts";
import {
  buildExternalMcpCommands,
  externalMcpCommandsForTransport,
  requireNegotiatedMcpRevision,
  retainConfiguredMcpTools,
  sanitizeMcpInputSchema,
} from "./adapter.ts";
import { createCommandRegistry, invokeCommandWithEvent } from "../mod.ts";
import { SdkError, SdkErrorCode } from "@modelcontextprotocol/client";

const CONFIG_PATH = "/private/operator/.dyfj/config.toml";

type McpDeps = NonNullable<Parameters<typeof buildExternalMcpCommands>[2]>;
type CallPort = NonNullable<McpDeps["call"]>;
type DiscoverPort = NonNullable<McpDeps["discover"]>;

// Recording ports the test expects to stay unused. Like a bare mock, each
// returns nothing if it is called; the assertions on its calls catch that.
function unusedCall() {
  return mock.fn((() => undefined) as unknown as CallPort);
}

function unusedDiscover() {
  return mock.fn((() => undefined) as unknown as DiscoverPort);
}

// The Linear extension's issue-creation builder, as the composition root
// passes it to discovery.
const WITH_LINEAR = {
  buildIssueCreationCommand: buildLinearIssueCreationCommand,
};

function serverTable(overrides: Record<string, unknown> = {}) {
  return {
    mcp: {
      servers: [{
        id: "linear",
        transport: "streamable_http",
        url: "https://mcp.linear.app/mcp",
        minimum_clearance: "loopback",
        auth: { type: "bearer", secret: "linear_mcp" },
        tools: [
          { name: "get_issue", effect: "read", approval: "allow" },
          {
            name: "create_comment",
            effect: "write_external",
            approval: "ask",
          },
        ],
        ...overrides,
      }],
    },
  };
}

function linearCreationTable(overrides: Record<string, unknown> = {}) {
  return serverTable({
    tools: [{
      name: "create_issue",
      effect: "write_external",
      approval: "ask",
    }],
    linear_issue_creation: {
      team_id: "team_fixture_01",
      projects: {
        "Synthetic Project": "project_fixture_01",
        "Second Project": "project_fixture_02",
      },
    },
    ...overrides,
  });
}

describe("external MCP command projection", () => {
  it("never exposes generic create_issue without a bounded binding", async () => {
    const table = serverTable({
      tools: [{
        name: "create_issue",
        effect: "write_external",
        approval: "ask",
      }],
    });
    const call = unusedCall();
    const built = await buildExternalMcpCommands(
      parseMcpServersConfig(table, CONFIG_PATH),
      { linear_mcp: "secret-value" },
      {
        ...WITH_LINEAR,
        discover: async () => ({
          revision: "2026-07-28",
          tools: [{ name: "create_issue", inputSchema: { type: "object" } }],
        }),
        call,
      },
    );
    assert.deepStrictEqual(built.commands, []);
    assert.deepStrictEqual(built.diagnostics, [
      {
        serverId: "linear",
        status: "withheld",
        tool: "create_issue",
        reason: "binding missing",
      },
      {
        serverId: "linear",
        status: "ready",
        revision: "2026-07-28",
        toolCount: 0,
      },
    ]);
    assert.equal(call.mock.callCount(), 0);
  });

  for (const upstreamTool of ["create_issue", "save_issue"] as const) {
    it(
      `withholds unserializable ${upstreamTool} without losing another tool`,
      async () => {
        const schema: Record<string, unknown> = { type: "object" };
        schema.properties = { optional: schema };
        const call = unusedCall();
        const built = await buildExternalMcpCommands(
          parseMcpServersConfig(
            linearCreationTable({
              tools: [
                {
                  name: upstreamTool,
                  effect: "write_external",
                  approval: "ask",
                },
                { name: "get_issue", effect: "read", approval: "allow" },
              ],
            }),
            CONFIG_PATH,
          ),
          { linear_mcp: "secret-value" },
          {
            ...WITH_LINEAR,
            discover: async () => ({
              revision: "2026-07-28",
              tools: [
                { name: upstreamTool, inputSchema: schema },
                {
                  name: "get_issue",
                  inputSchema: { type: "object", properties: {} },
                },
              ],
            }),
            call,
          },
        );
        assert.deepStrictEqual(built.commands.map((command) => command.id), [
          "mcp.linear.get_issue",
        ]);
        assert.deepStrictEqual(built.diagnostics, [
          {
            serverId: "linear",
            status: "withheld",
            tool: upstreamTool,
            reason: "unsupported schema",
          },
          {
            serverId: "linear",
            status: "ready",
            revision: "2026-07-28",
            toolCount: 1,
          },
        ]);
        assert.equal(call.mock.callCount(), 0);
      },
    );
  }

  it("withholds bounded create_issue on a discovered schema mismatch", async () => {
    const built = await buildExternalMcpCommands(
      parseMcpServersConfig(linearCreationTable(), CONFIG_PATH),
      { linear_mcp: "secret-value" },
      {
        ...WITH_LINEAR,
        discover: async () => ({
          revision: "2026-07-28",
          tools: [{
            name: "create_issue",
            inputSchema: {
              type: "object",
              properties: { title: { type: "string" } },
            },
          }],
        }),
        call: unusedCall(),
      },
    );
    assert.deepStrictEqual(built.commands, []);
    assert.deepStrictEqual(built.diagnostics, [
      {
        serverId: "linear",
        status: "withheld",
        tool: "create_issue",
        reason: "unsupported schema",
      },
      {
        serverId: "linear",
        status: "ready",
        revision: "2026-07-28",
        toolCount: 0,
      },
    ]);
  });

  for (
    const [name, tools, reason] of [
      ["missing discovery", [], "tool not discovered"],
      ["invalid schema", [{
        name: "create_issue",
        inputSchema: "untrusted schema details",
      }], "unsupported schema"],
    ] as const
  ) {
    it(`withholds with a fixed reason for ${name}`, async () => {
      const call = unusedCall();
      const built = await buildExternalMcpCommands(
        parseMcpServersConfig(linearCreationTable(), CONFIG_PATH),
        { linear_mcp: "secret-value" },
        {
          ...WITH_LINEAR,
          discover: async () => ({ revision: "2026-07-28", tools: [...tools] }),
          call,
        },
      );
      assert.deepStrictEqual(built.commands, []);
      assert.deepStrictEqual(built.diagnostics[0], {
        serverId: "linear",
        status: "withheld",
        tool: "create_issue",
        reason,
      });
      assert.ok(
        !(JSON.stringify(built.diagnostics)).includes(
          "untrusted schema details",
        ),
      );
      assert.equal(call.mock.callCount(), 0);
    });
  }

  it("reserves create_issue on a non-Linear server without a binding", async () => {
    const call = unusedCall();
    const built = await buildExternalMcpCommands(
      parseMcpServersConfig(
        serverTable({
          id: "other",
          url: "https://example.com/mcp",
          tools: [{
            name: "create_issue",
            effect: "write_external",
            approval: "ask",
          }],
        }),
        CONFIG_PATH,
      ),
      { linear_mcp: "secret-value" },
      {
        ...WITH_LINEAR,
        discover: async () => ({
          revision: "2026-07-28",
          tools: [{ name: "create_issue", inputSchema: { type: "object" } }],
        }),
        call,
      },
    );
    assert.deepStrictEqual(built.commands, []);
    assert.deepStrictEqual(built.diagnostics[0], {
      serverId: "other",
      status: "withheld",
      tool: "create_issue",
      reason: "binding missing",
    });
    assert.equal(call.mock.callCount(), 0);
  });

  it("registers save_issue only as bounded create_issue with a binding", async () => {
    for (const withBinding of [false, true]) {
      const overrides = {
        tools: [{
          name: "save_issue",
          effect: "write_external",
          approval: "ask",
        }],
      };
      const call = unusedCall();
      const built = await buildExternalMcpCommands(
        parseMcpServersConfig(
          withBinding ? linearCreationTable(overrides) : serverTable(overrides),
          CONFIG_PATH,
        ),
        { linear_mcp: "secret-value" },
        {
          ...WITH_LINEAR,
          discover: async () => ({
            revision: "2026-07-28",
            tools: [{ name: "save_issue", inputSchema: saveIssueSchema }],
          }),
          call,
        },
      );
      assert.deepStrictEqual(
        built.commands.map((c) => c.id),
        withBinding ? ["mcp.linear.create_issue"] : [],
      );
      assert.deepStrictEqual(
        externalMcpCommandsForTransport(built.commands, "remote"),
        [],
      );
      if (withBinding) {
        assert.ok(!("id" in built.commands[0].inputSchema.properties!));
        assert.strictEqual(built.commands[0].permission.defaultDecision, "ask");
      } else {
        assert.partialDeepStrictEqual(built.diagnostics[0], {
          tool: "save_issue",
          reason: "binding missing",
        });
      }
      assert.equal(call.mock.callCount(), 0);
    }
  });

  it("withholds bounded creation when discovery gets no issue-creation builder", async () => {
    const call = unusedCall();
    const built = await buildExternalMcpCommands(
      parseMcpServersConfig(
        linearCreationTable({
          tools: [
            { name: "save_issue", effect: "write_external", approval: "ask" },
            { name: "get_issue", effect: "read", approval: "allow" },
          ],
        }),
        CONFIG_PATH,
      ),
      { linear_mcp: "secret-value" },
      {
        // No buildIssueCreationCommand: the binding and schema are valid.
        discover: async () => ({
          revision: "2026-07-28",
          tools: [
            { name: "save_issue", inputSchema: saveIssueSchema },
            {
              name: "get_issue",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        }),
        call,
      },
    );
    assert.deepStrictEqual(built.commands.map((c) => c.id), [
      "mcp.linear.get_issue",
    ]);
    assert.deepStrictEqual(built.diagnostics, [
      {
        serverId: "linear",
        status: "withheld",
        tool: "save_issue",
        reason: "unsupported schema",
      },
      {
        serverId: "linear",
        status: "ready",
        revision: "2026-07-28",
        toolCount: 1,
      },
    ]);
    assert.equal(call.mock.callCount(), 0);
  });

  it("registers the bounded projection when binding and schema match", async () => {
    const built = await buildExternalMcpCommands(
      parseMcpServersConfig(linearCreationTable(), CONFIG_PATH),
      { linear_mcp: "secret-value" },
      {
        ...WITH_LINEAR,
        discover: async () => ({
          revision: "2026-07-28",
          tools: [{
            name: "create_issue",
            inputSchema: {
              type: "object",
              properties: {
                title: { type: "string" },
                description: { type: "string" },
                team: { type: "string" },
                project: { type: "string" },
                priority: { type: "integer" },
                relatedTo: {
                  type: "array",
                  items: { type: "string" },
                },
              },
              required: ["title", "team"],
              additionalProperties: false,
            },
          }],
        }),
        call: unusedCall(),
      },
    );
    assert.deepStrictEqual(built.commands.map((command) => command.id), [
      "mcp.linear.create_issue",
    ]);
    assert.ok(!("team" in built.commands[0].inputSchema.properties!));
    assert.partialDeepStrictEqual(built.commands[0].permission, {
      defaultDecision: "ask",
      network: "configured-external",
    });
    assert.strictEqual(built.commands[0].minimumClearance, "loopback");
    assert.deepStrictEqual(
      externalMcpCommandsForTransport(built.commands, "remote"),
      [],
    );
    assert.deepStrictEqual(
      externalMcpCommandsForTransport(built.commands, "loopback"),
      built.commands,
    );
    assert.partialDeepStrictEqual(built.diagnostics[0], { toolCount: 1 });
  });

  it("an inherited credential property is unavailable", async () => {
    const credentials = Object.create({ linear_mcp: "inherited-secret" });
    const discover = unusedDiscover();
    const result = await buildExternalMcpCommands(
      parseMcpServersConfig(serverTable(), CONFIG_PATH),
      credentials,
      { ...WITH_LINEAR, discover },
    );
    assert.deepStrictEqual(result.commands, []);
    assert.deepStrictEqual(result.diagnostics, [{
      serverId: "linear",
      status: "unavailable",
      reason: "credential unavailable",
    }]);
    assert.equal(discover.mock.callCount(), 0);
  });

  it("registers only the configured and discovered intersection", async () => {
    const call = mock.fn(async () => ({
      content: [{ type: "text", text: "issue" }],
      isError: false,
    }));
    const result = await buildExternalMcpCommands(
      parseMcpServersConfig(serverTable(), CONFIG_PATH),
      { linear_mcp: "secret-value" },
      {
        ...WITH_LINEAR,
        discover: async () => ({
          revision: "2026-07-28",
          tools: [
            {
              name: "get_issue",
              description: "Get one issue",
              inputSchema: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  labels: { type: "array", items: { type: "string" } },
                  filter: {
                    type: "object",
                    properties: { open: { type: "boolean" } },
                    additionalProperties: false,
                  },
                },
                required: ["id", "labels", "filter"],
                additionalProperties: false,
              },
            },
            {
              name: "delete_issue",
              description: "Not configured",
              inputSchema: { type: "object" },
            },
          ],
        }),
        call,
      },
    );

    assert.deepStrictEqual(result.diagnostics, [{
      serverId: "linear",
      status: "dropped",
      tool: "create_comment",
      reason: "not offered by the server",
    }, {
      serverId: "linear",
      status: "ready",
      revision: "2026-07-28",
      toolCount: 1,
    }]);
    assert.deepStrictEqual(
      result.commands.map((command: { id: string }) => command.id),
      [
        "mcp.linear.get_issue",
      ],
    );
    assert.partialDeepStrictEqual(result.commands[0]?.permission, {
      defaultDecision: "allow",
      network: "configured-external",
    });
    assert.strictEqual(result.commands[0]?.minimumClearance, "loopback");

    const registry = createCommandRegistry(result.commands);
    const events: Record<string, unknown>[] = [];
    const invocation = await invokeCommandWithEvent(
      registry,
      {
        commandId: "mcp.linear.get_issue",
        callId: "call-1",
        caller: { principalId: "operator", principalType: "human" },
        arguments: {
          id: "ISSUE-1",
          labels: ["bug"],
          filter: { open: true },
        },
      },
      {
        sessionId: "session-1",
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        writeEvent: (event: unknown) => {
          events.push(event as Record<string, unknown>);
        },
      },
      undefined,
      { loopback: true },
    );

    assert.partialDeepStrictEqual(invocation, {
      decision: "allow",
      isError: false,
      authzBasis: "policy:allow:operator-configured-external-read",
    });
    assert.equal(call.mock.callCount(), 1);
    assert.ok(
      String(invocation.isError ? "" : invocation.result).includes(
        "<untrusted-mcp-result>",
      ),
      `expected String(invocation.isError ? "" : invocation.result) to include "<untrusted-mcp-result>"`,
    );
    assert.partialDeepStrictEqual(events[0], {
      tool_name: "mcp.linear.get_issue",
      tool_arguments:
        '{"id":"[redacted]","labels":"[redacted]","filter":"[redacted]"}',
      tool_result: "[redacted]",
      span_kind: "client",
    });
    assert.ok(
      String(events[0]?.content).includes('"server":"linear"'),
      `expected String(events[0]?.content) to include '"server":"linear"'`,
    );
    assert.ok(
      String(events[0]?.content).includes('"revision":"2026-07-28"'),
      `expected String(events[0]?.content) to include '"revision":"2026-07-28"'`,
    );
    assert.ok(!(JSON.stringify(events[0])).includes("secret-value"));
    assert.ok(!(JSON.stringify(events[0])).includes("mcp.linear.app"));
  });

  it("write tools always ask and preserve one operator-approved call", async () => {
    const call = mock.fn(async () => ({
      content: [{ type: "text", text: "created" }],
      isError: false,
    }));
    const discovered = await buildExternalMcpCommands(
      parseMcpServersConfig(serverTable(), CONFIG_PATH),
      { linear_mcp: "secret-value" },
      {
        ...WITH_LINEAR,
        discover: async () => ({
          revision: "2026-07-28",
          tools: [{
            name: "create_comment",
            description: "Create a comment",
            inputSchema: {
              type: "object",
              properties: {
                issue: { type: "string" },
                body: { type: "string" },
              },
              required: ["issue", "body"],
              additionalProperties: false,
            },
          }],
        }),
        call,
      },
    );
    const registry = createCommandRegistry(discovered.commands);
    const approve = mock.fn(async () => ({ decision: "approve" as const }));
    const result = await invokeCommandWithEvent(
      registry,
      {
        commandId: "mcp.linear.create_comment",
        callId: "call-2",
        caller: { principalId: "operator", principalType: "human" },
        arguments: { issue: "ISSUE-1", body: "one comment" },
      },
      {
        sessionId: "session-1",
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        writeEvent: () => {},
      },
      approve,
      { permissionLevel: "operator", loopback: true },
    );
    assert.partialDeepStrictEqual(result, {
      decision: "allow",
      authzBasis: "policy:allow:operator-approved",
    });
    assert.equal(approve.mock.callCount(), 1);
    assert.equal(call.mock.callCount(), 1);
  });

  it("an unavailable credential disables only its server with a value-free diagnostic", async () => {
    const discover = unusedDiscover();
    const result = await buildExternalMcpCommands(
      parseMcpServersConfig(serverTable(), CONFIG_PATH),
      {},
      { ...WITH_LINEAR, discover, call: unusedCall() },
    );
    assert.deepStrictEqual(result.commands, []);
    assert.deepStrictEqual(result.diagnostics, [{
      serverId: "linear",
      status: "unavailable",
      reason: "credential unavailable",
    }]);
    assert.equal(discover.mock.callCount(), 0);
  });

  it("a call failure becomes one class-only tool error and one redacted receipt", async () => {
    const built = await buildExternalMcpCommands(
      parseMcpServersConfig(serverTable(), CONFIG_PATH),
      { linear_mcp: "secret-value" },
      {
        ...WITH_LINEAR,
        discover: async () => ({
          revision: "2026-07-28",
          tools: [{
            name: "get_issue",
            inputSchema: {
              type: "object",
              properties: { id: { type: "string" } },
              required: ["id"],
            },
          }],
        }),
        call: async () => {
          throw new Error("foreign failure containing secret-value");
        },
      },
    );
    const events: Record<string, unknown>[] = [];
    const result = await invokeCommandWithEvent(
      createCommandRegistry(built.commands),
      {
        commandId: "mcp.linear.get_issue",
        callId: "call-failed",
        caller: { principalId: "operator", principalType: "human" },
        arguments: { id: "ISSUE-1" },
      },
      {
        sessionId: "session-1",
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        writeEvent: (event: unknown) => {
          events.push(event as Record<string, unknown>);
        },
      },
      undefined,
      { loopback: true },
    );
    assert.deepStrictEqual(result, {
      decision: "allow",
      authzBasis: "policy:allow:operator-configured-external-read",
      isError: true,
      reason: "External MCP tool call failed: client error (Error).",
      operatorReason: "client error (Error)",
    });
    assert.partialDeepStrictEqual(events[0], {
      action: "invoke",
      tool_is_error: true,
      tool_result: "client error (Error)",
    });
    assert.ok(
      String(events[0]?.content).includes('"outcome":"error"'),
      `expected String(events[0]?.content) to include '"outcome":"error"'`,
    );
    assert.ok(!(JSON.stringify(events[0])).includes("secret-value"));
    assert.ok(!(JSON.stringify(result)).includes("secret-value"));
  });
});

describe("MCP HTTP containment", () => {
  it("preserves supported additionalProperties semantics", () => {
    const omitted = sanitizeMcpInputSchema({
      type: "object",
      properties: { query: { type: "string" } },
    });
    assert.strictEqual(omitted.additionalProperties, undefined);
    assert.strictEqual(
      sanitizeMcpInputSchema({
        type: "object",
        additionalProperties: true,
      }).additionalProperties,
      true,
    );
    assert.throws(
      () =>
        sanitizeMcpInputSchema({
          type: "object",
          additionalProperties: { type: "string" },
        }),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("additionalProperties is not a boolean"),
    );
  });

  it("retains an own __proto__ property without invoking a prototype setter", () => {
    const schema = sanitizeMcpInputSchema(JSON.parse(
      '{"type":"object","properties":{"__proto__":{"type":"string"}},"required":["__proto__"]}',
    ));
    assert.strictEqual(
      Object.hasOwn(schema.properties ?? {}, "__proto__"),
      true,
    );
    assert.strictEqual(Object.getPrototypeOf(schema.properties ?? {}), null);
  });

  it("retains only configured tools from an aggregated discovery result", () => {
    assert.deepStrictEqual(
      retainConfiguredMcpTools(
        [{ name: "keep" }, { name: "also_keep" }],
        [
          { name: "drop", inputSchema: { type: "object" } },
          { name: "keep", inputSchema: { type: "object" } },
          { name: "keep", inputSchema: { type: "object" } },
        ],
      ).map((tool: { name: string }) => tool.name),
      ["keep"],
    );
  });

  it("preserves integer schemas and rejects fractional arguments locally", async () => {
    const call = unusedCall();
    const built = await buildExternalMcpCommands(
      parseMcpServersConfig(serverTable(), CONFIG_PATH),
      { linear_mcp: "secret-value" },
      {
        ...WITH_LINEAR,
        discover: async () => ({
          revision: "2026-07-28",
          tools: [{
            name: "get_issue",
            inputSchema: {
              type: "object",
              properties: { count: { type: "integer" } },
              required: ["count"],
              additionalProperties: false,
            },
          }],
        }),
        call,
      },
    );
    assert.strictEqual(
      built.commands[0].inputSchema.properties?.count?.type,
      "integer",
    );
    const result = await invokeCommandWithEvent(
      createCommandRegistry(built.commands),
      {
        commandId: "mcp.linear.get_issue",
        callId: "fractional",
        caller: { principalId: "operator", principalType: "human" },
        arguments: { count: 1.5 },
      },
      {
        sessionId: "session-1",
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        writeEvent: () => {},
      },
      undefined,
      { loopback: true },
    );
    assert.partialDeepStrictEqual(result, { decision: "deny", isError: true });
    assert.equal(call.mock.callCount(), 0);
  });

  it("accepts only the observed pinned protocol revision", () => {
    const matching = mock.fn(() => "2026-07-28");
    assert.strictEqual(
      requireNegotiatedMcpRevision({
        getNegotiatedProtocolVersion: matching,
      }),
      "2026-07-28",
    );
    assert.equal(matching.mock.callCount(), 1);

    for (const revision of [undefined, "unsupported-2020-01-01"]) {
      assert.throws(
        () =>
          requireNegotiatedMcpRevision({
            getNegotiatedProtocolVersion: () => revision,
          }),
        (error: unknown) =>
          error instanceof Error &&
          error.message.includes("external MCP protocol revision mismatch"),
      );
    }
  });

  it("withholds loopback-only commands from remote turns", () => {
    const loopbackOnly = {
      id: "mcp.linear.get_issue",
      minimumClearance: "loopback",
    } as never;
    const remoteEligible = {
      id: "mcp.public.search",
      minimumClearance: "remote",
    } as never;
    assert.deepStrictEqual(
      externalMcpCommandsForTransport(
        [loopbackOnly, remoteEligible],
        "remote",
      ).map((command: { id: string }) => command.id),
      ["mcp.public.search"],
    );
    assert.deepStrictEqual(
      externalMcpCommandsForTransport(
        [loopbackOnly, remoteEligible],
        "loopback",
      ).map((command: { id: string }) => command.id),
      ["mcp.linear.get_issue", "mcp.public.search"],
    );
  });

  it("derives unique launch grants without retaining endpoints", () => {
    const configs = [
      ...parseMcpServersConfig(serverTable(), CONFIG_PATH),
      ...parseMcpServersConfig(
        serverTable({
          id: "local",
          url: "http://127.0.0.1:43137/mcp",
          auth: { type: "bearer", secret: "local_mcp" },
        }),
        CONFIG_PATH,
      ),
    ];
    assert.deepStrictEqual(mcpServerNetGrants(configs), [
      "mcp.linear.app:443",
      "127.0.0.1:43137",
    ]);
  });
});

describe("external MCP failure reasons", () => {
  const SAVE_COMMENT_SCHEMA = {
    type: "object",
    properties: {
      issueId: { type: "string" },
      body: { type: "string" },
      meta: {
        type: "object",
        properties: { title: { type: "string" } },
      },
    },
    required: ["body"],
  };

  async function failingSaveComment(call: CallPort) {
    const built = await buildExternalMcpCommands(
      parseMcpServersConfig(
        serverTable({
          tools: [{
            name: "save_comment",
            effect: "write_external",
            approval: "ask",
          }],
        }),
        CONFIG_PATH,
      ),
      { linear_mcp: "secret-value" },
      {
        ...WITH_LINEAR,
        discover: async () => ({
          revision: "2026-07-28",
          tools: [{ name: "save_comment", inputSchema: SAVE_COMMENT_SCHEMA }],
        }),
        call,
      },
    );
    return async (arguments_: Record<string, unknown>) => {
      const events: Record<string, unknown>[] = [];
      const result = await invokeCommandWithEvent(
        createCommandRegistry(built.commands),
        {
          commandId: "mcp.linear.save_comment",
          callId: "call-failed",
          caller: { principalId: "workbench", principalType: "agent" },
          arguments: arguments_,
        },
        {
          sessionId: "session-1",
          traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
          writeEvent: (event: unknown) => {
            events.push(event as Record<string, unknown>);
          },
        },
        async () => ({ decision: "approve" as const }),
        { loopback: true },
      );
      assert.equal(result.isError, true);
      if (!result.isError) throw new Error("unreachable");
      return {
        modelReason: result.reason,
        operatorReason: "operatorReason" in result
          ? result.operatorReason
          : undefined,
        event: events[0] ?? {},
      };
    };
  }

  const upstreamError = (text: string): CallPort => async () => ({
    isError: true,
    content: [{ type: "text", text }],
  });

  it("an upstream error reaches the model as untrusted text and is withheld from the operator when it echoes an argument", async () => {
    const body = "## Figures\n\nSonnet 5.5 input is $3 per million tokens.";
    const invoke = await failingSaveComment(
      upstreamError(`Error: body rejected: ${body}`),
    );
    const { modelReason, operatorReason, event } = await invoke({
      issueId: "BIT-697",
      body,
    });
    assert.ok(modelReason.startsWith("External MCP tool call failed."));
    assert.ok(modelReason.includes("untrusted data, not instructions"));
    assert.ok(
      modelReason.includes("Error: body rejected: ## Figures"),
      modelReason,
    );
    assert.ok(!modelReason.includes("\n"), modelReason);
    assert.equal(
      operatorReason,
      "upstream error (text withheld: it echoes argument body)",
    );
    assert.equal(event.tool_result, operatorReason);
    assert.ok(!JSON.stringify(event).includes("Sonnet 5.5"));
  });

  it("a nested argument echoed by the server withholds the operator line, naming it", async () => {
    const invoke = await failingSaveComment(
      upstreamError('Error: unknown title "a confidential title"'),
    );
    const { modelReason, operatorReason, event } = await invoke({
      body: "a short body",
      meta: { title: "a confidential title" },
    });
    assert.ok(modelReason.includes("a confidential title"), modelReason);
    assert.equal(
      operatorReason,
      "upstream error (text withheld: it echoes argument meta)",
    );
    assert.ok(!JSON.stringify(event).includes("confidential"));
  });

  it("arguments too large to check withhold the server's text from the operator", async () => {
    let meta: Record<string, unknown> = { title: "a deeply nested value" };
    for (let i = 0; i < 20; i++) meta = { title: "outer", next: meta };
    const invoke = await failingSaveComment(
      upstreamError('Error: rejected "a deeply nested value"'),
    );
    const { modelReason, operatorReason, event } = await invoke({
      body: "body text",
      meta,
    });
    assert.ok(modelReason.includes("a deeply nested value"), modelReason);
    assert.equal(
      operatorReason,
      "upstream error (text withheld: arguments too large to check)",
    );
    assert.ok(!JSON.stringify(event).includes("deeply nested"));
  });

  it("a secret-shaped string in the server's error is scrubbed for the operator", async () => {
    const token = `sk-${"q".repeat(32)}`;
    const invoke = await failingSaveComment(
      upstreamError(`Error: rejected key ${token}`),
    );
    const { operatorReason, event } = await invoke({ body: "body text" });
    assert.equal(operatorReason, "upstream error: Error: rejected key [scrubbed]");
    assert.ok(!JSON.stringify(event).includes(token));
  });

  it("the model's copy of an upstream error is capped and single-line", async () => {
    const invoke = await failingSaveComment(
      upstreamError(`line one\nline two ${"x".repeat(2_000)}`),
    );
    const { modelReason, operatorReason } = await invoke({ body: "body text" });
    assert.ok(!modelReason.includes("\n"), modelReason);
    assert.ok(modelReason.includes("line one line two"), modelReason);
    assert.ok(modelReason.length < 500, `${modelReason.length}`);
    assert.ok(
      new TextEncoder().encode(operatorReason).byteLength <= 160,
      `${operatorReason}`,
    );
  });

  it("an MCP call timeout is named as one", async () => {
    const invoke = await failingSaveComment(async () => {
      throw new SdkError(SdkErrorCode.RequestTimeout, "Request timed out", {
        timeout: 30_000,
      });
    });
    const { modelReason, operatorReason, event } = await invoke({
      body: "body text",
    });
    assert.equal(
      modelReason,
      "External MCP tool call failed: timed out after 30 s waiting for the server.",
    );
    assert.equal(operatorReason, "timed out after 30 s waiting for the server");
    assert.equal(event.tool_result, operatorReason);
  });

  it("a transport error gives a class line naming its code", async () => {
    const invoke = await failingSaveComment(async () => {
      throw new TypeError("fetch failed containing secret-value", {
        cause: Object.assign(new Error("socket hang up secret-value"), {
          code: "ECONNRESET",
        }),
      });
    });
    const { modelReason, operatorReason, event } = await invoke({
      body: "body text",
    });
    assert.equal(
      modelReason,
      "External MCP tool call failed: transport error (ECONNRESET).",
    );
    assert.equal(operatorReason, "transport error (ECONNRESET)");
    assert.ok(!JSON.stringify(event).includes("secret-value"));
  });

  it("an SDK error names its fixed code, not its message", async () => {
    const invoke = await failingSaveComment(async () => {
      throw new SdkError(
        SdkErrorCode.ClientHttpAuthentication,
        "401 with secret-value",
      );
    });
    const { operatorReason } = await invoke({ body: "body text" });
    assert.equal(operatorReason, "MCP client error (CLIENT_HTTP_AUTHENTICATION)");
  });
});
