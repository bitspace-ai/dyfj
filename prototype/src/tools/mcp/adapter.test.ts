import {
  assertEquals,
  assertFalse,
  assertObjectMatch,
  assertStrictEquals,
  assertStringIncludes,
  assertThrows,
  fail,
} from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { assertSpyCalls, spy } from "@std/testing/mock";
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

const CONFIG_PATH = "/private/operator/.dyfj/config.toml";

type McpDeps = NonNullable<Parameters<typeof buildExternalMcpCommands>[2]>;
type CallPort = NonNullable<McpDeps["call"]>;
type DiscoverPort = NonNullable<McpDeps["discover"]>;

// Recording ports the test expects to stay unused. Like a bare mock, each
// returns nothing if it is called; the assertions on its calls catch that.
function unusedCall() {
  return spy((() => undefined) as unknown as CallPort);
}

function unusedDiscover() {
  return spy((() => undefined) as unknown as DiscoverPort);
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
    assertEquals(built.commands, []);
    assertEquals(built.diagnostics, [
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
    assertSpyCalls(call, 0);
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
        assertEquals(built.commands.map((command) => command.id), [
          "mcp.linear.get_issue",
        ]);
        assertEquals(built.diagnostics, [
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
        assertSpyCalls(call, 0);
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
    assertEquals(built.commands, []);
    assertEquals(built.diagnostics, [
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
      assertEquals(built.commands, []);
      assertEquals(built.diagnostics[0], {
        serverId: "linear",
        status: "withheld",
        tool: "create_issue",
        reason,
      });
      assertFalse(
        (JSON.stringify(built.diagnostics)).includes(
          "untrusted schema details",
        ),
      );
      assertSpyCalls(call, 0);
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
    assertEquals(built.commands, []);
    assertEquals(built.diagnostics[0], {
      serverId: "other",
      status: "withheld",
      tool: "create_issue",
      reason: "binding missing",
    });
    assertSpyCalls(call, 0);
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
      assertEquals(
        built.commands.map((c) => c.id),
        withBinding ? ["mcp.linear.create_issue"] : [],
      );
      assertEquals(
        externalMcpCommandsForTransport(built.commands, "remote"),
        [],
      );
      if (withBinding) {
        assertFalse("id" in built.commands[0].inputSchema.properties!);
        assertStrictEquals(built.commands[0].permission.defaultDecision, "ask");
      } else {
        assertObjectMatch(built.diagnostics[0], {
          tool: "save_issue",
          reason: "binding missing",
        });
      }
      assertSpyCalls(call, 0);
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
    assertEquals(built.commands.map((c) => c.id), ["mcp.linear.get_issue"]);
    assertEquals(built.diagnostics, [
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
    assertSpyCalls(call, 0);
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
    assertEquals(built.commands.map((command) => command.id), [
      "mcp.linear.create_issue",
    ]);
    assertFalse("team" in built.commands[0].inputSchema.properties!);
    assertObjectMatch(built.commands[0].permission, {
      defaultDecision: "ask",
      network: "configured-external",
    });
    assertStrictEquals(built.commands[0].minimumClearance, "loopback");
    assertEquals(externalMcpCommandsForTransport(built.commands, "remote"), []);
    assertEquals(
      externalMcpCommandsForTransport(built.commands, "loopback"),
      built.commands,
    );
    assertObjectMatch(built.diagnostics[0], { toolCount: 1 });
  });

  it("an inherited credential property is unavailable", async () => {
    const credentials = Object.create({ linear_mcp: "inherited-secret" });
    const discover = unusedDiscover();
    const result = await buildExternalMcpCommands(
      parseMcpServersConfig(serverTable(), CONFIG_PATH),
      credentials,
      { ...WITH_LINEAR, discover },
    );
    assertEquals(result.commands, []);
    assertEquals(result.diagnostics, [{
      serverId: "linear",
      status: "unavailable",
      reason: "credential unavailable",
    }]);
    assertSpyCalls(discover, 0);
  });

  it("registers only the configured and discovered intersection", async () => {
    const call = spy(async () => ({
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

    assertEquals(result.diagnostics, [{
      serverId: "linear",
      status: "ready",
      revision: "2026-07-28",
      toolCount: 1,
    }]);
    assertEquals(result.commands.map((command: { id: string }) => command.id), [
      "mcp.linear.get_issue",
    ]);
    assertObjectMatch(result.commands[0]?.permission, {
      defaultDecision: "allow",
      network: "configured-external",
    });
    assertStrictEquals(result.commands[0]?.minimumClearance, "loopback");

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

    assertObjectMatch(invocation, {
      decision: "allow",
      isError: false,
      authzBasis: "policy:allow:operator-configured-external-read",
    });
    assertSpyCalls(call, 1);
    assertStringIncludes(
      String(invocation.isError ? "" : invocation.result),
      "<untrusted-mcp-result>",
    );
    assertObjectMatch(events[0], {
      tool_name: "mcp.linear.get_issue",
      tool_arguments:
        '{"id":"[redacted]","labels":"[redacted]","filter":"[redacted]"}',
      tool_result: "[redacted]",
      span_kind: "client",
    });
    assertStringIncludes(String(events[0]?.content), '"server":"linear"');
    assertStringIncludes(String(events[0]?.content), '"revision":"2026-07-28"');
    assertFalse((JSON.stringify(events[0])).includes("secret-value"));
    assertFalse((JSON.stringify(events[0])).includes("mcp.linear.app"));
  });

  it("write tools always ask and preserve one operator-approved call", async () => {
    const call = spy(async () => ({
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
    const approve = spy(async () => ({ decision: "approve" as const }));
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
    assertObjectMatch(result, {
      decision: "allow",
      authzBasis: "policy:allow:operator-approved",
    });
    assertSpyCalls(approve, 1);
    assertSpyCalls(call, 1);
  });

  it("an unavailable credential disables only its server with a value-free diagnostic", async () => {
    const discover = unusedDiscover();
    const result = await buildExternalMcpCommands(
      parseMcpServersConfig(serverTable(), CONFIG_PATH),
      {},
      { ...WITH_LINEAR, discover, call: unusedCall() },
    );
    assertEquals(result.commands, []);
    assertEquals(result.diagnostics, [{
      serverId: "linear",
      status: "unavailable",
      reason: "credential unavailable",
    }]);
    assertSpyCalls(discover, 0);
  });

  it("a call failure becomes one fixed tool error and one redacted receipt", async () => {
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
    assertEquals(result, {
      decision: "allow",
      authzBasis: "policy:allow:operator-configured-external-read",
      isError: true,
      reason: "External MCP tool call failed",
    });
    assertObjectMatch(events[0], {
      action: "invoke",
      tool_is_error: true,
      tool_result: "External MCP tool call failed",
    });
    assertStringIncludes(String(events[0]?.content), '"outcome":"error"');
    assertFalse((JSON.stringify(events[0])).includes("secret-value"));
    assertFalse((JSON.stringify(result)).includes("secret-value"));
  });
});

describe("MCP HTTP containment", () => {
  it("preserves supported additionalProperties semantics", () => {
    const omitted = sanitizeMcpInputSchema({
      type: "object",
      properties: { query: { type: "string" } },
    });
    assertStrictEquals(omitted.additionalProperties, undefined);
    assertStrictEquals(
      sanitizeMcpInputSchema({
        type: "object",
        additionalProperties: true,
      }).additionalProperties,
      true,
    );
    assertThrows(
      () =>
        sanitizeMcpInputSchema({
          type: "object",
          additionalProperties: { type: "string" },
        }),
      Error,
      "schema-valued additionalProperties are not supported",
    );
  });

  it("retains an own __proto__ property without invoking a prototype setter", () => {
    const schema = sanitizeMcpInputSchema(JSON.parse(
      '{"type":"object","properties":{"__proto__":{"type":"string"}},"required":["__proto__"]}',
    ));
    assertStrictEquals(
      Object.hasOwn(schema.properties ?? {}, "__proto__"),
      true,
    );
    assertStrictEquals(Object.getPrototypeOf(schema.properties ?? {}), null);
  });

  it("retains only configured tools from an aggregated discovery result", () => {
    assertEquals(
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
    assertStrictEquals(
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
    assertObjectMatch(result, { decision: "deny", isError: true });
    assertSpyCalls(call, 0);
  });

  it("accepts only the observed pinned protocol revision", () => {
    const matching = spy(() => "2026-07-28");
    assertStrictEquals(
      requireNegotiatedMcpRevision({
        getNegotiatedProtocolVersion: matching,
      }),
      "2026-07-28",
    );
    assertSpyCalls(matching, 1);

    for (const revision of [undefined, "unsupported-2020-01-01"]) {
      assertThrows(
        () =>
          requireNegotiatedMcpRevision({
            getNegotiatedProtocolVersion: () => revision,
          }),
        Error,
        "external MCP protocol revision mismatch",
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
    assertEquals(
      externalMcpCommandsForTransport(
        [loopbackOnly, remoteEligible],
        "remote",
      ).map((command: { id: string }) => command.id),
      ["mcp.public.search"],
    );
    assertEquals(
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
    assertEquals(mcpServerNetGrants(configs), [
      "mcp.linear.app:443",
      "127.0.0.1:43137",
    ]);
  });
});
