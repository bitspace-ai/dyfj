import { assertEquals, assertObjectMatch } from "@std/assert";
import {
  type UdsTestSocket,
  udsTestSocket,
} from "../../testing/servers/uds-sockets.ts";
import { AcpSessionHandleMap } from "../acp-session-map.ts";
import type { WorkbenchRuntimeResult } from "../engine/mod.ts";
import { installRuntimeSigintHandler } from "./sigint.ts";
import { MemoryStore } from "../store/mod.ts";
import { JsonRpcPeer, RpcErrorCode } from "../transport/mod.ts";
import {
  serveWorkbenchUnix,
  type WorkbenchUnixServer,
  type WorkbenchUnixServerOptions,
} from "./main.ts";

// The composition root over a real socket: the socket binding, the ACP
// session map it owns and reaps on close, and the method table it serves.
// Socket paths come from the integration lane's exact grants
// (testing/servers/uds-sockets.ts).

const noRuntime = () => Promise.resolve({} as WorkbenchRuntimeResult);

async function removeIfPresent(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch {
    // already gone
  }
}

async function startServer(
  name: UdsTestSocket,
  options: Partial<WorkbenchUnixServerOptions> = {},
) {
  const socketPath = udsTestSocket(name);
  await removeIfPresent(socketPath);
  const server = await serveWorkbenchUnix(socketPath, {
    store: new MemoryStore(),
    runRuntime: noRuntime,
    ...options,
  });
  return {
    server,
    async [Symbol.asyncDispose]() {
      await server.close();
      await removeIfPresent(socketPath);
    },
  };
}

async function dial(server: WorkbenchUnixServer) {
  const conn = await Deno.connect({
    transport: "unix",
    path: server.socketPath,
  });
  const peer = new JsonRpcPeer(conn, { handlers: {} });
  const loop = peer.run();
  return {
    peer,
    async [Symbol.asyncDispose]() {
      peer.close();
      await loop.catch(() => {});
    },
  };
}

// A warm ACP session whose handle records its close; no process is spawned.
async function warmAcpSessions() {
  const map = new AcpSessionHandleMap({ capacity: 2, idleTtlMs: 60_000 });
  const state = { closed: false };
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
          return !state.closed;
        },
        durableSessionLoad: false,
        prompt: () =>
          Promise.resolve({
            text: "",
            stopReason: "stop" as const,
            capabilities: [],
            elapsedMs: 0,
          }),
        close: () => {
          state.closed = true;
          return Promise.resolve();
        },
      }),
  });
  return { map, state };
}

Deno.test("runtime close shuts down warm ACP sessions", async () => {
  const { map, state } = await warmAcpSessions();
  await using started = await startServer("server-acp-close", {
    acpSessions: map,
  });
  assertEquals(state.closed, false);
  await started.server.close();
  assertEquals(state.closed, true);
  assertEquals(map.size, 0);
});

Deno.test("foreground SIGINT closes the server and reaps warm ACP sessions", async () => {
  const { map, state } = await warmAcpSessions();
  await using started = await startServer("server-sigint", {
    acpSessions: map,
  });
  let handler: () => void | Promise<void> = () => {};
  const exitCodes: number[] = [];
  installRuntimeSigintHandler(
    false,
    () => started.server.close(),
    { add: (next) => handler = next },
    (code) => exitCodes.push(code),
  );
  await handler();
  assertEquals(exitCodes, [0]);
  assertEquals(state.closed, true);
  assertEquals(map.size, 0);
});

Deno.test("runtime/stop reaps warm ACP sessions then returns stopping", async () => {
  const { map, state } = await warmAcpSessions();
  let server: WorkbenchUnixServer | undefined;
  await using started = await startServer("server-stop", {
    acpSessions: map,
    onShutdown: async () => {
      await server!.close({ disconnectPeers: false });
    },
  });
  server = started.server;
  await using client = await dial(server);
  assertEquals(state.closed, false);
  assertEquals(await client.peer.request("runtime/stop"), {
    status: "stopping",
  });
  assertEquals(state.closed, true);
  assertEquals(map.size, 0);
});

Deno.test("an unknown method -> methodNotFound", async () => {
  await using started = await startServer("server-unknown-method");
  await using client = await dial(started.server);
  const error = await client.peer.request("does/not/exist").then(
    () => undefined,
    (reason: unknown) => reason,
  );
  assertObjectMatch(error as Record<string, unknown>, {
    code: RpcErrorCode.methodNotFound,
  });
});
