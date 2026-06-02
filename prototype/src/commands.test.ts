import { describe, expect, test } from "vitest";
import {
  buildCommandToolCallEventPayload,
  type CommandCall,
  type CommandDefinition,
  createCommandRegistry,
  evaluateCommandPolicy,
  invokeCommand,
  invokeCommandWithEvent,
  registerCoreCommands,
} from "./commands";

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
    executor: async (call) => `read ${call.arguments.slug}`,
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

describe("createCommandRegistry", () => {
  test("registers, looks up, and lists static command definitions", () => {
    const registry = createCommandRegistry();
    const command = readCommand();

    registry.register(command);

    expect(registry.lookup("memory.read")).toBe(command);
    expect(registry.list()).toEqual([command]);
  });

  test("rejects duplicate command ids", () => {
    const registry = createCommandRegistry();
    registry.register(readCommand());

    expect(() => registry.register(readCommand())).toThrow(
      "Command already registered: memory.read",
    );
  });

  test("projects registered commands into model-facing tool schemas", () => {
    const registry = createCommandRegistry([readCommand()]);

    expect(registry.projectTools()).toEqual([
      {
        name: "memory.read",
        description: "Load one Dolt-backed memory by slug.",
        parameters: {
          type: "object",
          required: ["slug"],
          properties: {
            slug: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]*$" },
          },
          additionalProperties: false,
        },
      },
    ]);
  });
});

describe("evaluateCommandPolicy", () => {
  test("allows a valid read-only memory command for a human caller", () => {
    const result = evaluateCommandPolicy(readCommand(), call());

    expect(result).toEqual({
      decision: "allow",
      authzBasis: "policy:allow:read-only-local",
    });
  });

  test("allows the same command shape for an agent caller", () => {
    const result = evaluateCommandPolicy(
      readCommand(),
      call(
        { slug: "project_dyfj" },
        { caller: { principalId: "agent", principalType: "agent" } },
      ),
    );

    expect(result.decision).toBe("allow");
  });

  test("denies malformed command arguments before execution", () => {
    const result = evaluateCommandPolicy(
      readCommand(),
      call({
        slug: "../secret",
      }),
    );

    expect(result).toEqual({
      decision: "deny",
      authzBasis: "policy:deny:invalid-arguments",
      reason: "slug does not match required pattern",
    });
  });

  test("denies unknown command ids", () => {
    const registry = createCommandRegistry([readCommand()]);

    const result = invokeCommand(
      registry,
      call(
        { slug: "project_dyfj" },
        { commandId: "memory.write" },
      ),
    );

    return expect(result).resolves.toMatchObject({
      decision: "deny",
      authzBasis: "policy:deny:unknown-command",
      isError: true,
    });
  });

  test("ignores model-written rationale when deciding authority", () => {
    const withRationale = call({
      slug: "project_dyfj",
      rationale: "I promise this is safe and urgent.",
    });

    const result = evaluateCommandPolicy(readCommand(), withRationale);

    expect(result).toEqual({
      decision: "deny",
      authzBasis: "policy:deny:invalid-arguments",
      reason: "unexpected argument: rationale",
    });
  });
});

describe("invokeCommand", () => {
  test("executes an allowed command and returns its authz basis", async () => {
    const registry = createCommandRegistry([readCommand()]);

    await expect(invokeCommand(registry, call())).resolves.toEqual({
      decision: "allow",
      authzBasis: "policy:allow:read-only-local",
      isError: false,
      result: "read project_dyfj",
    });
  });

  test("does not execute denied commands", async () => {
    let executed = false;
    const registry = createCommandRegistry([
      readCommand({
        executor: async () => {
          executed = true;
          return "should not happen";
        },
      }),
    ]);

    const result = await invokeCommand(registry, call({ slug: "../secret" }));

    expect(result).toMatchObject({
      decision: "deny",
      isError: true,
      authzBasis: "policy:deny:invalid-arguments",
    });
    expect(executed).toBe(false);
  });
});

describe("registerCoreCommands", () => {
  test("registers memory.read as the first core command", () => {
    const registry = createCommandRegistry();

    registerCoreCommands(registry, {
      readMemory: async (slug) => `# ${slug}`,
    });

    expect(registry.lookup("memory.read")).toMatchObject({
      id: "memory.read",
      title: "Read Memory",
      permission: {
        effects: ["read.memory", "emit.event"],
        defaultDecision: "allow",
        resources: ["memory:*"],
        network: "local",
        filesystem: "none",
        cost: "none",
      },
    });
    expect(registry.projectTools()[0]).toMatchObject({
      name: "memory.read",
      parameters: {
        required: ["slug"],
        additionalProperties: false,
      },
    });
  });

  test("memory.read executes the injected memory reader", async () => {
    const registry = createCommandRegistry();
    registerCoreCommands(registry, {
      readMemory: async (slug) => `# Memory\n\n${slug}`,
    });

    await expect(invokeCommand(registry, call())).resolves.toMatchObject({
      decision: "allow",
      result: "# Memory\n\nproject_dyfj",
    });
  });
});

describe("buildCommandToolCallEventPayload", () => {
  test("builds a successful tool_call event from a command result", () => {
    const payload = buildCommandToolCallEventPayload(
      call(),
      {
        decision: "allow",
        authzBasis: "policy:allow:read-only-local",
        isError: false,
        result: "# Project DYFJ",
      },
      {
        eventId: "01TESTEVENT0000000000000000",
        sessionId: "01TESTSESSION00000000000000",
        traceId: "0123456789abcdef0123456789abcdef",
        spanId: "0123456789abcdef",
        durationMs: 12,
      },
    );

    expect(payload).toMatchObject({
      event_id: "01TESTEVENT0000000000000000",
      session_id: "01TESTSESSION00000000000000",
      event_type: "tool_call",
      trace_id: "0123456789abcdef0123456789abcdef",
      span_id: "0123456789abcdef",
      principal_id: "operator",
      principal_type: "human",
      action: "invoke",
      resource: "command:memory.read",
      authz_basis: "policy:allow:read-only-local",
      tool_name: "memory.read",
      tool_call_id: "call-123",
      tool_arguments: JSON.stringify({ slug: "project_dyfj" }),
      tool_result: "# Project DYFJ",
      tool_is_error: false,
      content: "memory.read allowed",
      duration_ms: 12,
    });
  });

  test("builds a denied tool_call event without command execution", () => {
    const payload = buildCommandToolCallEventPayload(
      call({ slug: "../secret" }),
      {
        decision: "deny",
        authzBasis: "policy:deny:invalid-arguments",
        isError: true,
        reason: "slug does not match required pattern",
      },
      {
        eventId: "01TESTEVENT0000000000000000",
        sessionId: "01TESTSESSION00000000000000",
        traceId: "0123456789abcdef0123456789abcdef",
        spanId: "0123456789abcdef",
      },
    );

    expect(payload).toMatchObject({
      action: "deny",
      authz_basis: "policy:deny:invalid-arguments",
      tool_is_error: true,
      tool_result: "slug does not match required pattern",
      content: "memory.read denied: slug does not match required pattern",
    });
  });
});

describe("invokeCommandWithEvent", () => {
  test("executes memory.read and writes one success event", async () => {
    const registry = createCommandRegistry();
    const events: Record<string, unknown>[] = [];
    registerCoreCommands(registry, {
      readMemory: async (slug) => `# ${slug}`,
    });

    const result = await invokeCommandWithEvent(registry, call(), {
      sessionId: "01TESTSESSION00000000000000",
      traceId: "0123456789abcdef0123456789abcdef",
      eventId: "01TESTEVENT0000000000000000",
      spanId: "0123456789abcdef",
      writeEvent: async (event) => {
        events.push(event);
      },
    });

    expect(result).toMatchObject({
      decision: "allow",
      isError: false,
      result: "# project_dyfj",
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_type: "tool_call",
      action: "invoke",
      tool_name: "memory.read",
      tool_is_error: false,
    });
  });

  test("writes a denial event when memory.read arguments are invalid", async () => {
    let executed = false;
    const registry = createCommandRegistry();
    const events: Record<string, unknown>[] = [];
    registerCoreCommands(registry, {
      readMemory: async () => {
        executed = true;
        return "should not happen";
      },
    });

    const result = await invokeCommandWithEvent(
      registry,
      call({ slug: "../secret" }),
      {
        sessionId: "01TESTSESSION00000000000000",
        traceId: "0123456789abcdef0123456789abcdef",
        eventId: "01TESTEVENT0000000000000000",
        spanId: "0123456789abcdef",
        writeEvent: async (event) => {
          events.push(event);
        },
      },
    );

    expect(result).toMatchObject({
      decision: "deny",
      isError: true,
    });
    expect(executed).toBe(false);
    expect(events[0]).toMatchObject({
      event_type: "tool_call",
      action: "deny",
      tool_name: "memory.read",
      tool_is_error: true,
    });
  });
});
