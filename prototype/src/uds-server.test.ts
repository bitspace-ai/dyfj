import { afterEach, describe, expect, test } from "vitest";
import {
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
  const server = serveWorkbenchUnix(`${dir}/wb.sock`, options);
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
});
