import net from "node:net";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { udsTestSocket } from "../../testing/servers/uds-sockets.ts";
import type { ByteConnection, ConnectionListener } from "./connection.ts";
import { nodeSocketHost } from "./node-socket.ts";

// The ByteConnection and SocketHost ports over a real Unix socket, through
// the node:net adapter. A file's cases run one at a time, so every case here
// reuses the one granted "node-socket" path in turn.

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

async function removeIfPresent(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch {
    // already gone
  }
}

// A listening adapter and one accepted/dialed connection pair on it.
async function connectPair() {
  const path = udsTestSocket("node-socket");
  await removeIfPresent(path);
  const listener = await nodeSocketHost.listen(path);
  const accepted = listener.accept();
  const client = await nodeSocketHost.connect(path);
  const server = await accepted;
  assert(server !== null);
  return {
    path,
    listener,
    client,
    server,
    async [Symbol.asyncDispose]() {
      client.close();
      server.close();
      listener.close();
      await removeIfPresent(path);
    },
  };
}

async function readAll(conn: ByteConnection, length: number) {
  const out = new Uint8Array(length);
  let offset = 0;
  while (offset < length) {
    const chunk = await conn.read();
    assert(chunk !== null, "stream ended before the expected length");
    assert(chunk.length > 0, "read() returned an empty chunk");
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

Deno.test("bytes written on one end are read on the other, in order", async () => {
  await using pair = await connectPair();
  await pair.client.write(encode("one"));
  await pair.client.write(encode("two"));
  assertEquals(decode(await readAll(pair.server, 6)), "onetwo");
  await pair.server.write(encode("back"));
  assertEquals(decode(await readAll(pair.client, 4)), "back");
});

Deno.test("read() resolves null at end of stream, never an empty chunk", async () => {
  await using pair = await connectPair();
  await pair.client.write(encode("last"));
  pair.client.close();
  assertEquals(decode(await readAll(pair.server, 4)), "last");
  assertEquals(await pair.server.read(), null);
  assertEquals(await pair.server.read(), null);
});

Deno.test("write() accepts a large frame whole, however the socket splits it", async () => {
  await using pair = await connectPair();
  const big = new Uint8Array(6 * 1024 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = i % 251;
  const sent = pair.client.write(big);
  const received = await readAll(pair.server, big.length);
  await sent;
  assertEquals(received.length, big.length);
  assert(received.every((byte, i) => byte === big[i]), "bytes differ");
});

Deno.test("close() is idempotent, ends the stream and rejects later writes", async () => {
  await using pair = await connectPair();
  pair.client.close();
  pair.client.close();
  const after = await pair.client.read().catch(() => null);
  assertEquals(after, null);
  await assertRejects(() => pair.client.write(encode("x")));
  assertEquals(await pair.server.read(), null);
});

Deno.test("close() drops bytes already buffered, so the next read() is null", async () => {
  await using pair = await connectPair();
  await pair.client.write(encode("buffered"));
  // The socket reads on its own: give the bytes time to reach the queue.
  await new Promise((resolve) => setTimeout(resolve, 50));
  pair.server.close();
  assertEquals(await pair.server.read().catch(() => null), null);
});

Deno.test("a pending read() resolves null when the connection is closed", async () => {
  await using pair = await connectPair();
  const pending = pair.server.read();
  pair.server.close();
  assertEquals(await pending.catch(() => null), null);
});

Deno.test("listener close() closes a connection nobody accepted, and accept() is then null", async () => {
  const path = udsTestSocket("node-socket");
  await removeIfPresent(path);
  const listener = await nodeSocketHost.listen(path);
  try {
    const client = await nodeSocketHost.connect(path);
    // The server side is queued, not accepted: give it time to arrive.
    await new Promise((resolve) => setTimeout(resolve, 50));
    listener.close();
    assertEquals(await listener.accept(), null);
    assertEquals(await client.read().catch(() => null), null);
    client.close();
  } finally {
    listener.close();
    await removeIfPresent(path);
  }
});

Deno.test("peer half-close: after the other side's FIN read() is null and a late reply still arrives", async () => {
  const path = udsTestSocket("node-socket");
  await removeIfPresent(path);
  const listener = await nodeSocketHost.listen(path);
  try {
    // A native client that sends a request and then its FIN, as a client
    // that half-closes does.
    const client = await Deno.connect({ transport: "unix", path });
    await client.write(encode("request"));
    await client.closeWrite();
    const server = await listener.accept();
    assert(server !== null);
    assertEquals(decode(await readAll(server, 7)), "request");
    assertEquals(await server.read(), null);
    await server.write(encode("late reply"));
    const buf = new Uint8Array(32);
    const n = await client.read(buf);
    assert(n !== null);
    assertEquals(decode(buf.subarray(0, n)), "late reply");
    server.close();
    client.close();
  } finally {
    listener.close();
    await removeIfPresent(path);
  }
});

Deno.test("client-side half-close: after the server's FIN read() is null and the client can still write", async () => {
  const path = udsTestSocket("node-socket");
  await removeIfPresent(path);
  // A plain node:net server that writes and then ends its side, as a server
  // that answers and half-closes does, and keeps reading.
  let received!: (text: string) => void;
  const reply = new Promise<string>((resolve) => received = resolve);
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    socket.on("data", (chunk) => received(decode(chunk)));
    socket.end(encode("hello"));
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  const client = await nodeSocketHost.connect(path);
  try {
    assertEquals(decode(await readAll(client, 5)), "hello");
    assertEquals(await client.read(), null);
    await client.write(encode("late reply"));
    assertEquals(await reply, "late reply");
  } finally {
    client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await removeIfPresent(path);
  }
});

Deno.test("accept() resolves null once the listener is closed", async () => {
  const path = udsTestSocket("node-socket");
  await removeIfPresent(path);
  const listener: ConnectionListener = await nodeSocketHost.listen(path);
  const pending = listener.accept();
  listener.close();
  listener.close();
  assertEquals(await pending, null);
  assertEquals(await listener.accept(), null);
  await removeIfPresent(path);
});

Deno.test("connect() to a missing socket rejects with ENOENT", async () => {
  const path = udsTestSocket("node-socket");
  await removeIfPresent(path);
  const error = await assertRejects(() => nodeSocketHost.connect(path));
  assertEquals((error as { code?: string }).code, "ENOENT");
});

Deno.test("connect() with an aborted signal rejects with the signal's reason", async () => {
  const path = udsTestSocket("node-socket");
  await removeIfPresent(path);
  const reason = new Error("stop");
  const error = await assertRejects(() =>
    nodeSocketHost.connect(path, AbortSignal.abort(reason))
  );
  assertEquals(error, reason);
});

Deno.test("connect() aborted while dialing closes the connection that settles later", async () => {
  const path = udsTestSocket("node-socket");
  await removeIfPresent(path);
  const listener = await nodeSocketHost.listen(path);
  try {
    const ac = new AbortController();
    const dialing = nodeSocketHost.connect(path, ac.signal);
    ac.abort(new Error("stop"));
    await assertRejects(() => dialing, Error, "stop");
    const late = await listener.accept();
    assert(late !== null);
    assertEquals(await late.read(), null);
    late.close();
  } finally {
    listener.close();
    await removeIfPresent(path);
  }
});

Deno.test("listen() rejects when the path cannot be bound", async () => {
  const path = udsTestSocket("node-socket");
  await Deno.writeTextFile(path, "not a socket");
  try {
    await assertRejects(() => nodeSocketHost.listen(path));
  } finally {
    await removeIfPresent(path);
  }
});
