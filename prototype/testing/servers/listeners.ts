/**
 * Raw socket peers for integration tests that exercise a client's handling of
 * a misbehaving or missing far side, below any protocol.
 *
 * - `startMuteListener` accepts connections and never reads or writes, so a
 *   client's deadline is what ends the exchange.
 * - `connectUdsPair` returns both ends of one Unix-socket connection, for
 *   tests that drive a protocol over a real kernel socket.
 * - `fabricateStaleUdsSocket` leaves a socket file with nothing accepting, the
 *   shape an unclean exit leaves behind. A cleanly closed Deno listener removes
 *   its file, so this needs a hard-killed process: it spawns the Deno the lane
 *   grants (`DENO_BIN`) and SIGKILLs it once it is listening.
 */

export interface MuteListener {
  addr: Deno.Addr;
  /** Resolves with the first accepted connection. */
  firstAccepted: Promise<Deno.Conn>;
  /** Closes the listener and every accepted connection; removes a Unix path. */
  close(): Promise<void>;
}

export function startMuteListener(
  options:
    | (Deno.TcpListenOptions & { transport?: "tcp" })
    | (Deno.UnixListenOptions & { transport: "unix" }),
): MuteListener {
  const listener: Deno.Listener = options.transport === "unix"
    ? Deno.listen(options)
    : Deno.listen(options);
  const connections: Deno.Conn[] = [];
  let first: (conn: Deno.Conn) => void = () => {};
  const firstAccepted = new Promise<Deno.Conn>((resolve) => {
    first = resolve;
  });
  const accepting = (async () => {
    try {
      for await (const conn of listener) {
        connections.push(conn);
        first(conn);
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.BadResource)) throw error;
    }
  })();
  return {
    addr: listener.addr,
    firstAccepted,
    async close() {
      try {
        listener.close();
      } catch {
        // already closed
      }
      for (const conn of connections) {
        try {
          conn.close();
        } catch {
          // closed by the peer
        }
      }
      await accepting;
      if (options.transport === "unix") await removeIfPresent(options.path);
    },
  };
}

export interface UdsPair {
  server: Deno.UnixConn;
  client: Deno.UnixConn;
}

/** Both ends of one connection over a Unix socket at `path`. */
export async function connectUdsPair(path: string): Promise<UdsPair> {
  await removeIfPresent(path);
  const listener = Deno.listen({ transport: "unix", path });
  try {
    const accepting = listener.accept();
    const client = await Deno.connect({ transport: "unix", path });
    return { server: await accepting, client };
  } finally {
    listener.close();
  }
}

/** Leave a socket file at `path` that nothing accepts on. */
export async function fabricateStaleUdsSocket(path: string): Promise<void> {
  await removeIfPresent(path);
  const deno = Deno.env.get("DENO_BIN") ?? Deno.execPath();
  const child = new Deno.Command(deno, {
    args: [
      "eval",
      `Deno.listen({ transport: "unix", path: ${
        JSON.stringify(path)
      } }); console.log("listening"); setInterval(() => {}, 1000);`,
    ],
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  try {
    // A pipe may split the line across reads: collect until the newline.
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let out = "";
    while (!out.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
    reader.releaseLock();
    if (out.trim() !== "listening") {
      throw new Error(`stale-socket child did not listen: ${out}`);
    }
  } finally {
    child.kill("SIGKILL");
    await child.status;
    await child.stdout.cancel().catch(() => {});
  }
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}
