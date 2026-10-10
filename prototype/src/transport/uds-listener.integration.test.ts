import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  type UdsTestSocket,
  udsTestSocket,
} from "../../testing/servers/uds-sockets.ts";
import { fabricateStaleUdsSocket } from "../../testing/servers/listeners.ts";
import { JsonRpcPeer } from "./jsonrpc-peer.ts";
import { nodeSocketHost } from "./node-socket.ts";
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

// A raw client peer on a new connection; `closed` settles when its read loop
// ends, and disposal closes it and waits for that.
async function dial(socketPath: string, handlers: RpcHandlers = {}) {
  const conn = await nodeSocketHost.connect(socketPath);
  const peer = new JsonRpcPeer(conn, { handlers });
  const loop = peer.run();
  return {
    peer,
    closed: loop,
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
  // The client's read loop rejects `pending` the moment it sees the server
  // hang up, which can land before server.close() resolves. Attach the
  // expectation first, or that rejection is briefly unhandled and Deno fails
  // the file with an uncaught error.
  const rejected = assertRejects(() => pending, Error, "connection closed");
  // Let the request reach the server before closing.
  await new Promise((resolve) => setTimeout(resolve, 20));
  await server.close();
  // The client observes the disconnect. Waiting for its read loop to end, then
  // yielding a macrotask, holds open on every run the window the race only
  // sometimes opened: a rejection with no handler yet at a task boundary.
  await client.closed;
  await new Promise((resolve) => setTimeout(resolve, 0));
  await rejected;
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

Deno.test({
  name:
    "serveUnixJsonRpc closes its side of a connection when the client disconnects",
  // The lane runs both sanitizers; this case also names them, so a server-side
  // connection left open after the client goes fails it wherever it runs.
  sanitizeOps: true,
  sanitizeResources: true,
  async fn() {
    await using served = await serve("listener-client-eof", {
      ping: () => "pong",
    });
    const conn = await Deno.connect({
      transport: "unix",
      path: served.server.socketPath,
    });
    try {
      // Half-close: the server's read loop sees end-of-file, while this side
      // can still read. The server must answer with end-of-file of its own.
      await conn.closeWrite();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const read = await Promise.race([
        conn.read(new Uint8Array(16)),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), 2_000);
        }),
      ]);
      clearTimeout(timer);
      assertEquals(read, null);
    } finally {
      conn.close();
    }
  },
});

Deno.test({
  name:
    "serveUnixJsonRpc answers a request sent just before the client half-closes",
  sanitizeOps: true,
  sanitizeResources: true,
  async fn() {
    await using served = await serve("listener-half-close", {
      late: async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return "answered";
      },
    });
    const conn = await Deno.connect({
      transport: "unix",
      path: served.server.socketPath,
    });
    try {
      // write() may send fewer bytes than asked; send the whole frame before
      // half-closing.
      const request = new TextEncoder().encode(
        '{"jsonrpc":"2.0","id":1,"method":"late"}\n',
      );
      for (let offset = 0; offset < request.length;) {
        offset += await conn.write(request.subarray(offset));
      }
      await conn.closeWrite();
      // Read to end-of-file: the response arrives first, then the server
      // closes its side.
      const decoder = new TextDecoder();
      const buf = new Uint8Array(4096);
      let text = "";
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), 2_000);
      });
      try {
        for (;;) {
          const n = await Promise.race([conn.read(buf), timedOut]);
          if (n === "timeout") throw new Error("server never closed its side");
          if (n === null) break;
          text += decoder.decode(buf.subarray(0, n), { stream: true });
        }
      } finally {
        clearTimeout(timer);
      }
      assertEquals(JSON.parse(text.trim()), {
        jsonrpc: "2.0",
        id: 1,
        result: "answered",
      });
    } finally {
      conn.close();
    }
  },
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
  // Fabricate the unclean-exit shape: a SIGKILL'd listener leaves its socket
  // file behind with nothing accepting.
  await fabricateStaleUdsSocket(socketPath);
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
