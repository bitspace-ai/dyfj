/** `dyfj stop`: ask the runtime to stop and wait until its socket closes. */

import { connectUnixClient, type UnixClient } from "../../transport/mod.ts";
import type { CliConfig } from "../args.ts";
import type { ConnectFn, Io } from "../io.ts";
import { socketError } from "../render/errors.ts";
import { LIVENESS_PROBE_TIMEOUT_MS } from "./status.ts";

const NOT_LISTENING =
  /no such file|file not found|socket not found|connection refused|econnrefused|enoent|\bos error 2\b|\bos error 61\b/i;

/** Whether a connect failure means nothing is listening on the socket. */
export function isNotListening(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return NOT_LISTENING.test(message);
}

/**
 * Polls with bounded connection attempts until nothing listens on `socket`,
 * or the deadline passes. True once the socket is closed or missing.
 */
export async function waitForSocketClosed(
  socket: string,
  connect: ConnectFn,
  deadlineMs = 3000,
): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const pollSignal = AbortSignal.timeout(200);
      const checkClient = await connect(socket, undefined, pollSignal);
      checkClient.close();
      await new Promise((r) => setTimeout(r, 50));
    } catch (err) {
      if (isNotListening(err)) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  return false;
}

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
      if (isNotListening(err)) {
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

    if (!(await waitForSocketClosed(config.socket, connect))) {
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
