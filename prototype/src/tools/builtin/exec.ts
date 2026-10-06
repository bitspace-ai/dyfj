/**
 * Workspace command execution for the agent loop.
 *
 * `bash` runs an arbitrary shell command with the working directory pinned to
 * the workspace root. It is the system's most dangerous capability, so the
 * command policy ALWAYS routes it through per-call operator approval: it carries
 * a `run.*` (exec-class) effect, and the no-exec invariant in
 * `evaluateCommandPolicy` keeps exec-class effects out of operator
 * auto-approval. The executor therefore never runs unapproved.
 *
 * This module is the explicit danger boundary until a Rust exec/sandbox
 * enforcement floor replaces the TypeScript process runner; until then,
 * per-call human approval is the floor. The process runner is injectable so
 * tests exercise the output/timeout/truncation logic without spawning
 * a real process.
 *
 * The timeout bounds the call, not just the shell: at the deadline the
 * command's whole process group is stopped (TERM, a short grace, then KILL),
 * output written after the deadline is dropped, and the status line says
 * whether anything could have survived (`bounded-process.ts`). The deadline
 * is 120 s unless the call asks for another with `timeoutSec`, up to a 600 s
 * ceiling; a larger value is refused rather than clamped, so the model learns
 * the limit, and the approval prompt names the effective timeout so the
 * operator approves the duration along with the command.
 */

import { type Env, processEnv } from "../../config/mod.ts";
import type { CommandDefinition } from "../definition.ts";
import {
  type BoundedResult,
  describeTimeout,
  runBounded,
} from "./bounded-process.ts";

export type BashResult = BoundedResult;

export type BashRunner = (
  command: string,
  cwd: string,
  timeoutMs: number,
) => Promise<BashResult>;

const DEFAULT_TIMEOUT_SEC = 120;
const DEFAULT_TIMEOUT_MS = DEFAULT_TIMEOUT_SEC * 1_000;
/**
 * The longest a call may ask for. The whole process group is stopped at the
 * deadline (BIT-571), which is what makes a deadline this long safe to grant.
 */
export const MAX_TIMEOUT_SEC = 600;
const DEFAULT_MAX_BYTES = 64 * 1024;

// bash runs with a deliberately minimal environment. clearEnv drops the parent
// process env — which holds the projected provider keys (ANTHROPIC/OPENAI/GEMINI),
// the Dolt password, and MCP tokens — and only this
// non-secret allowlist is forwarded, so an approved command cannot read or print
// the runtime's secrets through the inherited environment (CWE-532). Reads are
// defensive: a var the runtime is not granted is simply absent (PATH must be
// granted for commands to resolve).
const SAFE_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TZ",
  "TMPDIR",
] as const;

function readEnv(source: Env, key: string): string | undefined {
  try {
    return source.get(key);
  } catch {
    return undefined; // not granted to the runtime — treat as absent
  }
}

export function buildSafeBashEnv(
  source: Env = processEnv,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SAFE_ENV_KEYS) {
    const value = readEnv(source, key);
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * Real runner: `bash -c <command>` with cwd pinned, bounded by the timeout. At
 * the deadline the command's whole process group is stopped and output
 * collection ends (`bounded-process.ts`).
 */
const defaultRunner: BashRunner = (command, cwd, timeoutMs) =>
  runBounded({
    command: "bash",
    args: ["-c", command],
    cwd,
    env: buildSafeBashEnv(),
    timeoutMs,
  });

/**
 * Run a shell command in the workspace and return a single string carrying the
 * exit status and combined stdout/stderr (truncated at a byte cap). Never throws
 * on command failure — a non-zero exit is a normal tool result the model reads
 * and recovers from. Mutating + exec-class; the policy gates it behind approval.
 */
export async function executeBash(
  root: string,
  command: string,
  opts: { timeoutMs?: number; maxBytes?: number; runner?: BashRunner } = {},
): Promise<string> {
  const cmd = command.trim();
  if (cmd === "") return "error: empty command";
  const runner = opts.runner ?? defaultRunner;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  let res: BashResult;
  try {
    res = await runner(cmd, root, timeoutMs);
  } catch (err) {
    return `error: cannot run command: ${(err as Error).message}`;
  }

  let body = res.stdout;
  if (res.stderr) {
    body += (body && !body.endsWith("\n") ? "\n" : "") + res.stderr;
  }
  if (body.length > maxBytes) {
    body = `${
      body.slice(0, maxBytes)
    }\n\n[truncated at ${maxBytes} characters]`;
  }

  const status = res.timedOut
    ? describeTimeout(timeoutMs, res.termination)
    : res.signal
    ? `exit by signal ${res.signal}`
    : `exit ${res.code}`;
  return `${status}\n${body}`.trimEnd();
}

// ── The per-call timeout ─────────────────────────────────────────────────────

/**
 * The deadline for one call from its `timeoutSec` argument: the default when
 * absent, otherwise a whole number of seconds from 1 to the ceiling. Anything
 * else is refused with a reason the model can act on. The schema's bounds
 * refuse the same values before the approval prompt; this is the executor's
 * own check for callers that reach it directly.
 */
export function resolveBashTimeoutMs(
  timeoutSec: unknown,
): { timeoutMs: number } | { error: string } {
  if (timeoutSec === undefined) return { timeoutMs: DEFAULT_TIMEOUT_MS };
  if (typeof timeoutSec !== "number" || !Number.isInteger(timeoutSec)) {
    return { error: "timeoutSec must be a whole number of seconds" };
  }
  if (timeoutSec < 1) return { error: "timeoutSec must be at least 1 s" };
  if (timeoutSec > MAX_TIMEOUT_SEC) {
    return {
      error:
        `timeoutSec must be at most ${MAX_TIMEOUT_SEC} s (the ${MAX_TIMEOUT_SEC} s ceiling); ` +
        "ask for a shorter timeout or split the command",
    };
  }
  return { timeoutMs: timeoutSec * 1_000 };
}

const TITLE = "Run Bash Command";

/** The approval prompt names the effective deadline, e.g. `(timeout 300 s)`. */
function bashApprovalTitle(timeoutSec: unknown): string {
  const resolved = resolveBashTimeoutMs(timeoutSec);
  return "timeoutMs" in resolved
    ? `${TITLE} (timeout ${resolved.timeoutMs / 1_000} s)`
    : TITLE;
}

// ── Command definition ───────────────────────────────────────────────────────

export function defineBash(
  root: string,
  opts: { runner?: BashRunner } = {},
): CommandDefinition<string> {
  return {
    id: "bash",
    title: TITLE,
    description:
      "Run a shell command via `bash -c`. The working directory is the workspace " +
      "root, but the command is NOT sandboxed — it can read and write anywhere on " +
      "the machine and reach the network, exactly as if the operator ran it. " +
      "Returns the exit status and combined stdout/stderr. Always requires " +
      "explicit operator approval before it runs — it is never auto-approved. " +
      `The command and its whole process tree are stopped after ${DEFAULT_TIMEOUT_SEC} s ` +
      `by default; pass timeoutSec, up to the ${MAX_TIMEOUT_SEC} s ceiling, only when ` +
      "a command needs longer (a full test run, for example). A larger value is " +
      "refused, not clamped.",
    inputSchema: {
      type: "object",
      required: ["command"],
      properties: {
        command: {
          type: "string",
          description: "The shell command to run (executed as `bash -c`).",
        },
        timeoutSec: {
          type: "integer",
          minimum: 1,
          maximum: MAX_TIMEOUT_SEC,
          description:
            `Seconds before the command and its process tree are stopped. Default ${DEFAULT_TIMEOUT_SEC}; ` +
            `at most ${MAX_TIMEOUT_SEC} (the ceiling; a larger value is refused).`,
        },
      },
      additionalProperties: false,
    },
    approvalTitle: (call) => bashApprovalTitle(call.arguments.timeoutSec),
    permission: {
      // run.process is an exec-class effect: the no-exec invariant in
      // evaluateCommandPolicy keeps it out of operator auto-approval, so bash
      // ALWAYS routes to "ask". The honest filesystem/network envelope (a shell
      // command can read, write, and reach the network) is recorded for audit,
      // but the run.process effect is what actually gates it.
      effects: [
        "run.process",
        "read.filesystem",
        "write.filesystem",
        "emit.event",
      ],
      defaultDecision: "allow",
      resources: ["process:run"],
      network: "external",
      filesystem: "write",
      cost: "none",
    },
    // bash output can carry secrets the approver can't pre-screen (env dumps,
    // file contents), so keep the raw result out of the durable event log.
    redactResult: true,
    executor: (call) => {
      const timeout = resolveBashTimeoutMs(call.arguments.timeoutSec);
      if ("error" in timeout) return `error: ${timeout.error}`;
      return executeBash(root, String(call.arguments.command), {
        timeoutMs: timeout.timeoutMs,
        runner: opts.runner,
      });
    },
  };
}
