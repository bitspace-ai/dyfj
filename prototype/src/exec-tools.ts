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
 */

export interface BashResult {
  code: number;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type BashRunner = (
  command: string,
  cwd: string,
  timeoutMs: number,
) => Promise<BashResult>;

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BYTES = 64 * 1024;

// bash runs with a deliberately minimal environment. clearEnv drops the parent
// process env — which holds the projected provider keys (ANTHROPIC/OPENAI/GEMINI),
// the Dolt password, the workbench bearer key, and MCP tokens — and only this
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

function readEnv(key: string): string | undefined {
  try {
    return Deno.env.get(key);
  } catch {
    return undefined; // not granted to the runtime — treat as absent
  }
}

export function buildSafeBashEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SAFE_ENV_KEYS) {
    const value = readEnv(key);
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** Real runner: spawn `bash -c <command>` with cwd pinned, killed on timeout. */
const defaultRunner: BashRunner = async (command, cwd, timeoutMs) => {
  const proc = new Deno.Command("bash", {
    args: ["-c", command],
    cwd,
    clearEnv: true,
    env: buildSafeBashEnv(),
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
    body = `${body.slice(0, maxBytes)}\n\n[truncated at ${maxBytes} characters]`;
  }

  const status = res.timedOut
    ? `timed out after ${timeoutMs}ms (killed)`
    : res.signal
    ? `exit by signal ${res.signal}`
    : `exit ${res.code}`;
  return `${status}\n${body}`.trimEnd();
}
