import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  type UdsTestSocket,
  udsTestSocket,
} from "../../testing/servers/uds-sockets.ts";
import { JsonRpcPeer } from "./jsonrpc-peer.ts";
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  RpcHandlers,
} from "./jsonrpc.ts";
import {
  assertSocketBindable,
  serveUnixJsonRpc,
  type UnixJsonRpcServer,
} from "./uds-listener.ts";

// The server side of the Unix-socket transport over real sockets: bind
// safety, accept, per-connection peers, and close. Socket paths come from
// the integration lane's exact grants (testing/servers/uds-sockets.ts).

async function removeIfPresent(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch {
    // already gone
  }
}

// A raw client peer on a new connection; close() ends it and waits for its
// read loop.
async function dial(socketPath: string, handlers: RpcHandlers = {}) {
  const conn = await Deno.connect({ transport: "unix", path: socketPath });
  const peer = new JsonRpcPeer(conn, { handlers });
  const loop = peer.run();
  return {
    peer,
    async [Symbol.asyncDispose]() {
      peer.close();
      await loop;
    },
  };
}

async function serve(
  name: UdsTestSocket,
  handlers: RpcHandlers,
  options: Omit<Parameters<typeof serveUnixJsonRpc>[1], "handlers"> = {},
) {
  const socketPath = udsTestSocket(name);
  await removeIfPresent(socketPath);
  const server = await serveUnixJsonRpc(socketPath, { handlers, ...options });
  return {
    server,
    async [Symbol.asyncDispose]() {
      await server.close();
      await removeIfPresent(socketPath);
    },
  };
}

function exists(path: string): boolean {
  try {
    Deno.lstatSync(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

Deno.test("serveUnixJsonRpc serves every connection from one handler map and settles each request", async () => {
  const settled: Array<[JsonRpcRequest, JsonRpcResponse]> = [];
  let markSettled: () => void = () => {};
  await using served = await serve("listener-serve", {
    echo: (params) => ({ echoed: params }),
  }, {
    onRequestSettled: (req, res) => {
      settled.push([req, res]);
      markSettled();
    },
  });
  const server: UnixJsonRpcServer = served.server;
  assertEquals(server.socketPath, udsTestSocket("listener-serve"));
  assert(Deno.lstatSync(server.socketPath).isSocket);

  await using a = await dial(server.socketPath);
  await using b = await dial(server.socketPath);
  let settledOnce = new Promise<void>((resolve) => markSettled = resolve);
  assertEquals(await a.peer.request("echo", { from: "a" }), {
    echoed: { from: "a" },
  });
  await settledOnce;
  settledOnce = new Promise<void>((resolve) => markSettled = resolve);
  assertEquals(await b.peer.request("echo", { from: "b" }), {
    echoed: { from: "b" },
  });
  await settledOnce;
  assertEquals(settled.map(([req]) => req.method), ["echo", "echo"]);
  assertEquals(settled.map(([, res]) => "result" in res), [true, true]);
});

Deno.test("serveUnixJsonRpc close disconnects peers and removes the socket file", async () => {
  const socketPath = udsTestSocket("listener-serve");
  await removeIfPresent(socketPath);
  const server = await serveUnixJsonRpc(socketPath, {
    handlers: { hang: () => new Promise(() => {}) },
  });
  await using client = await dial(socketPath);
  const pending = client.peer.request("hang");
  // Let the request reach the server before closing.
  await new Promise((resolve) => setTimeout(resolve, 20));
  await server.close();
  await assertRejects(() => pending, Error, "connection closed");
  assert(!exists(socketPath));
  await assertRejects(() =>
    Deno.connect({ transport: "unix", path: socketPath })
  );
});

Deno.test("serveUnixJsonRpc close({ disconnectPeers: false }) keeps open connections serving", async () => {
  const socketPath = udsTestSocket("listener-keep-peers");
  await removeIfPresent(socketPath);
  const server = await serveUnixJsonRpc(socketPath, {
    handlers: { ping: () => "pong" },
  });
  await using client = await dial(socketPath);
  assertEquals(await client.peer.request("ping"), "pong");
  await server.close({ disconnectPeers: false });
  // No new connections, but the open one still answers.
  assert(!exists(socketPath));
  assertEquals(await client.peer.request("ping"), "pong");
});

Deno.test("serveUnixJsonRpc routes malformed frames to onParseError", async () => {
  const errors: string[] = [];
  let markReported: () => void = () => {};
  const reported = new Promise<void>((resolve) => markReported = resolve);
  await using served = await serve("listener-serve", {}, {
    onParseError: (detail) => {
      errors.push(detail);
      markReported();
    },
  });
  const conn = await Deno.connect({
    transport: "unix",
    path: served.server.socketPath,
  });
  try {
    await conn.write(new TextEncoder().encode("not json\n"));
    await reported;
  } finally {
    conn.close();
  }
  assertEquals(errors.length, 1);
});

// --- bind safety ---

Deno.test("refuses to bind while a live runtime answers on the socket", async () => {
  await using served = await serve("listener-live", { ping: () => "pong" });
  const socketPath = served.server.socketPath;
  await assertRejects(
    () => serveUnixJsonRpc(socketPath, { handlers: {} }),
    Error,
    "live runtime is already serving",
  );
  // The live server is untouched: its socket file still exists and accepts.
  await using client = await dial(socketPath);
  assertEquals(await client.peer.request("ping"), "pong");
});

Deno.test("clears a genuinely stale socket and binds", async () => {
  const socketPath = udsTestSocket("listener-stale");
  await removeIfPresent(socketPath);
  // Fabricate the unclean-exit shape: a SIGKILL'd listener leaves its socket
  // file behind with nothing accepting. (A cleanly closed Deno listener
  // removes its file, so this needs a hard-killed process.)
  // The lane grants spawning exactly the selected Deno, passed as DENO_BIN.
  const deno = Deno.env.get("DENO_BIN") ?? Deno.execPath();
  const child = new Deno.Command(deno, {
    args: [
      "eval",
      `Deno.listen({ transport: "unix", path: ${
        JSON.stringify(socketPath)
      } }); console.log("listening"); setInterval(() => {}, 1000);`,
    ],
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  try {
    const reader = child.stdout.getReader();
    const { value } = await reader.read();
    assertEquals(new TextDecoder().decode(value).trim(), "listening");
    reader.releaseLock();
  } finally {
    child.kill("SIGKILL");
    await child.status;
    await child.stdout.cancel().catch(() => {});
  }
  assert(Deno.lstatSync(socketPath).isSocket);

  await assertSocketBindable(socketPath);
  assertThrows(() => Deno.lstatSync(socketPath), Deno.errors.NotFound);

  // And the serve path binds over it end to end.
  const server = await serveUnixJsonRpc(socketPath, {
    handlers: { ping: () => "pong" },
  });
  try {
    await using client = await dial(socketPath);
    assertEquals(await client.peer.request("ping"), "pong");
  } finally {
    await server.close();
  }
});

Deno.test("refuses to bind over a non-socket path", async () => {
  const path = udsTestSocket("listener-file");
  await Deno.writeTextFile(path, "not a socket");
  try {
    await assertRejects(
      () => assertSocketBindable(path),
      Error,
      "exists and is not a socket",
    );
    await assertRejects(
      () => serveUnixJsonRpc(path, { handlers: {} }),
      Error,
      "exists and is not a socket",
    );
    assertEquals(await Deno.readTextFile(path), "not a socket");
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("assertSocketBindable is a no-op for an absent path", async () => {
  const path = udsTestSocket("listener-file");
  await removeIfPresent(path);
  await assertSocketBindable(path);
  assert(!exists(path));
});
