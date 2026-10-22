/**
 * Workspace command execution for the agent loop.
 *
 * `bash` runs an arbitrary shell command in the workspace root, or in the
 * workspace directory its `cwd` argument names. It is the system's most
 * dangerous capability, so the command policy routes it through per-call
 * operator approval: it carries a `run.*` (exec-class) effect, and the no-exec
 * invariant in `evaluateCommandPolicy` keeps exec-class effects out of
 * operator auto-approval. Two declared exceptions skip the prompt (BIT-707):
 * a call the read-only allowlist accepts (`bash-allowlist.ts`, operator
 * posture on loopback only), which then runs with git's program-running
 * config switched off (`GIT_SAFETY_ENV`); and a call that repeats exactly one
 * the operator allowed for the rest of the session.
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

import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { type Env, processEnv } from "../../config/mod.ts";
import type { CommandCall, CommandDefinition } from "../definition.ts";
import {
  classifyReadOnlyBash,
  resolveFollowingLinks,
} from "./bash-allowlist.ts";
import { isWithinRoot } from "./file-access.ts";
import {
  type BoundedResult,
  describeTimeout,
  runBounded,
} from "./bounded-process.ts";
import {
  createExecutorRunner,
  type ExecutorDialer,
} from "./executor-transport.ts";

export type BashResult = BoundedResult;

export type BashRunner = (
  command: string,
  cwd: string,
  timeoutMs: number,
  env: Record<string, string>,
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

/**
 * The isolated machine's executor socket, when its launcher set one. With it,
 * the bash and git tools run their commands in the executor and never here.
 */
export function executorSocket(source: Env = processEnv): string | undefined {
  const socket = readEnv(source, "DYFJ_EXECUTOR_SOCKET");
  return socket === undefined || socket === "" ? undefined : socket;
}

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

/** The authorisation basis of a call the read-only allowlist approved. */
export const BASH_ALLOWLIST_BASIS = "policy:allow:bash-allowlist";

/**
 * The environment added to a call the read-only allowlist approved (BIT-707).
 * Repository config and attributes can make `git status`, `diff`, `log` and
 * `show` run programs, and such a call ran without a prompt, so git's
 * program-running sources are switched off for it:
 * - `core.fsmonitor=false`: no fsmonitor hook on status or diff;
 * - `GIT_ATTR_SOURCE` set to the empty tree, and `core.attributesFile` to
 *   /dev/null: worktree and global attributes assign no diff or filter
 *   driver, so no textconv or clean filter runs;
 * - `safe.bareRepository=explicit`: a bare repository planted in a workspace
 *   subdirectory is not picked up by discovery;
 * - `log.showSignature=false`: no gpg on log;
 * - `core.pager=cat` and `GIT_PAGER=cat`: no pager, though none runs without
 *   a terminal anyway;
 * - `GIT_CONFIG_NOSYSTEM=1`: no system-wide config.
 * What remains is `$GIT_DIR` itself (`.git/config`, `.git/info/attributes`),
 * which the write tools refuse to touch, and the operator's own global config.
 * In particular a configured `diff.external` still runs on `git diff`: an
 * empty override makes git fail rather than skip it, and the model cannot
 * plant one, so it comes only from the operator's config or a command the
 * operator approved.
 */
export const GIT_SAFETY_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_ATTR_SOURCE: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  GIT_PAGER: "cat",
  GIT_CONFIG_COUNT: "5",
  GIT_CONFIG_KEY_0: "core.fsmonitor",
  GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_KEY_1: "core.attributesFile",
  GIT_CONFIG_VALUE_1: "/dev/null",
  GIT_CONFIG_KEY_2: "safe.bareRepository",
  GIT_CONFIG_VALUE_2: "explicit",
  GIT_CONFIG_KEY_3: "log.showSignature",
  GIT_CONFIG_VALUE_3: "false",
  GIT_CONFIG_KEY_4: "core.pager",
  GIT_CONFIG_VALUE_4: "cat",
};

/**
 * Every environment name a bash call can carry: the safe base, the git safety
 * switches, and the working-directory pair. None holds a secret, which is why
 * the isolated executor may receive them (`linux-launch-plan.ts`).
 */
export const BASH_COMMAND_ENV_KEYS: readonly string[] = Object.freeze([
  ...SAFE_ENV_KEYS,
  ...Object.keys(GIT_SAFETY_ENV),
  "PWD",
  "OLDPWD",
]);

/**
 * Real runner: `bash -c <command>` with cwd pinned, bounded by the timeout. At
 * the deadline the command's whole process group is stopped and output
 * collection ends (`bounded-process.ts`).
 */
const defaultRunner: BashRunner = (command, cwd, timeoutMs, env) =>
  runBounded({
    command: "bash",
    args: ["-c", command],
    cwd,
    env,
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
  opts: {
    timeoutMs?: number;
    maxBytes?: number;
    runner?: BashRunner;
    env?: Record<string, string>;
  } = {},
): Promise<string> {
  const cmd = command.trim();
  if (cmd === "") return "error: empty command";
  const runner = opts.runner ?? defaultRunner;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  let res: BashResult;
  try {
    res = await runner(cmd, root, timeoutMs, opts.env ?? buildSafeBashEnv());
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

// ── The working directory ────────────────────────────────────────────────────

/**
 * The directory one call runs in, from its `cwd` argument: the workspace root
 * when absent, otherwise an existing directory, relative to the root, that
 * resolves inside it with symlinks followed segment by segment. Anything else is refused, and
 * the command does not run.
 */
export function resolveBashCwd(
  root: string,
  cwd: unknown,
): { cwd: string } | { error: string } {
  if (cwd === undefined) return { cwd: root };
  if (typeof cwd !== "string" || cwd === "") {
    return { error: "cwd must be a non-empty path" };
  }
  // Relative only, as the file tools' paths are: an absolute one would put the
  // operator's username and layout into the call's durable arguments.
  if (isAbsolute(cwd)) {
    return { error: "cwd must be relative to the workspace root" };
  }
  try {
    const rootReal = realpathSync(root);
    const real = resolveFollowingLinks(rootReal, cwd);
    if (real === null || !isWithinRoot(rootReal, real)) {
      return { error: "cwd must be inside the workspace" };
    }
    if (!statSync(real).isDirectory()) {
      return { error: "cwd must be a directory" };
    }
    return { cwd: real };
  } catch {
    return { error: "cwd must be an existing directory inside the workspace" };
  }
}

/** Whether a bash call may skip the prompt; see `bash-allowlist.ts`. */
function readOnlyBashCall(root: string, call: CommandCall): boolean {
  const cwd = resolveBashCwd(root, call.arguments.cwd);
  if ("error" in cwd) return false;
  try {
    return classifyReadOnlyBash(
      String(call.arguments.command),
      cwd.cwd,
      realpathSync(root),
    ).allow;
  } catch {
    return false;
  }
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

/** What the command can reach, as the model is told it. */
function bashReach(contained: boolean): string {
  return contained
    ? ". The command runs in the isolated executor: its writes persist only " +
      "in the workspace (it also has private scratch space that is discarded " +
      "after the command), it has no network, and it cannot see the runtime's " +
      "credentials. "
    : ", but the command is NOT sandboxed — it can read and write anywhere on " +
      "the machine and reach the network, exactly as if the operator ran it. ";
}

/** A runner for a socket set with no dialer to reach it: always refuses. */
export const undialable: (...args: unknown[]) => Promise<never> = () =>
  Promise.reject(
    new Error("executor unavailable: no executor connection is configured"),
  );

export function defineBash(
  root: string,
  opts: { runner?: BashRunner; env?: Env; dialExecutor?: ExecutorDialer } =
    {},
): CommandDefinition<string> {
  // The supervisor of an isolated machine sets the socket when it starts the
  // runtime. With it, commands run in the executor and never here: without a
  // dialer to reach it, every command is refused rather than run locally.
  const socket = executorSocket(opts.env);
  const contained = opts.runner === undefined && socket !== undefined;
  const runner = !contained
    ? opts.runner
    : opts.dialExecutor === undefined
    ? undialable
    : createExecutorRunner(socket!, opts.dialExecutor);
  return {
    id: "bash",
    title: TITLE,
    description:
      "Run a shell command via `bash -c`. The working directory is the workspace " +
      "root, or the workspace directory cwd names" +
      bashReach(contained) +
      "Returns the exit status and combined stdout/stderr. Requires operator " +
      "approval before it runs, except for a small set of read-only commands " +
      "(git status/diff/log/show, ls, cat, head, tail, wc, grep, rg, sed -n) " +
      "and commands the operator allowed for the rest of the session. " +
      `The command and its whole process tree are stopped after ${DEFAULT_TIMEOUT_SEC} s ` +
      `by default; pass timeoutSec, up to the ${MAX_TIMEOUT_SEC} s ceiling, only when ` +
      "a command needs longer (a full test run, for example). A larger value is " +
      "refused, not clamped. Pass cwd rather than prefixing the command with cd.",
    inputSchema: {
      type: "object",
      required: ["command"],
      properties: {
        command: {
          type: "string",
          description: "The shell command to run (executed as `bash -c`).",
        },
        cwd: {
          type: "string",
          description:
            "Directory to run in, relative to the workspace root. It must be an " +
            "existing directory inside the workspace. Default: the workspace root.",
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
    readOnlyCall: (call) => readOnlyBashCall(root, call),
    // The prompt may offer "allow this exact command for the rest of the
    // session"; the grant matches command, cwd and timeoutSec exactly.
    grantable: true,
    permission: {
      // run.process is an exec-class effect: the no-exec invariant in
      // evaluateCommandPolicy keeps it out of operator auto-approval, so bash
      // routes to "ask" unless `readOnlyCall` accepts it. The honest
      // filesystem/network envelope (a shell command can read, write, and
      // reach the network) is recorded for audit, but the run.process effect
      // is what actually gates it.
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
    executor: (call, context) => {
      const timeout = resolveBashTimeoutMs(call.arguments.timeoutSec);
      if ("error" in timeout) return `error: ${timeout.error}`;
      const cwd = resolveBashCwd(root, call.arguments.cwd);
      if ("error" in cwd) return `error: ${cwd.error}`;
      // bash starts in the physical directory the allowlist checked: PWD and
      // OLDPWD name it, so a logical `cd ..` or `cd -` cannot start from a
      // symlinked path, and CDPATH is never passed (buildSafeBashEnv does not
      // forward it), so `cd foo` cannot land elsewhere.
      const base = {
        ...buildSafeBashEnv(opts.env),
        PWD: cwd.cwd,
        OLDPWD: cwd.cwd,
      };
      const env = context.authzBasis === BASH_ALLOWLIST_BASIS
        ? { ...base, ...GIT_SAFETY_ENV }
        : base;
      return executeBash(cwd.cwd, String(call.arguments.command), {
        timeoutMs: timeout.timeoutMs,
        runner,
        env,
      });
    },
  };
}
