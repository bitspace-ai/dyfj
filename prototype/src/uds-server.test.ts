import { afterEach, describe, expect, test } from "vitest";
import {
  assertSocketBindable,
  serveWorkbenchUnix,
  type WorkbenchUnixServer,
  type WorkbenchUnixServerOptions,
} from "./uds-server";
import { JsonRpcPeer } from "./jsonrpc-peer";
import { RpcErrorCode, type RpcHandlers } from "./jsonrpc";
import type { WorkbenchHttpRuntime } from "./turn-runner";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function startServer(
  options: WorkbenchUnixServerOptions,
): Promise<WorkbenchUnixServer> {
  const dir = await Deno.makeTempDir();
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

describe("serveWorkbenchUnix read methods", () => {
  test("models/list returns the loaded models", async () => {
    const client = await connectClient(await startServer(fakes));
    expect(await client.request("models/list")).toEqual({
      models: [{ slug: "local-x" }],
    });
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
        engineConfig: {
          defaultCompanionModel: "local-x",
          permissionLevel: "operator",
          approvePaidDefault: false,
          defaultSessionBudgetUsd: 2,
          defaultPerCallBudgetUsd: 0.2,
        },
      }),
    );
    expect(await client.request("runtime/status")).toMatchObject({
      runtime: {
        transport: "uds",
        clearance: "loopback",
        defaultCompanionModel: "local-x",
        permissionLevel: "operator",
        approvePaidDefault: false,
        models: { total: 1 },
      },
    });
  });

  test("runtime/status exposes method catalog metadata", async () => {
    const client = await connectClient(await startServer(fakes));
    expect(await client.request("runtime/status")).toMatchObject({
      runtime: {
        methods: [
          "runtime/status",
          "surface/snapshot",
          "models/list",
          "sessions/list",
          "events/query",
          "tools/list",
          "tools/inspect",
          "turn",
        ],
        methodCatalog: [
          { id: "runtime/status", namespace: "runtime", kind: "read" },
          { id: "surface/snapshot", namespace: "surface", kind: "read" },
          { id: "models/list", namespace: "models", kind: "read" },
          { id: "sessions/list", namespace: "sessions", kind: "read" },
          { id: "events/query", namespace: "events", kind: "read" },
          { id: "tools/list", namespace: "tools", kind: "read" },
          { id: "tools/inspect", namespace: "tools", kind: "read" },
          { id: "turn", namespace: "turn", kind: "interactive" },
        ],
      },
    });
  });

  test("tools/list exposes a catalog without executing tools", async () => {
    const client = await connectClient(await startServer(fakes));
    const result = anyVal(
      await client.request("tools/list", { workspace: "/workspace" }),
    );
    expect(result.tools.map((tool: { id: string }) => tool.id)).toEqual([
      "memory.read",
      "read_file",
      "list_files",
      "write_file",
      "edit_file",
      "bash",
    ]);
    expect(result.tools.find((tool: { id: string }) => tool.id === "bash"))
      .toMatchObject({
        permission: { filesystem: "write", network: "external" },
        redactResult: true,
      });
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
      const verdict = await input.confirmPaidEscalation?.();
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
      const verdict = await input.confirmPaidEscalation?.();
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
      const verdict = await input.confirmPaidEscalation?.();
      return anyVal({ verdict });
    };
    const client = await connectClient(
      await startServer({
        ...fakes,
        runRuntime,
        engineConfig: {
          defaultCompanionModel: null,
          permissionLevel: "strict",
          approvePaidDefault: true,
          defaultSessionBudgetUsd: 1,
          defaultPerCallBudgetUsd: 0.1,
        },
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
    const dir = await Deno.makeTempDir();
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
    const dir = await Deno.makeTempDir();
    const path = `${dir}/wb.sock`;
    await Deno.writeTextFile(path, "not a socket");
    await expect(assertSocketBindable(path)).rejects.toThrow(
      /exists and is not a socket/,
    );
    await Deno.remove(dir, { recursive: true });
  });
});
