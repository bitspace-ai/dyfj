import { describe, expect, test } from "vitest";
import {
  buildBashCommand,
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

  test("auto-allows a read-only filesystem command", () => {
    const readFile = readCommand({
      id: "read_file",
      inputSchema: {
        type: "object",
        required: ["path"],
        properties: { path: { type: "string" } },
        additionalProperties: false,
      },
      permission: {
        effects: ["read.filesystem", "emit.event"],
        defaultDecision: "allow",
        resources: ["file:read"],
        network: "none",
        filesystem: "read",
        cost: "none",
      },
    });
    const result = evaluateCommandPolicy(
      readFile,
      call({ path: "src/cli.ts" }, { commandId: "read_file" }),
    );
    expect(result.decision).toBe("allow");
  });

  test("does NOT auto-allow a write-filesystem command (falls to ask)", () => {
    const writeFile = readCommand({
      id: "write_file",
      inputSchema: {
        type: "object",
        required: ["path"],
        properties: { path: { type: "string" } },
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
    });
    const result = evaluateCommandPolicy(
      writeFile,
      call({ path: "x" }, { commandId: "write_file" }),
    );
    expect(result.decision).toBe("ask");
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

describe("registerCoreCommands", () => {
  test("registers only memory.read without a workspace root", () => {
    const registry = createCommandRegistry();
    registerCoreCommands(registry, {});
    expect(registry.list().map((c) => c.id)).toEqual(["memory.read"]);
  });

  test("registers the file tools when a workspace root is set", () => {
    const registry = createCommandRegistry();
    registerCoreCommands(registry, { workspaceRoot: "/work" });
    expect(registry.list().map((c) => c.id).sort()).toEqual([
      "bash",
      "edit_file",
      "list_files",
      "memory.read",
      "read_file",
      "write_file",
    ]);
  });

  test("the registered file tools are read-only (auto-allowed)", () => {
    const registry = createCommandRegistry();
    registerCoreCommands(registry, { workspaceRoot: "/work" });
    const readFile = registry.lookup("read_file")!;
    const result = evaluateCommandPolicy(
      readFile,
      call({ path: "deno.json" }, { commandId: "read_file" }),
    );
    expect(result.decision).toBe("allow");
  });
});

describe("search_memory (external recall)", () => {
  test("registers only when a recall fn is provided", () => {
    const registry = createCommandRegistry();
    registerCoreCommands(registry, { searchMemory: () => "hit" });
    expect(registry.list().map((c) => c.id).sort()).toEqual([
      "memory.read",
      "memory.search",
    ]);
  });

  test("recall is auto-allowed with its own audit basis (no per-call prompt)", () => {
    const registry = createCommandRegistry();
    registerCoreCommands(registry, { searchMemory: () => "hit" });
    const result = evaluateCommandPolicy(
      registry.lookup("memory.search")!,
      call({ query: "what did we decide about X" }, {
        commandId: "memory.search",
      }),
    );
    expect(result.decision).toBe("allow");
    expect(result.authzBasis).toBe("policy:allow:operator-configured-recall");
  });

  test("invokes the bound recall function with the query", async () => {
    const registry = createCommandRegistry();
    let received = "";
    registerCoreCommands(registry, {
      searchMemory: (q) => {
        received = q;
        return "result text";
      },
    });
    const result = await invokeCommand(
      registry,
      call({ query: "the auth rewrite" }, { commandId: "memory.search" }),
    );
    expect(received).toBe("the auth rewrite");
    expect(result).toMatchObject({
      decision: "allow",
      isError: false,
      result: "result text",
    });
  });

  test("denies a malformed call before reaching the recall function", async () => {
    const registry = createCommandRegistry();
    let called = false;
    registerCoreCommands(registry, {
      searchMemory: () => {
        called = true;
        return "x";
      },
    });
    const result = await invokeCommand(
      registry,
      call({}, { commandId: "memory.search" }),
    );
    expect(result.decision).toBe("deny");
    expect(called).toBe(false);
  });
});

describe("operator permission profile", () => {
  function writeCmd(
    over: Partial<CommandDefinition["permission"]> = {},
  ): CommandDefinition<string> {
    return readCommand({
      id: "write_file",
      title: "Write File",
      inputSchema: {
        type: "object",
        required: ["path"],
        properties: { path: { type: "string" } },
        additionalProperties: false,
      },
      permission: {
        effects: ["write.filesystem", "emit.event"],
        defaultDecision: "allow",
        resources: ["file:write"],
        network: "none",
        filesystem: "write",
        cost: "none",
        ...over,
      },
      executor: (c) => `wrote ${c.arguments.path}`,
    });
  }
  const wcall = () => call({ path: "x" }, { commandId: "write_file" });

  test("strict (default): a contained mutation still prompts for approval", () => {
    expect(evaluateCommandPolicy(writeCmd(), wcall()).decision).toBe("ask");
    expect(
      evaluateCommandPolicy(writeCmd(), wcall(), {
        permissionLevel: "strict",
        loopback: true,
      }).decision,
    ).toBe("ask");
  });

  test("operator + loopback: a contained mutation auto-approves", () => {
    const policy = evaluateCommandPolicy(writeCmd(), wcall(), {
      permissionLevel: "operator",
      loopback: true,
    });
    expect(policy.decision).toBe("allow");
    expect(policy.authzBasis).toBe("policy:allow:operator-profile");
  });

  test("the operator profile is loopback-only", () => {
    expect(
      evaluateCommandPolicy(writeCmd(), wcall(), {
        permissionLevel: "operator",
        loopback: false,
      }).decision,
    ).toBe("ask");
  });

  test("operator does NOT cover paid or networked mutations (bash-class stays gated)", () => {
    expect(
      evaluateCommandPolicy(writeCmd({ cost: "paid" }), wcall(), {
        permissionLevel: "operator",
        loopback: true,
      }).decision,
    ).toBe("ask");
    expect(
      evaluateCommandPolicy(writeCmd({ network: "external" }), wcall(), {
        permissionLevel: "operator",
        loopback: true,
      }).decision,
    ).toBe("ask");
  });

  test("no-exec invariant: a run.* effect never auto-approves, even with a contained envelope", () => {
    // Identical write/free/local envelope to the auto-approving case above, but
    // carrying an exec-class effect — the effect, not the metadata, is the gate,
    // so it must fall through to "ask" under the operator profile.
    for (
      const effects of [
        ["run.process", "write.filesystem", "emit.event"],
        ["run.checks", "write.filesystem", "emit.event"],
      ] as CommandDefinition["permission"]["effects"][]
    ) {
      const policy = evaluateCommandPolicy(writeCmd({ effects }), wcall(), {
        permissionLevel: "operator",
        loopback: true,
      });
      expect(policy.decision).toBe("ask");
    }
  });

  test("the real bash command always asks under the operator profile", () => {
    const bash = buildBashCommand("/work");
    const policy = evaluateCommandPolicy(
      bash,
      call({ command: "ls" }, { commandId: "bash" }),
      { permissionLevel: "operator", loopback: true },
    );
    expect(policy.decision).toBe("ask");
  });

  test("operator + loopback runs the tool without invoking the approver", async () => {
    const registry = createCommandRegistry([writeCmd()]);
    let approverCalled = false;
    const result = await invokeCommand(
      registry,
      wcall(),
      () => {
        approverCalled = true;
        return Promise.resolve({ decision: "approve" as const });
      },
      { permissionLevel: "operator", loopback: true },
    );
    expect(approverCalled).toBe(false);
    expect(result).toMatchObject({
      decision: "allow",
      authzBasis: "policy:allow:operator-profile",
      result: "wrote x",
    });
  });
});

describe("invokeCommand approval (ask) flow", () => {
  function writeFileCommand(
    executor: CommandDefinition<string>["executor"] = (c) =>
      `wrote ${c.arguments.path}`,
  ): CommandDefinition<string> {
    return readCommand({
      id: "write_file",
      title: "Write File",
      inputSchema: {
        type: "object",
        required: ["path"],
        properties: { path: { type: "string" } },
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
      executor,
    });
  }

  test("with no approver, a mutating tool is denied — fail-closed", async () => {
    let ran = false;
    const registry = createCommandRegistry([
      writeFileCommand(() => {
        ran = true;
        return "ran";
      }),
    ]);
    const result = await invokeCommand(
      registry,
      call({ path: "x" }, { commandId: "write_file" }),
    );
    expect(result).toMatchObject({
      decision: "deny",
      authzBasis: "policy:deny:approval-denied",
      isError: true,
    });
    expect(ran).toBe(false);
  });

  test("an approve verdict runs the tool with the operator-approved basis", async () => {
    const registry = createCommandRegistry([writeFileCommand()]);
    const result = await invokeCommand(
      registry,
      call({ path: "x" }, { commandId: "write_file" }),
      () => Promise.resolve({ decision: "approve" }),
    );
    expect(result).toEqual({
      decision: "allow",
      authzBasis: "policy:allow:operator-approved",
      isError: false,
      result: "wrote x",
    });
  });

  test("a deny verdict does not run the tool and carries the reason", async () => {
    let ran = false;
    const registry = createCommandRegistry([
      writeFileCommand(() => {
        ran = true;
        return "ran";
      }),
    ]);
    const result = await invokeCommand(
      registry,
      call({ path: "x" }, { commandId: "write_file" }),
      () => Promise.resolve({ decision: "deny", reason: "operator said no" }),
    );
    expect(result).toMatchObject({
      decision: "deny",
      authzBasis: "policy:deny:approval-denied",
      reason: "operator said no",
      isError: true,
    });
    expect(ran).toBe(false);
  });

  test("the approval request carries the tool identity and arguments", async () => {
    let seen: unknown;
    const registry = createCommandRegistry([writeFileCommand()]);
    await invokeCommand(
      registry,
      call({ path: "a.txt" }, { commandId: "write_file" }),
      (request) => {
        seen = request;
        return Promise.resolve({ decision: "approve" });
      },
    );
    expect(seen).toEqual({
      commandId: "write_file",
      callId: "call-123",
      title: "Write File",
      arguments: { path: "a.txt" },
    });
  });

  test("an invalid-argument mutating call is denied before any approval", async () => {
    let asked = false;
    const registry = createCommandRegistry([writeFileCommand()]);
    const result = await invokeCommand(
      registry,
      call({ path: "x", extra: 1 }, { commandId: "write_file" }),
      () => {
        asked = true;
        return Promise.resolve({ decision: "approve" });
      },
    );
    expect(result).toMatchObject({
      decision: "deny",
      authzBasis: "policy:deny:invalid-arguments",
    });
    expect(asked).toBe(false);
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

  test("narrows memory.read slug schema to advertised context-index slugs", () => {
    const registry = createCommandRegistry();

    registerCoreCommands(registry, {
      allowedMemorySlugs: ["project_dyfj", "reference_1password_cli"],
      readMemory: async (slug) => `# ${slug}`,
    });

    const slugSchema = registry.projectTools()[0]!.parameters.properties!.slug!;
    expect(slugSchema.pattern).toBe(
      "^(project_dyfj|reference_1password_cli)$",
    );
  });

  test("denies syntactically valid but unadvertised memory slugs", async () => {
    let executed = false;
    const registry = createCommandRegistry();
    registerCoreCommands(registry, {
      allowedMemorySlugs: ["project_dyfj"],
      readMemory: async () => {
        executed = true;
        return "should not happen";
      },
    });

    const result = await invokeCommand(
      registry,
      call({ slug: "prod-secrets" }),
    );

    expect(result).toMatchObject({
      decision: "deny",
      authzBasis: "policy:deny:invalid-arguments",
      isError: true,
      reason: "slug does not match required pattern",
    });
    expect(executed).toBe(false);
  });
});

describe("redactCommandArguments (sensitive tool args)", () => {
  test("a write-file event redacts the content argument, preserves path", async () => {
    const writeCmd: CommandDefinition<string> = {
      id: "write_file",
      title: "Write File",
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
    const events: Record<string, unknown>[] = [];
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
        writeEvent: async (e) => {
          events.push(e);
        },
      },
      () => Promise.resolve({ decision: "approve" }),
    );
    const args = JSON.parse(events[0].tool_arguments as string);
    expect(args.path).toBe("notes.md");
    expect(args.content).toBe("[redacted]");
  });

  test("redacts a redact-marked argument of any type — malformed content cannot bypass it", async () => {
    const writeCmd: CommandDefinition<string> = {
      id: "write_file",
      title: "Write File",
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
      const events: Record<string, unknown>[] = [];
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
          writeEvent: async (e) => {
            events.push(e);
          },
        },
        () => Promise.resolve({ decision: "approve" }),
      );
      // Non-string content is denied by validation before execution, but the
      // denied call's persisted event still redacts content to the sentinel —
      // the raw nested payload never reaches the log or replay.
      expect(result.decision).toBe("deny");
      const args = JSON.parse(events[0].tool_arguments as string);
      expect(args.content).toBe("[redacted]");
      expect(events[0].tool_arguments as string).not.toContain("secret token");
    }
  });

  test("the real write_file command marks content for redaction", () => {
    const registry = createCommandRegistry();
    registerCoreCommands(registry, { workspaceRoot: "/work" });
    expect(
      registry.lookup("write_file")!.inputSchema.properties!.content!.redact,
    ).toBe(true);
  });

  test("leaves non-redacted arguments verbatim", async () => {
    const registry = createCommandRegistry();
    registerCoreCommands(registry, {
      readMemory: async (slug) => `# ${slug}`,
    });
    const events: Record<string, unknown>[] = [];
    await invokeCommandWithEvent(registry, call(), {
      sessionId: "01TESTSESSION00000000000000",
      traceId: "0123456789abcdef0123456789abcdef",
      eventId: "01TESTEVENT0000000000000000",
      spanId: "0123456789abcdef",
      writeEvent: async (e) => {
        events.push(e);
      },
    });
    expect(JSON.parse(events[0].tool_arguments as string)).toEqual({
      slug: "project_dyfj",
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
