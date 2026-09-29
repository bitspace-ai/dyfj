import { afterEach, describe, expect, test } from "vitest";
import { MemoryStore } from "./store/mod.ts";
import {
  serveWorkbenchUnix,
  type WorkbenchUnixServer,
  type WorkbenchUnixServerOptions,
} from "./uds-server.ts";
import {
  JsonRpcPeer,
  RpcErrorCode,
  type RpcHandlers,
} from "./transport/mod.ts";
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

describe("serveWorkbenchUnix", () => {
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

  test("an unknown method -> methodNotFound", async () => {
    const client = await connectClient(await startServer(fakes));
    await expect(client.request("does/not/exist")).rejects.toMatchObject({
      code: RpcErrorCode.methodNotFound,
    });
  });
});

// The serve-unix Deno permission-profile parity test moved to config.test.ts,
// where it became structural: the deno.json env allowlist is asserted against the
// declared CONFIG_SCHEMA surface (forward + reverse) rather than band-aided pair
// by pair.
