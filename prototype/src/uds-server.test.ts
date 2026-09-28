import { afterEach, describe, expect, test } from "vitest";
import { type EventInsert, MemoryStore } from "./store/mod.ts";
import {
  buildTurnHandlers,
  serveWorkbenchUnix,
  type WorkbenchUnixServer,
  type WorkbenchUnixServerOptions,
} from "./uds-server.ts";
import {
  JsonRpcPeer,
  type RpcContext,
  RpcErrorCode,
  type RpcHandlers,
} from "./transport/mod.ts";
import type { TurnRuntime } from "./engine/mod.ts";
import type { TurnStreamFrame } from "./contract/mod.ts";
import type { CommandDefinition } from "./tools/mod.ts";
import { installRuntimeSigintHandler } from "./runtime-sigint.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function startServer(
  options: WorkbenchUnixServerOptions,
): Promise<WorkbenchUnixServer> {
  const socketPath = `/tmp/dyfj-uds-${crypto.randomUUID()}.sock`;
  const server = await serveWorkbenchUnix(socketPath, {
    store: new MemoryStore(),
    ...options,
  });
  cleanups.push(async () => {
    await server.close();
    try {
      await Deno.remove(socketPath);
    } catch {
      // already gone
    }
  });
  return server;
}

async function connectClient(
  server: WorkbenchUnixServer,
  handlers: RpcHandlers = {},
): Promise<JsonRpcPeer> {
  const conn = await Deno.connect({
    transport: "unix",
    path: server.socketPath,
  });
  const client = new JsonRpcPeer(conn, { handlers });
  void client.run();
  cleanups.push(async () => client.close());
  return client;
}

// deno-lint-ignore no-explicit-any
const fakes: WorkbenchUnixServerOptions = {
  loadModels: async () => [{ slug: "local-x" } as any],
  listSessions: async (
    o,
  ) => [{ project: o.project ?? null, sessions: [] } as any],
  fetchSessionEvents: async (
    i,
  ) => [{ id: "e1", sessionId: i.sessionId } as any],
};

// Cast helper so the fake runtime can return receipt-shaped stubs without
// reconstructing the full WorkbenchRuntimeResult in each test.
// deno-lint-ignore no-explicit-any
const anyVal = (v: unknown): any => v;

const externalReadCommand: CommandDefinition<string> = {
  id: "mcp.linear.get_issue",
  title: "External MCP: linear/get_issue",
  description: "Configured external MCP read.",
  inputSchema: { type: "object", additionalProperties: true },
  permission: {
    effects: ["read.external", "emit.event"],
    defaultDecision: "allow",
    resources: ["mcp:linear/get_issue"],
    network: "configured-external",
    filesystem: "none",
    cost: "none",
  },
  minimumClearance: "loopback",
  executor: () => "result",
};

function frictionCommands(input: {
  comments?: string[];
  getIssueError?: string;
  listCommentsError?: string;
  createCommentError?: string;
  createdBodies?: string[];
} = {}): CommandDefinition[] {
  return [
    {
      id: "mcp.linear.get_issue",
      title: "External MCP: linear/get_issue",
      description: "Configured external MCP read.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
      permission: {
        effects: ["read.external", "emit.event"],
        defaultDecision: "allow",
        resources: ["mcp:linear/get_issue"],
        network: "configured-external",
        filesystem: "none",
        cost: "none",
      },
      minimumClearance: "loopback",
      redactArguments: true,
      redactResult: true,
      executor: () => {
        if (input.getIssueError) throw new Error(input.getIssueError);
        return { id: "issue-uuid" };
      },
    },
    {
      // Comments come from list_comments, not from the issue record: the
      // handler must resolve this tool or refuse before any write.
      id: "mcp.linear.list_comments",
      title: "External MCP: linear/list_comments",
      description: "Configured external MCP paged read.",
      inputSchema: {
        type: "object",
        properties: {
          issueId: { type: "string" },
          limit: { type: "number" },
          cursor: { type: "string" },
        },
        required: ["issueId"],
        additionalProperties: false,
      },
      permission: {
        effects: ["read.external", "emit.event"],
        defaultDecision: "allow",
        resources: ["mcp:linear/list_comments"],
        network: "configured-external",
        filesystem: "none",
        cost: "none",
      },
      minimumClearance: "loopback",
      redactArguments: true,
      redactResult: true,
      executor: () => {
        if (input.listCommentsError) throw new Error(input.listCommentsError);
        return {
          comments: (input.comments ?? []).map((body) => ({ body })),
          hasNextPage: false,
        };
      },
    },
    {
      id: "mcp.linear.create_comment",
      title: "External MCP: linear/create_comment",
      description: "Configured external MCP write.",
      inputSchema: {
        type: "object",
        properties: {
          issueId: { type: "string" },
          body: { type: "string" },
        },
        required: ["issueId", "body"],
        additionalProperties: false,
      },
      permission: {
        effects: ["write.external", "emit.event"],
        defaultDecision: "ask",
        resources: ["mcp:linear/create_comment"],
        network: "configured-external",
        filesystem: "none",
        cost: "none",
      },
      minimumClearance: "loopback",
      redactArguments: true,
      redactResult: true,
      executor: (call) => {
        if (input.createCommentError) throw new Error(input.createCommentError);
        input.createdBodies?.push(String(call.arguments.body));
        return { id: "comment-created" };
      },
    },
  ];
}

// Fixture order is an implementation detail. Instrumenting by position let a
// write counter land on the comment read when list_comments was added between
// them, so the assertion stopped watching writes while still passing.
function instrumentCommand(
  commands: CommandDefinition[],
  id: string,
  executor: CommandDefinition["executor"],
): void {
  const command = commands.find((candidate) => candidate.id === id);
  if (command === undefined) throw new Error(`fixture has no ${id}`);
  command.executor = executor;
}

type EngineConfig = NonNullable<WorkbenchUnixServerOptions["engineConfig"]>;
function engineConfig(overrides: Partial<EngineConfig> = {}): EngineConfig {
  return {
    defaultCompanionModel: null,
    permissionLevel: "strict",
    approvePaidDefault: false,
    trustWorkspaceInstructions: false,
    defaultSessionBudgetUsd: 1,
    defaultPerCallBudgetUsd: 0.1,
    defaultDailyBudgetUsd: 25,
    anomalyTurnMultiple: 3,
    anomalyScopeMultiple: 2,
    maxToolSteps: 32,
    ...overrides,
  };
}

describe("serveWorkbenchUnix read methods", () => {
  test("runtime close shuts down warm ACP sessions", async () => {
    const { AcpSessionHandleMap } = await import("./acp-session-map.ts");
    const map = new AcpSessionHandleMap({ capacity: 2, idleTtlMs: 60_000 });
    let closed = false;
    await map.acquire({
      sessionId: "s1",
      workspace: Deno.cwd(),
      profile: {
        slug: "fixture",
        command: Deno.execPath(),
        args: ["eval", "1"],
        environment: {},
        workspace: Deno.cwd(),
        transport: "local_stdio",
        accessRoute: "local_sidecar",
        costBasis: "local_free",
      },
      create: () =>
        Promise.resolve({
          get isAlive() {
            return !closed;
          },
          durableSessionLoad: false,
          prompt: async () => ({
            text: "",
            stopReason: "stop" as const,
            capabilities: [],
            elapsedMs: 0,
          }),
          close: async () => {
            closed = true;
          },
        }),
    });
    const server = await startServer({
      ...fakes,
      acpSessions: map,
      runRuntime: async () => anyVal({}),
    });
    expect(closed).toBe(false);
    await server.close();
    expect(closed).toBe(true);
    expect(map.size).toBe(0);
  });

  test("foreground SIGINT closes the server and reaps warm ACP sessions", async () => {
    const { AcpSessionHandleMap } = await import("./acp-session-map.ts");
    const map = new AcpSessionHandleMap({ capacity: 2, idleTtlMs: 60_000 });
    let closed = false;
    await map.acquire({
      sessionId: "s1",
      workspace: Deno.cwd(),
      profile: {
        slug: "fixture",
        command: Deno.execPath(),
        args: ["eval", "1"],
        environment: {},
        workspace: Deno.cwd(),
        transport: "local_stdio",
        accessRoute: "local_sidecar",
        costBasis: "local_free",
      },
      create: () =>
        Promise.resolve({
          get isAlive() {
            return !closed;
          },
          durableSessionLoad: false,
          prompt: async () => ({
            text: "",
            stopReason: "stop" as const,
            capabilities: [],
            elapsedMs: 0,
          }),
          close: async () => {
            closed = true;
          },
        }),
    });
    const server = await startServer({
      ...fakes,
      acpSessions: map,
      runRuntime: async () => anyVal({}),
    });
    let handler: () => void | Promise<void> = () => {};
    const exit = (code: number) => {
      expect(code).toBe(0);
    };
    installRuntimeSigintHandler(
      false,
      () => server.close(),
      { add: (next) => handler = next },
      exit,
    );
    await handler();
    expect(closed).toBe(true);
    expect(map.size).toBe(0);
  });

  test("runtime/stop reaps warm ACP sessions then returns stopping", async () => {
    const { AcpSessionHandleMap } = await import("./acp-session-map.ts");
    const map = new AcpSessionHandleMap({ capacity: 2, idleTtlMs: 60_000 });
    let closed = false;
    await map.acquire({
      sessionId: "s1",
      workspace: Deno.cwd(),
      profile: {
        slug: "fixture",
        command: Deno.execPath(),
        args: ["eval", "1"],
        environment: {},
        workspace: Deno.cwd(),
        transport: "local_stdio",
        accessRoute: "local_sidecar",
        costBasis: "local_free",
      },
      create: () =>
        Promise.resolve({
          get isAlive() {
            return !closed;
          },
          durableSessionLoad: false,
          prompt: async () => ({
            text: "",
            stopReason: "stop" as const,
            capabilities: [],
            elapsedMs: 0,
          }),
          close: async () => {
            closed = true;
          },
        }),
    });
    let server: WorkbenchUnixServer | undefined;
    server = await startServer({
      ...fakes,
      acpSessions: map,
      runRuntime: async () => anyVal({}),
      onShutdown: async () => {
        await server!.close({ disconnectPeers: false });
      },
    });
    const client = await connectClient(server);
    expect(closed).toBe(false);
    const res = await client.request("runtime/stop");
    expect(res).toEqual({ status: "stopping" });
    expect(closed).toBe(true);
    expect(map.size).toBe(0);
  });

  test("threads boot-discovered external MCP commands into UDS turns", async () => {
    let received: unknown;
    const runRuntime: TurnRuntime = async (input) => {
      received = input.externalMcpCommands;
      return anyVal({ receiptId: "r1" });
    };
    const handlers = buildTurnHandlers({
      ...fakes,
      runRuntime,
      externalMcpCommands: [externalReadCommand],
    });
    await handlers.turn(
      { prompt: "inspect issue" },
      {
        notify: () => Promise.resolve(),
        request: () => Promise.reject(new Error("no approval expected")),
      },
    );
    expect(received).toEqual([externalReadCommand]);
  });

  test("friction/post numbers comments and preserves write approval", async () => {
    const createdBodies: string[] = [];
    const approvals: unknown[] = [];
    const receiptEvents: EventInsert[] = [];
    const client = await connectClient(
      await startServer({
        ...fakes,
        frictionIssueId: "CHECKPOINT-1",
        frictionNow: () => new Date(2026, 8, 3, 12),
        frictionEventWriter: (event) => {
          receiptEvents.push(event);
        },
        externalMcpCommands: frictionCommands({
          comments: ["F008 · prior", "F010 · E002 · prior escape"],
          createdBodies,
        }),
      }),
      {
        approval: (request) => {
          approvals.push(request);
          return { decision: "approve" };
        },
      },
    );

    expect(
      await client.request("friction/post", {
        severity: "paper-cut",
        escaped: true,
        text: "A concrete operator moment.",
        context: {
          sessionId: "01FRICTIONSESSION00000000000",
          model: "model-slug",
          workspace: "/workspace",
          command: "/packet draft",
        },
      }),
    ).toEqual({
      number: "F011",
      escapeNumber: "E003",
      commentId: "comment-created",
      firstLine: "F011 · E003 · 2026-09-03 · paper-cut · escaped? yes",
    });
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      commandId: "mcp.linear.create_comment",
    });
    expect(receiptEvents).toHaveLength(3);
    expect(receiptEvents.map((event) => event.tool_name)).toEqual([
      "mcp.linear.get_issue",
      "mcp.linear.list_comments",
      "mcp.linear.create_comment",
    ]);
    expect(receiptEvents[2]).toMatchObject({
      authz_basis: "policy:allow:operator-approved",
      tool_arguments: '{"issueId":"[redacted]","body":"[redacted]"}',
      tool_result: "[redacted]",
    });
    expect(createdBodies[0]).toContain(
      "F011 · E003 · 2026-09-03 · paper-cut · escaped? yes",
    );
  });

  test("friction/post validates severity before reading Linear", async () => {
    let reads = 0;
    const commands = frictionCommands();
    instrumentCommand(commands, "mcp.linear.get_issue", () => {
      reads++;
      return { comments: [] };
    });
    const client = await connectClient(
      await startServer({ ...fakes, externalMcpCommands: commands }),
    );

    await expect(client.request("friction/post", {
      severity: "trivial",
      escaped: false,
      text: "moment",
    })).rejects.toMatchObject({ code: RpcErrorCode.invalidParams });
    expect(reads).toBe(0);
  });

  test.each([undefined, "   "])(
    "friction/post requires the operator's friction-checkpoint issue and emits no receipt",
    async (frictionIssueId) => {
      let reads = 0;
      let writes = 0;
      const receiptEvents: EventInsert[] = [];
      const commands = frictionCommands();
      instrumentCommand(commands, "mcp.linear.get_issue", () => {
        reads++;
        return { comments: [] };
      });
      instrumentCommand(commands, "mcp.linear.create_comment", () => {
        writes++;
        return { id: "comment-created" };
      });
      const client = await connectClient(
        await startServer({
          ...fakes,
          frictionIssueId,
          externalMcpCommands: commands,
          frictionEventWriter: (event) => {
            receiptEvents.push(event);
          },
        }),
      );

      await expect(client.request("friction/post", {
        severity: "minor",
        escaped: false,
        text: "moment",
      })).rejects.toMatchObject({
        message: expect.stringContaining(
          "configuration failed: DYFJ_FRICTION_ISSUE_ID must be set to the operator's friction-checkpoint issue",
        ),
      });
      expect(reads).toBe(0);
      expect(writes).toBe(0);
      expect(receiptEvents).toEqual([]);
    },
  );

  test("friction/post names create_comment failure and emits no receipt", async () => {
    const client = await connectClient(
      await startServer({
        ...fakes,
        frictionIssueId: "EX-100",
        externalMcpCommands: frictionCommands({
          createCommentError: "fixture refused",
        }),
        frictionEventWriter: () => {},
      }),
      { approval: () => ({ decision: "approve" }) },
    );

    await expect(client.request("friction/post", {
      severity: "minor",
      escaped: false,
      text: "moment",
      context: { sessionId: "01FRICTIONSESSION00000000000" },
    })).rejects.toMatchObject({
      message: expect.stringContaining("create_comment failed"),
    });
  });

  test("an unknown method -> methodNotFound", async () => {
    const client = await connectClient(await startServer(fakes));
    await expect(client.request("does/not/exist")).rejects.toMatchObject({
      code: RpcErrorCode.methodNotFound,
    });
  });
});

describe("serveWorkbenchUnix turn method", () => {
  test("streams deltas + events and returns the receipt", async () => {
    const runRuntime: TurnRuntime = async (input) => {
      input.frames?.onTextDelta?.("hello ");
      input.frames?.onTextDelta?.("world");
      input.frames?.onRuntimeEvent?.(
        anyVal({ kind: "tool-call", name: "noop" }),
      );
      return anyVal({ receiptId: "r1" });
    };
    const streamed: unknown[] = [];
    const server = await startServer({ ...fakes, runRuntime });
    const client = await connectClient(server, {
      stream: (p) => {
        streamed.push(p);
      },
    });
    expect(await client.request("turn", { prompt: "hi" })).toEqual({
      receiptId: "r1",
    });
    // Stream frames carry the shared TurnStreamFrame union.
    expect(streamed).toEqual([
      { t: "delta", text: "hello " },
      { t: "delta", text: "world" },
      { t: "event", event: { kind: "tool-call", name: "noop" } },
    ]);
  });

  test("threads the configured agent-step limit and returns the receipt field", async () => {
    let seenMaxToolSteps: number | undefined;
    const server = await startServer({
      ...fakes,
      engineConfig: anyVal({
        defaultCompanionModel: null,
        permissionLevel: "strict",
        approvePaidDefault: false,
        trustWorkspaceInstructions: false,
        defaultSessionBudgetUsd: 1,
        defaultPerCallBudgetUsd: 0.1,
        defaultDailyBudgetUsd: 25,
        anomalyTurnMultiple: 3,
        anomalyScopeMultiple: 2,
        maxToolSteps: 7,
      }),
      runRuntime: async (input) => {
        seenMaxToolSteps = input.maxToolSteps;
        return anyVal({
          agent: { toolStepsUsed: 3, maxToolSteps: 7, limitReached: false },
        });
      },
    });
    const client = await connectClient(server);
    await expect(client.request("turn", { prompt: "hi" })).resolves.toEqual({
      agent: { toolStepsUsed: 3, maxToolSteps: 7, limitReached: false },
    });
    expect(seenMaxToolSteps).toBe(7);
  });

  test("turn/cancel aborts the matching active turn and is otherwise a no-op", async () => {
    const turnId = "123e4567-e89b-42d3-a456-426614174000";
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const runRuntime: TurnRuntime = (input) =>
      new Promise((resolve) => {
        markStarted();
        input.abortSignal?.addEventListener("abort", () => {
          resolve(anyVal({ stopReason: "aborted", text: "partial" }));
        }, { once: true });
      });
    const ctx: RpcContext = {
      notify: () => Promise.resolve(),
      request: () => Promise.reject(new Error("no peer approver")),
    };
    const handlers = buildTurnHandlers({ ...fakes, runRuntime });
    const turn = handlers.turn({ prompt: "hi", turnId }, ctx);

    await started;
    const otherContext: RpcContext = {
      notify: () => Promise.resolve(),
      request: () => Promise.reject(new Error("different peer")),
    };
    expect(
      await handlers["turn/cancel"]({ turnId }, otherContext),
    ).toEqual({
      cancelled: false,
      reason: "no_active_turn",
    });
    expect(await handlers["turn/cancel"]({ turnId }, ctx)).toEqual({
      cancelled: true,
    });
    await expect(turn).resolves.toMatchObject({
      stopReason: "aborted",
      text: "partial",
    });
    expect(await handlers["turn/cancel"]({ turnId }, ctx)).toEqual({
      cancelled: false,
      reason: "no_active_turn",
    });
  });

  test("an approval arriving after acknowledged cancellation cannot start work", async () => {
    const turnId = "123e4567-e89b-42d3-a456-426614174000";
    let markApprovalRequested!: () => void;
    const approvalRequested = new Promise<void>((resolve) => {
      markApprovalRequested = resolve;
    });
    let resolveApproval!: (value: unknown) => void;
    const approvalResponse = new Promise<unknown>((resolve) => {
      resolveApproval = resolve;
    });
    let executorStarted = false;
    let runtimeCalls = 0;
    const runRuntime: TurnRuntime = async (input) => {
      runtimeCalls++;
      if (runtimeCalls > 1) return anyVal({ text: "next turn" });
      let matchedSignalReason = false;
      try {
        const verdict = await input.approver?.confirmToolApproval?.({
          commandId: "write_file",
          callId: "c1",
          title: "Write File",
          arguments: { path: "notes.md" },
        });
        executorStarted = verdict?.decision === "approve";
      } catch (error) {
        matchedSignalReason = error === input.abortSignal?.reason;
      }
      return anyVal({
        aborted: input.abortSignal?.aborted,
        matchedSignalReason,
      });
    };
    const ctx: RpcContext = {
      notify: () => Promise.resolve(),
      request: (_method, _params, signal) => {
        markApprovalRequested();
        return new Promise((resolve, reject) => {
          const onAbort = () => reject(signal?.reason);
          signal?.addEventListener("abort", onAbort, { once: true });
          approvalResponse.then(resolve, reject).finally(() => {
            signal?.removeEventListener("abort", onAbort);
          });
        });
      },
    };
    const handlers = buildTurnHandlers({ ...fakes, runRuntime });
    const turn = handlers.turn({ prompt: "edit notes", turnId }, ctx);

    await approvalRequested;
    expect(await handlers["turn/cancel"]({ turnId }, ctx)).toEqual({
      cancelled: true,
    });
    await expect(turn).resolves.toMatchObject({
      aborted: true,
      matchedSignalReason: true,
    });
    expect(executorStarted).toBe(false);
    await expect(handlers.turn({ prompt: "next" }, ctx)).resolves.toMatchObject(
      {
        text: "next turn",
      },
    );
    resolveApproval({ decision: "approve" });
  });

  test("turn/cancel declines after the runtime closes its cancellation window", async () => {
    const turnId = "123e4567-e89b-42d3-a456-426614174000";
    let markFinalizing!: () => void;
    const finalizing = new Promise<void>((resolve) => {
      markFinalizing = resolve;
    });
    let finish!: () => void;
    const finalized = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const runRuntime: TurnRuntime = async (input) => {
      input.cancellationWindow?.closeCancellation();
      markFinalizing();
      await finalized;
      return anyVal({ stopReason: "stop", text: "done" });
    };
    const ctx: RpcContext = {
      notify: () => Promise.resolve(),
      request: () => Promise.reject(new Error("no peer approver")),
    };
    const handlers = buildTurnHandlers({ ...fakes, runRuntime });
    const turn = handlers.turn({ prompt: "hi", turnId }, ctx);

    await finalizing;
    expect(await handlers["turn/cancel"]({ turnId }, ctx)).toEqual({
      cancelled: false,
      reason: "no_active_turn",
    });
    finish();
    await expect(turn).resolves.toMatchObject({
      stopReason: "stop",
      text: "done",
    });
  });

  test("different connections may use the same active turn id", async () => {
    const turnId = "123e4567-e89b-42d3-a456-426614174000";
    let startedCount = 0;
    let markBothStarted!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      markBothStarted = resolve;
    });
    const runRuntime: TurnRuntime = (input) =>
      new Promise((resolve) => {
        startedCount++;
        if (startedCount === 2) markBothStarted();
        input.abortSignal?.addEventListener("abort", () => {
          resolve(anyVal({ stopReason: "aborted", text: "" }));
        }, { once: true });
      });
    const context = (): RpcContext => ({
      notify: () => Promise.resolve(),
      request: () => Promise.reject(new Error("no peer approver")),
    });
    const firstContext = context();
    const secondContext = context();
    const handlers = buildTurnHandlers({ ...fakes, runRuntime });
    const first = handlers.turn({ prompt: "first", turnId }, firstContext);
    const second = handlers.turn({ prompt: "second", turnId }, secondContext);

    await bothStarted;
    expect(
      await handlers["turn/cancel"]({ turnId }, firstContext),
    ).toEqual({ cancelled: true });
    expect(
      await handlers["turn/cancel"]({ turnId }, secondContext),
    ).toEqual({ cancelled: true });
    await expect(first).resolves.toMatchObject({ stopReason: "aborted" });
    await expect(second).resolves.toMatchObject({ stopReason: "aborted" });
  });

  test("one connection cannot accumulate concurrent active turns", async () => {
    const firstTurnId = "123e4567-e89b-42d3-a456-426614174000";
    const secondTurnId = "123e4567-e89b-42d3-a456-426614174001";
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const runRuntime: TurnRuntime = (input) =>
      new Promise((resolve) => {
        markStarted();
        input.abortSignal?.addEventListener("abort", () => {
          resolve(anyVal({ stopReason: "aborted", text: "" }));
        }, { once: true });
      });
    const ctx: RpcContext = {
      notify: () => Promise.resolve(),
      request: () => Promise.reject(new Error("no peer approver")),
    };
    const handlers = buildTurnHandlers({ ...fakes, runRuntime });
    const first = handlers.turn({
      prompt: "first",
      turnId: firstTurnId,
    }, ctx);

    await started;
    await expect(handlers.turn({
      prompt: "second",
      turnId: secondTurnId,
    }, ctx)).rejects.toMatchObject({
      code: RpcErrorCode.invalidParams,
      message: "connection already has an active turn",
    });
    expect(
      await handlers["turn/cancel"]({ turnId: firstTurnId }, ctx),
    ).toEqual({ cancelled: true });
    await expect(first).resolves.toMatchObject({ stopReason: "aborted" });
  });

  test("keeps the superseding-retry signal ordered between stale and replacement deltas", async () => {
    // The reset contract only works if the seam preserves emission order: a
    // consumer resets exactly at the signal, keeping everything after it.
    const supersede = {
      type: "supersedingRetryStarted",
      sessionId: "01UDSSESSION0000000000000000",
      modelSlug: "gemma4:e2b",
      reason: "context_overflow_recovery",
    };
    const runRuntime: TurnRuntime = async (input) => {
      input.frames?.onTextDelta?.("stale partial");
      await input.frames?.onRuntimeEvent?.(anyVal(supersede));
      input.frames?.onTextDelta?.("replacement answer");
      return anyVal({ receiptId: "r1" });
    };
    const streamed: unknown[] = [];
    const server = await startServer({ ...fakes, runRuntime });
    const client = await connectClient(server, {
      stream: (p) => {
        streamed.push(p);
      },
    });
    await client.request("turn", { prompt: "hi" });
    expect(streamed).toEqual([
      { t: "delta", text: "stale partial" },
      { t: "event", event: supersede },
      { t: "delta", text: "replacement answer" },
    ]);
  });

  test("a rejected supersede notification prevents the replacement provider call", async () => {
    // The seam must not merely await a handler that discards the notification:
    // if the signal never reaches the client, the replacement text would be
    // glued onto the stale text the client still has rendered. The runtime here
    // mirrors the real one's fail-closed shape — await the signal, and only then
    // run the replacement call.
    const supersede = {
      type: "supersedingRetryStarted",
      sessionId: "01UDSSESSION0000000000000000",
      modelSlug: "gemma4:e2b",
      reason: "context_overflow_recovery",
    };
    let replacementProviderCalled = false;
    const runRuntime: TurnRuntime = async (input) => {
      input.frames?.onTextDelta?.("stale partial");
      await input.frames?.onRuntimeEvent?.(anyVal(supersede));
      replacementProviderCalled = true;
      input.frames?.onTextDelta?.("replacement answer");
      return anyVal({ receiptId: "r1" });
    };

    const sent: unknown[] = [];
    const ctx: RpcContext = {
      notify: (_method, params) => {
        const frame = params as TurnStreamFrame;
        if (frame.t === "event") {
          // The client's stream channel died between the stale and replacement
          // deltas — exactly when the reset signal must land.
          return Promise.reject(new Error("stream channel lost"));
        }
        sent.push(params);
        return Promise.resolve();
      },
      request: () => Promise.reject(new Error("no peer approver")),
    };

    const handlers = buildTurnHandlers({ ...fakes, runRuntime });
    await expect(handlers.turn({ prompt: "hi" }, ctx)).rejects.toThrow(
      "stream channel lost",
    );

    expect(replacementProviderCalled).toBe(false);
    expect(sent).toEqual([{ t: "delta", text: "stale partial" }]);
  });

  test("a rejected unparsed-markup notification fails the turn", async () => {
    const warning = {
      type: "unparsedToolCallMarkupDetected",
      sessionId: "01UDSSESSION0000000000000000",
      count: 2,
      countIsLowerBound: false,
    };
    let completed = false;
    const runRuntime: TurnRuntime = async (input) => {
      await input.frames?.onRuntimeEvent?.(anyVal(warning));
      completed = true;
      return anyVal({ receiptId: "r1" });
    };
    const ctx: RpcContext = {
      notify: (_method, params) =>
        (params as TurnStreamFrame).t === "event"
          ? Promise.reject(new Error("stream channel lost"))
          : Promise.resolve(),
      request: () => Promise.reject(new Error("no peer approver")),
    };

    const handlers = buildTurnHandlers({ ...fakes, runRuntime });
    await expect(handlers.turn({ prompt: "hi" }, ctx)).rejects.toThrow(
      "stream channel lost",
    );
    expect(completed).toBe(false);
  });

  test("a rejected plain status notification does not abort the turn", async () => {
    // The asymmetry: safety signals are fail-closed. This plain status event's
    // failed send (client gone) must stay best-effort — swallowed, not
    // surfaced — so the turn runs to completion instead of failing on a dropped
    // notification, and no per-event rejection floods back to the runtime.
    let afterEventReached = false;
    const runRuntime: TurnRuntime = async (input) => {
      // A plain status event, not either fail-closed safety signal.
      await input.frames?.onRuntimeEvent?.(anyVal({ type: "toolCallStarted" }));
      afterEventReached = true;
      return anyVal({ receiptId: "r1" });
    };
    const ctx: RpcContext = {
      notify: (_method, params) =>
        (params as TurnStreamFrame).t === "event"
          ? Promise.reject(new Error("client gone"))
          : Promise.resolve(),
      request: () => Promise.reject(new Error("no peer approver")),
    };
    const handlers = buildTurnHandlers({ ...fakes, runRuntime });
    // Resolves (does not reject), and execution continued past the failed send.
    await expect(handlers.turn({ prompt: "hi" }, ctx)).resolves.toBeDefined();
    expect(afterEventReached).toBe(true);
  });

  test("a turn without a prompt -> invalidParams", async () => {
    const runRuntime: TurnRuntime = async () => anyVal({});
    const client = await connectClient(
      await startServer({ ...fakes, runRuntime }),
    );
    await expect(client.request("turn", {})).rejects.toMatchObject({
      code: RpcErrorCode.invalidParams,
    });
  });

  // The security-critical property: UDS is the canonical loopback transport, so
  // paid inference is available — but only with the explicit per-turn opt-in,
  // decided by the shared turn core. Same gate as the HTTP loopback path.
  test("loopback clearance: paid approved with the per-turn opt-in", async () => {
    const runRuntime: TurnRuntime = async (input) => {
      const verdict = await input.approver?.confirmPaidEscalation?.("test");
      return anyVal({ verdict });
    };
    const client = await connectClient(
      await startServer({ ...fakes, runRuntime }),
    );
    expect(
      await client.request("turn", {
        prompt: "hi",
        approvePaidInference: true,
      }),
    ).toEqual({ verdict: { decision: "approve" } });
  });

  test("paid denied without the per-turn opt-in", async () => {
    const runRuntime: TurnRuntime = async (input) => {
      const verdict = await input.approver?.confirmPaidEscalation?.("test");
      return anyVal({ verdict });
    };
    const client = await connectClient(
      await startServer({ ...fakes, runRuntime }),
    );
    const result = anyVal(await client.request("turn", { prompt: "hi" }));
    expect(result.verdict.decision).toBe("deny");
  });

  test("loopback inherits approvePaidDefault when the request omits opt-in", async () => {
    const runRuntime: TurnRuntime = async (input) => {
      const verdict = await input.approver?.confirmPaidEscalation?.("test");
      return anyVal({ verdict });
    };
    const client = await connectClient(
      await startServer({
        ...fakes,
        runRuntime,
        engineConfig: engineConfig({
          defaultCompanionModel: null,
          permissionLevel: "strict",
          approvePaidDefault: true,
          defaultSessionBudgetUsd: 1,
          defaultPerCallBudgetUsd: 0.1,
        }),
      }),
    );
    expect(await client.request("turn", { prompt: "hi" })).toEqual({
      verdict: { decision: "approve" },
    });
  });

  test("applies a loopback budget override", async () => {
    const runRuntime: TurnRuntime = async (input) =>
      anyVal({ sessionLimitUsd: input.sessionLimitUsd ?? null });
    const client = await connectClient(
      await startServer({ ...fakes, runRuntime }),
    );
    expect(
      await client.request("turn", {
        prompt: "hi",
        budget: { sessionLimitUsd: 5 },
      }),
    ).toEqual({ sessionLimitUsd: 5 });
  });
});

// The serve-unix Deno permission-profile parity test moved to config.test.ts,
// where it became structural: the deno.json env allowlist is asserted against the
// declared CONFIG_SCHEMA surface (forward + reverse) rather than band-aided pair
// by pair.

describe("serveWorkbenchUnix turn approval round-trip", () => {
  // A runtime that asks to approve one mutating tool and reports the verdict.
  function approvalProbeRuntime(): TurnRuntime {
    return async (input) => {
      const verdict = await input.approver?.confirmToolApproval?.({
        commandId: "write_file",
        callId: "c1",
        title: "Write File",
        arguments: { path: "notes.md" },
      });
      return anyVal({ verdict });
    };
  }

  function acpPermissionProbeRuntime(): TurnRuntime {
    return async (input) => {
      const selection = await input.approver?.confirmExternalAgentPermission?.({
        sessionId: "external-session",
        toolCallId: "permission-1",
        toolCall: {
          title: "Run shell command?",
          name: "terminal",
          kind: "execute\u001b[31mforged",
          inputSummary: "git status",
        },
        options: [{
          optionId: "allow-once-id",
          name: "Allow Once",
          kind: "allow_once",
        }, {
          optionId: "remember-command-id",
          name: "Always allow `git status`",
          kind: "allow_always",
        }, {
          optionId: "reject-id",
          name: "Reject",
          kind: "reject_once",
        }],
      }, input.abortSignal ?? new AbortController().signal);
      return anyVal({ selection });
    };
  }

  function emptyAllowOnlyPermissionProbeRuntime(): TurnRuntime {
    return async (input) => {
      const selection = await input.approver?.confirmExternalAgentPermission?.({
        sessionId: "external-session",
        toolCallId: "permission-1",
        toolCall: {
          title: "Run shell command?",
          inputSummary: "git status",
        },
        options: [{
          optionId: "",
          name: "Allow Once",
          kind: "allow_once",
        }],
      }, input.abortSignal ?? new AbortController().signal);
      return anyVal({ selection });
    };
  }

  test("preserves the exact selected ACP option id across the duplex seam", async () => {
    const asked: unknown[] = [];
    const server = await startServer({
      ...fakes,
      runRuntime: acpPermissionProbeRuntime(),
    });
    const client = await connectClient(server, {
      approval: (request) => {
        asked.push(request);
        return { decision: "select", optionId: "remember-command-id" };
      },
    });
    await expect(client.request("turn", { prompt: "run it" })).resolves
      .toMatchObject({
        selection: { optionId: "remember-command-id", source: "operator" },
      });
    expect(asked).toEqual([expect.objectContaining({
      kind: "external_agent_permission",
      arguments: expect.objectContaining({
        "ACP kind": "(not supplied)",
      }),
      options: expect.arrayContaining([
        expect.objectContaining({
          optionId: "remember-command-id",
          name: "Always allow `git status`",
        }),
      ]),
    })]);
  });

  test("a client policy denial selects the request rejection as policy", async () => {
    const server = await startServer({
      ...fakes,
      runRuntime: acpPermissionProbeRuntime(),
    });
    const client = await connectClient(server, {
      approval: () => ({
        decision: "deny",
        reason: "ACP permission selection unavailable",
      }),
    });
    await expect(client.request("turn", { prompt: "run it" })).resolves
      .toMatchObject({
        selection: { optionId: "reject-id", source: "policy" },
      });
  });

  test("a missing ACP approver selects the request rejection", async () => {
    const server = await startServer({
      ...fakes,
      runRuntime: acpPermissionProbeRuntime(),
    });
    const client = await connectClient(server);
    await expect(client.request("turn", { prompt: "run it" })).resolves
      .toMatchObject({
        selection: { optionId: "reject-id", source: "policy" },
      });
  });

  test("a missing approver cannot select an empty allow id when rejection is absent", async () => {
    const server = await startServer({
      ...fakes,
      runRuntime: emptyAllowOnlyPermissionProbeRuntime(),
    });
    const client = await connectClient(server);
    await expect(client.request("turn", { prompt: "run it" })).resolves
      .toMatchObject({
        selection: { optionId: null, source: "policy" },
      });
  });

  test("server asks the client to approve a mutating tool mid-turn; approve flows back", async () => {
    const asked: unknown[] = [];
    const server = await startServer({
      ...fakes,
      runRuntime: approvalProbeRuntime(),
    });
    const client = await connectClient(server, {
      approval: (req) => {
        asked.push(req);
        return { decision: "approve" };
      },
    });
    const result = anyVal(
      await client.request("turn", { prompt: "edit notes" }),
    );
    expect(result.verdict).toEqual({ decision: "approve" });
    expect(asked[0]).toMatchObject({
      commandId: "write_file",
      arguments: { path: "notes.md" },
    });
  });

  test("a client denial flows back as a deny verdict", async () => {
    const server = await startServer({
      ...fakes,
      runRuntime: approvalProbeRuntime(),
    });
    const client = await connectClient(server, {
      approval: () => ({ decision: "deny", reason: "not now" }),
    });
    const result = anyVal(
      await client.request("turn", { prompt: "edit notes" }),
    );
    expect(result.verdict).toMatchObject({
      decision: "deny",
      reason: "not now",
    });
  });

  test("an interrupted approval aborts the server-side turn signal", async () => {
    const runRuntime: TurnRuntime = async (input) => {
      let matchedSignalReason = false;
      try {
        await input.approver?.confirmToolApproval?.({
          commandId: "write_file",
          callId: "c1",
          title: "Write File",
          arguments: { path: "notes.md" },
        });
      } catch (error) {
        matchedSignalReason = error === input.abortSignal?.reason;
      }
      return anyVal({
        aborted: input.abortSignal?.aborted,
        matchedSignalReason,
      });
    };
    const server = await startServer({ ...fakes, runRuntime });
    const client = await connectClient(server, {
      approval: () => ({ decision: "abort" }),
    });

    await expect(
      client.request("turn", { prompt: "edit notes" }),
    ).resolves.toMatchObject({
      aborted: true,
      matchedSignalReason: true,
    });
  });

  test("no client approver -> fail-closed deny", async () => {
    const server = await startServer({
      ...fakes,
      runRuntime: approvalProbeRuntime(),
    });
    const client = await connectClient(server);
    const result = anyVal(
      await client.request("turn", { prompt: "edit notes" }),
    );
    expect(result.verdict.decision).toBe("deny");
  });

  test("a reasonless anomaly-halt denial names the anomaly gate, not the budget ceiling", async () => {
    const runRuntime: TurnRuntime = async (input) => {
      const verdict = await input.approver?.confirmRunawayAnomaly?.({
        kind: "runaway_anomaly",
        trigger: "turn_spend",
        spentUsd: 0.35,
        haltUsd: 0.30,
        turnSpentUsd: 0.35,
        turnHaltUsd: 0.30,
        sessionSpentUsd: 0.35,
        sessionHaltUsd: 2,
        dailySpentUsd: 0.35,
        dailyHaltUsd: 50,
        turnMultiple: 3,
        scopeMultiple: 2,
        authzBasis: "policy:halt:runaway-anomaly",
        approvalAuthzBasis: "policy:allow:operator-confirmed-anomaly",
      });
      return anyVal({ verdict });
    };
    const server = await startServer({ ...fakes, runRuntime });
    const client = await connectClient(server, {
      approval: () => ({ decision: "deny" }), // no reason supplied
    });
    const result = anyVal(
      await client.request("turn", { prompt: "spend" }),
    );
    expect(result.verdict).toEqual({
      decision: "deny",
      reason: "operator declined the anomaly halt",
    });
  });
});

describe("sessions/inspect, ideas, and packets over UDS", () => {
  test("ideas/mark, ideas/list, ideas/get flow", async () => {
    const server = await startServer({
      ...fakes,
      fetchSessionEvents: async () => [
        {
          eventId: "evt-idea-1",
          sessionId: "01TEST_IDEA_SESSION",
          eventType: "model_response",
          createdAt: "2026-08-15T12:00:00Z",
          content: "Let us capture candidate work items as ideas.",
        } as any,
      ],
    });

    const client = await connectClient(server);

    const markRes = (await client.request("ideas/mark", {
      sessionId: "01TEST_IDEA_SESSION",
      eventId: "evt-idea-1",
      label: "Capture ideas",
    })) as any;

    expect(markRes.idea.label).toBe("Capture ideas");
    expect(markRes.idea.description).toBe(
      "Let us capture candidate work items as ideas.",
    );
    const ideaId = markRes.idea.ideaId;

    const listRes = (await client.request("ideas/list", {
      sessionId: "01TEST_IDEA_SESSION",
    })) as any;
    expect(listRes.ideas).toHaveLength(1);
    expect(listRes.ideas[0].ideaId).toBe(ideaId);

    const getRes = (await client.request("ideas/get", { ideaId })) as any;
    expect(getRes.idea.ideaId).toBe(ideaId);
  });

  test("packets/draft, packets/list, packets/get flow", async () => {
    const server = await startServer({
      ...fakes,
      fetchSessionWorkspaceRecord: async () => ({
        exists: true,
        workspace: "/workspaces/project",
      }),
      fetchSessionEvents: async () => [
        {
          eventId: "evt-pk-1",
          sessionId: "01TEST_PACKET_SESSION",
          eventType: "model_response",
          createdAt: "2026-08-15T12:00:00Z",
          content: "Drafting bounded work packets.",
        } as any,
      ],
    });

    const client = await connectClient(server);

    const draftRes = (await client.request("packets/draft", {
      sessionId: "01TEST_PACKET_SESSION",
      issueId: "ISSUE-258",
      title: "Neutral session model",
      operatorIntent: "Deliver Milestone 3 Packet 0",
    })) as any;

    expect(draftRes.packet.issueId).toBe("ISSUE-258");
    expect(draftRes.packet.targetWorkspace).toBe("/workspaces/project");
    expect(draftRes.markdown).toContain("# Work Packet: Neutral session model");
    expect(draftRes.markdown).toContain("- **Related Issue:** `ISSUE-258`");

    const packetId = draftRes.packet.packetId;

    const listRes = (await client.request("packets/list", {
      sessionId: "01TEST_PACKET_SESSION",
    })) as any;
    expect(listRes.packets).toHaveLength(1);
    expect(listRes.packets[0].packetId).toBe(packetId);

    const getRes = (await client.request("packets/get", { packetId })) as any;
    expect(getRes.packet.packetId).toBe(packetId);
    expect(getRes.markdown).toContain("# Work Packet: Neutral session model");
  });

  test("packets/draft rejects whitespace-only optional issueId", async () => {
    const server = await startServer(fakes);
    const client = await connectClient(server);

    await expect(client.request("packets/draft", {
      sessionId: "01TEST_PACKET_SESSION",
      issueId: "   ",
      title: "Neutral session model",
    })).rejects.toMatchObject({
      code: RpcErrorCode.invalidParams,
      message: "issueId cannot be empty or whitespace-only",
    });
  });

  test("RPC string sanitization strips complete ANSI CSI escape sequences", async () => {
    const server = await startServer(fakes);
    const client = await connectClient(server);

    const res = await client.request("ideas/mark", {
      sessionId: "01TEST_ANSI_SESSION",
      label: "Clean \x1b[31mRed\x1b[0m Text",
    }) as { idea: { label: string } };

    expect(res.idea.label).toBe("Clean Red Text");
    expect(res.idea.label).not.toContain("[31m");
  });

  test("ideas/list and packets/list reject missing sessionId", async () => {
    const server = await startServer(fakes);
    const client = await connectClient(server);

    await expect(client.request("ideas/list", {})).rejects.toMatchObject({
      code: RpcErrorCode.invalidParams,
      message: "sessionId is required",
    });

    await expect(client.request("packets/list", {})).rejects.toMatchObject({
      code: RpcErrorCode.invalidParams,
      message: "sessionId is required",
    });
  });

  test("packets/draft rejects idea belonging to a different session before fetching context", async () => {
    const server = await startServer(fakes);
    const client = await connectClient(server);

    const ideaRes = await client.request("ideas/mark", {
      sessionId: "01SESSION_OWNER_A",
      label: "Idea in A",
    }) as { idea: { ideaId: string } };

    await expect(client.request("packets/draft", {
      sessionId: "01SESSION_OWNER_B",
      ideaId: ideaRes.idea.ideaId,
    })).rejects.toMatchObject({
      code: RpcErrorCode.invalidParams,
      message: expect.stringContaining(
        'belongs to session "01SESSION_OWNER_A"',
      ),
    });
  });
});
