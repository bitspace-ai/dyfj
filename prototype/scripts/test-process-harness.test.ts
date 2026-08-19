import { spawn } from "node:child_process";
import { afterEach, describe, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { processGroupSignalerEvalSource } from "../src/acp-client.ts";
import { selectedDenoExecutable } from "./deno-executable.ts";
import {
  acquireTestRunLock,
  captureProcessIdentity,
  discoverSurvivors,
  isEmptyReport,
  killPid,
  lockPath,
  operatorVitestLockPath,
  processIsAlive,
  readLockFile,
  reapSavedVitestGroup,
  recordSpawn,
  releaseTestRunLock,
  requireOperatorLockFile,
  resolveBoundSec,
  runReaper,
  sweepStagingFiles,
  sweepTestRuntime,
  TestRunConflictError,
  vitestPgidPath,
  writeVitestGroupIdentity,
} from "./test-process-harness.ts";

const prototypeRoot = fileURLToPath(new URL("..", import.meta.url)).replace(
  /[\\\/]$/,
  "",
);
const reaperScript = fileURLToPath(
  new URL("./test-process-reaper.ts", import.meta.url),
);
const harnessScript = fileURLToPath(
  new URL("./test-process-harness.ts", import.meta.url),
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

function spawnLockContender(
  tmpDir: string,
  lockFile: string,
): { pid: number; resultPath: string } {
  const resultPath = `${tmpDir}/contender-${crypto.randomUUID()}.result`;
  const lockDir = lockFile.slice(0, lockFile.lastIndexOf("/"));
  const child = spawn(selectedDenoExecutable(), [
    "run",
    "--allow-env",
    `--allow-read=${prototypeRoot},${tmpDir},${lockDir}`,
    `--allow-write=${tmpDir},${lockDir}`,
    "--allow-run=/bin/kill,/bin/ps,/bin/bash",
    harnessScript,
    "acquire-hold",
  ], {
    detached: true,
    stdio: "ignore",
    cwd: prototypeRoot,
    env: {
      ...Deno.env.toObject(),
      DYFJ_LOCK_TMP: tmpDir,
      DYFJ_LOCK_FILE: lockFile,
      DYFJ_LOCK_RESULT: resultPath,
    },
  });
  if (child.pid === undefined) throw new Error("contender spawn produced no pid");
  child.unref();
  return { pid: trackPid(child.pid), resultPath };
}

async function waitForContenderResults(
  paths: string[],
): Promise<string[]> {
  await waitUntil(async () => {
    const texts = await Promise.all(
      paths.map((path) => Deno.readTextFile(path).catch(() => "")),
    );
    return texts.every((text) =>
      text.startsWith("acquired ") || text.startsWith("conflict ")
    );
  }, 8_000, "lock contenders did not report acquire or conflict");
  return await Promise.all(paths.map((path) => Deno.readTextFile(path)));
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
    await releaseTestRunLock({ tmpDir, generation: next.generation });
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

  test("matching Vitest group identity is reaped on stale-lock recovery", async () => {
    const tmpDir = await scopedTmp();
    const vitestShaped = spawnDetachedSleep("sleep 60");
    const captured = await captureProcessIdentity(vitestShaped.pid);
    expect(captured).not.toBeNull();
    const holder = spawnDetachedSleep("sleep 60");
    const held = await acquireTestRunLock({
      tmpDir,
      boundSec: 30,
      pid: holder.pid,
    });
    await writeVitestGroupIdentity(tmpDir, {
      pgid: captured!.pgid,
      leaderPid: vitestShaped.pid,
      lstart: captured!.lstart,
      command: captured!.command,
      generation: held.generation,
      tmpDir,
    });
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
      "stale-lock recovery left the matching Vitest group alive",
    );
    await expect(Deno.lstat(vitestPgidPath(tmpDir))).rejects.toBeInstanceOf(
      Deno.errors.NotFound,
    );
    await releaseTestRunLock({ tmpDir, generation: next.generation });
  }, 15_000);

  test("a recycled process-group number is not killed", async () => {
    const tmpDir = await scopedTmp();
    const foreign = spawnDetachedSleep("sleep 60");
    await writeVitestGroupIdentity(tmpDir, {
      pgid: foreign.pid,
      leaderPid: foreign.pid,
      lstart: "Thu Jan  1 00:00:00 1970",
      command: "/bin/bash -c sleep 60",
      generation: "other-run",
      tmpDir,
    });
    await reapSavedVitestGroup(tmpDir);
    expect(await processIsAlive(foreign.pid)).toBe(true);
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
    expect(await processIsAlive(foreign.pid)).toBe(true);
    await releaseTestRunLock({ tmpDir, generation: next.generation });
  }, 15_000);

  test("leader-gone identity with a mismatched tmp dir does not kill a foreign member", async () => {
    const tmpDir = await scopedTmp();
    const memberPidFile = `${tmpDir}/member.pid`;
    const leader = spawn("/bin/bash", [
      "-c",
      'sleep 60 & echo $! > "$1"; exit 0',
      "leader",
      memberPidFile,
    ], { detached: true, stdio: "ignore" });
    if (leader.pid === undefined) throw new Error("leader spawn produced no pid");
    leader.unref();
    trackPid(leader.pid);
    await waitUntil(async () => {
      try {
        const pid = Number(await Deno.readTextFile(memberPidFile));
        return Number.isSafeInteger(pid) && pid > 0 &&
          !await processIsAlive(leader.pid!) &&
          await processIsAlive(pid);
      } catch {
        return false;
      }
    }, 2_000, "leader-gone member did not remain after the leader exited");
    const memberPid = Number(await Deno.readTextFile(memberPidFile));
    trackPid(memberPid);
    await writeVitestGroupIdentity(tmpDir, {
      pgid: leader.pid,
      leaderPid: leader.pid,
      lstart: "Thu Jan  1 00:00:00 1970",
      command: "/bin/bash -c sleep 60",
      generation: "stale-generation",
      tmpDir: "/",
    });
    await reapSavedVitestGroup(tmpDir, "expected-generation");
    expect(await processIsAlive(memberPid)).toBe(true);
  }, 10_000);

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
    const held = await acquireTestRunLock({
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
    await releaseTestRunLock({
      tmpDir: rootA,
      lockFile,
      generation: held.generation,
    });
  }, 15_000);

  test("an empty lock is reclaimed", async () => {
    const tmpDir = await scopedTmp();
    await Deno.writeTextFile(lockPath(tmpDir), "");
    const next = await acquireTestRunLock({
      tmpDir,
      boundSec: 30,
      pid: Deno.pid,
    });
    expect(next.pid).toBe(Deno.pid);
    await releaseTestRunLock({ tmpDir, generation: next.generation });
  }, 10_000);

  test("partial JSON in the lock is reclaimed", async () => {
    const tmpDir = await scopedTmp();
    await Deno.writeTextFile(lockPath(tmpDir), '{"pid":');
    const next = await acquireTestRunLock({
      tmpDir,
      boundSec: 30,
      pid: Deno.pid,
    });
    expect(next.pid).toBe(Deno.pid);
    await releaseTestRunLock({ tmpDir, generation: next.generation });
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
    const winner = fulfilled[0] as PromiseFulfilledResult<{ generation: string }>;
    await releaseTestRunLock({ tmpDir, generation: winner.value.generation });
  }, 10_000);

  test("two processes reclaiming a valid stale lock yield one owner", async () => {
    const tmpDir = await scopedTmp();
    const lockFile = lockPath(tmpDir);
    const holder = spawnDetachedSleep("sleep 60");
    await acquireTestRunLock({ tmpDir, boundSec: 30, pid: holder.pid });
    await killPid(holder.pid, "SIGKILL");
    await waitUntil(
      async () => !await processIsAlive(holder.pid),
      2_000,
      "stale lock holder did not exit",
    );
    const first = spawnLockContender(tmpDir, lockFile);
    const second = spawnLockContender(tmpDir, lockFile);
    const texts = await waitForContenderResults([
      first.resultPath,
      second.resultPath,
    ]);
    const acquired = texts.filter((text) => text.startsWith("acquired "));
    const conflicts = texts.filter((text) => text.startsWith("conflict "));
    expect(acquired).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    const generation = acquired[0]!.trim().slice("acquired ".length);
    const held = await readLockFile(tmpDir, lockFile);
    expect(held?.generation).toBe(generation);
    const winnerPid = acquired[0] === texts[0] ? first.pid : second.pid;
    expect(held?.pid).toBe(winnerPid);
  }, 15_000);

  test("two processes reclaiming a malformed stale lock yield one owner", async () => {
    const tmpDir = await scopedTmp();
    const lockFile = lockPath(tmpDir);
    await Deno.writeTextFile(lockFile, '{"pid":');
    const first = spawnLockContender(tmpDir, lockFile);
    const second = spawnLockContender(tmpDir, lockFile);
    const texts = await waitForContenderResults([
      first.resultPath,
      second.resultPath,
    ]);
    const acquired = texts.filter((text) => text.startsWith("acquired "));
    const conflicts = texts.filter((text) => text.startsWith("conflict "));
    expect(acquired).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    const generation = acquired[0]!.trim().slice("acquired ".length);
    const held = await readLockFile(tmpDir, lockFile);
    expect(held?.generation).toBe(generation);
  }, 15_000);

  test("two prototype roots reclaiming a stale operator lock yield one owner", async () => {
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
    await killPid(holder.pid, "SIGKILL");
    await waitUntil(
      async () => !await processIsAlive(holder.pid),
      2_000,
      "stale lock holder did not exit",
    );
    const first = spawnLockContender(rootA, lockFile);
    const second = spawnLockContender(rootB, lockFile);
    const texts = await waitForContenderResults([
      first.resultPath,
      second.resultPath,
    ]);
    const acquired = texts.filter((text) => text.startsWith("acquired "));
    const conflicts = texts.filter((text) => text.startsWith("conflict "));
    expect(acquired).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    const generation = acquired[0]!.trim().slice("acquired ".length);
    const held = await readLockFile(rootA, lockFile);
    expect(held?.generation).toBe(generation);
    const winnerTmp = acquired[0] === texts[0] ? rootA : rootB;
    expect(held?.tmpDir).toBe(winnerTmp);
  }, 15_000);

  test("stale lock staging files are reaped before and after the hard-link", async () => {
    const tmpDir = await scopedTmp();
    const lockFile = lockPath(tmpDir);
    const before = spawnDetachedSleep("sleep 60");
    await killPid(before.pid, "SIGKILL");
    await waitUntil(
      async () => !await processIsAlive(before.pid),
      2_000,
      "staging pid did not exit",
    );
    const stagingBefore =
      `${lockFile}.${before.pid}.${crypto.randomUUID()}.writing`;
    await Deno.writeTextFile(stagingBefore, "{}\n");
    const first = await acquireTestRunLock({
      tmpDir,
      boundSec: 30,
      pid: Deno.pid,
    });
    await expect(Deno.lstat(stagingBefore)).rejects.toBeInstanceOf(
      Deno.errors.NotFound,
    );
    const stagingAfter =
      `${lockFile}.${before.pid}.${crypto.randomUUID()}.writing`;
    await Deno.writeTextFile(stagingAfter, `${JSON.stringify(first)}\n`);
    await sweepStagingFiles(lockFile);
    await expect(Deno.lstat(stagingAfter)).rejects.toBeInstanceOf(
      Deno.errors.NotFound,
    );
    await releaseTestRunLock({ tmpDir, generation: first.generation });
  }, 10_000);

  test("supervised runs require an absolute HOME for the operator lock", () => {
    expect(() => requireOperatorLockFile(undefined)).toThrow(
      "absolute HOME",
    );
    expect(() => requireOperatorLockFile("home")).toThrow("absolute HOME");
    expect(requireOperatorLockFile("/tmp/dyfj-operator")).toBe(
      "/tmp/dyfj-operator/.dyfj/run/dyfj-vitest-run.lock",
    );
  });

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
