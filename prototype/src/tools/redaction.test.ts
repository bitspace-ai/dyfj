// Tests for the shared redactor (`redaction.ts`) as the durable tool_call
// event applies it.

import {
  assertEquals,
  assertFalse,
  assertStrictEquals,
  assertStringIncludes,
} from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import type { EventInsert } from "../store/mod.ts";
import type { CommandCall, CommandDefinition } from "./definition.ts";
import { createCommandRegistry } from "./registry.ts";
import {
  buildCommandToolCallEventPayload,
  invokeCommandWithEvent,
} from "./invoke.ts";
import { buildToolCatalog } from "./catalog.ts";

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
    assertStrictEquals(args.path, "notes.md");
    assertStrictEquals(args.content, "[redacted]");
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
      assertStrictEquals(result.decision, "deny");
      const args = JSON.parse(events[0].tool_arguments as string);
      assertStrictEquals(args.content, "[redacted]");
      assertFalse(
        (events[0].tool_arguments as string).includes("secret token"),
      );
    }
  });

  it("the real write_file command marks content for redaction", () => {
    const registry = buildToolCatalog({}, { workspaceRoot: "/work" });
    assertStrictEquals(
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
    assertEquals(JSON.parse(events[0].tool_arguments as string), {
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

    assertStrictEquals(result.decision, "deny");
    assertEquals(JSON.parse(events[0].tool_arguments as string), {
      slug: "[redacted]",
    });
    assertFalse((events[0].tool_arguments as string).includes("unexpected"));
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
    assertStrictEquals(redacted.tool_result, "[redacted]");
    assertFalse((redacted.tool_result as string).includes("ANTHROPIC_API_KEY"));
    assertEquals(JSON.parse(redacted.tool_arguments as string), {
      command: "env",
    });

    const kept = buildCommandToolCallEventPayload(
      call({ command: "env" }, { commandId: "bash" }),
      success,
      ctx,
      bashCommand(false),
    );
    assertStringIncludes(kept.tool_result as string, "ANTHROPIC_API_KEY");
    assertEquals(JSON.parse(kept.tool_arguments as string), {
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
    assertStrictEquals(result.isError, false);
    if (!result.isError) {
      assertStringIncludes(result.result as string, "ANTHROPIC_API_KEY");
    }
    // …but the durable event never persists it.
    assertStrictEquals(events[0].tool_result, "[redacted]");
    assertFalse(
      (events[0].tool_result as string).includes("ANTHROPIC_API_KEY"),
    );
  });
});
