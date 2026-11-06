/** How a failed runtime call is reported on the terminal. */

import { processEnv } from "../../config/mod.ts";
import { summarizeError } from "../../contract/mod.ts";
import { sanitizeBoundaryText } from "../../kernel/mod.ts";
import { PeerClosedError, RpcError } from "../../transport/mod.ts";
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

/** The most of the runtime log's path that is printed, in UTF-8 bytes. */
const MAX_RUNTIME_LOG_PATH_BYTES = 1_024;

/**
 * The runtime does not know where its autostart log is; the launcher does,
 * and passes it as `DYFJ_RUNTIME_LOG`. Its value is made safe to print
 * (control characters removed, length capped), or undefined when unset.
 */
function runtimeLogPath(runtimeLog: string | undefined): string | undefined {
  if (runtimeLog === undefined) return undefined;
  const path = sanitizeBoundaryText(runtimeLog, MAX_RUNTIME_LOG_PATH_BYTES)
    .trim();
  return path.length > 0 ? path : undefined;
}

/** A failure that sends the operator to the runtime log names that file. */
function withRuntimeLog(line: string, runtimeLog: string | undefined): string {
  return runtimeLog !== undefined && line.includes("runtime log")
    ? `${line} (runtime log: ${runtimeLog})`
    : line;
}

/**
 * True when this process runs inside Anthropic's sandbox-runtime (srt), which
 * sets `SANDBOX_RUNTIME=1` for every command it wraps. The Workbench runs its
 * bash and git tools there, and the launcher does not autostart a runtime
 * from inside it (BIT-817).
 */
export function inToolSandbox(value: string | undefined): boolean {
  return value === "1";
}

/**
 * The error line a sandboxed `dyfj` prints when its connect to the socket is
 * refused, denied or finds no socket: an error with one of
 * `CONNECT_REFUSAL_CODES`, or, without a code, a message that says so. A
 * timeout, an answer from the runtime and any other failure get the message
 * they get outside the sandbox.
 */
export const SANDBOXED_UNREACHABLE =
  "dyfj: the runtime socket is not reachable from inside the tool sandbox, " +
  "and dyfj does not autostart a runtime there; in a Workbench session, " +
  "list the model catalog with the workbench.models tool";

const CONNECT_REFUSAL_CODES: ReadonlySet<unknown> = new Set([
  "ENOENT",
  "ENOTDIR",
  "ECONNREFUSED",
  "EACCES",
  "EPERM",
]);

/**
 * A connect the socket refused or denied, or one that found no socket. The
 * message is read only for an error with no code: a coded error is judged by
 * its code, whatever its message names.
 */
function isConnectRefusal(error: unknown, code: unknown): boolean {
  if (code !== undefined) return CONNECT_REFUSAL_CODES.has(code);
  const message = error instanceof Error ? error.message : "";
  return UNREACHABLE_MESSAGE.test(message) || DENIED_MESSAGE.test(message);
}

/** An uncoded permission or not-a-directory refusal, as srt reports one. */
const DENIED_MESSAGE =
  /permission denied|operation not permitted|not a directory|\bos error (1|13|20)\b/i;

const UNREACHABLE_MESSAGE =
  /no such file|file not found|socket not found|connection refused|econnrefused|enoent|\bos error 2\b|\bos error 61\b/i;

export function socketError(
  error: unknown,
  config: CliConfig,
  runtimeLogValue: string | undefined = processEnv.get("DYFJ_RUNTIME_LOG"),
  sandboxed: boolean = inToolSandbox(processEnv.get("SANDBOX_RUNTIME")),
): string {
  const runtimeLog = runtimeLogPath(runtimeLogValue);
  if (isTimeoutError(error)) {
    return `dyfj: runtime at ${config.socket} is unresponsive (timed out)`;
  }
  if (error instanceof RpcError) {
    return withRuntimeLog(`dyfj: ${error.message}`, runtimeLog);
  }
  const code = typeof error === "object" && error !== null
    ? (error as { code?: unknown }).code
    : undefined;
  // Inside the sandbox, a refused, denied or missing socket is the sandbox's
  // refusal or a runtime nobody started; the advice below does not apply.
  if (sandboxed && isConnectRefusal(error, code)) return SANDBOXED_UNREACHABLE;
  if (
    error instanceof PeerClosedError || code === "EPIPE" ||
    code === "ECONNRESET"
  ) {
    return `dyfj: the runtime at ${config.socket} closed the connection ` +
      "before it answered: it may have stopped or crashed. Run " +
      "`dyfj status`; " +
      (runtimeLog !== undefined
        ? `its output is in ${runtimeLog}`
        : "an autostarted runtime's output is in ~/.dyfj/log/") +
      ", and `dyfj start` shows it in the foreground";
  }
  if (code === "EACCES" || code === "EPERM") {
    return `dyfj: permission denied opening the runtime socket ` +
      `${config.socket}; the socket or its directory may belong to another ` +
      "user or not grant you access. Use your own socket with --socket or " +
      "DYFJ_SOCKET";
  }
  const message = error instanceof Error ? error.message : String(error);
  if (UNREACHABLE_MESSAGE.test(message)) {
    return `dyfj: runtime not reachable at ${config.socket}. ` +
      `Start it with: dyfj start`;
  }
  return `dyfj: ${summarizeError(error)}`;
}
