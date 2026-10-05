/**
 * Deadline-bounded child processes for the exec-class builtin tools (`bash`,
 * `git`).
 *
 * A timeout that kills only the direct child does not bound the call: its
 * descendants inherit the output pipes, keep running, and hold them open, so a
 * reader that waits for end-of-file waits for the whole tree. This module
 * bounds the call instead of the process:
 *
 * - Outside Windows the command starts as the leader of its own process group,
 *   so its pid is the group id and every descendant that stays in the group
 *   can be signalled at once.
 * - Output is read here, chunk by chunk, rather than collected at end-of-file.
 *   At the deadline collection stops: nothing read after that point reaches
 *   the result, so output from a command that would have finished later is
 *   never presented as if it completed.
 * - At the deadline the group is stopped the way the aggregate gate tears down
 *   a test lane: SIGTERM, a short grace that ends as soon as the group is
 *   empty, then SIGKILL to whatever is left. Signalling a group needs
 *   `Deno.kill`, which needs unscoped run permission the runtime does not
 *   hold, so a short-lived child of the running Deno executable carries the
 *   signals. Its program is code-authored, with only a validated numeric group
 *   id and fixed bounds substituted in, and its streams are discarded.
 * - After the stop, the pipes get a bounded drain. A process that left the
 *   group (`setsid`, `setpgrp`) cannot be signalled through it and may still
 *   hold the pipes; the call returns anyway and reports that.
 *
 * The result says how the stop went, so callers report a timeout honestly: an
 * emptied group, a group member that outlived SIGKILL, a group that could not
 * be signalled (Windows, or no signaller), a command still present after
 * SIGKILL (its exit status is then unavailable), or output held open by a
 * process outside the group. Every wait after the deadline is bounded, the
 * signaller's and the command's own exit included, so the call returns even
 * when a process is stuck in uninterruptible I/O.
 *
 * Scope: on an ordinary exit nothing is signalled, so a background process
 * whose output is redirected elsewhere is left running, as it would be in a
 * terminal. Output is still collected in full before callers clip it; bounding
 * that memory is separate work.
 */

/** How a timed-out command's process group ended up after the stop. */
export type GroupStop =
  /** Nothing live is left in the group. */
  | "stopped"
  /** A non-zombie group member was still present after SIGKILL. */
  | "survived"
  /** The group could not be signalled; only the direct child was killed. */
  | "unavailable";

/** Port: stop a process group (TERM, grace, KILL) and report what is left. */
export type GroupStopper = (
  group: number,
  graceMs: number,
) => Promise<GroupStop>;

export interface TimeoutTermination {
  group: GroupStop;
  /**
   * False when the command itself was still present after SIGKILL and its
   * settle bound (uninterruptible I/O). Its exit status is then unavailable:
   * `code` is null.
   */
  exited: boolean;
  /** False when the output pipes were still open after the drain bound. */
  outputClosed: boolean;
}

export interface BoundedResult {
  /** Null only on a timeout whose command had not exited (`termination.exited`). */
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Present when the deadline stopped the command. */
  termination?: TimeoutTermination;
}

export interface BoundedRequest {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}

export interface BoundedOptions {
  /** SIGTERM-to-SIGKILL grace for the group. */
  graceMs?: number;
  /** How long the pipes may stay open after the stop before reads are cut. */
  drainMs?: number;
  stopGroup?: GroupStopper;
}

// With the defaults a timed-out call returns about 2.5 s after its deadline
// when the stop goes as designed (grace, kill settle, drain), and within about
// 8 s if the signalling child itself hangs and has to be given up on.
const DEFAULT_GRACE_MS = 1_000;
const DEFAULT_DRAIN_MS = 1_000;
// After SIGKILL, how long the group may take to empty before a member that is
// still present counts as a survivor.
const KILL_SETTLE_MS = 500;
// Headroom for the signalling child's own startup; a hung signaller must not
// hold the call open either.
const STOPPER_STARTUP_MS = 5_000;
const SURVIVED_EXIT = 3;

function isSignallableGroup(group: number): boolean {
  return Number.isSafeInteger(group) && group > 1;
}

/**
 * The code-authored stop program. Liveness is a SIGCONT probe confirmed by
 * `ps`: a group whose members are all unreaped zombies still accepts a signal,
 * and a zombie is not a survivor. When `ps` is unavailable the probe assumes
 * the member is live, so a survivor is never reported as stopped.
 */
export function groupStopProgram(group: number, graceMs: number): string {
  if (!isSignallableGroup(group)) {
    throw new RangeError("process group id must be an integer above 1");
  }
  const grace = Math.max(0, Math.round(graceMs));
  return [
    `const group = ${group};`,
    `const signal = (name) => {`,
    `  try { Deno.kill(-group, name); return true; }`,
    `  catch (error) { return !(error instanceof Deno.errors.NotFound); }`,
    `};`,
    `const live = async () => {`,
    `  if (!signal("SIGCONT")) return false;`,
    `  try {`,
    `    const out = await new Deno.Command("/bin/ps", {`,
    `      args: ["-A", "-o", "pgid=,stat="],`,
    `      stdin: "null", stdout: "piped", stderr: "null",`,
    `    }).output();`,
    `    if (!out.success) return true;`,
    `    return new TextDecoder().decode(out.stdout).split("\\n").some((line) => {`,
    `      const [pgid, stat] = line.trim().split(/\\s+/);`,
    `      return Number(pgid) === group && stat !== undefined &&`,
    `        !stat.startsWith("Z");`,
    `    });`,
    `  } catch { return true; }`,
    `};`,
    `const emptiesWithin = async (ms) => {`,
    `  const end = Date.now() + ms;`,
    `  for (;;) {`,
    `    if (!(await live())) return true;`,
    `    if (Date.now() >= end) return false;`,
    `    await new Promise((resolve) => setTimeout(resolve, 25));`,
    `  }`,
    `};`,
    `if (!signal("SIGTERM")) Deno.exit(0);`,
    `if (await emptiesWithin(${grace})) Deno.exit(0);`,
    `signal("SIGKILL");`,
    `Deno.exit((await emptiesWithin(${KILL_SETTLE_MS})) ? 0 : ${SURVIVED_EXIT});`,
  ].join("\n");
}

/** Default stopper: run the stop program in a child of the running Deno. */
export const stopProcessGroup: GroupStopper = async (group, graceMs) => {
  if (!isSignallableGroup(group)) return "unavailable";
  let signaller: Deno.ChildProcess;
  try {
    signaller = new Deno.Command(Deno.execPath(), {
      args: ["eval", "--allow-run", groupStopProgram(group, graceMs)],
      clearEnv: true,
      env: {},
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();
  } catch {
    return "unavailable";
  }
  const bound = Math.max(0, graceMs) + KILL_SETTLE_MS + STOPPER_STARTUP_MS;
  const status = await settleWithin(signaller.status, bound);
  if (status === undefined) {
    try {
      signaller.kill("SIGKILL");
    } catch {
      // It exited at the bound.
    }
    // Its eventual exit is observed, not awaited: a signaller stuck in
    // uninterruptible I/O must not hold the timeout path open.
    signaller.status.catch(() => undefined);
    return "unavailable";
  }
  if (status.code === 0) return "stopped";
  if (status.code === SURVIVED_EXIT) return "survived";
  return "unavailable";
};

async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.catch(() => undefined),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

interface Collector {
  /** Resolves when the stream reaches end-of-file or its read is cancelled. */
  done: Promise<void>;
  /** Stop keeping chunks; later reads only drain the pipe. */
  freeze(): void;
  cancel(): Promise<void>;
  text(): string;
}

function collect(stream: ReadableStream<Uint8Array>): Collector {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let frozen = false;
  const done = (async () => {
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) return;
        if (!frozen) chunks.push(next.value);
      }
    } catch {
      // A cancelled or failed read ends collection; what was kept stands.
    } finally {
      reader.releaseLock();
    }
  })();
  return {
    done,
    freeze: () => {
      frozen = true;
    },
    cancel: async () => {
      await reader.cancel().catch(() => undefined);
      await done;
    },
    text: () => {
      const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return new TextDecoder().decode(bytes);
    },
  };
}

/**
 * Run one command with stdin closed and both output streams piped, bounded by
 * `timeoutMs` plus the stop grace and the drain bound. Throws only when the
 * command cannot be started.
 */
export async function runBounded(
  request: BoundedRequest,
  options: BoundedOptions = {},
): Promise<BoundedResult> {
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const drainMs = options.drainMs ?? DEFAULT_DRAIN_MS;
  const stopGroup = options.stopGroup ?? stopProcessGroup;
  // Windows has no POSIX process groups; there only the direct child is
  // killed and the result says so.
  const useGroup = Deno.build.os !== "windows";
  const child = new Deno.Command(request.command, {
    args: [...request.args],
    cwd: request.cwd,
    clearEnv: true,
    env: request.env,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    // Own process group: the leader's pid is the group id the stop signals.
    detached: useGroup,
  }).spawn();
  const group = useGroup && isSignallableGroup(child.pid)
    ? child.pid
    : undefined;
  const stdout = collect(child.stdout);
  const stderr = collect(child.stderr);
  const outputClosed = Promise.all([stdout.done, stderr.done]);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const finishedFirst = await Promise.race([
    Promise.all([child.status, outputClosed]).then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), request.timeoutMs);
    }),
  ]);
  clearTimeout(timer);

  if (finishedFirst) {
    const status = await child.status;
    return {
      code: status.code,
      signal: status.signal,
      stdout: stdout.text(),
      stderr: stderr.text(),
      timedOut: false,
    };
  }

  // The deadline: keep nothing written from here on, then stop the tree.
  stdout.freeze();
  stderr.freeze();
  // A stopper that throws, even synchronously, counts as unable to signal; the
  // direct child is still killed below.
  const groupStop = group === undefined
    ? "unavailable"
    : await Promise.resolve()
      .then(() => stopGroup(group, graceMs))
      .catch(() => "unavailable" as const);
  // The direct child as well: the only kill when the group could not be
  // signalled, and a no-op when the group stop already reaped it.
  try {
    child.kill("SIGKILL");
  } catch {
    // Already exited.
  }
  // Bounded as well: a leader in uninterruptible I/O can outlive SIGKILL for
  // as long as the I/O takes, and its status promise stays pending with it.
  // Its exit is then observed, not awaited, and the result says so.
  const status = await settleWithin(child.status, KILL_SETTLE_MS);
  if (status === undefined) child.status.catch(() => undefined);
  const closed = (await settleWithin(outputClosed.then(() => true), drainMs)) ??
    false;
  if (!closed) await Promise.all([stdout.cancel(), stderr.cancel()]);
  return {
    code: status?.code ?? null,
    signal: status?.signal ?? null,
    stdout: stdout.text(),
    stderr: stderr.text(),
    timedOut: true,
    termination: {
      group: groupStop,
      exited: status !== undefined,
      outputClosed: closed,
    },
  };
}

/**
 * The status line for a timed-out call. A result without termination detail
 * (a runner that predates it) reads as a plain kill.
 */
export function describeTimeout(
  timeoutMs: number,
  termination?: TimeoutTermination,
): string {
  if (termination === undefined) {
    return `timed out after ${timeoutMs}ms (killed)`;
  }
  const notes = ["killed"];
  if (termination.group === "survived") {
    notes.push("a process in its group was still running after SIGKILL");
  } else if (termination.group === "unavailable") {
    notes.push(
      "its process group could not be signalled, so descendants may survive",
    );
  }
  if (!termination.exited) {
    notes.push(
      "the command itself had not exited after SIGKILL, so its exit status is unavailable",
    );
  }
  if (!termination.outputClosed) {
    // Only an emptied group proves the holder is outside it. Otherwise the
    // holder may be the survivor, or on Windows there is no group at all.
    notes.push(
      termination.group === "stopped"
        ? "a process outside its group held the output open and may still be running"
        : "the output was still held open after the stop, so a process may still be running",
    );
  }
  notes.push("output shown up to the deadline");
  return `timed out after ${timeoutMs}ms (${notes.join("; ")})`;
}
