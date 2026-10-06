// The bash tool's timeout against real process trees (POSIX only). These go
// through `executeBash` with its real runner, so they exercise exactly what
// the agent loop runs: the deadline must bound the call, stop the whole tree,
// and keep output written after the kill point out of the result.

import {
  assert,
  assertFalse,
  assertMatch,
  assertStrictEquals,
} from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import type { CommandCall } from "../definition.ts";
import { defineBash, executeBash } from "./exec.ts";

const posix = Deno.build.os !== "windows";
const TIMEOUT_MS = 500;
// The deadline plus the stop grace, the kill settle and the drain bound, with
// slack for a loaded machine. A tree that survives the timeout runs for 10 s.
const RETURN_BOUND_MS = TIMEOUT_MS + 4_000;

// Live means present and not a zombie: an unreaped zombie has already exited.
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

function pidIn(out: string): number | undefined {
  const match = out.match(/^pid=(\d+)$/m);
  return match ? Number(match[1]) : undefined;
}

async function runTimed(command: string) {
  const start = performance.now();
  const out = await executeBash(Deno.cwd(), command, { timeoutMs: TIMEOUT_MS });
  return { out, elapsedMs: performance.now() - start };
}

describe("bash timeout against a real process tree", { ignore: !posix }, () => {
  it("stops a backgrounded child the shell waits on", async () => {
    let pid: number | undefined;
    try {
      const { out, elapsedMs } = await runTimed(
        `sleep 10 & echo "pid=$!"; wait`,
      );
      pid = pidIn(out);
      assert(
        elapsedMs < RETURN_BOUND_MS,
        `returned after ${Math.round(elapsedMs)}ms`,
      );
      assertMatch(out, /^timed out after 500ms \(killed/);
      assert(pid !== undefined, `no pid in: ${out}`);
      assertFalse(await isLive(pid), "the sleep outlived the timeout");
    } finally {
      await forceKill(pid);
    }
  });

  it("stops a pipeline whose members hold the output pipe", async () => {
    let pid: number | undefined;
    try {
      // `$!` rather than `$BASHPID`: macOS's /bin/bash is 3.2, which has no
      // BASHPID. The subshell and its sleep both hold the pipe to `cat` open.
      const { out, elapsedMs } = await runTimed(
        `( sleep 10 & echo "pid=$!"; wait ) | cat`,
      );
      pid = pidIn(out);
      assert(
        elapsedMs < RETURN_BOUND_MS,
        `returned after ${Math.round(elapsedMs)}ms`,
      );
      assertMatch(out, /^timed out after 500ms \(killed/);
      assert(pid !== undefined, `no pid in: ${out}`);
      assertFalse(await isLive(pid), "the sleep outlived the timeout");
    } finally {
      await forceKill(pid);
    }
  });

  it("reports a command that would finish after the deadline as killed, without its later output", async () => {
    const { out } = await runTimed(
      `echo before; ( sleep 2; echo after ) | cat`,
    );
    assertMatch(out, /^timed out after 500ms \(killed/);
    assertMatch(out, /^before$/m);
    assertFalse(/after$/m.test(out), `post-deadline output reported: ${out}`);
  });
});

// The requested timeout through the registered definition, as the agent loop
// invokes it: the executor resolves `timeoutSec` and the real runner honours
// it, for a command that finishes and for a tree that does not.
describe("bash with a requested timeoutSec against real processes", {
  ignore: !posix,
}, () => {
  const bash = defineBash(Deno.cwd());
  const context = { authzBasis: "policy:allow:operator-approved" };
  const call = (args: Record<string, unknown>): CommandCall => ({
    commandId: "bash",
    callId: "call-timeout",
    caller: { principalId: "operator", principalType: "human" },
    arguments: args,
  });

  it("runs a short command to its real exit code under a short requested timeout", async () => {
    const out = await bash.executor(
      call({ command: "echo requested; exit 3", timeoutSec: 5 }),
      context,
    );
    assertStrictEquals(out, "exit 3\nrequested");
  });

  it("stops the whole tree at the requested timeout, not the default", async () => {
    let pid: number | undefined;
    try {
      const start = performance.now();
      const out = await bash.executor(
        call({ command: `sleep 10 & echo "pid=$!"; wait`, timeoutSec: 1 }),
        context,
      );
      const elapsedMs = performance.now() - start;
      pid = pidIn(out);
      assert(
        elapsedMs < 1_000 + 4_000,
        `returned after ${Math.round(elapsedMs)}ms`,
      );
      assertMatch(out, /^timed out after 1000ms \(killed/);
      assert(pid !== undefined, `no pid in: ${out}`);
      assertFalse(
        await isLive(pid),
        "the sleep outlived the requested timeout",
      );
    } finally {
      await forceKill(pid);
    }
  });
});
