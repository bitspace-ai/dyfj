/**
 * The executor transport: a bash runner that hands each command to the
 * isolated machine's trusted supervisor instead of spawning it here. The
 * supervisor runs it in the secret-free executor (its own uid, no network,
 * only the workspace writable) and answers with the result. The runtime is
 * opted in by `DYFJ_EXECUTOR_SOCKET`, which the supervisor sets when it starts
 * the runtime; approval is unchanged.
 *
 * The protocol is one request per connection, each message one line of JSON:
 *
 *   → {"v":1,"argv":["bash","-c",command],"cwd":…,"env":{…},"timeoutMs":…}
 *   ← {"v":1,"code":…,"signal":…,"stdout":…,"stderr":…,"timedOut":…,
 *      "termination"?:{…}}  or  {"v":1,"error":"…"}
 *
 * The supervisor enforces the deadline and stops the command's tree. Every
 * failure here (no supervisor, a refusal, a malformed or oversized reply, no
 * reply by the deadline plus a grace) throws, so the bash tool reports it; the
 * command never falls back to running in the runtime.
 */

import { createConnection } from "node:net";
import type { BoundedResult, GroupStop } from "./bounded-process.ts";

/** The bash tool's runner shape (`BashRunner` in `exec.ts`). */
export type ExecutorRunner = (
  command: string,
  cwd: string,
  timeoutMs: number,
  env: Record<string, string>,
) => Promise<BoundedResult>;

export const EXECUTOR_PROTOCOL_VERSION = 1;

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

/** A bash runner that runs each command through the supervisor at `path`. */
export function createExecutorRunner(
  path: string,
  options: ExecutorRunnerOptions = {},
): ExecutorRunner {
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const maxReplyBytes = options.maxReplyBytes ?? DEFAULT_MAX_REPLY_BYTES;
  return (command, cwd, timeoutMs, env) =>
    new Promise<BoundedResult>((resolve, reject) => {
      const socket = createConnection(path);
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      const finish = (outcome: () => BoundedResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        try {
          resolve(outcome());
        } catch (error) {
          reject(error);
        }
      };
      const fail = (error: Error) =>
        finish(() => {
          throw error;
        });
      const timer = setTimeout(
        () =>
          fail(
            new Error(
              `executor did not answer within ${timeoutMs + graceMs} ms`,
            ),
          ),
        timeoutMs + graceMs,
      );

      socket.on("connect", () => {
        socket.write(
          `${
            JSON.stringify({
              v: EXECUTOR_PROTOCOL_VERSION,
              argv: ["bash", "-c", command],
              cwd,
              env,
              timeoutMs,
            })
          }\n`,
        );
      });
      socket.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxReplyBytes) {
          fail(new Error(`executor reply exceeded ${maxReplyBytes} bytes`));
          return;
        }
        chunks.push(chunk);
        const text = Buffer.concat(chunks).toString("utf8");
        const end = text.indexOf("\n");
        if (end !== -1) finish(() => parseReply(text.slice(0, end)));
      });
      socket.on("end", () =>
        fail(new Error("executor reply ended before a complete line"))
      );
      socket.on("error", (error: NodeJS.ErrnoException) =>
        fail(
          new Error(
            settled || chunks.length > 0
              ? `executor reply failed: ${error.code ?? error.message}`
              : `executor unavailable: ${error.code ?? error.message}`,
          ),
        )
      );
    });
}
