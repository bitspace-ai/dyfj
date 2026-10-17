import assert from "node:assert/strict";
import { unlink } from "node:fs/promises";
import process from "node:process";
import { test } from "node:test";
import {
  type UdsTestSocket,
  udsTestSocket,
} from "../../testing/servers/uds-sockets.ts";
import { AcpSessionHandleMap } from "../acp-session-map.ts";
import type { WorkbenchRuntimeResult } from "../engine/mod.ts";
import { installRuntimeSigintHandler } from "./sigint.ts";
import { MemoryStore } from "../store/mod.ts";
import {
  JsonRpcPeer,
  nodeSocketHost,
  RpcError,
  RpcErrorCode,
} from "../transport/mod.ts";
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
    await unlink(path);
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
  const conn = await nodeSocketHost.connect(server.socketPath);
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
    workspace: process.cwd(),
    profile: {
      slug: "fixture",
      command: process.execPath,
      args: ["eval", "1"],
      environment: {},
      workspace: process.cwd(),
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

test("runtime close shuts down warm ACP sessions", async () => {
  const { map, state } = await warmAcpSessions();
  await using started = await startServer("server-acp-close", {
    acpSessions: map,
  });
  assert.deepStrictEqual(state.closed, false);
  await started.server.close();
  assert.deepStrictEqual(state.closed, true);
  assert.deepStrictEqual(map.size, 0);
});

test("foreground SIGINT closes the server and reaps warm ACP sessions", async () => {
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
  assert.deepStrictEqual(exitCodes, [0]);
  assert.deepStrictEqual(state.closed, true);
  assert.deepStrictEqual(map.size, 0);
});

test("runtime/stop reaps warm ACP sessions then returns stopping", async () => {
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
  assert.deepStrictEqual(state.closed, false);
  assert.deepStrictEqual(await client.peer.request("runtime/stop"), {
    status: "stopping",
  });
  assert.deepStrictEqual(state.closed, true);
  assert.deepStrictEqual(map.size, 0);
});

test("an unknown method -> methodNotFound", async () => {
  await using started = await startServer("server-unknown-method");
  await using client = await dial(started.server);
  const error = await client.peer.request("does/not/exist").then(
    () => undefined,
    (reason: unknown) => reason,
  );
  assert.ok(error instanceof RpcError);
  assert.strictEqual(error.code, RpcErrorCode.methodNotFound);
});

// A warm ACP session backed by a real child process, so a test can assert
// that a shutdown leaves no orphan behind.
async function warmAcpChild() {
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const map = new AcpSessionHandleMap({ capacity: 2, idleTtlMs: 60_000 });
  await map.acquire({
    sessionId: "s1",
    workspace: process.cwd(),
    profile: {
      slug: "fixture",
      command: process.execPath,
      args: ["eval", "1"],
      environment: {},
      workspace: process.cwd(),
      transport: "local_stdio",
      accessRoute: "local_sidecar",
      costBasis: "local_free",
    },
    create: () =>
      Promise.resolve({
        get isAlive() {
          return child.exitCode === null && child.signalCode === null;
        },
        durableSessionLoad: false,
        prompt: () =>
          Promise.resolve({
            text: "",
            stopReason: "stop" as const,
            capabilities: [],
            elapsedMs: 0,
          }),
        close: async () => {
          child.kill("SIGTERM");
          await exited;
        },
      }),
  });
  return { map, child, exited };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("an autostarted runtime closes through its shutdown path after its last client leaves, reaping ACP children", async () => {
  const { map, child, exited } = await warmAcpChild();
  let server: WorkbenchUnixServer | undefined;
  const idle: number[] = [];
  let resolveIdleClosed!: () => void;
  const idleClosed = new Promise<void>((resolve) => resolveIdleClosed = resolve);
  await using started = await startServer("server-idle-stop", {
    acpSessions: map,
    autostarted: true,
    idleGraceMs: 300,
    onIdle: async () => {
      idle.push(Date.now());
      await server!.close();
      resolveIdleClosed();
    },
  });
  server = started.server;
  {
    await using client = await dial(server);
    const status = await client.peer.request("runtime/status") as {
      runtime: { clients: number };
    };
    assert.strictEqual(status.runtime.clients, 1);
    await delay(600);
    assert.deepStrictEqual(idle, [], "a connected client holds the runtime up");
  }
  await idleClosed;
  await exited;
  assert.strictEqual(idle.length, 1);
  assert.strictEqual(isAlive(child.pid!), false);
  assert.strictEqual(map.size, 0);
});

test("a client connecting inside the grace keeps an autostarted runtime up", async () => {
  const idle: number[] = [];
  await using started = await startServer("server-idle-cancel", {
    autostarted: true,
    idleGraceMs: 400,
    onIdle: () => {
      idle.push(Date.now());
    },
  });
  {
    await using _first = await dial(started.server);
  }
  await delay(200);
  {
    await using second = await dial(started.server);
    await delay(600);
    assert.deepStrictEqual(idle, []);
    assert.deepStrictEqual(
      await second.peer.request("runtime/liveness"),
      { status: "ok", transport: "uds", clearance: "loopback" },
    );
  }
});

test("a runtime started with dyfj start stays up with no clients", async () => {
  const idle: number[] = [];
  await using started = await startServer("server-manual-stays", {
    autostarted: false,
    idleGraceMs: 100,
    onIdle: () => {
      idle.push(Date.now());
    },
  });
  {
    await using _client = await dial(started.server);
  }
  await delay(400);
  assert.deepStrictEqual(idle, []);
  await using client = await dial(started.server);
  assert.strictEqual(
    (await client.peer.request("runtime/liveness") as { status: string }).status,
    "ok",
  );
});

test("a conditional stop is refused when a second client connects after the probe", async () => {
  let stopped = false;
  const stopCompletions: number[] = [];
  let server: WorkbenchUnixServer | undefined;
  await using started = await startServer("server-sole-client-race", {
    autostarted: true,
    onShutdown: async () => {
      stopped = true;
      await server!.close({ disconnectPeers: false });
    },
    // The runtime process exits here after a stop; a declined stop must
    // not reach it.
    onStopComplete: (code) => {
      stopCompletions.push(code);
    },
  });
  server = started.server;
  await using prober = await dial(server);
  const probe = await prober.peer.request("runtime/status") as {
    runtime: { clients: number };
  };
  assert.strictEqual(probe.runtime.clients, 1, "the probe saw itself alone");
  // Another client arrives between the probe and the stop.
  await using other = await dial(server);
  assert.strictEqual(
    (await other.peer.request("runtime/liveness") as { status: string }).status,
    "ok",
  );
  const result = await prober.peer.request("runtime/stop", {
    ifSoleClient: true,
  }) as { status: string };
  assert.strictEqual(result.status, "declined");
  assert.strictEqual(stopped, false);
  assert.strictEqual(
    (await other.peer.request("runtime/liveness") as { status: string }).status,
    "ok",
  );
  assert.deepStrictEqual(stopCompletions, [], "a declined stop does not exit");
});

test("a conditional stop closes admission before it awaits cleanup", async () => {
  // ACP cleanup the test holds open, so it can try to connect in the window
  // between the stop's decision and the end of cleanup.
  let releaseCleanup!: () => void;
  const cleanupHeld = new Promise<void>((resolve) => releaseCleanup = resolve);
  let markCleanupStarted!: () => void;
  const cleanupStarted = new Promise<void>((resolve) => markCleanupStarted = resolve);
  const map = new AcpSessionHandleMap({ capacity: 2, idleTtlMs: 60_000 });
  await map.acquire({
    sessionId: "s1",
    workspace: process.cwd(),
    profile: {
      slug: "fixture",
      command: process.execPath,
      args: ["eval", "1"],
      environment: {},
      workspace: process.cwd(),
      transport: "local_stdio",
      accessRoute: "local_sidecar",
      costBasis: "local_free",
    },
    create: () =>
      Promise.resolve({
        isAlive: true,
        durableSessionLoad: false,
        prompt: () =>
          Promise.resolve({
            text: "",
            stopReason: "stop" as const,
            capabilities: [],
            elapsedMs: 0,
          }),
        close: async () => {
          markCleanupStarted();
          await cleanupHeld;
        },
      }),
  });
  let server: WorkbenchUnixServer | undefined;
  await using started = await startServer("server-stop-closes-admission", {
    acpSessions: map,
    autostarted: true,
    onShutdown: async () => {
      await server!.close({ disconnectPeers: false });
    },
  });
  server = started.server;
  await using prober = await dial(server);
  const stopping = prober.peer.request("runtime/stop", { ifSoleClient: true })
    .then((result) => result, (error: unknown) => error);
  await cleanupStarted;
  // The stop has been decided and cleanup is under way: no new client is
  // admitted.
  let late: Awaited<ReturnType<typeof nodeSocketHost.connect>> | undefined;
  try {
    late = await nodeSocketHost.connect(server.socketPath).catch(() => undefined);
    assert.strictEqual(late, undefined, "a client connected during cleanup");
  } finally {
    late?.close();
    releaseCleanup();
  }
  assert.deepStrictEqual(await stopping, { status: "stopping" });
});

test("an autostarted runtime that cannot bind fails its boot and leaves nothing running", async () => {
  // The boot's failure path: a second runtime on a live socket. Its lifetime
  // must not arm a stop timer (the file's handle check fails on a leaked
  // one), and the runtime already serving is untouched.
  const { map, state } = await warmAcpSessions();
  const idle: number[] = [];
  await using live = await startServer("server-boot-bind-fail");
  await assert.rejects(
    () =>
      serveWorkbenchUnix(live.server.socketPath, {
        store: new MemoryStore(),
        runRuntime: noRuntime,
        acpSessions: map,
        autostarted: true,
        idleGraceMs: 50,
        onIdle: () => {
          idle.push(Date.now());
        },
      }),
    /live runtime is already serving/,
  );
  await delay(150);
  assert.deepStrictEqual(idle, []);
  await using client = await dial(live.server);
  assert.strictEqual(
    (await client.peer.request("runtime/liveness") as { status: string }).status,
    "ok",
  );
  await map.shutdown();
  assert.strictEqual(state.closed, true);
});
