import { spawn } from "node:child_process";
import { afterEach, describe, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { processGroupSignalerEvalSource } from "../src/acp-client.ts";
import { selectedDenoExecutable } from "./deno-executable.ts";
import {
  acquireTestRunLock,
  discoverSurvivors,
  isEmptyReport,
  killPid,
  LOCK_WRITE_GRACE_MS,
  lockPath,
  operatorVitestLockPath,
  processIsAlive,
  recordSpawn,
  releaseTestRunLock,
  resolveBoundSec,
  runReaper,
  sweepTestRuntime,
  TestRunConflictError,
  vitestPgidPath,
} from "./test-process-harness.ts";

const prototypeRoot = fileURLToPath(new URL("..", import.meta.url)).replace(
  /[\\\/]$/,
  "",
);
const reaperScript = fileURLToPath(
  new URL("./test-process-reaper.ts", import.meta.url),
);
const cleanups: Array<() => Promise<void>> = [];
const spawnedPids: number[] = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  const survivors: number[] = [];
  for (const pid of spawnedPids) {
    if (await processIsAlive(pid)) survivors.push(pid);
  }
  spawnedPids.length = 0;
  expect(survivors, "harness processes remained after teardown").toEqual([]);
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

function trackPid(pid: number): number {
  spawnedPids.push(pid);
  cleanups.push(async () => {
    await killPid(pid, "SIGKILL");
  });
  return pid;
}

function spawnDetachedSleep(script: string): { pid: number } {
  const child = spawn("/bin/bash", ["-c", script], {
    detached: true,
    stdio: "ignore",
  });
  if (child.pid === undefined) throw new Error("detached spawn produced no pid");
  child.unref();
  return { pid: trackPid(child.pid) };
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
    await killPid(holder.pid, "SIGKILL");
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
    trackPid(child.pid);
    await waitUntil(async () => {
      try {
        const pid = Number(await Deno.readTextFile(pidFile));
        return Number.isSafeInteger(pid) && pid > 0;
      } catch {
        return false;
      }
    }, 2_000, "descendant pid file was not written");
    const descendantPid = Number(await Deno.readTextFile(pidFile));
    trackPid(descendantPid);
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
    trackPid(supervisor.pid);

    const reaper = spawn(selectedDenoExecutable(), [
      "run",
      "--allow-env",
      `--allow-read=${prototypeRoot},${tmpDir}`,
      `--allow-write=${tmpDir}`,
      "--allow-run=/bin/kill,/bin/ps,/bin/bash",
      reaperScript,
      "--supervisor-pid",
      String(supervisor.pid),
      "--deadline-epoch",
      String(Math.floor(Date.now() / 1000) + 30),
      "--tmp-dir",
      tmpDir,
    ], { detached: true, stdio: "ignore", cwd: prototypeRoot });
    if (reaper.pid === undefined) throw new Error("reaper spawn produced no pid");
    reaper.unref();
    trackPid(reaper.pid);

    await killPid(supervisor.pid, "SIGKILL");
    await waitUntil(
      async () => !await processIsAlive(descendantPid),
      8_000,
      "reaper did not kill the detached descendant after supervisor SIGKILL",
    );
    await waitUntil(async () => {
      const report = await discoverSurvivors({ tmpDir });
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
    trackPid(child.pid);
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
    trackPid(supervisor.pid);
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

  test("next run reaps a saved Vitest group after supervisor and reaper are both gone", async () => {
    const tmpDir = await scopedTmp();
    const vitestShaped = spawnDetachedSleep("sleep 60");
    await Deno.writeTextFile(vitestPgidPath(tmpDir), `${vitestShaped.pid}\n`);
    const holder = spawnDetachedSleep("sleep 60");
    await acquireTestRunLock({ tmpDir, boundSec: 30, pid: holder.pid });
    await killPid(holder.pid, "SIGKILL");
    await waitUntil(
      async () => !await processIsAlive(holder.pid),
      2_000,
      "stale lock holder did not exit",
    );
    const next = await acquireTestRunLock({
      tmpDir,
      boundSec: 30,
      pid: Deno.pid,
    });
    expect(next.pid).toBe(Deno.pid);
    await waitUntil(
      async () => !await processIsAlive(vitestShaped.pid),
      4_000,
      "stale-lock recovery left the saved Vitest group alive",
    );
    await expect(Deno.lstat(vitestPgidPath(tmpDir))).rejects.toBeInstanceOf(
      Deno.errors.NotFound,
    );
    await releaseTestRunLock(tmpDir);
  }, 15_000);

  test("force-killing a supervisor reaps a detached ACP signaler-shaped descendant", async () => {
    const tmpDir = await scopedTmp();
    const probe = spawn(selectedDenoExecutable(), [
      "eval",
      processGroupSignalerEvalSource(tmpDir),
    ], { detached: true, stdio: "ignore" });
    if (probe.pid === undefined) throw new Error("signaler spawn produced no pid");
    probe.unref();
    trackPid(probe.pid);
    await waitUntil(
      async () => await processIsAlive(probe.pid!),
      2_000,
      "signaler-shaped probe did not start",
    );

    const supervisor = spawn("/bin/bash", ["-c", "sleep 60"], {
      detached: true,
      stdio: "ignore",
    });
    if (supervisor.pid === undefined) {
      throw new Error("supervisor spawn produced no pid");
    }
    supervisor.unref();
    trackPid(supervisor.pid);

    const reaper = spawn(selectedDenoExecutable(), [
      "run",
      "--allow-env",
      `--allow-read=${prototypeRoot},${tmpDir}`,
      `--allow-write=${tmpDir}`,
      "--allow-run=/bin/kill,/bin/ps,/bin/bash",
      reaperScript,
      "--supervisor-pid",
      String(supervisor.pid),
      "--deadline-epoch",
      String(Math.floor(Date.now() / 1000) + 30),
      "--tmp-dir",
      tmpDir,
    ], { detached: true, stdio: "ignore", cwd: prototypeRoot });
    if (reaper.pid === undefined) throw new Error("reaper spawn produced no pid");
    reaper.unref();
    trackPid(reaper.pid);

    await killPid(supervisor.pid, "SIGKILL");
    await waitUntil(
      async () => !await processIsAlive(probe.pid!),
      8_000,
      "reaper did not kill the ACP signaler-shaped descendant",
    );
  }, 15_000);

  test("a second prototype root is refused and cannot reap the first root's children", async () => {
    const operatorHome = await scopedTmp();
    const rootA = await scopedTmp();
    const rootB = await scopedTmp();
    const lockFile = operatorVitestLockPath(operatorHome);
    const holder = spawnDetachedSleep("sleep 60");
    await acquireTestRunLock({
      tmpDir: rootA,
      lockFile,
      boundSec: 30,
      pid: holder.pid,
    });
    await expect(acquireTestRunLock({
      tmpDir: rootB,
      lockFile,
      boundSec: 30,
      pid: Deno.pid,
    })).rejects.toBeInstanceOf(TestRunConflictError);

    const foreign = spawnDetachedSleep(`sleep 60; echo ${rootB}`);
    await recordSpawn(rootB, {
      pid: foreign.pid,
      pgid: foreign.pid,
      kind: "serve-unix",
      sockets: [`${rootB}/other.sock`],
      locks: [`${rootB}/start-test-runtime-other.lock`],
      startedAt: new Date().toISOString(),
    });
    await Deno.writeTextFile(`${rootB}/start-test-runtime-other.lock`, "stale\n");
    const leftover = await sweepTestRuntime({ tmpDir: rootA, lockFile, graceMs: 200 });
    expect(isEmptyReport(leftover)).toBe(true);
    expect(await processIsAlive(foreign.pid)).toBe(true);
    expect(await Deno.readTextFile(`${rootB}/start-test-runtime-other.lock`))
      .toBe("stale\n");
    await releaseTestRunLock(rootA, lockFile);
  }, 15_000);

  test("an empty lock is reclaimed after the write grace", async () => {
    const tmpDir = await scopedTmp();
    await Deno.writeTextFile(lockPath(tmpDir), "");
    const started = performance.now();
    const next = await acquireTestRunLock({
      tmpDir,
      boundSec: 30,
      pid: Deno.pid,
    });
    expect(performance.now() - started).toBeGreaterThanOrEqual(
      LOCK_WRITE_GRACE_MS - 50,
    );
    expect(next.pid).toBe(Deno.pid);
    await releaseTestRunLock(tmpDir);
  }, 10_000);

  test("partial JSON in the lock is reclaimed after the write grace", async () => {
    const tmpDir = await scopedTmp();
    await Deno.writeTextFile(lockPath(tmpDir), '{"pid":');
    const next = await acquireTestRunLock({
      tmpDir,
      boundSec: 30,
      pid: Deno.pid,
    });
    expect(next.pid).toBe(Deno.pid);
    await releaseTestRunLock(tmpDir);
  }, 10_000);

  test("concurrent lock creation leaves one holder and one conflict", async () => {
    const tmpDir = await scopedTmp();
    const first = spawnDetachedSleep("sleep 60");
    const second = spawnDetachedSleep("sleep 60");
    const results = await Promise.allSettled([
      acquireTestRunLock({ tmpDir, boundSec: 30, pid: first.pid }),
      acquireTestRunLock({ tmpDir, boundSec: 30, pid: second.pid }),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      status: "rejected",
      reason: expect.any(TestRunConflictError),
    });
    await releaseTestRunLock(tmpDir);
  }, 10_000);

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
