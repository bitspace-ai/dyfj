/**
 * The executor transport: runners that hand each command (the bash tool's
 * shell, the git tool's git) to the isolated machine's trusted supervisor
 * instead of spawning it here. The
 * supervisor runs it in the secret-free executor (its own uid, no network,
 * writes persisting only in the workspace) and answers with the result. The runtime is
 * opted in by `DYFJ_EXECUTOR_SOCKET`, which the supervisor sets when it starts
 * the runtime; approval is unchanged.
 *
 * The protocol is one request per connection, each message one line of JSON:
 *
 *   → {"v":2,"op":"exec","argv":[…],"cwd":…,"env":{…},"timeoutMs":…,
 *      "binding"?:…,"stdin"?:…}
 *   ← {"v":2,"code":…,"signal":…,"stdout":…,"stderr":…,"timedOut":…,
 *      "termination"?:{…}}  or  {"v":2,"error":"…"}
 *
 *   → {"v":2,"op":"attest","nonce":…}
 *   ← {"v":2,"nonce":…,"instance":…,"executorPolicy":…,"grant":…,…}
 *      (`containment.ts` reads it)
 *
 * A request carries `binding`, the supervisor instance the runtime attested,
 * when the call was allowed by the attested envelope; the supervisor refuses
 * a binding that names another instance (BIT-736). Version 1 is refused.
 *
 * The supervisor enforces the deadline and stops the command's tree. Every
 * failure here (no supervisor, a refusal, a malformed or oversized reply, no
 * reply by the deadline plus a grace) throws, so the bash tool reports it; the
 * command never falls back to running in the runtime. The socket connection
 * comes from the composition root, through the transport's socket port.
 */

import type { BoundedResult, GroupStop } from "./bounded-process.ts";

/**
 * Runs one process in the executor: argv, start directory, deadline, env,
 * the attested instance the call is bound to, if any, and text for its
 * standard input, if any (which keeps that text out of argv, BIT-796).
 */
export type ExecutorProcessRunner = (
  argv: readonly string[],
  cwd: string,
  timeoutMs: number,
  env: Record<string, string>,
  binding?: string,
  stdin?: string,
) => Promise<BoundedResult>;

/** The bash tool's runner shape (`BashRunner` in `exec.ts`). */
export type ExecutorRunner = (
  command: string,
  cwd: string,
  timeoutMs: number,
  env: Record<string, string>,
  binding?: string,
) => Promise<BoundedResult>;

/**
 * One end of a connection to the supervisor: the transport's `ByteConnection`
 * port, which the composition root supplies (`nodeSocketHost.connect`).
 */
export interface ExecutorConnection {
  read(): Promise<Uint8Array | null>;
  write(bytes: Uint8Array): Promise<void>;
  close(): void;
}

/** Dials the supervisor's socket. */
export type ExecutorDialer = (
  path: string,
  signal?: AbortSignal,
) => Promise<ExecutorConnection>;

export const EXECUTOR_PROTOCOL_VERSION = 2;

export interface ExecutorRunnerOptions {
  /** How long past the command's deadline to wait for the supervisor. */
  graceMs?: number;
  /** The largest reply accepted, in bytes. */
  maxReplyBytes?: number;
}

// The supervisor's own stop (grace, kill, drain) finishes well inside this.
const DEFAULT_GRACE_MS = 10_000;
// Above the bash tool's output cap with room for JSON escaping.
const DEFAULT_MAX_REPLY_BYTES = 16 * 1024 * 1024;

const GROUP_STOPS: readonly GroupStop[] = ["stopped", "survived", "unavailable"];

function malformed(): Error {
  return new Error("executor reply is malformed");
}

/** The result a reply carries; throws on a refusal or a malformed reply. */
function parseReply(line: string): BoundedResult {
  let reply: any;
  try {
    reply = JSON.parse(line);
  } catch {
    throw new Error("executor reply is not JSON");
  }
  if (
    reply === null || typeof reply !== "object" ||
    reply.v !== EXECUTOR_PROTOCOL_VERSION
  ) {
    throw new Error("executor reply has an unknown version");
  }
  if (typeof reply.error === "string") {
    throw new Error(`executor refused the command: ${reply.error}`);
  }
  const { code, signal, stdout, stderr, timedOut, termination } = reply;
  if (
    !(code === null || Number.isInteger(code)) ||
    !(signal === null || typeof signal === "string") ||
    typeof stdout !== "string" || typeof stderr !== "string" ||
    typeof timedOut !== "boolean"
  ) {
    throw malformed();
  }
  const result: BoundedResult = { code, signal, stdout, stderr, timedOut };
  if (termination !== undefined) {
    if (
      termination === null || typeof termination !== "object" ||
      !GROUP_STOPS.includes(termination.group) ||
      typeof termination.exited !== "boolean" ||
      typeof termination.outputClosed !== "boolean"
    ) {
      throw malformed();
    }
    result.termination = {
      group: termination.group,
      exited: termination.exited,
      outputClosed: termination.outputClosed,
    };
  }
  return result;
}

/** Reads one reply line from `connection`, within `maxBytes`. */
async function readReply(
  connection: ExecutorConnection,
  maxBytes: number,
): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    let chunk: Uint8Array | null;
    try {
      chunk = await connection.read();
    } catch (error) {
      throw new Error(`executor reply failed: ${(error as Error).message}`);
    }
    if (chunk === null) {
      throw new Error("executor reply ended before a complete line");
    }
    size += chunk.length;
    if (size > maxBytes) {
      throw new Error(`executor reply exceeded ${maxBytes} bytes`);
    }
    chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf8");
    const end = text.indexOf("\n");
    if (end !== -1) return text.slice(0, end);
  }
}

/**
 * A bash runner that runs each command through the supervisor at `path`,
 * dialed with `dial`.
 */
export function createExecutorRunner(
  path: string,
  dial: ExecutorDialer,
  options: ExecutorRunnerOptions = {},
): ExecutorRunner {
  const run = createExecutorProcessRunner(path, dial, options);
  return (command, cwd, timeoutMs, env, binding) =>
    run(["bash", "-c", command], cwd, timeoutMs, env, binding);
}

/**
 * A runner that starts each argv in the executor, through the supervisor at
 * `path`, dialed with `dial`.
 */
export function createExecutorProcessRunner(
  path: string,
  dial: ExecutorDialer,
  options: ExecutorRunnerOptions = {},
): ExecutorProcessRunner {
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const maxReplyBytes = options.maxReplyBytes ?? DEFAULT_MAX_REPLY_BYTES;
  return (argv, cwd, timeoutMs, env, binding, stdin) =>
    exchange(
      path,
      dial,
      {
        op: "exec",
        argv: [...argv],
        cwd,
        env,
        timeoutMs,
        ...(binding === undefined ? {} : { binding }),
        ...(stdin === undefined ? {} : { stdin }),
      },
      timeoutMs + graceMs,
      maxReplyBytes,
      parseReply,
    );
}

/**
 * Sends `attest` with `nonce` to the supervisor at `path` and returns its
 * raw reply object; `containment.ts` checks it. Throws on any transport
 * failure or refusal, as an exec request does.
 */
export function requestAttestation(
  path: string,
  dial: ExecutorDialer,
  nonce: string,
  options: ExecutorRunnerOptions = {},
): Promise<Record<string, unknown>> {
  return exchange(
    path,
    dial,
    { op: "attest", nonce },
    options.graceMs ?? DEFAULT_GRACE_MS,
    options.maxReplyBytes ?? DEFAULT_MAX_REPLY_BYTES,
    parseAttestation,
  );
}

function parseAttestation(line: string): Record<string, unknown> {
  let reply: any;
  try {
    reply = JSON.parse(line);
  } catch {
    throw new Error("executor reply is not JSON");
  }
  if (
    reply === null || typeof reply !== "object" || Array.isArray(reply) ||
    reply.v !== EXECUTOR_PROTOCOL_VERSION
  ) {
    throw new Error("executor reply has an unknown version");
  }
  if (typeof reply.error === "string") {
    throw new Error(`executor refused the command: ${reply.error}`);
  }
  return reply;
}

/** One request and its reply on a fresh connection, within `deadline` ms. */
async function exchange<T>(
  path: string,
  dial: ExecutorDialer,
  body: Record<string, unknown>,
  deadline: number,
  maxReplyBytes: number,
  parse: (line: string) => T,
): Promise<T> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let connection: ExecutorConnection | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      connection?.close();
      reject(new Error(`executor did not answer within ${deadline} ms`));
    }, deadline);
  });
  const send = async (): Promise<T> => {
    try {
      connection = await dial(path, abort.signal);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw new Error(
        `executor unavailable: ${code ?? (error as Error).message}`,
      );
    }
    const request = JSON.stringify({ v: EXECUTOR_PROTOCOL_VERSION, ...body });
    await connection.write(new TextEncoder().encode(`${request}\n`));
    return parse(await readReply(connection, maxReplyBytes));
  };
  try {
    return await Promise.race([send(), expired]);
  } finally {
    clearTimeout(timer);
    connection?.close();
  }
}
