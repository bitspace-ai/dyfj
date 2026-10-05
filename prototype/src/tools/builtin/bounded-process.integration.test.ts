// The bounded process runner against real processes (POSIX only): ordinary
// exits, trees that outlive their shell, a descendant that leaves the group,
// and a group stopper that cannot signal (a fake at the stopper port).

import {
  assert,
  assertEquals,
  assertFalse,
  assertStrictEquals,
} from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { buildSafeBashEnv } from "./exec.ts";
import {
  type BoundedOptions,
  type GroupStopper,
  runBounded,
} from "./bounded-process.ts";

const posix = Deno.build.os !== "windows";
const TIMEOUT_MS = 300;
const RETURN_BOUND_MS = TIMEOUT_MS + 4_000;

async function isLive(pid: number): Promise<boolean> {
  const out = await new Deno.Command("/bin/ps", {
    args: ["-o", "stat=", "-p", String(pid)],
    stdout: "piped",
    stderr: "null",
  }).output();
  const stat = new TextDecoder().decode(out.stdout).trim();
  return stat !== "" && !stat.startsWith("Z");
}

async function forceKill(pid: number | undefined): Promise<void> {
  if (pid === undefined) return;
  await new Deno.Command("/bin/kill", {
    args: ["-KILL", String(pid)],
    stdout: "null",
    stderr: "null",
  }).output();
}

function pidIn(text: string): number | undefined {
  const match = text.match(/^pid=(\d+)$/m);
  return match ? Number(match[1]) : undefined;
}

async function bash(script: string, options: BoundedOptions = {}) {
  const start = performance.now();
  const result = await runBounded({
    command: "bash",
    args: ["-c", script],
    cwd: Deno.cwd(),
    env: buildSafeBashEnv(),
    timeoutMs: TIMEOUT_MS,
  }, options);
  return { result, elapsedMs: performance.now() - start };
}

describe("runBounded", { ignore: !posix }, () => {
  it("returns the exit code and both streams of an ordinary exit", async () => {
    const { result } = await bash("echo out; echo err >&2; exit 3");
    assertEquals(result, {
      code: 3,
      signal: null,
      stdout: "out\n",
      stderr: "err\n",
      timedOut: false,
    });
  });

  it("stops a child that holds the output open after its shell exited", async () => {
    let pid: number | undefined;
    try {
      const { result, elapsedMs } = await bash(`sleep 10 & echo "pid=$!"`);
      pid = pidIn(result.stdout);
      assert(elapsedMs < RETURN_BOUND_MS, `took ${Math.round(elapsedMs)}ms`);
      assertStrictEquals(result.timedOut, true);
      assertEquals(result.termination, {
        group: "stopped",
        exited: true,
        outputClosed: true,
      });
      assert(pid !== undefined);
      assertFalse(await isLive(pid));
    } finally {
      await forceKill(pid);
    }
  });

  it("escalates to SIGKILL when the group ignores SIGTERM", async () => {
    let pid: number | undefined;
    try {
      // The shell ignores TERM and its sleep inherits that disposition, so
      // only the group SIGKILL can stop either of them.
      const { result, elapsedMs } = await bash(
        `trap '' TERM; sleep 10 & echo "pid=$!"; wait`,
        { graceMs: 200 },
      );
      pid = pidIn(result.stdout);
      assert(elapsedMs < RETURN_BOUND_MS, `took ${Math.round(elapsedMs)}ms`);
      // TERM was ignored, so the stop ran the full grace before escalating.
      assert(
        elapsedMs >= TIMEOUT_MS + 200,
        `returned before the grace elapsed: ${Math.round(elapsedMs)}ms`,
      );
      assertEquals(result.termination, {
        group: "stopped",
        exited: true,
        outputClosed: true,
      });
      assert(pid !== undefined, `no pid in: ${result.stdout}`);
      assertFalse(await isLive(pid), "the TERM-ignoring sleep survived");
    } finally {
      await forceKill(pid);
    }
  });

  it("drops output written after the deadline", async () => {
    const { result } = await bash(
      `echo before; trap 'echo trapped; exit 1' TERM; sleep 10 & wait`,
    );
    assertStrictEquals(result.timedOut, true);
    assertStrictEquals(result.stdout, "before\n");
  });

  it("returns within the drain bound when a descendant leaves the group, and says so", async () => {
    let pid: number | undefined;
    try {
      const { result, elapsedMs } = await bash(
        // Backgrounded so bash does not exec perl as the group leader, whose
        // setpgrp would be a no-op.
        `perl -e '$| = 1; setpgrp(0, 0); print "pid=$$\\n"; sleep 10' & wait`,
        { drainMs: 200 },
      );
      pid = pidIn(result.stdout);
      assert(elapsedMs < RETURN_BOUND_MS, `took ${Math.round(elapsedMs)}ms`);
      assertStrictEquals(result.timedOut, true);
      assertStrictEquals(result.termination?.outputClosed, false);
      assert(pid !== undefined, `no pid in: ${result.stdout}`);
      // The report is honest: the escaped process really is still running.
      assert(await isLive(pid));
    } finally {
      await forceKill(pid);
    }
  });

  it("reports an unsignallable group and still returns when the stopper cannot signal", async () => {
    let pid: number | undefined;
    let stopped: number | undefined;
    const cannotSignal: GroupStopper = (group) => {
      stopped = group;
      return Promise.resolve("unavailable");
    };
    try {
      const { result, elapsedMs } = await bash(
        `sleep 10 & echo "pid=$!"; wait`,
        { stopGroup: cannotSignal, drainMs: 200 },
      );
      pid = pidIn(result.stdout);
      assert(elapsedMs < RETURN_BOUND_MS, `took ${Math.round(elapsedMs)}ms`);
      assert(stopped !== undefined && stopped > 1);
      assertEquals(result.termination, {
        group: "unavailable",
        exited: true,
        outputClosed: false,
      });
      // Only the shell was killed; its child is the survivor reported above.
      assert(pid !== undefined);
      assert(await isLive(pid));
    } finally {
      await forceKill(pid);
    }
  });

  it("treats a stopper that throws as unable to signal", async () => {
    let pid: number | undefined;
    try {
      const { result } = await bash(`sleep 10 & echo "pid=$!"; wait`, {
        stopGroup: () => {
          throw new Error("no signaller");
        },
        drainMs: 200,
      });
      pid = pidIn(result.stdout);
      assertStrictEquals(result.termination?.group, "unavailable");
    } finally {
      await forceKill(pid);
    }
  });
});
