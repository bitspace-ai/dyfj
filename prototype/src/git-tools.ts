/**
 * Bounded git operations for the agent loop, started in the workspace root.
 *
 * `bash` can already run git. What this tool narrows is what the CALLER can
 * select: typed arguments, a closed subcommand set, an argv built here, and no
 * shell string — so the approval prompt and the durable event name exactly
 * which git operation and which paths were requested, instead of the
 * indistinguishable "read and write anywhere, reach the network" that every
 * bash call carries. It does not narrow what the resulting process can do:
 * git executes repository configuration, and a hook can run anything the
 * operator's own git already would.
 *
 * What is deliberately absent:
 *
 * - Network subcommands (`push`, `pull`, `fetch`, `remote`), so publishing
 *   stays an operator action. This bounds what the TOOL initiates; it does not
 *   bound the process. Git runs repository configuration — hooks, credential
 *   helpers, textconv and external diff drivers — and any of those can reach
 *   the network or the filesystem. The permission envelope therefore declares
 *   `network: "external"`, which is the honest ceiling. Hooks are left enabled
 *   on purpose: an operator's own pre-commit checks are a guardrail, and
 *   suppressing them to narrow this envelope would remove that protection.
 * - History rewriting and working-tree destruction (`reset`, `rebase`,
 *   `checkout`, `switch`, `restore`, `clean`, `stash`, `cherry-pick`). A model
 *   that can discard uncommitted work can discard the operator's work.
 * - Free-form flags. Every flag in the argv is chosen here; the caller supplies
 *   values, never options.
 *
 * `run.process` is an exec-class effect, so the no-exec invariant in
 * `evaluateCommandPolicy` routes every call through per-call operator approval.
 * This module does not change that invariant and must not be read as sandboxed
 * execution.
 *
 * Two limits it shares with `bash`, stated rather than fixed here: output is
 * collected in full before it is clipped, so a very large diff is held in
 * memory first; and the timeout kills the git process, not any descendant it
 * spawned, so a hook's child can outlive it and keep the call pending. Both
 * deserve a process-group fix in their own change rather than a partial one
 * bolted onto this tool.
 *
 * Validation failures return an `error: …` string rather than throwing, so the
 * model sees the failure as a tool result and can correct itself within the
 * turn. That covers the argument shapes this module checks; it is not a claim
 * that every possible malformed value is caught.
 */

import { relative, resolve } from "node:path";
import { buildSafeBashEnv } from "./exec-tools.ts";
import {
  clipToUtf8Bytes,
  resolveWorkspacePath,
  sanitizeOutputText,
  toPosixPath,
} from "./file-tools.ts";

export interface GitResult {
  code: number;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Injectable so tests exercise argv/parsing logic without spawning git. */
export type GitRunner = (
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
) => Promise<GitResult>;

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 64 * 1024;
const MAX_MESSAGE_BYTES = 4 * 1024;
const DEFAULT_LOG_LIMIT = 20;
const MAX_LOG_LIMIT = 200;
const MAX_PATHS = 100;
// An input-validation limit, not a filesystem one: it bounds trimming,
// normalization and the error string built from a path before that work
// happens. Some platforms permit longer paths than this.
const MAX_PATH_LENGTH = 4096;
// Every allowed subcommand is under ten characters; this only has to be small
// enough to bound scanning a hostile value.
const MAX_SUBCOMMAND_LENGTH = 64;

export const GIT_SUBCOMMANDS = [
  "status",
  "diff",
  "log",
  "add",
  "commit",
] as const;

export type GitSubcommand = typeof GIT_SUBCOMMANDS[number];

/**
 * Subcommands refused by name rather than by falling through to the generic
 * "unsupported" message. The model gets the reason, so it routes to the
 * operator instead of retrying variations of a call that will never be allowed.
 */
const REFUSED_SUBCOMMANDS: Readonly<Record<string, string>> = {
  push: "publishing is an operator action, not an agent action",
  pull: "this tool issues no network subcommands",
  fetch: "this tool issues no network subcommands",
  clone: "this tool issues no network subcommands",
  remote: "this tool issues no network subcommands",
  submodule: "this tool issues no network subcommands",
  reset: "it can discard committed or staged work",
  revert: "it rewrites working-tree state; ask the operator",
  rebase: "it rewrites history",
  merge: "it rewrites working-tree state; ask the operator",
  checkout: "it can discard uncommitted work",
  switch: "it can discard uncommitted work",
  restore: "it can discard uncommitted work",
  clean: "it deletes untracked files",
  stash: "it moves uncommitted work out of the working tree",
  "cherry-pick": "it rewrites history",
  tag: "tags are an operator action",
  config: "repository configuration is an operator action",
  filter: "history rewriting is an operator action",
};

export interface GitArguments {
  subcommand?: unknown;
  paths?: unknown;
  message?: unknown;
  staged?: unknown;
  limit?: unknown;
}

/** Either the exact argv to hand to git, or a caller-facing error string. */
export type GitArgvPlan =
  | { argv: string[]; error?: undefined }
  | { argv?: undefined; error: string };

function describeAllowed(): string {
  return GIT_SUBCOMMANDS.join(", ");
}

/**
 * Validate `paths` and return them workspace-relative.
 *
 * Absolute paths and traversal are rejected by `resolveWorkspacePath`, and the
 * argv carries `--literal-pathspecs`, so a value is a filename rather than a
 * pathspec: git's magic prefixes (`:(top)`, `:(exclude)`), wildcards and
 * negation are inert. Without that flag, lexical validation is not enough —
 * `:(top)secret` passes a path check and then addresses the repository root
 * from a nested workspace. A leading `:` is rejected too, so such a value fails
 * with a clear reason rather than as a missing file.
 *
 * This still does not resolve symlinks the way the file tools do: git acts on
 * index entries rather than following a link out of the tree, so `add` stages
 * the link itself. A leading `-`
 * is rejected separately: those values are placed after `--` in the argv, but
 * rejecting them keeps the tool safe if that separator is ever lost in a later
 * edit, and the rejection is a clearer error than git's own.
 */
function normalizePaths(
  root: string,
  raw: unknown,
): { paths: string[]; error?: undefined } | {
  paths?: undefined;
  error: string;
} {
  if (raw === undefined) return { paths: [] };
  if (!Array.isArray(raw)) return { error: "error: paths must be an array" };
  if (raw.length > MAX_PATHS) {
    return { error: `error: at most ${MAX_PATHS} paths per call` };
  }
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") {
      return { error: "error: each path must be a non-empty string" };
    }
    if (entry.length > MAX_PATH_LENGTH) {
      return { error: `error: a path exceeds ${MAX_PATH_LENGTH} characters` };
    }
    if (entry.trim() === "") {
      return { error: "error: each path must be a non-empty string" };
    }
    if (entry.startsWith("-")) {
      return {
        error: `error: path must not start with '-': ${
          sanitizeOutputText(entry)
        }`,
      };
    }
    // Inert under --literal-pathspecs, rejected anyway so the caller gets the
    // real reason instead of "did not match any files".
    if (entry.startsWith(":")) {
      return {
        error: `error: path must not start with ':' (git pathspec magic is ` +
          `disabled): ${sanitizeOutputText(entry)}`,
      };
    }
    let abs: string;
    try {
      abs = resolveWorkspacePath(root, entry);
    } catch (err) {
      return { error: `error: ${(err as Error).message}` };
    }
    const rel = relative(resolve(root), abs);
    out.push(rel === "" ? "." : toPosixPath(rel));
  }
  return { paths: out };
}

/**
 * Build the exact argv for an allowed git call, or explain the refusal.
 *
 * Exported because the argv is the security surface: it is asserted directly in
 * tests rather than only through a spawned process.
 */
export function buildGitArgv(root: string, args: GitArguments): GitArgvPlan {
  const subcommand = args.subcommand;
  if (typeof subcommand !== "string") {
    return { error: `error: subcommand is required (${describeAllowed()})` };
  }
  // Length before trim: the caller controls this string, and every allowed
  // value is under ten characters, so nothing longer deserves a full scan.
  if (subcommand.length > MAX_SUBCOMMAND_LENGTH) {
    return {
      error:
        `error: unsupported git subcommand. Allowed: ${describeAllowed()}.`,
    };
  }
  if (subcommand.trim() === "") {
    return { error: `error: subcommand is required (${describeAllowed()})` };
  }
  const refusal = REFUSED_SUBCOMMANDS[subcommand];
  if (refusal !== undefined) {
    return {
      error:
        `error: git ${subcommand} is not available to the agent: ${refusal}. ` +
        `Allowed: ${describeAllowed()}.`,
    };
  }
  if (!(GIT_SUBCOMMANDS as readonly string[]).includes(subcommand)) {
    // Echo a bounded prefix: the caller controls this string's length.
    const shown = sanitizeOutputText(subcommand.slice(0, 64));
    return {
      error: `error: unsupported git subcommand: ${shown}. ` +
        `Allowed: ${describeAllowed()}.`,
    };
  }
  const sub = subcommand as GitSubcommand;

  if (args.message !== undefined && sub !== "commit") {
    return { error: "error: message applies to commit only" };
  }
  if (args.staged !== undefined && sub !== "diff") {
    return { error: "error: staged applies to diff only" };
  }
  if (args.limit !== undefined && sub !== "log") {
    return { error: "error: limit applies to log only" };
  }

  const normalized = normalizePaths(root, args.paths);
  if (normalized.error !== undefined) return { error: normalized.error };
  const paths = normalized.paths;

  // `--no-pager`: git must not wait on a pager with no terminal.
  // `--literal-pathspecs`: every path value is a filename, never a pathspec
  // expression, so magic prefixes and wildcards cannot widen the selection.
  const argv: string[] = ["--no-pager", "--literal-pathspecs"];

  switch (sub) {
    case "status":
      argv.push("status", "--porcelain=v1", "--branch");
      break;
    case "diff": {
      argv.push("diff");
      if (args.staged !== undefined) {
        if (typeof args.staged !== "boolean") {
          return { error: "error: staged must be a boolean" };
        }
        if (args.staged) argv.push("--staged");
      }
      break;
    }
    case "log": {
      let limit = DEFAULT_LOG_LIMIT;
      if (args.limit !== undefined) {
        // typeof, not Number(): coercion runs caller-supplied valueOf/toString,
        // which can throw out of this function and past the executor's own
        // error handling.
        if (
          typeof args.limit !== "number" || !Number.isInteger(args.limit) ||
          args.limit < 1
        ) {
          return { error: "error: limit must be an integer >= 1" };
        }
        limit = Math.min(args.limit, MAX_LOG_LIMIT);
      }
      argv.push(
        "log",
        `--max-count=${limit}`,
        "--date=iso-strict",
        "--pretty=format:%h %ad %an %s",
      );
      break;
    }
    case "add":
      if (paths.length === 0) {
        return { error: "error: add requires at least one path" };
      }
      argv.push("add");
      break;
    case "commit": {
      const message = args.message;
      if (typeof message !== "string") {
        return { error: "error: commit requires a non-empty message" };
      }
      // Length first: UTF-8 is at least one byte per UTF-16 unit, so an
      // oversized string is rejected before trimming or encoding it.
      if (message.length > MAX_MESSAGE_BYTES) {
        return {
          error: `error: message exceeds the ${MAX_MESSAGE_BYTES}-byte limit`,
        };
      }
      if (message.trim() === "") {
        return { error: "error: commit requires a non-empty message" };
      }
      if (message.includes("\0")) {
        return { error: "error: message must not contain NUL" };
      }
      const size = new TextEncoder().encode(message).byteLength;
      if (size > MAX_MESSAGE_BYTES) {
        return {
          error:
            `error: message is ${size} bytes; the limit is ${MAX_MESSAGE_BYTES}`,
        };
      }
      // The message is its own argv entry, so a leading '-' is a value, not a
      // flag. Paths, when given, do more than narrow the commit: a pathspec
      // commit records the WORKING-TREE content of those paths, so a file
      // staged as A and edited to B is committed as B.
      argv.push("commit", "-m", message);
      break;
    }
  }

  if (paths.length > 0) argv.push("--", ...paths);
  return { argv };
}

/** Real runner: spawn git with cwd pinned to the workspace, killed on timeout. */
const defaultRunner: GitRunner = async (args, cwd, timeoutMs) => {
  const proc = new Deno.Command("git", {
    args: [...args],
    cwd,
    clearEnv: true,
    env: {
      ...buildSafeBashEnv(),
      // Disables git's own terminal credential prompt. It does not disable
      // SSH or an askpass helper, which a hook or helper can still invoke.
      GIT_TERMINAL_PROMPT: "0",
      // Read-only subcommands should not take the index lock; a blocked lock is
      // a stall, not a result.
      GIT_OPTIONAL_LOCKS: "0",
    },
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill("SIGKILL");
    } catch {
      // already exited
    }
  }, timeoutMs);
  try {
    const out = await proc.output();
    const dec = new TextDecoder();
    return {
      code: out.code,
      signal: out.signal,
      stdout: dec.decode(out.stdout),
      stderr: dec.decode(out.stderr),
      timedOut,
    };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Run one allowed git operation and return a single string carrying the exit
 * status and combined stdout/stderr. On the normal path the collected body is
 * clipped to a byte cap, with the status line and any notice added outside it.
 * Validation and spawn-failure returns are separate short strings that do not
 * pass through the clip.
 *
 * A pathless `commit` is a repository operation, not a directory one: git
 * commits everything staged in the enclosing repository, including paths
 * outside the workspace when the workspace is a subdirectory. A best-effort
 * probe reports that case in the result; if the probe fails or times out, the
 * commit still proceeds and carries no notice.
 *
 * Never throws on git failure: a non-zero exit (nothing staged, merge conflict,
 * not a repository) is a normal tool result the model reads and recovers from.
 */
export async function executeGit(
  root: string,
  args: GitArguments,
  opts: { timeoutMs?: number; maxBytes?: number; runner?: GitRunner } = {},
): Promise<string> {
  const plan = buildGitArgv(root, args);
  if (plan.error !== undefined) return plan.error;

  const runner = opts.runner ?? defaultRunner;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  // A pathless commit reaches the whole repository. When the workspace is a
  // subdirectory, say so in the result: the approver saw "commit", not "commit
  // everything staged in the parent repository".
  let notice = "";
  if (
    args.subcommand === "commit" && (args.paths as unknown[] ?? []).length === 0
  ) {
    try {
      const top = await runner(
        ["--no-pager", "rev-parse", "--show-toplevel"],
        root,
        timeoutMs,
      );
      const topPath = top.stdout.trim();
      if (
        top.code === 0 && topPath !== "" && resolve(topPath) !== resolve(root)
      ) {
        notice =
          "note: the workspace is a subdirectory of this repository, so this " +
          "commit records every staged change in it, including paths outside " +
          "the workspace.\n";
      }
    } catch {
      // Best effort: a failed check must not block the commit itself.
    }
  }

  let res: GitResult;
  try {
    res = await runner(plan.argv, root, timeoutMs);
  } catch (err) {
    // Message, not the spawn error object: Deno embeds the absolute path it
    // failed on, and this string reaches the durable transcript.
    return `error: cannot run git: ${(err as Error).message}`;
  }

  let body = res.stdout;
  if (res.stderr) {
    body += (body && !body.endsWith("\n") ? "\n" : "") + res.stderr;
  }
  // Byte-bounded, not `.length`-bounded: a UTF-16 slice would let a multibyte
  // diff return several times the named ceiling.
  const clipped = clipToUtf8Bytes(body, maxBytes);
  if (clipped !== null) {
    body = `${clipped}\n\n[truncated at ${maxBytes} bytes]`;
  }

  const status = res.timedOut
    ? `timed out after ${timeoutMs}ms (git killed; descendants may survive)`
    : res.signal
    ? `exit by signal ${res.signal}`
    : `exit ${res.code}`;
  return `${notice}${status}\n${body}`.trimEnd();
}
