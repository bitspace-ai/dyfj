import assert from "node:assert/strict";
import { lstatSync } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import { test } from "node:test";
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
    await unlink(path);
  } catch {
    // already gone
  }
}

// A raw node:net client on the socket, outside the adapters under test.
// allowHalfOpen keeps this side readable after end() sends its FIN; `closed`
// settles once the socket's handle is released.
function rawConnect(
  path: string,
): Promise<{ socket: net.Socket; closed: Promise<void> }> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path, allowHalfOpen: true });
    const closed = new Promise<void>((done) =>
      socket.once("close", () => done())
    );
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.off("error", reject);
      resolve({ socket, closed });
    });
  });
}

// Everything the peer sends until it closes its side, or undefined when it
// has not closed within `ms`.
function readToEnd(
  socket: net.Socket,
  ms: number,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const decoder = new TextDecoder();
    let text = "";
    const onData = (chunk: Uint8Array) => {
      text += decoder.decode(chunk, { stream: true });
    };
    const finish = (result: string | undefined) => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("end", onEnd);
      resolve(result);
    };
    const onEnd = () => finish(text + decoder.decode());
    const timer = setTimeout(() => finish(undefined), ms);
    socket.on("data", onData);
    socket.once("end", onEnd);
  });
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
    lstatSync(path);
    return true;
  } catch (err) {
    if (
      (err instanceof Error && (err as { code?: unknown }).code === "ENOENT")
    ) return false;
    throw err;
  }
}

test("serveUnixJsonRpc serves every connection from one handler map and settles each request", async () => {
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
  assert.deepStrictEqual(server.socketPath, udsTestSocket("listener-serve"));
  assert.ok(lstatSync(server.socketPath).isSocket());

  await using a = await dial(server.socketPath);
  await using b = await dial(server.socketPath);
  let settledOnce = new Promise<void>((resolve) => markSettled = resolve);
  assert.deepStrictEqual(await a.peer.request("echo", { from: "a" }), {
    echoed: { from: "a" },
  });
  await settledOnce;
  settledOnce = new Promise<void>((resolve) => markSettled = resolve);
  assert.deepStrictEqual(await b.peer.request("echo", { from: "b" }), {
    echoed: { from: "b" },
  });
  await settledOnce;
  assert.deepStrictEqual(settled.map(([req]) => req.method), ["echo", "echo"]);
  assert.deepStrictEqual(settled.map(([, res]) => "result" in res), [
    true,
    true,
  ]);
});

test("serveUnixJsonRpc close disconnects peers and removes the socket file", async () => {
  const socketPath = udsTestSocket("listener-serve");
  await removeIfPresent(socketPath);
  const server = await serveUnixJsonRpc(socketPath, {
    handlers: { hang: () => new Promise(() => {}) },
  });
  await using client = await dial(socketPath);
  const pending = client.peer.request("hang");
  // The client's read loop rejects `pending` the moment it sees the server
  // hang up, which can land before server.close() resolves. Attach the
  // expectation first, or that rejection is briefly unhandled and the test
  // runner fails the file with an uncaught error.
  const rejected = assert.rejects(
    () => pending,
    (error: unknown) =>
      error instanceof Error && error.message.includes("connection closed"),
  );
  // Let the request reach the server before closing.
  await new Promise((resolve) => setTimeout(resolve, 20));
  await server.close();
  // The client observes the disconnect. Waiting for its read loop to end, then
  // yielding a macrotask, holds open on every run the window the race only
  // sometimes opened: a rejection with no handler yet at a task boundary.
  await client.closed;
  await new Promise((resolve) => setTimeout(resolve, 0));
  await rejected;
  assert.ok(!exists(socketPath));
  await assert.rejects(() => rawConnect(socketPath));
});

test("serveUnixJsonRpc close({ disconnectPeers: false }) keeps open connections serving", async () => {
  const socketPath = udsTestSocket("listener-keep-peers");
  await removeIfPresent(socketPath);
  const server = await serveUnixJsonRpc(socketPath, {
    handlers: { ping: () => "pong" },
  });
  await using client = await dial(socketPath);
  assert.deepStrictEqual(await client.peer.request("ping"), "pong");
  await server.close({ disconnectPeers: false });
  // No new connections, but the open one still answers.
  assert.ok(!exists(socketPath));
  assert.deepStrictEqual(await client.peer.request("ping"), "pong");
});

test(
  "serveUnixJsonRpc closes its side of a connection when the client disconnects",
  async () => {
    await using served = await serve("listener-client-eof", {
      ping: () => "pong",
    });
    const conn = await rawConnect(served.server.socketPath);
    try {
      // Half-close: the server's read loop sees end-of-file, while this side
      // can still read. The server must answer with end-of-file of its own,
      // and send nothing before it.
      conn.socket.end();
      assert.strictEqual(await readToEnd(conn.socket, 2_000), "");
    } finally {
      conn.socket.destroy();
      await conn.closed;
    }
  },
);

test(
  "serveUnixJsonRpc answers a request sent just before the client half-closes",
  async () => {
    await using served = await serve("listener-half-close", {
      late: async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return "answered";
      },
    });
    const conn = await rawConnect(served.server.socketPath);
    try {
      // end() sends the whole frame, then the FIN.
      conn.socket.end('{"jsonrpc":"2.0","id":1,"method":"late"}\n');
      // Read to end-of-file: the response arrives first, then the server
      // closes its side.
      const text = await readToEnd(conn.socket, 2_000);
      if (text === undefined) throw new Error("server never closed its side");
      assert.deepStrictEqual(JSON.parse(text.trim()), {
        jsonrpc: "2.0",
        id: 1,
        result: "answered",
      });
    } finally {
      conn.socket.destroy();
      await conn.closed;
    }
  },
);

test("serveUnixJsonRpc routes malformed frames to onParseError", async () => {
  const errors: string[] = [];
  let markReported: () => void = () => {};
  const reported = new Promise<void>((resolve) => markReported = resolve);
  await using served = await serve("listener-serve", {}, {
    onParseError: (detail) => {
      errors.push(detail);
      markReported();
    },
  });
  const conn = await rawConnect(served.server.socketPath);
  try {
    conn.socket.write("not json\n");
    await reported;
  } finally {
    conn.socket.destroy();
    await conn.closed;
  }
  assert.deepStrictEqual(errors.length, 1);
});

// --- bind safety ---

test("refuses to bind while a live runtime answers on the socket", async () => {
  await using served = await serve("listener-live", { ping: () => "pong" });
  const socketPath = served.server.socketPath;
  await assert.rejects(
    () => serveUnixJsonRpc(socketPath, { handlers: {} }),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("live runtime is already serving"),
  );
  // The live server is untouched: its socket file still exists and accepts.
  await using client = await dial(socketPath);
  assert.deepStrictEqual(await client.peer.request("ping"), "pong");
});

test("clears a genuinely stale socket and binds", async () => {
  const socketPath = udsTestSocket("listener-stale");
  // Fabricate the unclean-exit shape: a SIGKILL'd listener leaves its socket
  // file behind with nothing accepting.
  await fabricateStaleUdsSocket(socketPath);
  assert.ok(lstatSync(socketPath).isSocket());

  await assertSocketBindable(socketPath);
  assert.throws(
    () => lstatSync(socketPath),
    (error: unknown) =>
      error instanceof Error && (error as { code?: unknown }).code === "ENOENT",
  );

  // And the serve path binds over it end to end.
  const server = await serveUnixJsonRpc(socketPath, {
    handlers: { ping: () => "pong" },
  });
  try {
    await using client = await dial(socketPath);
    assert.deepStrictEqual(await client.peer.request("ping"), "pong");
  } finally {
    await server.close();
  }
});

test("refuses to bind over a non-socket path", async () => {
  const path = udsTestSocket("listener-file");
  await writeFile(path, "not a socket");
  try {
    await assert.rejects(
      () => assertSocketBindable(path),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("exists and is not a socket"),
    );
    await assert.rejects(
      () => serveUnixJsonRpc(path, { handlers: {} }),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("exists and is not a socket"),
    );
    assert.deepStrictEqual(await readFile(path, "utf8"), "not a socket");
  } finally {
    await unlink(path);
  }
});

test("assertSocketBindable is a no-op for an absent path", async () => {
  const path = udsTestSocket("listener-file");
  await removeIfPresent(path);
  await assertSocketBindable(path);
  assert.ok(!exists(path));
});

test("serveUnixJsonRpc reports the open-connection count as clients come and go", async () => {
  const socketPath = udsTestSocket("listener-count");
  await removeIfPresent(socketPath);
  const counts: number[] = [];
  let changed: () => void = () => {};
  const server = await serveUnixJsonRpc(socketPath, {
    handlers: { ping: () => "pong" },
    onConnectionsChanged: (count) => {
      counts.push(count);
      changed();
    },
  });
  const next = () => new Promise<void>((resolve) => changed = resolve);
  try {
    let seen = next();
    const first = await dial(socketPath);
    await seen;
    seen = next();
    const second = await dial(socketPath);
    await seen;
    assert.strictEqual(await second.peer.request("ping"), "pong");
    seen = next();
    await first[Symbol.asyncDispose]();
    await seen;
    seen = next();
    await second[Symbol.asyncDispose]();
    await seen;
    assert.deepStrictEqual(counts, [1, 2, 1, 0]);
  } finally {
    await server.close();
  }
  // Closing the server with no connection open reports nothing more.
  assert.deepStrictEqual(counts, [1, 2, 1, 0]);
});
