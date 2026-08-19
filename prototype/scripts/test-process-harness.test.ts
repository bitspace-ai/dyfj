import { spawn } from "node:child_process";
import { afterEach, describe, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { selectedDenoExecutable } from "./deno-executable.ts";
import {
  acquireTestRunLock,
  discoverSurvivors,
  isEmptyReport,
  processIsAlive,
  recordSpawn,
  releaseTestRunLock,
  resolveBoundSec,
  runReaper,
  sweepTestRuntime,
  TestRunConflictError,
} from "./test-process-harness.ts";

const prototypeRoot = fileURLToPath(new URL("..", import.meta.url)).replace(
  /[\\\/]$/,
  "",
);
const reaperScript = fileURLToPath(
  new URL("./test-process-reaper.ts", import.meta.url),
);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  message: string,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error(message);
}

async function scopedTmp(): Promise<string> {
  await Deno.mkdir(".vitest-tmp", { recursive: true });
  const dir = await Deno.realPath(
    await Deno.makeTempDir({ dir: ".vitest-tmp", prefix: "harness-" }),
  );
  cleanups.push(async () => {
    await sweepTestRuntime({ tmpDir: dir, graceMs: 200 }).catch(() => undefined);
    await Deno.remove(dir, { recursive: true }).catch(() => undefined);
  });
  return dir;
}

function spawnDetachedSleep(script: string): { pid: number } {
  const child = spawn("/bin/bash", ["-c", script], {
    detached: true,
    stdio: "ignore",
  });
  if (child.pid === undefined) throw new Error("detached spawn produced no pid");
  child.unref();
  cleanups.push(async () => {
    try {
      Deno.kill(child.pid!, "SIGKILL");
    } catch {
      // Already reaped.
    }
  });
  return { pid: child.pid };
}

describe("test process harness", () => {
  test("an exclusive lock refuses a second run while the first pid is alive", async () => {
    const tmpDir = await scopedTmp();
    const holder = spawnDetachedSleep("sleep 60");
    await acquireTestRunLock({ tmpDir, boundSec: 30, pid: holder.pid });
    await expect(acquireTestRunLock({
      tmpDir,
      boundSec: 30,
      pid: Deno.pid,
    })).rejects.toBeInstanceOf(TestRunConflictError);
  });

  test("a dead lock is swept and replaced", async () => {
    const tmpDir = await scopedTmp();
    const holder = spawnDetachedSleep("sleep 60");
    await acquireTestRunLock({ tmpDir, boundSec: 30, pid: holder.pid });
    Deno.kill(holder.pid, "SIGKILL");
    await waitUntil(
      async () => !await processIsAlive(holder.pid),
      2_000,
      "lock holder did not exit",
    );
    const next = await acquireTestRunLock({
      tmpDir,
      boundSec: 30,
      pid: Deno.pid,
    });
    expect(next.pid).toBe(Deno.pid);
    await releaseTestRunLock(tmpDir);
  });

  test("force-killing a supervisor-shaped process reaps a detached launcher-shaped descendant", async () => {
    const tmpDir = await scopedTmp();
    const home = `${tmpDir}/home`;
    const runDir = `${home}/.dyfj/run`;
    await Deno.mkdir(runDir, { recursive: true });
    const socket = `${tmpDir}/test-runtime.sock`;
    const lock = `${runDir}/start-test-runtime-deadbeef.lock`;
    const pidFile = `${tmpDir}/descendant.pid`;

    const child = spawn("/bin/bash", [
      "-c",
      'echo "$$" > "$1"; : > "$2"; printf "stale\\n" > "$3"; while :; do sleep 1; done',
      "descendant",
      pidFile,
      socket,
      lock,
    ], { detached: true, stdio: "ignore" });
    if (child.pid === undefined) throw new Error("descendant spawn produced no pid");
    child.unref();
    cleanups.push(async () => {
      try {
        Deno.kill(child.pid!, "SIGKILL");
      } catch {
        // Already reaped.
      }
    });
    await waitUntil(async () => {
      try {
        const pid = Number(await Deno.readTextFile(pidFile));
        return Number.isSafeInteger(pid) && pid > 0;
      } catch {
        return false;
      }
    }, 2_000, "descendant pid file was not written");
    const descendantPid = Number(await Deno.readTextFile(pidFile));
    await recordSpawn(tmpDir, {
      pid: descendantPid,
      pgid: child.pid,
      kind: "launcher-supervisor",
      sockets: [socket],
      locks: [lock],
      command: "test-runtime.sock",
      startedAt: new Date().toISOString(),
    });

    const supervisor = spawn("/bin/bash", ["-c", "sleep 60"], {
      detached: true,
      stdio: "ignore",
    });
    if (supervisor.pid === undefined) {
      throw new Error("supervisor spawn produced no pid");
    }
    supervisor.unref();
    cleanups.push(async () => {
      try {
        Deno.kill(supervisor.pid!, "SIGKILL");
      } catch {
        // Already reaped.
      }
    });

    const reaper = spawn(selectedDenoExecutable(), [
      "run",
      "--allow-env",
      `--allow-read=${prototypeRoot},${tmpDir},${runDir}`,
      `--allow-write=${tmpDir},${runDir}`,
      "--allow-run=/bin/kill,/bin/ps,/bin/bash",
      reaperScript,
      "--supervisor-pid",
      String(supervisor.pid),
      "--deadline-epoch",
      String(Math.floor(Date.now() / 1000) + 30),
      "--tmp-dir",
      tmpDir,
      "--home",
      home,
    ], { detached: true, stdio: "ignore", cwd: prototypeRoot });
    if (reaper.pid === undefined) throw new Error("reaper spawn produced no pid");
    reaper.unref();
    cleanups.push(async () => {
      try {
        Deno.kill(reaper.pid!, "SIGKILL");
      } catch {
        // Already reaped.
      }
    });

    Deno.kill(supervisor.pid, "SIGKILL");
    await waitUntil(
      async () => !await processIsAlive(descendantPid),
      8_000,
      "reaper did not kill the detached descendant after supervisor SIGKILL",
    );
    await waitUntil(async () => {
      const report = await discoverSurvivors({ tmpDir, extraHomes: [home] });
      return isEmptyReport(report);
    }, 4_000, "socket or lock survived the reaper sweep");
  }, 15_000);

  test("a hung recorded child fails the reaper bound instead of surviving", async () => {
    const tmpDir = await scopedTmp();
    const child = spawn("/bin/bash", ["-c", "while :; do sleep 1; done"], {
      detached: true,
      stdio: "ignore",
    });
    if (child.pid === undefined) throw new Error("hung child spawn produced no pid");
    child.unref();
    cleanups.push(async () => {
      try {
        Deno.kill(child.pid!, "SIGKILL");
      } catch {
        // Already reaped.
      }
    });
    await recordSpawn(tmpDir, {
      pid: child.pid,
      pgid: child.pid,
      kind: "serve-unix",
      sockets: [],
      locks: [],
      startedAt: new Date().toISOString(),
    });
    const supervisor = spawn("/bin/bash", ["-c", "sleep 60"], {
      detached: true,
      stdio: "ignore",
    });
    if (supervisor.pid === undefined) {
      throw new Error("supervisor spawn produced no pid");
    }
    supervisor.unref();
    cleanups.push(async () => {
      try {
        Deno.kill(supervisor.pid!, "SIGKILL");
      } catch {
        // Already reaped.
      }
    });
    const code = await runReaper({
      supervisorPid: supervisor.pid,
      deadlineEpochSec: Math.floor(Date.now() / 1000) + 1,
      tmpDir,
    });
    expect(code).toBe(124);
    await waitUntil(
      async () => !await processIsAlive(child.pid!),
      4_000,
      "bound breach left the hung child alive",
    );
  }, 15_000);

  test("focused args select the short bound unless DYFJ_TEST_BOUND_SEC is set", () => {
    expect(resolveBoundSec(["run", "--root", "."], { get: () => undefined }))
      .toBe(600);
    expect(resolveBoundSec(
      ["run", "scripts/test-process-harness.test.ts"],
      { get: () => undefined },
    )).toBe(180);
    expect(resolveBoundSec(["run", "-t", "force-killing"], {
      get: () => undefined,
    })).toBe(180);
    expect(resolveBoundSec(["run", "-t", "force-killing"], {
      get: (name) => name === "DYFJ_TEST_BOUND_SEC" ? "45" : undefined,
    })).toBe(45);
  });
});
