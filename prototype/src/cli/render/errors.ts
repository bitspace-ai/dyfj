/** How a failed runtime call is reported on the terminal. */

import { summarizeError } from "../../contract/mod.ts";
import { RpcError } from "../../transport/mod.ts";
import type { CliConfig } from "../args.ts";

// A server-side error message can embed the full offending payload (e.g. a
// rejected event-log INSERT quoting the oversized value back in the driver
// error), and dispatchRequest (jsonrpc.ts) forwards err.message verbatim to
// the client. The server console already logs class-only for exactly this
// reason (the native runner's [turn-error] line, and every joint that forwards a
// turn error toward a client — see summarizeError in contract/turn.ts, the
// shared discipline this client and the server both apply); the client had no
// equivalent discipline, so an unbounded server message printed pages of raw
// payload to the operator's terminal. summarizeError caps what any client
// error printer renders: a sane excerpt plus the error class and full byte
// count, never a multi-KB dump.

export function isTimeoutError(error: unknown): boolean {
  if (error instanceof Error) {
    if (error.name === "TimeoutError") {
      return true;
    }
    if (
      error.name === "AbortError" &&
      error.cause instanceof Error &&
      error.cause.name === "TimeoutError"
    ) {
      return true;
    }
  }
  return false;
}

export function socketError(error: unknown, config: CliConfig): string {
  if (isTimeoutError(error)) {
    return `dyfj: runtime at ${config.socket} is unresponsive (timed out)`;
  }
  if (error instanceof RpcError) {
    return `dyfj: ${error.message}`;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (
    /no such file|file not found|socket not found|connection refused|econnrefused|enoent|\bos error 2\b|\bos error 61\b/i
      .test(message)
  ) {
    return `dyfj: runtime not reachable at ${config.socket}. ` +
      `Start it with: dyfj start`;
  }
  return `dyfj: ${summarizeError(error)}`;
}
