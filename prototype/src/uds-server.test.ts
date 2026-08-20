import { afterEach, describe, expect, test } from "vitest";
import {
  assertSocketBindable,
  buildTurnHandlers,
  serveWorkbenchUnix,
  type WorkbenchUnixServer,
  type WorkbenchUnixServerOptions,
} from "./uds-server";
import { JsonRpcPeer } from "./jsonrpc-peer";
import { type RpcContext, RpcErrorCode, type RpcHandlers } from "./jsonrpc";
import type { WorkbenchHttpRuntime } from "./turn-runner";
import type { TurnStreamFrame } from "./turn-contract";
import type { CommandDefinition } from "./commands";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function startServer(
  options: WorkbenchUnixServerOptions,
): Promise<WorkbenchUnixServer> {
  await Deno.mkdir(".vitest-tmp", { recursive: true });
  const dir = await Deno.makeTempDir({ dir: ".vitest-tmp" });
  const server = await serveWorkbenchUnix(`${dir}/wb.sock`, options);
  cleanups.push(async () => {
    await server.close();
    try {
      await Deno.remove(dir, { recursive: true });
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
  test("models/list returns the loaded models with a server-computed routable flag", async () => {
    const client = await connectClient(
      await startServer({
      ...fakes,
      loadModels: async () =>
        anyVal([
          { slug: "local-x", tier: 0, costInput: 0, costOutput: 0 },
          { slug: "hosted-priced", tier: 2, costInput: 15, costOutput: 75 },
          { slug: "hosted-unpriced", tier: 2, costInput: 0, costOutput: 0 },
        ]),
      }),
    );
    const { models } = anyVal(await client.request("models/list"));
    expect(models.map((m: { slug: string; routable: boolean }) => [
      m.slug,
      m.routable,
    ])).toEqual([
      ["local-x", true],
      ["hosted-priced", true],
      ["hosted-unpriced", false],
    ]);
  });

  test("models/list marks locality server-side", async () => {
    const client = await connectClient(
      await startServer({
      ...fakes,
      loadModels: async () =>
        anyVal([
          {
            slug: "local-x",
            provider: "ollama",
            baseUrl: "http://127.0.0.1:11434/v1",
            tier: 0,
            costInput: 0,
            costOutput: 0,
          },
          {
            slug: "hosted-x",
            provider: "anthropic",
            baseUrl: "https://api.anthropic.com",
            tier: 2,
            costInput: 15,
            costOutput: 75,
          },
        ]),
      }),
    );
    const { models } = anyVal(await client.request("models/list"));
    expect(models.map((m: { slug: string; local: boolean }) => [
      m.slug,
      m.local,
    ])).toEqual([
      ["local-x", true],
      ["hosted-x", false],
    ]);
  });

  test("models/list marks access modality server-side", async () => {
    const client = await connectClient(
      await startServer({
      ...fakes,
      loadModels: async () =>
        anyVal([
          {
            slug: "local-x",
            provider: "ollama",
            baseUrl: "http://127.0.0.1:11434/v1",
            tier: 0,
            costInput: 0,
            costOutput: 0,
          },
          {
            slug: "router-x",
            provider: "openrouter",
            baseUrl: "https://openrouter.ai/api/v1",
            tier: 1,
            costInput: 0.1,
            costOutput: 0.2,
          },
          {
            slug: "frontier-x",
            provider: "anthropic",
            baseUrl: "https://api.anthropic.com",
            tier: 2,
            costInput: 15,
            costOutput: 75,
          },
        ]),
      }),
    );
    const { models } = anyVal(await client.request("models/list"));
    expect(models.map((m: { slug: string; modality: string }) => [
      m.slug,
      m.modality,
    ])).toEqual([
      ["local-x", "local"],
      ["router-x", "aggregator-hosted"],
      ["frontier-x", "frontier-hosted"],
    ]);
  });

  test("runtime/status resolves the bare-turn route past a hosted configured default", async () => {
    const client = await connectClient(
      await startServer({
      ...fakes,
      loadModels: async () =>
        anyVal([
          {
            slug: "local-x",
            displayName: "Local X",
            provider: "ollama",
            baseUrl: "http://127.0.0.1:11434/v1",
            tier: 0,
            costInput: 0,
            costOutput: 0,
          },
          {
            slug: "hosted-x",
            displayName: "Hosted X",
            provider: "anthropic",
            baseUrl: "https://api.anthropic.com",
            tier: 2,
            costInput: 15,
            costOutput: 75,
          },
        ]),
      engineConfig: anyVal({
        defaultCompanionModel: "hosted-x",
        permissionLevel: "operator",
        approvePaidDefault: false,
      }),
      }),
    );
    const { runtime } = anyVal(await client.request("runtime/status"));
    // The configured default is reported and resolved as defaultTurnModel
    // when present in the catalog with pricing.
    expect(runtime.defaultCompanionModel).toBe("hosted-x");
    expect(runtime.defaultTurnModel).toMatchObject({
      slug: "hosted-x",
      tier: 2,
      local: false,
      reason: "default_config",
    });
    // Locality counts use the same provider+loopback classification as the
    // per-row `local` flag, not the tier label.
    expect(runtime.models).toEqual({ total: 2, local: 1, hosted: 1 });
  });

  test("runtime/status reports a null bare-turn route when nothing is routable", async () => {
    const client = await connectClient(await startServer(fakes));
    const { runtime } = anyVal(await client.request("runtime/status"));
    expect(runtime.defaultTurnModel).toBeNull();
  });

  test("sessions/list passes the project filter through", async () => {
    const client = await connectClient(await startServer(fakes));
    expect(await client.request("sessions/list", { project: "dyfj" })).toEqual({
      projects: [{ project: "dyfj", sessions: [] }],
    });
  });

  test("events/query returns events for a session", async () => {
    const client = await connectClient(await startServer(fakes));
    expect(await client.request("events/query", { sessionId: "s1" })).toEqual({
      events: [{ id: "e1", sessionId: "s1" }],
    });
  });

  test("runtime/status returns the local transport posture", async () => {
    const client = await connectClient(
      await startServer({
        ...fakes,
        engineConfig: engineConfig({
          defaultCompanionModel: "local-x",
          permissionLevel: "operator",
          approvePaidDefault: false,
          defaultSessionBudgetUsd: 2,
          defaultPerCallBudgetUsd: 0.2,
          maxToolSteps: 7,
        }),
      }),
    );
    expect(await client.request("runtime/status")).toMatchObject({
      runtime: {
        transport: "uds",
        clearance: "loopback",
        defaultCompanionModel: "local-x",
        permissionLevel: "operator",
        approvePaidDefault: false,
        maxToolSteps: 7,
        models: { total: 1 },
      },
    });
  });

  test("runtime/liveness returns immediately without loading models or sessions", async () => {
    let loadModelsCalled = false;
    let listSessionsCalled = false;
    const client = await connectClient(
      await startServer({
        loadModels: async () => {
          loadModelsCalled = true;
          return [{ slug: "local-x" } as any];
        },
        listSessions: async () => {
          listSessionsCalled = true;
          return [];
        },
      }),
    );
    const result = anyVal(await client.request("runtime/liveness"));
    expect(result).toEqual({
      status: "ok",
      transport: "uds",
      clearance: "loopback",
    });
    expect(loadModelsCalled).toBe(false);
    expect(listSessionsCalled).toBe(false);
  });

  test("runtime/status exposes method catalog metadata", async () => {
    const client = await connectClient(await startServer(fakes));
    expect(await client.request("runtime/status")).toMatchObject({
      runtime: {
        methods: [
          "runtime/liveness",
          "runtime/status",
          "runtime/stop",
          "surface/snapshot",
          "models/list",
          "sessions/list",
          "sessions/inspect",
          "events/query",
          "ideas/mark",
          "ideas/list",
          "ideas/get",
          "packets/draft",
          "packets/list",
          "packets/get",
          "tools/list",
          "tools/inspect",
          "turn",
          "turn/cancel",
        ],
        methodCatalog: [
          { id: "runtime/liveness", namespace: "runtime", kind: "read" },
          { id: "runtime/status", namespace: "runtime", kind: "read" },
          { id: "runtime/stop", namespace: "runtime", kind: "interactive" },
          { id: "surface/snapshot", namespace: "surface", kind: "read" },
          { id: "models/list", namespace: "models", kind: "read" },
          { id: "sessions/list", namespace: "sessions", kind: "read" },
          { id: "sessions/inspect", namespace: "sessions", kind: "read" },
          { id: "events/query", namespace: "events", kind: "read" },
          { id: "ideas/mark", namespace: "ideas", kind: "interactive" },
          { id: "ideas/list", namespace: "ideas", kind: "read" },
          { id: "ideas/get", namespace: "ideas", kind: "read" },
          { id: "packets/draft", namespace: "packets", kind: "interactive" },
          { id: "packets/list", namespace: "packets", kind: "read" },
          { id: "packets/get", namespace: "packets", kind: "read" },
          { id: "tools/list", namespace: "tools", kind: "read" },
          { id: "tools/inspect", namespace: "tools", kind: "read" },
          { id: "turn", namespace: "turn", kind: "interactive" },
          {
            id: "turn/cancel",
            namespace: "turn",
            kind: "interactive",
          },
        ],
      },
    });
  });

  test("runtime/stop triggers onShutdown callback and returns stopping status", async () => {
    let shutdownCalled = false;
    const shutdownPromise = new Promise<void>((resolve) => {
      // onShutdown
      fakes.onShutdown = () => {
        shutdownCalled = true;
        resolve();
      };
    });
    const client = await connectClient(await startServer(fakes));
    const res = await client.request("runtime/stop");
    expect(res).toEqual({ status: "stopping" });
    await shutdownPromise;
    expect(shutdownCalled).toBe(true);
  });

  test("runtime/stop throws internalError when onShutdown is absent", async () => {
    const serverOptions = { ...fakes };
    delete serverOptions.onShutdown;
    const client = await connectClient(await startServer(serverOptions));
    await expect(client.request("runtime/stop")).rejects.toMatchObject({
      code: RpcErrorCode.internalError,
      message: expect.stringContaining("shutdown is not configured"),
    });
  });

  test("tools/list exposes a catalog without executing tools", async () => {
    const client = await connectClient(
      await startServer({
        ...fakes,
        externalMcpCommands: [externalReadCommand],
      }),
    );
    const result = anyVal(
      await client.request("tools/list", { workspace: "/workspace" }),
    );
    expect(result.tools.map((tool: { id: string }) => tool.id)).toEqual([
      "memory.read",
      "read_file",
      "list_files",
      "grep_files",
      "glob_files",
      "write_file",
      "edit_file",
      "bash",
      "mcp.linear.get_issue",
    ]);
    expect(result.tools.find((tool: { id: string }) => tool.id === "bash"))
      .toMatchObject({
        permission: { filesystem: "write", network: "external" },
        redactResult: true,
      });
  });

  test("threads boot-discovered external MCP commands into UDS turns", async () => {
    let received: unknown;
    const runRuntime: WorkbenchHttpRuntime = async (input) => {
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

  test("tools/inspect returns one tool schema", async () => {
    const client = await connectClient(await startServer(fakes));
    expect(
      await client.request("tools/inspect", {
        workspace: "/workspace",
        commandId: "read_file",
      }),
    ).toMatchObject({
      tool: {
        id: "read_file",
        inputSchema: { required: ["path"] },
        permission: { filesystem: "read" },
      },
    });
  });

  test("surface/snapshot bundles status, models, sessions, and tools", async () => {
    const client = await connectClient(await startServer(fakes));
    const result = anyVal(
      await client.request("surface/snapshot", {
        project: "dyfj",
        workspace: "/workspace",
      }),
    );
    expect(result.generatedAt).toEqual(expect.any(String));
    expect(result.runtime).toMatchObject({ transport: "uds" });
    expect(result.models).toEqual([{ slug: "local-x" }]);
    expect(result.projects).toEqual([{ project: "dyfj", sessions: [] }]);
    expect(result.tools.map((tool: { id: string }) => tool.id)).toContain(
      "read_file",
    );
  });

  test("events/query without a sessionId -> invalidParams", async () => {
    const client = await connectClient(await startServer(fakes));
    await expect(client.request("events/query", {})).rejects.toMatchObject({
      code: RpcErrorCode.invalidParams,
    });
  });

  test("events/query with a malformed asOf -> invalidParams", async () => {
    const client = await connectClient(await startServer(fakes));
    await expect(
      client.request("events/query", {
        sessionId: "s1",
        asOf: "not-a-timestamp",
      }),
    ).rejects.toMatchObject({ code: RpcErrorCode.invalidParams });
  });

  test("events/query with an invalid limit -> invalidParams", async () => {
    const client = await connectClient(await startServer(fakes));
    await expect(
      client.request("events/query", {
        sessionId: "s1",
        limit: 0,
      }),
    ).rejects.toMatchObject({ code: RpcErrorCode.invalidParams });
    await expect(
      client.request("events/query", {
        sessionId: "s1",
        limit: -5,
      }),
    ).rejects.toMatchObject({ code: RpcErrorCode.invalidParams });
    await expect(
      client.request("events/query", {
        sessionId: "s1",
        limit: "100" as any,
      }),
    ).rejects.toMatchObject({ code: RpcErrorCode.invalidParams });
    await expect(
      client.request("events/query", {
        sessionId: "s1",
        limit: 1001,
      }),
    ).rejects.toMatchObject({ code: RpcErrorCode.invalidParams });
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
    const runRuntime: WorkbenchHttpRuntime = async (input) => {
      input.onTextDelta?.("hello ");
      input.onTextDelta?.("world");
      input.onRuntimeEvent?.(anyVal({ kind: "tool-call", name: "noop" }));
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
    // Stream frames mirror the HTTP SSE frame shape (TurnStreamFrame).
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
    const runRuntime: WorkbenchHttpRuntime = (input) =>
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
    const runRuntime: WorkbenchHttpRuntime = async (input) => {
      runtimeCalls++;
      if (runtimeCalls > 1) return anyVal({ text: "next turn" });
      let matchedSignalReason = false;
      try {
        const verdict = await input.confirmToolApproval?.({
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
    await expect(handlers.turn({ prompt: "next" }, ctx)).resolves.toMatchObject({
      text: "next turn",
    });
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
    const runRuntime: WorkbenchHttpRuntime = async (input) => {
      input.onCancellationClosed?.();
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
    const runRuntime: WorkbenchHttpRuntime = (input) =>
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
    const runRuntime: WorkbenchHttpRuntime = (input) =>
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
    const runRuntime: WorkbenchHttpRuntime = async (input) => {
      input.onTextDelta?.("stale partial");
      await input.onRuntimeEvent?.(anyVal(supersede));
      input.onTextDelta?.("replacement answer");
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
    const runRuntime: WorkbenchHttpRuntime = async (input) => {
      input.onTextDelta?.("stale partial");
      await input.onRuntimeEvent?.(anyVal(supersede));
      replacementProviderCalled = true;
      input.onTextDelta?.("replacement answer");
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
    const runRuntime: WorkbenchHttpRuntime = async (input) => {
      await input.onRuntimeEvent?.(anyVal(warning));
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
    const runRuntime: WorkbenchHttpRuntime = async (input) => {
      // A plain status event, not either fail-closed safety signal.
      await input.onRuntimeEvent?.(anyVal({ type: "toolCallStarted" }));
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
    const runRuntime: WorkbenchHttpRuntime = async () => anyVal({});
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
    const runRuntime: WorkbenchHttpRuntime = async (input) => {
      const verdict = await input.confirmPaidEscalation?.("test");
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
    const runRuntime: WorkbenchHttpRuntime = async (input) => {
      const verdict = await input.confirmPaidEscalation?.("test");
      return anyVal({ verdict });
    };
    const client = await connectClient(
      await startServer({ ...fakes, runRuntime }),
    );
    const result = anyVal(await client.request("turn", { prompt: "hi" }));
    expect(result.verdict.decision).toBe("deny");
  });

  test("loopback inherits approvePaidDefault when the request omits opt-in", async () => {
    const runRuntime: WorkbenchHttpRuntime = async (input) => {
      const verdict = await input.confirmPaidEscalation?.("test");
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
    const runRuntime: WorkbenchHttpRuntime = async (input) =>
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
// by pair, with the serve-unix ⊇ workbench-http net backstop retained there.

describe("serveWorkbenchUnix turn approval round-trip", () => {
  // A runtime that asks to approve one mutating tool and reports the verdict.
  function approvalProbeRuntime(): WorkbenchHttpRuntime {
    return async (input) => {
      const verdict = await input.confirmToolApproval?.({
        commandId: "write_file",
        callId: "c1",
        title: "Write File",
        arguments: { path: "notes.md" },
      });
      return anyVal({ verdict });
    };
  }

  function acpPermissionProbeRuntime(): WorkbenchHttpRuntime {
    return async (input) => {
      const selection = await input.confirmExternalAgentPermission?.({
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

  function emptyAllowOnlyPermissionProbeRuntime(): WorkbenchHttpRuntime {
    return async (input) => {
      const selection = await input.confirmExternalAgentPermission?.({
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
    const runRuntime: WorkbenchHttpRuntime = async (input) => {
      let matchedSignalReason = false;
      try {
        await input.confirmToolApproval?.({
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
    const runRuntime: WorkbenchHttpRuntime = async (input) => {
      const verdict = await input.confirmRunawayAnomaly?.({
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

describe("socket bind safety", () => {
  test("refuses to bind while a live runtime answers on the socket", async () => {
    const server = await startServer(fakes);
    await expect(serveWorkbenchUnix(server.socketPath, fakes)).rejects.toThrow(
      /live runtime is already serving/,
    );
    // The live server is untouched: its socket file still exists and accepts.
    const client = await connectClient(server);
    await expect(client.request("runtime/status")).resolves.toBeTruthy();
  });

  test("clears a genuinely stale socket and binds", async () => {
    await Deno.mkdir(".vitest-tmp", { recursive: true });
    const dir = await Deno.makeTempDir({ dir: ".vitest-tmp" });
    const sock = `${dir}/wb.sock`;
    // Fabricate the unclean-exit shape: a SIGKILL'd listener leaves its
    // socket file behind with nothing accepting. (A cleanly closed Deno
    // listener removes its file, so this needs a hard-killed process.)
    const fabricate = await new Deno.Command("bash", {
      args: [
        "-c",
        `nc -lU '${sock}' & pid=$!; for i in $(seq 1 50); do [ -S '${sock}' ] && break; sleep 0.1; done; kill -9 $pid 2>/dev/null; wait $pid 2>/dev/null; [ -S '${sock}' ]`,
      ],
    }).output();
    expect(fabricate.success).toBe(true);
    expect(Deno.lstatSync(sock).isSocket).toBe(true);
    await assertSocketBindable(sock);
    expect(() => Deno.lstatSync(sock)).toThrow();
    await Deno.remove(dir, { recursive: true });
  });

  test("refuses to bind over a non-socket path", async () => {
    await Deno.mkdir(".vitest-tmp", { recursive: true });
    const dir = await Deno.makeTempDir({ dir: ".vitest-tmp" });
    const path = `${dir}/wb.sock`;
    await Deno.writeTextFile(path, "not a socket");
    await expect(assertSocketBindable(path)).rejects.toThrow(
      /exists and is not a socket/,
    );
    await Deno.remove(dir, { recursive: true });
  });
});

describe("sessions/inspect, ideas, and packets over UDS", () => {
  test("sessions/inspect returns session summary, workspace, and event counts", async () => {
    const server = await startServer({
      ...fakes,
      fetchSessionRecord: async () => ({
        sessionId: "01TEST_SESSION",
        slug: "workbench-01test_session",
        sessionName: null,
        taskDescription: "Explore neutral sessions",
        project: "DYFJ Context",
        status: "active",
        createdAt: "2026-08-15T12:00:00Z",
        updatedAt: "2026-08-15T12:00:00Z",
      }),
      fetchSessionWorkspaceRecord: async () => ({
        exists: true,
        workspace: "/workspaces/project",
      }),
      countSessionEvents: async () => 1,
    });

    const client = await connectClient(server);
    const inspectRes = (await client.request("sessions/inspect", {
      sessionId: "01TEST_SESSION",
    })) as any;

    expect(inspectRes.exists).toBe(true);
    expect(inspectRes.session.taskDescription).toBe("Explore neutral sessions");
    expect(inspectRes.workspace).toBe("/workspaces/project");
    expect(inspectRes.eventCount).toBe(1);
  });

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

  test("events/query rejects asOf longer than 64 characters", async () => {
    const server = await startServer(fakes);
    const client = await connectClient(server);

    await expect(client.request("events/query", {
      sessionId: "01TEST_EVENTS_SESSION",
      asOf: "2026-08-15T12:00:00.000Z" + "0".repeat(100),
    })).rejects.toMatchObject({
      code: RpcErrorCode.invalidParams,
    });
  });

  test("RPC methods reject C1 control characters in identifiers", async () => {
    const server = await startServer(fakes);
    const client = await connectClient(server);

    await expect(client.request("sessions/inspect", {
      sessionId: "01TEST\u009BSESSION",
    })).rejects.toMatchObject({
      code: RpcErrorCode.invalidParams,
      message: expect.stringContaining("cannot contain control characters"),
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
      message: expect.stringContaining("belongs to session \"01SESSION_OWNER_A\""),
    });
  });
});

