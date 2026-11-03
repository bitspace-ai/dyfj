// Why a Unix socket could not be bound or reached, as messages the operator
// can act on. The node:net adapter raises these in place of the platform's
// own errors, which reach the operator only as `[Error, N bytes]` (a client)
// or as an uncaught stack trace in a log nobody reads (the runtime).
//
// Each message is built from the socket path, which the operator supplied
// (--socket, DYFJ_SOCKET, or the HOME/XDG_RUNTIME_DIR it derives from), and
// fixed text; the platform's message is never relayed.

import { Buffer } from "node:buffer";
import { statSync } from "node:fs";
import process from "node:process";
import { DomainError } from "../contract/mod.ts";

/** `sun_path` sizes, in bytes, including the terminating NUL. */
const SUN_PATH_BYTES: Readonly<Record<string, number>> = {
  darwin: 104,
  freebsd: 104,
  openbsd: 104,
  linux: 108,
};

/** The longest socket path, in bytes, a Unix socket may bind or connect to. */
export function maxSocketPathBytes(
  platform: string = process.platform,
): number {
  return (SUN_PATH_BYTES[platform] ?? 104) - 1;
}

const FIX =
  "Choose a shorter socket path with --socket or DYFJ_SOCKET (for " +
  "example under /tmp), or shorten the HOME or XDG_RUNTIME_DIR it is " +
  "derived from";

/** The socket path does not fit the platform's `sun_path`. */
export class SocketPathTooLongError extends DomainError {
  constructor(path: string, bytes: number, limit: number) {
    super(
      `The socket path ${path} is ${bytes} bytes; this system allows at ` +
        `most ${limit}. ${FIX}`,
    );
    this.name = "SocketPathTooLongError";
  }
}

/** Throw `SocketPathTooLongError` when `path` does not fit. */
export function assertSocketPathFits(path: string): void {
  const bytes = Buffer.byteLength(path, "utf8");
  const limit = maxSocketPathBytes();
  if (bytes > limit) throw new SocketPathTooLongError(path, bytes, limit);
}

/** Bind failures by code, as the operator would say them. */
const LISTEN_CAUSES: Readonly<Record<string, string>> = {
  EACCES: "permission denied",
  EPERM: "the operation is not permitted",
  EADDRINUSE: "the address is already in use",
  EINVAL: "the platform rejected the path",
  ENAMETOOLONG: "the path is too long",
  EROFS: "the file system is read-only",
  ENOTDIR: "a component of the path is not a directory",
};

/** The runtime could not bind its socket. */
export class RuntimeListenError extends DomainError {
  constructor(path: string, cause: string) {
    super(
      `The runtime could not listen on ${path}: ${cause}. Fix the socket's ` +
        "directory, or choose another socket path with --socket or " +
        "DYFJ_SOCKET",
    );
    this.name = "RuntimeListenError";
  }
}

/** An error code safe to name in a message: an `E`-prefixed literal. */
const ERROR_CODE = /^E[A-Z0-9_]{1,31}$/;

/** The code `stat` of `path`'s parent directory fails with, if it fails. */
function parentStatCode(path: string): string | undefined {
  const slash = path.lastIndexOf("/");
  if (slash <= 0) return undefined;
  try {
    statSync(path.slice(0, slash));
    return undefined;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : "unknown";
  }
}

/**
 * The bind failure `error` reports for `path`. The parent directory is
 * checked directly, because macOS reports a missing one as EACCES: it is
 * called missing only when `stat` says ENOENT, and an ENOTDIR from `stat`
 * names that instead. Any other cause is read from the bind error's code,
 * never its message; a code without a fixed description is still named.
 */
export function listenFailure(path: string, error: unknown): DomainError {
  if (error instanceof DomainError) return error;
  const parent = parentStatCode(path);
  if (parent === "ENOENT") {
    return new RuntimeListenError(path, "its directory does not exist");
  }
  const raw = parent === "ENOTDIR"
    ? parent
    : typeof error === "object" && error !== null
    ? (error as { code?: unknown }).code
    : undefined;
  const code = typeof raw === "string" && ERROR_CODE.test(raw)
    ? raw
    : undefined;
  const cause = code === undefined
    ? "an unrecognized error"
    : Object.hasOwn(LISTEN_CAUSES, code)
    ? `${LISTEN_CAUSES[code]} (${code})`
    : `an error without a known fix (${code})`;
  return new RuntimeListenError(path, cause);
}
