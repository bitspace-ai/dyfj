/** How a failed runtime call is reported on the terminal. */

import { summarizeError } from "../../contract/mod.ts";
import { RpcError } from "../../transport/mod.ts";
import type { CliConfig } from "../args.ts";

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
