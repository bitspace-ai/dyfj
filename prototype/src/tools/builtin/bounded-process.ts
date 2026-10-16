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
 *   empty, then SIGKILL to whatever is left. Each step is one run of
 *   `/bin/kill` addressed at the negated group id, as the ACP runner signals
 *   its agent's group: a numeric id validated here and fixed arguments, with
 *   its streams discarded. Liveness is `kill -0`, so a group whose members
 *   are all unreaped zombies still reads as present until they are reaped.
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

import type { ChildProcess } from "node:child_process";
import { constants as osConstants } from "node:os";
import process from "node:process";
import type { Readable } from "node:stream";
import {
  baseRuntimePolicy,
  guardedSpawn,
  type RuntimePolicy,
} from "../../config/mod.ts";

/** How a timed-out command's process group ended up after the stop. */
export type GroupStop =
  /** Nothing live is left in the group. */
  | "stopped"
  /** A group member was still present after SIGKILL and its settle bound. */
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
  /**
   * The run policy the command is checked against before it starts; the base
   * policy (which holds `bash` and `git`) when absent. A refused command
   * throws `SpawnRefusedError`, as a command that cannot start throws.
   */
  policy?: RuntimePolicy;
}

// With the defaults a timed-out call returns about 2.5 s after its deadline
// when the stop goes as designed (grace, kill settle, drain), and within about
// 8 s if the signalling child itself hangs and has to be given up on.
const DEFAULT_GRACE_MS = 1_000;
const DEFAULT_DRAIN_MS = 1_000;
// After SIGKILL, how long the group may take to empty before a member that is
// still present counts as a survivor.
const KILL_SETTLE_MS = 500;
// How often the group is probed for members while waiting for it to empty.
const PROBE_INTERVAL_MS = 25;
// Headroom for one signal run's own startup; a hung `/bin/kill` must not hold
// the call open either.
const STOPPER_STARTUP_MS = 5_000;
const KILL_COMMAND = "/bin/kill";

function isSignallableGroup(group: number): boolean {
  return Number.isSafeInteger(group) && group > 1;
}

/** The signal a stop step sends: TERM, KILL, or "0" for the liveness probe. */
export type GroupSignal = "TERM" | "KILL" | "0";

/**
 * The argument list for one `/bin/kill` step against a process group. The
 * group id is validated (an integer above 1, never "all processes" or the
 * caller's own group) and goes after `--`, so it can only be read as a target.
 */
export function groupSignalArgs(group: number, signal: GroupSignal): string[] {
  if (!isSignallableGroup(group)) {
    throw new RangeError("process group id must be an integer above 1");
  }
  return signal === "0"
    ? ["-0", "--", `-${group}`]
    : ["-s", signal, "--", `-${group}`];
}

/**
 * What one `/bin/kill` run reported. `gone` is "no such process": the group
 * has no members. `failed` is any other refusal or a run that outlived its
 * bound. `unavailable` is a run that could not start at all.
 */
export type SignalOutcome = "delivered" | "gone" | "failed" | "unavailable";

/** Port: run `/bin/kill` with these arguments and report the outcome. */
export type SignalRunner = (
  args: string[],
  signal?: AbortSignal,
  policy?: RuntimePolicy,
) => Promise<SignalOutcome>;

/**
 * Default signal runner: `/bin/kill`, spawned through the guarded spawn under
 * `policy` (the base policy, which holds `/bin/kill`, when absent). A refused
 * or failed start reports unavailable. An abort kills a run still in flight
 * and reports it failed; an already-aborted signal starts nothing.
 */
export const runKill: SignalRunner = (
  args,
  signal,
  policy = baseRuntimePolicy(),
) =>
  new Promise<SignalOutcome>((resolve) => {
    if (signal?.aborted) {
      resolve("failed");
      return;
    }
    let child: ChildProcess;
    try {
      child = guardedSpawn(policy)(KILL_COMMAND, args, {
        stdio: ["ignore", "ignore", "pipe"],
        env: { LC_ALL: "C" },
      });
    } catch {
      resolve("unavailable");
      return;
    }
    let detail = "";
    child.stderr?.on("data", (chunk: Uint8Array) => {
      if (detail.length < 256) detail += new TextDecoder().decode(chunk);
    });
    let settled = false;
    const finish = (outcome: SignalOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", giveUp);
      resolve(outcome);
    };
    const giveUp = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // It exited at the bound.
      }
      finish("failed");
    };
    const timer = setTimeout(giveUp, STOPPER_STARTUP_MS);
    signal?.addEventListener("abort", giveUp, { once: true });
    child.once("error", () => finish("unavailable"));
    child.once("close", (code) => {
      if (code === 0) finish("delivered");
      else finish(detail.includes("No such process") ? "gone" : "failed");
    });
  });

export interface GroupStopperTuning {
  /** How often the group is probed while waiting for it to empty. */
  pollMs?: number;
  /** How long a single signal run may take to start and finish. */
  startupMs?: number;
  /** How long the group may take to empty after SIGKILL. */
  killSettleMs?: number;
}

/**
 * Build a group stopper over a signal runner: SIGTERM, probe until the group
 * is empty or the grace ends, then SIGKILL and probe for the settle bound.
 * Only a probe that reports "no such process" counts as empty, so a probe that
 * fails or cannot run never reports a survivor as stopped. A runner that
 * cannot start at all, or that throws, makes the group unavailable.
 */
export function createGroupStopper(
  run: SignalRunner,
  tuning: GroupStopperTuning = {},
): GroupStopper {
  const pollMs = Math.max(1, tuning.pollMs ?? PROBE_INTERVAL_MS);
  const killSettleMs = tuning.killSettleMs ?? KILL_SETTLE_MS;
  const startupMs = tuning.startupMs ?? STOPPER_STARTUP_MS;
  return async (group, graceMs) => {
    if (!isSignallableGroup(group)) return "unavailable";
    const probeArgs = groupSignalArgs(group, "0");
    // Tripped at the bound: the stopper has reported, so nothing it started may
    // signal afterwards, when the group id could belong to another process.
    const given = new AbortController();
    const send = (args: string[]): Promise<SignalOutcome> =>
      given.signal.aborted
        ? Promise.resolve("failed")
        : run(args, given.signal);
    const emptiesWithin = async (ms: number): Promise<boolean> => {
      const end = Date.now() + ms;
      for (;;) {
        if (given.signal.aborted) return false;
        if ((await send(probeArgs)) === "gone") return true;
        if (Date.now() >= end) return false;
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
    };
    const steps = async (): Promise<GroupStop> => {
      const term = await send(groupSignalArgs(group, "TERM"));
      if (term === "unavailable") return "unavailable";
      if (term === "gone") return "stopped";
      if (await emptiesWithin(Math.max(0, graceMs))) return "stopped";
      const kill = await send(groupSignalArgs(group, "KILL"));
      if (kill === "unavailable") return "unavailable";
      if (kill === "gone") return "stopped";
      return (await emptiesWithin(killSettleMs)) ? "stopped" : "survived";
    };
    const bound = Math.max(0, graceMs) + killSettleMs + startupMs;
    try {
      return (await settleWithin(steps(), bound)) ?? "unavailable";
    } finally {
      given.abort();
    }
  };
}

/** Default stopper: `/bin/kill` steps through `node:child_process`. */
export const stopProcessGroup: GroupStopper = createGroupStopper(runKill);

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

function collect(stream: Readable): Collector {
  const chunks: Uint8Array[] = [];
  let frozen = false;
  const done = new Promise<void>((resolve) => {
    // A cancelled or failed read ends collection; what was kept stands.
    stream.once("end", () => resolve());
    stream.once("close", () => resolve());
    stream.once("error", () => resolve());
  });
  stream.on("data", (chunk: Uint8Array) => {
    if (!frozen) chunks.push(chunk);
  });
  return {
    done,
    freeze: () => {
      frozen = true;
    },
    cancel: async () => {
      stream.destroy();
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

interface ExitStatus {
  code: number | null;
  signal: string | null;
}

/**
 * The command's exit, taken from the `exit` event and not `close`: `close`
 * waits for the output pipes, and a descendant can hold those open long after
 * the command is gone. A signal death carries the shell convention's
 * 128 + signal number in `code`, as `signal` names it.
 */
function exitStatus(child: ChildProcess): Promise<ExitStatus> {
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      const number = signal === null
        ? undefined
        : (osConstants.signals as Record<string, number>)[signal];
      resolve({
        code: code ?? (number === undefined ? null : 128 + number),
        signal,
      });
    });
  });
}

/** Resolves once the command has started; rejects when it cannot. */
function started(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", reject);
  });
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
  // The default stopper's /bin/kill runs under the same policy as the
  // command, so a policy that refuses /bin/kill refuses the timeout kill too.
  const stopGroup = options.stopGroup ??
    (options.policy === undefined
      ? stopProcessGroup
      : createGroupStopper((args, signal) =>
        runKill(args, signal, options.policy)
      ));
  // Windows has no POSIX process groups; there only the direct child is
  // killed and the result says so.
  const useGroup = process.platform !== "win32";
  const child = guardedSpawn(options.policy ?? baseRuntimePolicy())(
    request.command,
    [...request.args],
    {
      cwd: request.cwd,
      env: request.env,
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group: the leader's pid is the group id the stop signals.
      detached: useGroup,
    },
  );
  await started(child);
  // Later errors (a failed kill) have no caller to tell.
  child.on("error", () => {});
  const group = useGroup && child.pid !== undefined &&
      isSignallableGroup(child.pid)
    ? child.pid
    : undefined;
  const exited = exitStatus(child);
  const stdout = collect(child.stdout!);
  const stderr = collect(child.stderr!);
  const outputClosed = Promise.all([stdout.done, stderr.done]);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const finishedFirst = await Promise.race([
    Promise.all([exited, outputClosed]).then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), request.timeoutMs);
    }),
  ]);
  clearTimeout(timer);

  if (finishedFirst) {
    const status = await exited;
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
  // as long as the I/O takes, and its exit event stays pending with it.
  // Its exit is then observed, not awaited, and the result says so.
  const status = await settleWithin(exited, KILL_SETTLE_MS);
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
