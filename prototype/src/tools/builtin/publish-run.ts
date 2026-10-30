/**
 * Running one operator-configured publish command (BIT-786).
 *
 * The gates take 10-30 minutes by hand, so this is not `runBounded`: a call
 * that long cannot ride a tool call, and it must be cancellable, so the run is
 * started detached, its output is kept bounded, and its process group is
 * stopped the same way `bounded-process.ts` stops a timed-out command - the
 * group-stopper primitive is shared rather than reimplemented. A stopped run
 * settles within a drain bound even when a process that left the group still
 * holds its output pipes; the pipes are then destroyed, that process is not
 * killed, and the result says so (`pipesLeftOpen`).
 *
 * Three properties matter beyond the deadline:
 *
 * - the child is spawned through `guardedSpawn` under the policy it is given;
 *   `publishPolicyFor` builds that from the runtime's policy plus exactly the
 *   `[publish]` binaries the operator configured;
 * - its environment is the caller's (the publish tool builds it, with the git
 *   hardening and no runtime credentials) and nothing else;
 * - output is captured bounded: a chatty gate cannot grow the runtime's
 *   memory. The window kept is the LAST `PUBLISH_OUTPUT_CAP_BYTES`, and a
 *   failure is reported from the first non-empty lines of that window, with a
 *   note when anything before it was dropped.
 */

import type { ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import process from "node:process";
import { guardedSpawn } from "../../config/spawn-guard.ts";
import type { RuntimePolicy } from "../../config/runtime-policy.ts";
import { stopProcessGroup } from "./bounded-process.ts";
import type { PublishConfig } from "../../config/publish-config.ts";

/** Bytes of a command's output kept for reporting; the rest is dropped. */
export const PUBLISH_OUTPUT_CAP_BYTES = 256 * 1024;

/** What to run: an argv, a cwd, an environment and a deadline. */
export interface PublishCommand {
  argv: readonly string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}

export interface PublishCommandResult {
  /** The child's exit code, or null when it ended by a signal. */
  code: number | null;
  timedOut: boolean;
  cancelled: boolean;
  /** Combined stdout and stderr, older output dropped past the cap. */
  output: string;
  /** True when output was dropped, so a report never looks complete. */
  truncated: boolean;
  /**
   * True when the run was stopped and its output pipes were still open after
   * the drain bound: a process that left the group may still be running.
   */
  pipesLeftOpen: boolean;
}

/** One run in flight: what a cancel addresses. */
export interface PublishCommandHandle {
  readonly result: Promise<PublishCommandResult>;
  /** Stop the run's process group; a no-op once it has finished. */
  cancel(): void;
}

const CANCEL_GRACE_MS = 1_000;

/**
 * How long a stopped run's pipes may stay open after the stop. A descendant
 * that left the process group can hold them open forever; past this bound the
 * pipes are destroyed and the run settles anyway.
 */
const DRAIN_MS = 1_000;

/**
 * The policy a publish command starts under: the runtime's own, plus the
 * binaries the operator's `[publish]` section names.
 *
 * This is the same trust class as `[secrets].command` (`config/secrets-config.ts`):
 * an executable the operator wrote into their own config, not a path any model
 * supplies. The model chooses no binary — it chooses no argv at all — so the
 * grant cannot be steered; what it can do is start a program the operator
 * already decided to run.
 */
export function publishPolicyFor(
  policy: RuntimePolicy,
  config: PublishConfig,
): RuntimePolicy {
  const added = [config.preGate[0], config.gate[0]].filter(
    (entry): entry is string => entry !== undefined && entry !== "",
  );
  const run = [...policy.run];
  for (const entry of added) if (!run.includes(entry)) run.push(entry);
  return { ...policy, run };
}

/** Keep the last `cap` bytes of a growing buffer, reporting any loss. */
function appendBounded(text: string, chunk: string, cap: number) {
  const joined = text + chunk;
  if (Buffer.byteLength(joined, "utf8") <= cap) {
    return { text: joined, truncated: false };
  }
  // Cut from the front on a byte boundary, then drop a partial leading line so
  // the kept tail starts at a line the operator can read.
  let bytes = Buffer.from(joined, "utf8").subarray(-cap);
  const text_ = bytes.toString("utf8");
  const newline = text_.indexOf("\n");
  return {
    text: newline >= 0 ? text_.slice(newline + 1) : text_,
    truncated: true,
  };
}

/**
 * Start one publish command. The returned handle resolves when the command
 * exits, times out, or is cancelled; it never resolves differently for the
 * command's own failure. A command that cannot start either throws here or
 * rejects `result`, depending on when the spawn fails.
 */
export function startPublishCommand(
  command: PublishCommand,
  policy: RuntimePolicy,
): PublishCommandHandle {
  const [binary, ...args] = command.argv;
  if (binary === undefined) {
    throw new Error("publish: an empty command cannot start");
  }
  const child: ChildProcess = guardedSpawn(policy)(binary, [...args], {
    cwd: command.cwd,
    env: command.env,
    // No stdin: a phase that would ask a question reads EOF instead of
    // holding the runtime open.
    stdio: ["ignore", "pipe", "pipe"],
    // Its own process group, so the stop reaches descendants (a shell wrapper
    // the operator configured, and everything it starts).
    detached: process.platform !== "win32",
  });
  let output = "";
  let truncated = false;
  // One decoder per stream, so a multi-byte character split across two reads
  // is decoded whole.
  const collector = () => {
    const decoder = new StringDecoder("utf8");
    return (chunk: Buffer) => {
      const next = appendBounded(output, decoder.write(chunk), PUBLISH_OUTPUT_CAP_BYTES);
      output = next.text;
      truncated = truncated || next.truncated;
    };
  };
  child.stdout?.on("data", collector());
  child.stderr?.on("data", collector());

  let timedOut = false;
  let cancelled = false;
  let settled = false;
  let group: number | undefined = child.pid;
  const stopGroup = async () => {
    if (group === undefined) return;
    try {
      await stopProcessGroup(group, CANCEL_GRACE_MS);
    } catch {
      // A stopper that throws leaves the direct child to the kill below.
    }
  };

  let exitCode: number | null = null;
  child.once("exit", (code) => {
    exitCode = code;
  });
  let finish: (code: number | null, pipesLeftOpen?: boolean) => void = () => {};

  /**
   * Stop the run and settle it within a bound, whether or not the pipes ever
   * close: the group stop, a kill of the direct child, then a drain, then the
   * pipes are destroyed and the result settles with what was kept.
   */
  const terminate = () => {
    void stopGroup()
      .finally(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      })
      .finally(() => {
        const drain = setTimeout(() => {
          if (settled) return;
          child.stdout?.destroy();
          child.stderr?.destroy();
          finish(exitCode, true);
        }, DRAIN_MS);
        drain.unref?.();
      });
  };

  const result = new Promise<PublishCommandResult>((resolve, reject) => {
    finish = (code, pipesLeftOpen = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        timedOut,
        cancelled,
        output,
        truncated,
        pipesLeftOpen,
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, command.timeoutMs);
    // A deadline that long must not keep the process alive on its own.
    timer.unref?.();
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      group = undefined;
      finish(code);
    });
  });

  return {
    result,
    cancel() {
      if (settled || cancelled) return;
      cancelled = true;
      terminate();
    },
  };
}
