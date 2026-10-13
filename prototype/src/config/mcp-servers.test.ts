import { captureThrow } from "../../testing/assertions/captured.ts";
import assert from "node:assert/strict";
import { parseMcpServersConfig } from "./mcp-servers.ts";
import type { SecretsConfig } from "./secrets-config.ts";

const CONFIG_PATH = "/private/operator/.dyfj/config.toml";

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

{ // "parseMcpServersConfig"
  Deno.test("parseMcpServersConfig: accepts the bounded HTTP-only server and per-tool policy shape", () => {
    assert.deepStrictEqual(parseMcpServersConfig(serverTable(), CONFIG_PATH), [{
      id: "linear",
      transport: "streamable_http",
      url: "https://mcp.linear.app/mcp",
      minimumClearance: "loopback",
      auth: { type: "bearer", secret: "linear_mcp" },
      tools: [
        { name: "get_issue", effect: "read", approval: "allow" },
        {
          name: "create_comment",
          effect: "write_external",
          approval: "ask",
        },
      ],
    }]);
  });

  Deno.test("parseMcpServersConfig: accepts declared capabilities mapping to declared tools", () => {
    const table = serverTable({
      tools: [
        { name: "tavily_search", effect: "read", approval: "allow" },
        { name: "tavily_extract", effect: "read", approval: "allow" },
      ],
      capabilities: {
        search_tool: "tavily_search",
        fetch_tool: "tavily_extract",
      },
    });
    assert.deepStrictEqual(parseMcpServersConfig(table, CONFIG_PATH), [{
      id: "linear",
      transport: "streamable_http",
      url: "https://mcp.linear.app/mcp",
      minimumClearance: "loopback",
      auth: { type: "bearer", secret: "linear_mcp" },
      tools: [
        { name: "tavily_search", effect: "read", approval: "allow" },
        { name: "tavily_extract", effect: "read", approval: "allow" },
      ],
      capabilities: {
        searchTool: "tavily_search",
        fetchTool: "tavily_extract",
      },
    }]);
  });

  for (
    const [capability, withBinding] of [
      ["search_tool", false],
      ["fetch_tool", false],
      ["search_tool", true],
      ["fetch_tool", true],
    ] as const
  ) {
    Deno.test(`parseMcpServersConfig: rejects create_issue as ${capability} with binding=${withBinding}`, () => {
      const capabilities = { [capability]: "create_issue" };
      const table = withBinding
        ? linearCreationTable({ capabilities })
        : serverTable({
          capabilities,
          tools: [{
            name: "create_issue",
            effect: "write_external",
            approval: "ask",
          }],
        });
      assert.throws(
        () => parseMcpServersConfig(table, CONFIG_PATH),
        (error: unknown) =>
          error instanceof Error &&
          error.message.includes(
            "create_issue cannot be a search or fetch capability; use linear_issue_creation",
          ),
      );
    });
  }

  for (const capability of ["search_tool", "fetch_tool"]) {
    Deno.test(`parseMcpServersConfig: rejects save_issue as ${capability}`, () => {
      for (const withBinding of [false, true]) {
        const overrides = {
          capabilities: { [capability]: "save_issue" },
          tools: [{
            name: "save_issue",
            effect: "write_external",
            approval: "ask",
          }],
        };
        assert.match(
          (captureThrow(() =>
            parseMcpServersConfig(
              withBinding
                ? linearCreationTable(overrides)
                : serverTable(overrides),
              CONFIG_PATH,
            )
          ) as Error).message,
          /also required for save_issue/,
        );
      }
    });
  }

  Deno.test("parseMcpServersConfig: requires exactly one creation upstream", () => {
    assert.match(
      (captureThrow(() =>
        parseMcpServersConfig(
          linearCreationTable({
            tools: [
              {
                name: "create_issue",
                effect: "write_external",
                approval: "ask",
              },
              { name: "save_issue", effect: "write_external", approval: "ask" },
            ],
          }),
          CONFIG_PATH,
        )
      ) as Error).message,
      /configure exactly one/,
    );
  });

  Deno.test("parseMcpServersConfig: accepts fixed Linear team and exact-name project bindings", () => {
    const parsed = parseMcpServersConfig(linearCreationTable(), CONFIG_PATH);
    // The parser builds `projects` without a prototype, so a project named
    // like an Object.prototype member cannot collide with one; the expected
    // value pins that.
    assert.deepStrictEqual(parsed[0].linearIssueCreation, {
      teamId: "team_fixture_01",
      projects: Object.assign(Object.create(null), {
        "Synthetic Project": "project_fixture_01",
        "Second Project": "project_fixture_02",
      }),
    });
  });

  const malformedBindings: [Record<string, unknown>, RegExp][] = [
    [
      { linear_issue_creation: { team_id: "", projects: { Synthetic: "p1" } } },
      /team_id/,
    ],
    [
      { linear_issue_creation: { team_id: "team1", projects: {} } },
      /projects must contain/,
    ],
    [
      {
        linear_issue_creation: {
          team_id: "team1",
          projects: { "   ": "project1" },
        },
      },
      /project names/,
    ],
    [
      { minimum_clearance: "remote" },
      /minimum_clearance loopback/,
    ],
    [
      {
        tools: [{
          name: "create_comment",
          effect: "write_external",
          approval: "ask",
        }],
      },
      /requires create_issue/,
    ],
  ];
  for (const [index, [overrides, pattern]] of malformedBindings.entries()) {
    Deno.test(`parseMcpServersConfig: rejects malformed Linear issue binding ${index}`, () => {
      assert.match(
        (captureThrow(() =>
          parseMcpServersConfig(linearCreationTable(overrides), CONFIG_PATH)
        ) as Error).message,
        pattern,
      );
    });
  }

  Deno.test("parseMcpServersConfig: rejects capabilities pointing to undeclared tools", () => {
    const table = serverTable({
      capabilities: {
        search_tool: "undeclared_search",
      },
    });
    assert.match(
      (captureThrow(() => parseMcpServersConfig(table, CONFIG_PATH)) as Error)
        .message,
      /search_tool must be a declared tool/,
    );
  });

  const unsupportedShapes: [Record<string, unknown>, RegExp][] = [
    [{ transport: "stdio" }, /streamable_http/],
    [{ url: "http://mcp.example/mcp" }, /https/],
    [
      { url: ["https://user", "pass@mcp.example/mcp"].join(":") },
      /credentials/,
    ],
    [
      { tools: [{ name: "*", effect: "read", approval: "allow" }] },
      /tool name/,
    ],
    [{
      tools: [{
        name: "create_comment",
        effect: "write_external",
        approval: "allow",
      }],
    }, /write_external.*ask/],
  ];
  for (const [index, [overrides, pattern]] of unsupportedShapes.entries()) {
    Deno.test(`parseMcpServersConfig: fails closed on unsupported authority shape ${index}`, () => {
      assert.match(
        (captureThrow(() =>
          parseMcpServersConfig(serverTable(overrides), CONFIG_PATH)
        ) as Error).message,
        pattern,
      );
    });
  }

  Deno.test("parseMcpServersConfig: requires every auth reference to exist in [secrets.named]", () => {
    const secrets: SecretsConfig = {
      command: ["op", "read"],
      timeoutMs: 10_000,
      pointers: {},
      named: {},
      env: {},
      inheritEnv: [],
    };
    assert.match(
      (captureThrow(() =>
        parseMcpServersConfig(serverTable(), CONFIG_PATH, secrets)
      ) as Error).message,
      /linear_mcp.*secrets\.named/,
    );
  });

  Deno.test("parseMcpServersConfig: permits cleartext only for loopback IP literals", () => {
    assert.match(
      (captureThrow(() =>
        parseMcpServersConfig(
          serverTable({ url: "http://localhost:43137/mcp" }),
          CONFIG_PATH,
        )
      ) as Error).message,
      /https.*loopback/,
    );
    assert.strictEqual(
      parseMcpServersConfig(
        serverTable({ url: "http://127.0.0.1:43137/mcp" }),
        CONFIG_PATH,
      )[0].url,
      "http://127.0.0.1:43137/mcp",
    );
  });

  Deno.test("parseMcpServersConfig: rejects hostnames containing net-grant list separators", () => {
    assert.match(
      (captureThrow(() =>
        parseMcpServersConfig(
          serverTable({ url: "https://foo%2cbar.example/mcp" }),
          CONFIG_PATH,
        )
      ) as Error).message,
      /hostname.*comma/,
    );
  });
}
