import { describe, expect, test, vi } from "vitest";
import saveIssueSchema from "./extensions/linear/linear-save-issue-schema.fixture.ts";
import { buildLinearIssueCreationCommand } from "./extensions/linear/mod.ts";
import { parseMcpServersConfig, type SecretsConfig } from "./config/mod.ts";
import {
  buildDoltAllowNetGrant,
  buildExternalMcpCommands,
  externalMcpCommandsForTransport,
  mcpServerNetGrants,
  requireNegotiatedMcpRevision,
  retainConfiguredMcpTools,
  sanitizeMcpInputSchema,
  validateDoltPort,
} from "./mcp-tools.ts";
import { createCommandRegistry, invokeCommandWithEvent } from "./tools/mod.ts";

const CONFIG_PATH = "/private/operator/.dyfj/config.toml";

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
  test("never exposes generic create_issue without a bounded binding", async () => {
    const table = serverTable({
      tools: [{
        name: "create_issue",
        effect: "write_external",
        approval: "ask",
      }],
    });
    const call = vi.fn();
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
    expect(built.commands).toEqual([]);
    expect(built.diagnostics).toEqual([
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
    expect(call).not.toHaveBeenCalled();
  });

  test.each(["create_issue", "save_issue"])(
    "withholds unserializable %s without losing another tool",
    async (upstreamTool) => {
      const schema: Record<string, unknown> = { type: "object" };
      schema.properties = { optional: schema };
      const call = vi.fn();
      const built = await buildExternalMcpCommands(
        parseMcpServersConfig(
          linearCreationTable({
            tools: [
              { name: upstreamTool, effect: "write_external", approval: "ask" },
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
      expect(built.commands.map((command) => command.id)).toEqual([
        "mcp.linear.get_issue",
      ]);
      expect(built.diagnostics).toEqual([
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
      expect(call).not.toHaveBeenCalled();
    },
  );

  test("withholds bounded create_issue on a discovered schema mismatch", async () => {
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
        call: vi.fn(),
      },
    );
    expect(built.commands).toEqual([]);
    expect(built.diagnostics).toEqual([
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

  test.each(
    [
      ["missing discovery", [], "tool not discovered"],
      ["invalid schema", [{
        name: "create_issue",
        inputSchema: "untrusted schema details",
      }], "unsupported schema"],
    ] as const,
  )("withholds with a fixed reason for %s", async (_name, tools, reason) => {
    const call = vi.fn();
    const built = await buildExternalMcpCommands(
      parseMcpServersConfig(linearCreationTable(), CONFIG_PATH),
      { linear_mcp: "secret-value" },
      {
        ...WITH_LINEAR,
        discover: async () => ({ revision: "2026-07-28", tools: [...tools] }),
        call,
      },
    );
    expect(built.commands).toEqual([]);
    expect(built.diagnostics[0]).toEqual({
      serverId: "linear",
      status: "withheld",
      tool: "create_issue",
      reason,
    });
    expect(JSON.stringify(built.diagnostics)).not.toContain(
      "untrusted schema details",
    );
    expect(call).not.toHaveBeenCalled();
  });

  test("reserves create_issue on a non-Linear server without a binding", async () => {
    const call = vi.fn();
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
    expect(built.commands).toEqual([]);
    expect(built.diagnostics[0]).toEqual({
      serverId: "other",
      status: "withheld",
      tool: "create_issue",
      reason: "binding missing",
    });
    expect(call).not.toHaveBeenCalled();
  });

  test("registers save_issue only as bounded create_issue with a binding", async () => {
    for (const withBinding of [false, true]) {
      const overrides = {
        tools: [{
          name: "save_issue",
          effect: "write_external",
          approval: "ask",
        }],
      };
      const call = vi.fn();
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
      expect(built.commands.map((c) => c.id)).toEqual(
        withBinding ? ["mcp.linear.create_issue"] : [],
      );
      expect(externalMcpCommandsForTransport(built.commands, "remote")).toEqual(
        [],
      );
      if (withBinding) {
        expect(built.commands[0].inputSchema.properties).not.toHaveProperty(
          "id",
        );
        expect(built.commands[0].permission.defaultDecision).toBe("ask");
      } else {
        expect(built.diagnostics[0]).toMatchObject({
          tool: "save_issue",
          reason: "binding missing",
        });
      }
      expect(call).not.toHaveBeenCalled();
    }
  });

  test("registers the bounded projection when binding and schema match", async () => {
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
        call: vi.fn(),
      },
    );
    expect(built.commands.map((command) => command.id)).toEqual([
      "mcp.linear.create_issue",
    ]);
    expect(built.commands[0].inputSchema.properties).not.toHaveProperty("team");
    expect(built.commands[0].permission).toMatchObject({
      defaultDecision: "ask",
      network: "configured-external",
    });
    expect(built.commands[0].minimumClearance).toBe("loopback");
    expect(externalMcpCommandsForTransport(built.commands, "remote")).toEqual(
      [],
    );
    expect(externalMcpCommandsForTransport(built.commands, "loopback")).toEqual(
      built.commands,
    );
    expect(built.diagnostics[0]).toMatchObject({ toolCount: 1 });
  });

  test("an inherited credential property is unavailable", async () => {
    const credentials = Object.create({ linear_mcp: "inherited-secret" });
    const discover = vi.fn();
    const result = await buildExternalMcpCommands(
      parseMcpServersConfig(serverTable(), CONFIG_PATH),
      credentials,
      { ...WITH_LINEAR, discover },
    );
    expect(result.commands).toEqual([]);
    expect(result.diagnostics).toEqual([{
      serverId: "linear",
      status: "unavailable",
      reason: "credential unavailable",
    }]);
    expect(discover).not.toHaveBeenCalled();
  });

  test("registers only the configured and discovered intersection", async () => {
    const call = vi.fn(async () => ({
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

    expect(result.diagnostics).toEqual([{
      serverId: "linear",
      status: "ready",
      revision: "2026-07-28",
      toolCount: 1,
    }]);
    expect(result.commands.map((command: { id: string }) => command.id))
      .toEqual([
        "mcp.linear.get_issue",
      ]);
    expect(result.commands[0]?.permission).toMatchObject({
      defaultDecision: "allow",
      network: "configured-external",
    });
    expect(result.commands[0]?.minimumClearance).toBe("loopback");

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

    expect(invocation).toMatchObject({
      decision: "allow",
      isError: false,
      authzBasis: "policy:allow:operator-configured-external-read",
    });
    expect(call).toHaveBeenCalledTimes(1);
    expect(String(invocation.isError ? "" : invocation.result)).toContain(
      "<untrusted-mcp-result>",
    );
    expect(events[0]).toMatchObject({
      tool_name: "mcp.linear.get_issue",
      tool_arguments:
        '{"id":"[redacted]","labels":"[redacted]","filter":"[redacted]"}',
      tool_result: "[redacted]",
      span_kind: "client",
    });
    expect(String(events[0]?.content)).toContain('"server":"linear"');
    expect(String(events[0]?.content)).toContain('"revision":"2026-07-28"');
    expect(JSON.stringify(events[0])).not.toContain("secret-value");
    expect(JSON.stringify(events[0])).not.toContain("mcp.linear.app");
  });

  test("write tools always ask and preserve one operator-approved call", async () => {
    const call = vi.fn(async () => ({
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
    const approve = vi.fn(async () => ({ decision: "approve" as const }));
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
    expect(result).toMatchObject({
      decision: "allow",
      authzBasis: "policy:allow:operator-approved",
    });
    expect(approve).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledTimes(1);
  });

  test("an unavailable credential disables only its server with a value-free diagnostic", async () => {
    const discover = vi.fn();
    const result = await buildExternalMcpCommands(
      parseMcpServersConfig(serverTable(), CONFIG_PATH),
      {},
      { ...WITH_LINEAR, discover, call: vi.fn() },
    );
    expect(result.commands).toEqual([]);
    expect(result.diagnostics).toEqual([{
      serverId: "linear",
      status: "unavailable",
      reason: "credential unavailable",
    }]);
    expect(discover).not.toHaveBeenCalled();
  });

  test("a call failure becomes one fixed tool error and one redacted receipt", async () => {
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
    expect(result).toEqual({
      decision: "allow",
      authzBasis: "policy:allow:operator-configured-external-read",
      isError: true,
      reason: "External MCP tool call failed",
    });
    expect(events[0]).toMatchObject({
      action: "invoke",
      tool_is_error: true,
      tool_result: "External MCP tool call failed",
    });
    expect(String(events[0]?.content)).toContain('"outcome":"error"');
    expect(JSON.stringify(events[0])).not.toContain("secret-value");
    expect(JSON.stringify(result)).not.toContain("secret-value");
  });
});

describe("MCP HTTP containment", () => {
  test("preserves supported additionalProperties semantics", () => {
    const omitted = sanitizeMcpInputSchema({
      type: "object",
      properties: { query: { type: "string" } },
    });
    expect(omitted.additionalProperties).toBeUndefined();
    expect(
      sanitizeMcpInputSchema({
        type: "object",
        additionalProperties: true,
      }).additionalProperties,
    ).toBe(true);
    expect(() =>
      sanitizeMcpInputSchema({
        type: "object",
        additionalProperties: { type: "string" },
      })
    ).toThrow("schema-valued additionalProperties are not supported");
  });

  test("retains an own __proto__ property without invoking a prototype setter", () => {
    const schema = sanitizeMcpInputSchema(JSON.parse(
      '{"type":"object","properties":{"__proto__":{"type":"string"}},"required":["__proto__"]}',
    ));
    expect(Object.hasOwn(schema.properties ?? {}, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(schema.properties ?? {})).toBeNull();
  });

  test("retains only configured tools from an aggregated discovery result", () => {
    expect(
      retainConfiguredMcpTools(
        [{ name: "keep" }, { name: "also_keep" }],
        [
          { name: "drop", inputSchema: { type: "object" } },
          { name: "keep", inputSchema: { type: "object" } },
          { name: "keep", inputSchema: { type: "object" } },
        ],
      ).map((tool: { name: string }) => tool.name),
    ).toEqual(["keep"]);
  });

  test("preserves integer schemas and rejects fractional arguments locally", async () => {
    const call = vi.fn();
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
    expect(built.commands[0].inputSchema.properties?.count?.type).toBe(
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
    expect(result).toMatchObject({ decision: "deny", isError: true });
    expect(call).not.toHaveBeenCalled();
  });

  test("accepts only the observed pinned protocol revision", () => {
    const matching = vi.fn(() => "2026-07-28");
    expect(
      requireNegotiatedMcpRevision({
        getNegotiatedProtocolVersion: matching,
      }),
    ).toBe("2026-07-28");
    expect(matching).toHaveBeenCalledTimes(1);

    for (const revision of [undefined, "unsupported-2020-01-01"]) {
      expect(() =>
        requireNegotiatedMcpRevision({
          getNegotiatedProtocolVersion: () => revision,
        })
      ).toThrow("external MCP protocol revision mismatch");
    }
  });

  test("withholds loopback-only commands from remote turns", () => {
    const loopbackOnly = {
      id: "mcp.linear.get_issue",
      minimumClearance: "loopback",
    } as never;
    const remoteEligible = {
      id: "mcp.public.search",
      minimumClearance: "remote",
    } as never;
    expect(
      externalMcpCommandsForTransport(
        [loopbackOnly, remoteEligible],
        "remote",
      ).map((command: { id: string }) => command.id),
    ).toEqual(["mcp.public.search"]);
    expect(
      externalMcpCommandsForTransport(
        [loopbackOnly, remoteEligible],
        "loopback",
      ).map((command: { id: string }) => command.id),
    ).toEqual(["mcp.linear.get_issue", "mcp.public.search"]);
  });

  test("derives unique launch grants without retaining endpoints", () => {
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
    expect(mcpServerNetGrants(configs)).toEqual([
      "mcp.linear.app:443",
      "127.0.0.1:43137",
    ]);
  });
});

describe("validateDoltPort & buildDoltAllowNetGrant", () => {
  test("accepts valid boundary and ordinary port numbers and strings", () => {
    expect(validateDoltPort()).toBe(3306);
    expect(validateDoltPort(undefined)).toBe(3306);
    expect(validateDoltPort(null)).toBe(3306);
    expect(validateDoltPort("3306")).toBe(3306);
    expect(validateDoltPort("3316")).toBe(3316);
    expect(validateDoltPort("1")).toBe(1);
    expect(validateDoltPort("65535")).toBe(65535);
    expect(validateDoltPort(3306)).toBe(3306);
    expect(validateDoltPort(1)).toBe(1);
    expect(validateDoltPort(65535)).toBe(65535);

    expect(buildDoltAllowNetGrant()).toBe("--allow-net=127.0.0.1:3306");
    expect(buildDoltAllowNetGrant("3306")).toBe("--allow-net=127.0.0.1:3306");
    expect(buildDoltAllowNetGrant("1")).toBe("--allow-net=127.0.0.1:1");
    expect(buildDoltAllowNetGrant("65535")).toBe("--allow-net=127.0.0.1:65535");
    expect(buildDoltAllowNetGrant(3316)).toBe("--allow-net=127.0.0.1:3316");
  });

  test("rejects malformed, delimiter-bearing, signed, whitespace, and out-of-range ports", () => {
    const invalidInputs = [
      // Delimiters / network injection attempts
      "3306,0.0.0.0",
      "3306,localhost",
      "3306,127.0.0.1:8080",
      "127.0.0.1:3306",
      "3306;80",
      "3306/tcp",
      "3306 80",
      // Whitespace
      " 3306",
      "3306 ",
      "\t3306",
      "33 06",
      // Signs
      "+3306",
      "-3306",
      "+1",
      "-1",
      // Out of range & oversized
      "0",
      "65536",
      "100000",
      "123456",
      "9".repeat(10_000),
      0,
      65536,
      -1,
      // Non-decimal / formatting
      "",
      "   ",
      "abc",
      "3306a",
      "0x3306",
      "33e2",
      "3306.0",
      "3306.5",
      "NaN",
      "Infinity",
      // Non-port types
      true,
      false,
      {},
      [],
    ];

    for (const input of invalidInputs) {
      expect(
        () => validateDoltPort(input),
        `expected validateDoltPort(${JSON.stringify(input)}) to throw`,
      ).toThrow(
        "invalid DOLT_PORT: must be a decimal integer between 1 and 65535",
      );

      expect(
        () => buildDoltAllowNetGrant(input),
        `expected buildDoltAllowNetGrant(${JSON.stringify(input)}) to throw`,
      ).toThrow(
        "invalid DOLT_PORT: must be a decimal integer between 1 and 65535",
      );
    }
  });

  test("rejection diagnostic is path-free and credential-free", () => {
    const sensitiveInputs = [
      "3306,SECRET_KEY_VALUE",
      "/private/keys/dolt:3306",
      "op://vault/dolt/port",
      "password123,0.0.0.0",
    ];

    for (const input of sensitiveInputs) {
      try {
        buildDoltAllowNetGrant(input);
        expect.unreachable("should have thrown");
      } catch (err: any) {
        expect(err.message).toBe(
          "invalid DOLT_PORT: must be a decimal integer between 1 and 65535",
        );
        expect(err.message).not.toContain("SECRET_KEY_VALUE");
        expect(err.message).not.toContain("/private/keys");
        expect(err.message).not.toContain("op://");
        expect(err.message).not.toContain("password123");
      }
    }
  });
});
