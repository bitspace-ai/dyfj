// The accept loop over a fake socket host, where the test decides when each
// accept settles: the ordering between an accept and `stopAccepting()` that a
// real socket cannot pin down.
import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ByteConnection,
  ConnectionListener,
  SocketHost,
} from "./connection.ts";
import { serveUnixJsonRpc } from "./uds-listener.ts";

function fakeConnection(): ByteConnection & { closed: boolean } {
  let end!: (value: null) => void;
  const ended = new Promise<null>((resolve) => end = resolve);
  const conn = {
    closed: false,
    read: () => ended,
    write: () => Promise.resolve(),
    close: () => {
      conn.closed = true;
      end(null);
    },
  };
  return conn;
}

/** A listener whose accepts settle only when the test hands one over. */
function fakeHost() {
  const waiting: Array<(conn: ByteConnection | null) => void> = [];
  const listener: ConnectionListener = {
    accept: () => new Promise((resolve) => waiting.push(resolve)),
    close: () => {
      for (const resolve of waiting.splice(0)) resolve(null);
    },
  };
  const host: SocketHost = {
    connect: () => Promise.reject(new Error("not used")),
    listen: () => Promise.resolve(listener),
  };
  return {
    host,
    /** Settles the pending accept with `conn`, synchronously. */
    deliver(conn: ByteConnection) {
      const resolve = waiting.shift();
      assert.ok(resolve, "the accept loop is waiting");
      resolve(conn);
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a connection whose accept settled just before stopAccepting is closed, not admitted", async () => {
  const fake = fakeHost();
  const counts: number[] = [];
  const server = await serveUnixJsonRpc("/nonexistent/dyfj-fake.sock", {
    handlers: {},
    host: fake.host,
    onConnectionsChanged: (count) => counts.push(count),
  });
  await flush();
  const late = fakeConnection();
  // The accept completes, and the stop comes before the accept loop's
  // continuation has run.
  fake.deliver(late);
  server.stopAccepting();
  await flush();
  assert.strictEqual(late.closed, true);
  assert.deepStrictEqual(counts, [], "no connection was admitted");
  await server.close();
});

test("a connection accepted before stopAccepting is admitted and stays open until close", async () => {
  const fake = fakeHost();
  const counts: number[] = [];
  const server = await serveUnixJsonRpc("/nonexistent/dyfj-fake.sock", {
    handlers: {},
    host: fake.host,
    onConnectionsChanged: (count) => counts.push(count),
  });
  await flush();
  const early = fakeConnection();
  fake.deliver(early);
  await flush();
  server.stopAccepting();
  await flush();
  assert.strictEqual(early.closed, false);
  assert.deepStrictEqual(counts, [1]);
  await server.close();
  assert.strictEqual(early.closed, true);
});
