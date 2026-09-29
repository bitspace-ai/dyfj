/** `dyfj stop`: ask the runtime to stop and wait until its socket closes. */

import { connectUnixClient, type UnixClient } from "../../transport/mod.ts";
import type { CliConfig } from "../args.ts";
import type { ConnectFn, Io } from "../io.ts";
import { socketError } from "../render/errors.ts";
import { LIVENESS_PROBE_TIMEOUT_MS } from "./status.ts";

export async function runStop(
  config: CliConfig,
  io: Io,
  connect: ConnectFn = connectUnixClient,
  signal: AbortSignal = AbortSignal.timeout(LIVENESS_PROBE_TIMEOUT_MS),
): Promise<number> {
  try {
    let client: UnixClient;
    try {
      client = await connect(config.socket, undefined, signal);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (
        /no such file|file not found|socket not found|connection refused|econnrefused|enoent|\bos error 2\b|\bos error 61\b/i
          .test(message)
      ) {
        io.out(`dyfj: runtime is not running at ${config.socket}\n`);
        return 0;
      }
      throw err;
    }
    try {
      await client.request("runtime/stop", undefined, signal);
    } finally {
      client.close();
    }

    // Poll with bounded connection attempts until the socket is verified closed or missing
    let closed = false;
    const stopDeadline = Date.now() + 3000;
    while (Date.now() < stopDeadline) {
      try {
        const pollSignal = AbortSignal.timeout(200);
        const checkClient = await connect(config.socket, undefined, pollSignal);
        checkClient.close();
        await new Promise((r) => setTimeout(r, 50));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (
          /no such file|file not found|socket not found|connection refused|econnrefused|enoent|\bos error 2\b|\bos error 61\b/i
            .test(message)
        ) {
          closed = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    if (!closed) {
      io.err(`dyfj: runtime at ${config.socket} did not stop within deadline`);
      return 1;
    }

    io.out(`dyfj: runtime at ${config.socket} stopped\n`);
    return 0;
  } catch (error) {
    io.err(socketError(error, config));
    return 1;
  }
}
