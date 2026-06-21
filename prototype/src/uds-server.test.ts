import { afterEach, describe, expect, test } from "vitest";
import {
  serveWorkbenchUnix,
  type WorkbenchUnixServer,
  type WorkbenchUnixServerOptions,
} from "./uds-server";
import { JsonRpcPeer } from "./jsonrpc-peer";
import { RpcErrorCode } from "./jsonrpc";

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

async function connectClient(server: WorkbenchUnixServer): Promise<JsonRpcPeer> {
  const conn = await Deno.connect({ transport: "unix", path: server.socketPath });
  const client = new JsonRpcPeer(conn);
  void client.run();
  cleanups.push(async () => client.close());
  return client;
}

// deno-lint-ignore no-explicit-any
const fakes: WorkbenchUnixServerOptions = {
  loadModels: async () => [{ slug: "local-x" } as any],
  listSessions: async (o) => [{ project: o.project ?? null, sessions: [] } as any],
  fetchSessionEvents: async (i) => [{ id: "e1", sessionId: i.sessionId } as any],
};

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
      client.request("events/query", { sessionId: "s1", asOf: "not-a-timestamp" }),
    ).rejects.toMatchObject({ code: RpcErrorCode.invalidParams });
  });

  test("an unknown method -> methodNotFound", async () => {
    const client = await connectClient(await startServer(fakes));
    await expect(client.request("turn")).rejects.toMatchObject({
      code: RpcErrorCode.methodNotFound,
    });
  });
});
