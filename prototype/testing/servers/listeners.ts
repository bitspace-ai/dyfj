/**
 * Raw socket peers for integration tests that exercise a client's handling of
 * a misbehaving or missing far side, below any protocol.
 *
 * - `startMuteListener` accepts connections and never reads or writes, so a
 *   client's deadline is what ends the exchange.
 * - `connectUdsPair` returns both ends of one Unix-socket connection, for
 *   tests that drive a protocol over a real kernel socket.
 * - `fabricateStaleUdsSocket` leaves a socket file with nothing accepting, the
 *   shape an unclean exit leaves behind. A cleanly closed listener removes its
 *   file, so this needs a hard-killed process: it spawns the `deno` the lane
 *   grants (`DENO_BIN`) and SIGKILLs it once it is listening.
 */

import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import {
  type AddressInfo,
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import { denoBin, inheritedEnv } from "../deno-bin.ts";

export type MuteListenerAddr =
  | { transport: "tcp"; hostname: string; port: number }
  | { transport: "unix"; path: string };

/** A connection the mute listener accepted, read from by the test. */
export interface MuteConnection {
  /**
   * Reads up to `buffer.length` bytes into `buffer` and resolves with the
   * count, or with `null` once the peer has closed its side and nothing is
   * left to read (end of file).
   */
  read(buffer: Uint8Array): Promise<number | null>;
}

export interface MuteListener {
  addr: MuteListenerAddr;
  /** Resolves with the first accepted connection. */
  firstAccepted: Promise<MuteConnection>;
  /** Closes the listener and every accepted connection; removes a Unix path. */
  close(): Promise<void>;
}

/** Settles once `socket` has fully closed; at once if it already has. */
function socketClosed(socket: Socket): Promise<void> {
  return new Promise((resolve) => {
    if (socket.closed) resolve();
    else socket.once("close", () => resolve());
  });
}

function listening(server: Server, listen: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", () => {
      server.off("error", reject);
      resolve();
    });
    listen();
  });
}

function muteConnection(socket: Socket): MuteConnection {
  // Whatever arrives is queued for `read`, and the end of the peer's side is
  // recorded as soon as it happens, so a read after it still sees it.
  const queued: Uint8Array[] = [];
  let ended = false;
  let wake: () => void = () => {};
  socket.on("data", (chunk: Uint8Array) => {
    queued.push(chunk);
    wake();
  });
  const end = () => {
    ended = true;
    wake();
  };
  socket.once("end", end);
  socket.once("close", end);
  return {
    async read(buffer) {
      while (queued.length === 0 && !ended) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      const chunk = queued.shift();
      if (chunk === undefined) return null;
      const n = Math.min(chunk.length, buffer.length);
      buffer.set(chunk.subarray(0, n));
      if (n < chunk.length) queued.unshift(chunk.subarray(n));
      return n;
    },
  };
}

export async function startMuteListener(
  options:
    | { transport?: "tcp"; hostname: string; port: number }
    | { transport: "unix"; path: string },
): Promise<MuteListener> {
  const sockets: Socket[] = [];
  let first: (conn: MuteConnection) => void = () => {};
  const firstAccepted = new Promise<MuteConnection>((resolve) => {
    first = resolve;
  });
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.push(socket);
    // A peer that resets the connection is not a listener failure.
    socket.on("error", () => {});
    first(muteConnection(socket));
  });
  await listening(
    server,
    () =>
      options.transport === "unix"
        ? server.listen(options.path)
        : server.listen(options.port, options.hostname),
  );
  const address = server.address();
  const addr: MuteListenerAddr = options.transport === "unix"
    ? { transport: "unix", path: options.path }
    : {
      transport: "tcp",
      hostname: (address as AddressInfo).address,
      port: (address as AddressInfo).port,
    };
  return {
    addr,
    firstAccepted,
    async close() {
      const closed = new Promise<void>((resolve) =>
        server.close(() => resolve())
      );
      for (const socket of sockets) socket.destroy();
      await Promise.all(sockets.map(socketClosed));
      await closed;
      if (options.transport === "unix") await removeIfPresent(options.path);
    },
  };
}

export interface UdsPair {
  server: Socket;
  client: Socket;
}

/** Both ends of one connection over a Unix socket at `path`. */
export async function connectUdsPair(path: string): Promise<UdsPair> {
  await removeIfPresent(path);
  let accept: (socket: Socket) => void = () => {};
  const accepted = new Promise<Socket>((resolve) => {
    accept = resolve;
  });
  const listener = createServer((socket) => accept(socket));
  await listening(listener, () => listener.listen(path));
  try {
    const client = await new Promise<Socket>((resolve, reject) => {
      const pending = createConnection({ path });
      pending.once("error", reject);
      pending.once("connect", () => {
        pending.off("error", reject);
        resolve(pending);
      });
    });
    return { server: await accepted, client };
  } finally {
    // Stops accepting at once; its callback would wait for the pair to close.
    listener.close();
  }
}

/** Leave a socket file at `path` that nothing accepts on. */
export async function fabricateStaleUdsSocket(path: string): Promise<void> {
  await removeIfPresent(path);
  const child = spawn(
    denoBin(),
    [
      "eval",
      `import { createServer } from "node:net"; createServer().listen(${
        JSON.stringify(path)
      }, () => console.log("listening")); setInterval(() => {}, 1000);`,
    ],
    { env: inheritedEnv(), stdio: ["ignore", "pipe", "inherit"] },
  );
  const closed = new Promise<void>((resolve) => {
    child.once("error", () => resolve());
    child.once("close", () => resolve());
  });
  try {
    // A pipe may split the line across reads: collect until the newline.
    const decoder = new TextDecoder();
    let out = "";
    for await (const chunk of child.stdout as AsyncIterable<Uint8Array>) {
      out += decoder.decode(chunk, { stream: true });
      if (out.includes("\n")) break;
    }
    if (out.trim() !== "listening") {
      throw new Error(`stale-socket child did not listen: ${out}`);
    }
  } finally {
    child.kill("SIGKILL");
    child.stdout.destroy();
    await closed;
  }
}

async function removeIfPresent(path: string): Promise<void> {
  // `force` ignores a missing path; any other failure still throws.
  await rm(path, { force: true });
}
