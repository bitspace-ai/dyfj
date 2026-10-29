// Tests for the shared redactor (`redaction.ts`) as the durable tool_call
// event applies it.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EventInsert } from "../store/mod.ts";
import type { CommandCall, CommandDefinition } from "./definition.ts";
import { createCommandRegistry } from "./registry.ts";
import {
  buildCommandToolCallEventPayload,
  invokeCommandWithEvent,
} from "./invoke.ts";
import { buildToolCatalog } from "./catalog.ts";
import { redactCommandResult, redactsArgumentsById } from "./redaction.ts";
import { RootAnchors } from "./builtin/root-anchors.ts";
import { buildExternalMcpCommands } from "./mcp/adapter.ts";
import { defineWebCommands } from "./web/web.ts";
import { parseMcpServersConfig } from "../config/mod.ts";
import { buildLinearIssueCreationCommand } from "../extensions/linear/mod.ts";
import saveIssueSchema from "../extensions/linear/linear-save-issue-schema.fixture.ts";

function readCommand(
  overrides: Partial<CommandDefinition<string>> = {},
): CommandDefinition<string> {
  return {
    id: "memory.read",
    title: "Read Memory",
    description: "Load one Dolt-backed memory by slug.",
    inputSchema: {
      type: "object",
      required: ["slug"],
      properties: {
        slug: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]*$" },
      },
      additionalProperties: false,
    },
    permission: {
      effects: ["read.memory", "emit.event"],
      defaultDecision: "allow",
      resources: ["memory:*"],
      network: "local",
      filesystem: "none",
      cost: "none",
    },
    executor: (call) => Promise.resolve(`read ${call.arguments.slug}`),
    ...overrides,
  };
}

function call(
  args: Record<string, unknown> = { slug: "project_dyfj" },
  overrides: Partial<CommandCall> = {},
): CommandCall {
  return {
    commandId: "memory.read",
    callId: "call-123",
    caller: { principalId: "operator", principalType: "human" },
    arguments: args,
    ...overrides,
  };
}

describe("redactCommandArguments (sensitive tool args)", () => {
  it("a write-file event redacts the content argument, preserves path", async () => {
    const writeCmd: CommandDefinition<string> = {
      id: "write_file",
      title: "Write File",
      description: "Write a file",
      inputSchema: {
        type: "object",
        required: ["path", "content"],
        properties: {
          path: { type: "string" },
          content: { type: "string", redact: true },
        },
        additionalProperties: false,
      },
      permission: {
        effects: ["write.filesystem", "emit.event"],
        defaultDecision: "allow",
        resources: ["file:write"],
        network: "none",
        filesystem: "write",
        cost: "none",
      },
      executor: () => "ok",
    };
    const registry = createCommandRegistry([writeCmd]);
    const events: EventInsert[] = [];
    await invokeCommandWithEvent(
      registry,
      call(
        { path: "notes.md", content: "secret token ABC123" },
        { commandId: "write_file" },
      ),
      {
        sessionId: "01TESTSESSION00000000000000",
        traceId: "0123456789abcdef0123456789abcdef",
        eventId: "01TESTEVENT0000000000000000",
        spanId: "0123456789abcdef",
        writeEvent: (e) => {
          events.push(e);
        },
      },
      () => Promise.resolve({ decision: "approve" }),
    );
    const args = JSON.parse(events[0].tool_arguments as string);
    assert.strictEqual(args.path, "notes.md");
    assert.strictEqual(args.content, "[redacted]");
  });

  it("redacts a redact-marked argument of any type — malformed content cannot bypass it", async () => {
    const writeCmd: CommandDefinition<string> = {
      id: "write_file",
      title: "Write File",
      description: "Write a file",
      inputSchema: {
        type: "object",
        required: ["path", "content"],
        properties: {
          path: { type: "string" },
          content: { type: "string", redact: true },
        },
        additionalProperties: false,
      },
      permission: {
        effects: ["write.filesystem", "emit.event"],
        defaultDecision: "allow",
        resources: ["file:write"],
        network: "none",
        filesystem: "write",
        cost: "none",
      },
      executor: () => "ok",
    };
    const registry = createCommandRegistry([writeCmd]);
    for (
      const malformed of [
        { nested: "secret token ABC123" },
        ["secret token ABC123"],
      ]
    ) {
      const events: EventInsert[] = [];
      const result = await invokeCommandWithEvent(
        registry,
        call(
          { path: "notes.md", content: malformed },
          { commandId: "write_file" },
        ),
        {
          sessionId: "01TESTSESSION00000000000000",
          traceId: "0123456789abcdef0123456789abcdef",
          eventId: "01TESTEVENT0000000000000000",
          spanId: "0123456789abcdef",
          writeEvent: (e) => {
            events.push(e);
          },
        },
        () => Promise.resolve({ decision: "approve" }),
      );
      // Non-string content is denied by validation before execution, but the
      // denied call's persisted event still redacts content to the sentinel —
      // the raw nested payload never reaches the log or replay.
      assert.strictEqual(result.decision, "deny");
      const args = JSON.parse(events[0].tool_arguments as string);
      assert.strictEqual(args.content, "[redacted]");
      assert.ok(!(events[0].tool_arguments as string).includes("secret token"));
    }
  });

  it("the real write_file command marks content for redaction", () => {
    const registry = buildToolCatalog({ rootAnchors: new RootAnchors() }, {
      workspaceRoot: "/work",
    });
    assert.strictEqual(
      registry.lookup("write_file")!.inputSchema.properties!.content!.redact,
      true,
    );
  });

  it("leaves non-redacted arguments verbatim", async () => {
    const registry = buildToolCatalog({
      readMemory: (slug) => Promise.resolve(`# ${slug}`),
    }, {});
    const events: EventInsert[] = [];
    await invokeCommandWithEvent(registry, call(), {
      sessionId: "01TESTSESSION00000000000000",
      traceId: "0123456789abcdef0123456789abcdef",
      eventId: "01TESTEVENT0000000000000000",
      spanId: "0123456789abcdef",
      writeEvent: (e) => {
        events.push(e);
      },
    });
    assert.deepStrictEqual(JSON.parse(events[0].tool_arguments as string), {
      slug: "project_dyfj",
    });
  });

  it("drops undeclared argument identities when redacting the whole call", async () => {
    const registry = createCommandRegistry([
      readCommand({ redactArguments: true }),
    ]);
    const events: EventInsert[] = [];
    const result = await invokeCommandWithEvent(
      registry,
      call({
        slug: "project_dyfj",
        "unexpected-sensitive-name": "unexpected-sensitive-value",
      }),
      {
        sessionId: "01TESTSESSION00000000000000",
        traceId: "0123456789abcdef0123456789abcdef",
        eventId: "01TESTEVENT0000000000000000",
        spanId: "0123456789abcdef",
        writeEvent: (event) => {
          events.push(event);
        },
      },
    );

    assert.strictEqual(result.decision, "deny");
    assert.deepStrictEqual(JSON.parse(events[0].tool_arguments as string), {
      slug: "[redacted]",
    });
    assert.ok(!(events[0].tool_arguments as string).includes("unexpected"));
  });
});

describe("buildCommandToolCallEventPayload", () => {
  it("redacts the result when redactResult is set, keeps it otherwise", () => {
    const success = {
      decision: "allow" as const,
      authzBasis: "policy:allow:operator-profile",
      isError: false as const,
      result: "exit 0\nANTHROPIC_API_KEY=fixture-should-not-persist",
    };
    const ctx = {
      eventId: "01TESTEVENT0000000000000000",
      sessionId: "01TESTSESSION00000000000000",
      traceId: "0123456789abcdef0123456789abcdef",
      spanId: "0123456789abcdef",
    };
    // The redaction declaration now travels on the command definition; the
    // same bash-shaped command with and without redactResult.
    const bashCommand = (redactResult: boolean): CommandDefinition<string> => ({
      id: "bash",
      title: "Run Bash Command",
      description: "Run a shell command",
      inputSchema: {
        type: "object",
        required: ["command"],
        properties: { command: { type: "string" } },
        additionalProperties: false,
      },
      permission: {
        effects: ["run.process", "emit.event"],
        defaultDecision: "allow",
        resources: ["process:run"],
        network: "external",
        filesystem: "write",
        cost: "none",
      },
      redactResult,
      executor: () => "unused",
    });
    const redacted = buildCommandToolCallEventPayload(
      call({ command: "env" }, { commandId: "bash" }),
      success,
      ctx,
      bashCommand(true),
    );
    assert.strictEqual(redacted.tool_result, "[redacted]");
    assert.ok(!(redacted.tool_result as string).includes("ANTHROPIC_API_KEY"));
    assert.deepStrictEqual(JSON.parse(redacted.tool_arguments as string), {
      command: "env",
    });

    const kept = buildCommandToolCallEventPayload(
      call({ command: "env" }, { commandId: "bash" }),
      success,
      ctx,
      bashCommand(false),
    );
    assert.ok(
      (kept.tool_result as string).includes("ANTHROPIC_API_KEY"),
      `expected kept.tool_result as string to include "ANTHROPIC_API_KEY"`,
    );
    assert.deepStrictEqual(JSON.parse(kept.tool_arguments as string), {
      command: "env",
    });
  });

  it("invokeCommandWithEvent keeps a redactResult command's output out of the persisted event", async () => {
    const sensitiveCmd: CommandDefinition<string> = {
      id: "bash",
      title: "Run Bash Command",
      description: "Run a shell command",
      inputSchema: {
        type: "object",
        required: ["command"],
        properties: { command: { type: "string" } },
        additionalProperties: false,
      },
      permission: {
        effects: ["run.process", "emit.event"],
        defaultDecision: "allow",
        resources: ["process:run"],
        network: "external",
        filesystem: "write",
        cost: "none",
      },
      redactResult: true,
      executor: () => "exit 0\nANTHROPIC_API_KEY=fixture-should-not-persist",
    };
    const registry = createCommandRegistry([sensitiveCmd]);
    const events: EventInsert[] = [];
    const result = await invokeCommandWithEvent(
      registry,
      call({ command: "env" }, { commandId: "bash" }),
      {
        sessionId: "01TESTSESSION00000000000000",
        traceId: "0123456789abcdef0123456789abcdef",
        eventId: "01TESTEVENT0000000000000000",
        spanId: "0123456789abcdef",
        writeEvent: (e) => {
          events.push(e);
        },
      },
      () => Promise.resolve({ decision: "approve" }),
    );
    // The model still received the real output in-turn…
    assert.strictEqual(result.isError, false);
    if (!result.isError) {
      assert.ok(
        (result.result as string).includes("ANTHROPIC_API_KEY"),
        `expected result.result as string to include "ANTHROPIC_API_KEY"`,
      );
    }
    // …but the durable event never persists it.
    assert.strictEqual(events[0].tool_result, "[redacted]");
    assert.ok(!(events[0].tool_result as string).includes("ANTHROPIC_API_KEY"));
  });
});

describe("a failed call's stored reason for a command with redacted arguments", () => {
  const command = {
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string", redact: true } },
    },
  } as unknown as CommandDefinition;
  const failed = (reason: string) => ({
    decision: "allow" as const,
    authzBasis: "test",
    isError: true as const,
    reason,
  });
  const content = "a private document body";

  it("is withheld, naming the argument, when it echoes a redacted value", () => {
    assert.equal(
      redactCommandResult(command, failed(`rejected: ${content}`), {
        path: "notes.md",
        content,
      }),
      "error (text withheld: it echoes argument content)",
    );
  });

  it("never stores a value's first characters cut at the window edge", () => {
    // A value starting at character 638 would have only 2 characters inside
    // the 640-character window, below the 3-character tail rule; the stored
    // text stops before it.
    const reason = `${"r".repeat(638)}${content}`;
    const stored = redactCommandResult(command, failed(reason), {
      path: "notes.md",
      content,
    });
    assert.equal(stored, "r".repeat(638));
  });

  it("keeps the checked window, not the operator line, when it echoes none", () => {
    const reason = `refused: ${"r".repeat(300)}`;
    assert.equal(
      redactCommandResult(command, failed(reason), { path: "notes.md", content }),
      reason,
    );
  });
});

describe("redactsArgumentsById", () => {
  // The resume path decides from the command id alone, because a later turn's
  // registry does not exist yet when it rebuilds the model's history. This
  // builds the real catalog — builtin tools, the web capability, every
  // discovered external MCP tool and the Linear extension's bounded
  // create-issue command — and requires the rule and the declarations to agree
  // in both directions, so neither can drift from the other.
  it("equals `redactArguments` across the real catalog", async () => {
    const builtin = buildToolCatalog({ rootAnchors: new RootAnchors() }, {
      workspaceRoot: "/work",
    }).list();
    const web = defineWebCommands(
      {
        id: "tavily",
        transport: "streamable_http",
        url: "https://mcp.tavily.com/mcp",
        minimumClearance: "loopback",
        auth: { type: "bearer", secret: "tavily_key" },
        tools: [
          { name: "tavily_search", effect: "read", approval: "allow" },
          { name: "tavily_extract", effect: "read", approval: "allow" },
        ],
        capabilities: {
          searchTool: "tavily_search",
          fetchTool: "tavily_extract",
        },
      },
      "token",
    );
    const external = await buildExternalMcpCommands(
      parseMcpServersConfig({
        mcp: {
          servers: [{
            id: "notes",
            transport: "streamable_http",
            url: "https://mcp.example.com/mcp",
            minimum_clearance: "loopback",
            auth: { type: "bearer", secret: "notes_mcp" },
            tools: [
              { name: "get_note", effect: "read", approval: "allow" },
              { name: "save_note", effect: "write_external", approval: "ask" },
              {
                name: "create_issue",
                effect: "write_external",
                approval: "ask",
              },
            ],
            linear_issue_creation: {
              team_id: "team_fixture_01",
              projects: { "Synthetic Project": "project_fixture_01" },
            },
          }],
        },
      }, "/private/operator/.dyfj/config.toml"),
      { notes_mcp: "secret-value" },
      {
        discover: () =>
          Promise.resolve({
            revision: "2026-07-28",
            tools: [
              {
                name: "get_note",
                inputSchema: { type: "object", properties: {} },
              },
              {
                name: "save_note",
                inputSchema: { type: "object", properties: {} },
              },
              { name: "create_issue", inputSchema: saveIssueSchema },
            ],
          }),
        buildIssueCreationCommand: buildLinearIssueCreationCommand,
        call: () => Promise.resolve({ content: [] }),
      },
    );
    const catalog = [
      ...builtin,
      ...web,
      ...external.commands,
    ];
    // The catalog this checks must actually contain each declaring kind, or it
    // would pass by covering nothing.
    const ids = catalog.map((command) => command.id);
    for (const id of ["web_search", "web_fetch", "mcp.notes.get_note"]) {
      assert.ok(ids.includes(id), `expected the catalog to include ${id}`);
    }
    assert.ok(
      ids.some((id) => id.startsWith("mcp.") && id.endsWith(".create_issue")),
      `expected the catalog to include the bounded create-issue command: ${
        JSON.stringify(ids)
      }`,
    );
    for (const command of catalog) {
      const declared = command.redactArguments === true;
      assert.strictEqual(
        redactsArgumentsById(command.id),
        declared,
        `${command.id}: redactsArgumentsById says ${
          redactsArgumentsById(command.id)
        }, the command declares ${declared}`,
      );
    }
  });
});
