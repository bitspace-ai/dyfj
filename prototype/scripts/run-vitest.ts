/**
 * Prototype Vitest launcher. `run ...` is supervised: exclusive lock, wall-clock
 * bound, Vitest in its own process group, and a detached sibling reaper.
 *
 * Signal coverage:
 * - SIGTERM/SIGINT to this supervisor: process-group kill + sweep
 * - SIGKILL of Vitest only: this process sees exit and sweeps
 * - SIGKILL of this supervisor: the sibling reaper sweeps
 * - SIGKILL of supervisor and reaper together: not covered in-process; the next
 *   `run` reclaims the operator-scoped lock and TERM-then-KILL the saved Vitest
 *   process group only when a recovering run generation is supplied and the
 *   recorded recovery directory, run generation, leader start time, and command
 *   still match. If the saved leader is gone, or the lock is malformed so no
 *   generation can be recovered, the numeric group is left alive. A spawn
 *   manifest PID is not kill authority unless that record carries matching
 *   start time, command, recovery directory, and run generation. Run-scoped
 *   discovery still reaps descendants whose command names this run's tmp dir.
 *   Supervised runs fail closed without an absolute HOME.
 *
 * `--version` / other non-`run` args stay an unsupervised passthrough so
 * existing launcher probes keep working.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveEsbuildBinary } from "./esbuild-binary.ts";
import { selectedDenoExecutable } from "./deno-executable.ts";
import {
  acquireTestRunLock,
  captureProcessIdentity,
  donePath,
  formatSurvivorReport,
  harnessDir,
  isEmptyReport,
  isSupervisedVitestInvocation,
  killPid,
  killProcessGroup,
  markRunDone,
  REAP_TERM_GRACE_MS,
  recordSpawn,
  releaseTestRunLock,
  requireOperatorLockFile,
  resolveBoundSec,
  sweepTestRuntime,
  TEST_RUN_DIR_ENV,
  TestRunConflictError,
  writeVitestGroupIdentity,
} from "./test-process-harness.ts";

const prototypeRoot = fileURLToPath(new URL("..", import.meta.url)).replace(
  /[\\\/]$/,
  "",
);
const esbuildBinary = await resolveEsbuildBinary(prototypeRoot);
const denoExecutable = selectedDenoExecutable();
const extraReads = await extraReadGrants();
const reaperScript = fileURLToPath(
  new URL("./test-process-reaper.ts", import.meta.url),
);

async function extraReadGrants(): Promise<string[]> {
  try {
    const real = await Deno.realPath(`${prototypeRoot}/node_modules`);
    const local = `${prototypeRoot}/node_modules`;
    return real === local ? [] : [real];
  } catch {
    return [];
  }
}

function vitestArgs(args: string[], extraReads: string[]): string[] {
  const read = [
    ".",
    "..",
    "/tmp",
    "/private/tmp",
    "/var/folders",
    "/private/var/folders",
    ...extraReads,
  ].join(",");
  const ffi = ["node_modules", ...extraReads].join(",");
  return [
    "run",
    "-P=test",
    `--allow-read=${read}`,
    "--allow-write=.,/tmp,/private/tmp,/var/folders,/private/var/folders",
    `--allow-run=bash,/bin/bash,${denoExecutable},/bin/kill,/bin/sh,/bin/ps,${esbuildBinary}`,
    `--allow-ffi=${ffi}`,
    "npm:vitest@3.2.6",
    ...args,
  ];
}

function spawnDetached(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    stdio: "inherit" | "ignore";
  },
): ChildProcess {
  return spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: options.stdio,
  });
}

function waitForExit(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null) {
        resolve(signal === "SIGKILL" ? 137 : 1);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

async function stopProcessGroup(pgid: number | undefined): Promise<void> {
  if (pgid === undefined || pgid <= 1) return;
  await killProcessGroup(pgid, "SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, REAP_TERM_GRACE_MS));
  await killProcessGroup(pgid, "SIGKILL");
}

function operatorHome(): string | undefined {
  const home = Deno.env.get("HOME");
  if (home === undefined || !home.startsWith("/")) return undefined;
  return home;
}

function fixtureAgentNeedle(): string {
  return fileURLToPath(new URL("./acp-fixture-agent.ts", import.meta.url));
}

async function passthrough(args: string[]): Promise<number> {
  const child = new Deno.Command(denoExecutable, {
    args: vitestArgs(args, extraReads),
    cwd: prototypeRoot,
    env: {
      ...Deno.env.toObject(),
      ESBUILD_BINARY_PATH: `${prototypeRoot}/${esbuildBinary}`,
    },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  const forwardSignal = (signal: Deno.Signal) => {
    try {
      child.kill(signal);
    } catch {
      // The child exited while the signal was being delivered.
    }
  };
  const onSigint = () => forwardSignal("SIGINT");
  const onSigterm = () => forwardSignal("SIGTERM");
  Deno.addSignalListener("SIGINT", onSigint);
  Deno.addSignalListener("SIGTERM", onSigterm);
  try {
    return (await child.status).code;
  } finally {
    Deno.removeSignalListener("SIGINT", onSigint);
    Deno.removeSignalListener("SIGTERM", onSigterm);
  }
}

async function supervised(args: string[]): Promise<number> {
  if (Deno.build.os === "windows") {
    console.error(
      "dyfj: supervised Vitest execution requires process groups (unavailable on Windows)",
    );
    return 1;
  }
  const tmpDir = harnessDir(prototypeRoot);
  await Deno.mkdir(tmpDir, { recursive: true });
  const boundSec = resolveBoundSec(args);
  let lockFile: string;
  try {
    lockFile = requireOperatorLockFile(operatorHome());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`dyfj: ${message}`);
    return 1;
  }
  const commandNeedles = [fixtureAgentNeedle()];
  let runLock;
  try {
    runLock = await acquireTestRunLock({
      tmpDir,
      boundSec,
      pid: Deno.pid,
      lockFile,
      commandNeedles,
    });
  } catch (error) {
    if (error instanceof TestRunConflictError) {
      console.error(`dyfj: ${error.message}`);
      return 1;
    }
    throw error;
  }

  const deadlineEpochSec = Math.floor(Date.now() / 1000) + boundSec;
  const lockDir = lockFile.slice(0, lockFile.lastIndexOf("/"));
  const reaperRead = [".", tmpDir, lockDir];
  const reaperWrite = [tmpDir, lockDir];
  const reaper = spawnDetached(denoExecutable, [
    "run",
    "--allow-env",
    `--allow-read=${reaperRead.join(",")}`,
    `--allow-write=${reaperWrite.join(",")}`,
    "--allow-run=/bin/kill,/bin/ps,/bin/bash",
    reaperScript,
    "--supervisor-pid",
    String(Deno.pid),
    "--deadline-epoch",
    String(deadlineEpochSec),
    "--tmp-dir",
    tmpDir,
    ...commandNeedles.flatMap((needle) => ["--command-needle", needle]),
    "--lock-file",
    lockFile,
    "--generation",
    runLock.generation,
  ], {
    cwd: prototypeRoot,
    env: Deno.env.toObject(),
    stdio: "ignore",
  });
  const reaperPid = reaper.pid;
  reaper.unref();

  const ignorePids = new Set<number>([Deno.pid]);
  if (reaperPid !== undefined) ignorePids.add(reaperPid);
  const ignorePgids = new Set<number>();
  if (reaperPid !== undefined) ignorePgids.add(reaperPid);

  let vitest: ChildProcess | undefined;
  let vitestPgid: number | undefined;
  let timedOut = false;
  let signalled = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    void stopProcessGroup(vitestPgid);
  }, boundSec * 1_000);

  const onSigint = () => {
    signalled = true;
    void stopProcessGroup(vitestPgid);
  };
  const onSigterm = () => {
    signalled = true;
    void stopProcessGroup(vitestPgid);
  };
  Deno.addSignalListener("SIGINT", onSigint);
  Deno.addSignalListener("SIGTERM", onSigterm);

  let exitCode = 1;
  try {
    vitest = spawnDetached(denoExecutable, vitestArgs(args, extraReads), {
      cwd: prototypeRoot,
      env: {
        ...Deno.env.toObject(),
        ESBUILD_BINARY_PATH: `${prototypeRoot}/${esbuildBinary}`,
        [TEST_RUN_DIR_ENV]: tmpDir,
      },
      stdio: "inherit",
    });
    vitestPgid = vitest.pid;
    if (vitestPgid !== undefined) {
      const captured = await captureProcessIdentity(vitestPgid);
      if (captured !== null) {
        await writeVitestGroupIdentity(tmpDir, {
          pgid: captured.pgid,
          leaderPid: vitestPgid,
          lstart: captured.lstart,
          command: captured.command,
          generation: runLock.generation,
          tmpDir,
        });
      }
      await recordSpawn(tmpDir, {
        pid: vitestPgid,
        pgid: captured?.pgid ?? vitestPgid,
        kind: "vitest",
        sockets: [],
        locks: [],
        command: captured?.command,
        lstart: captured?.lstart,
        generation: runLock.generation,
        tmpDir,
        startedAt: new Date().toISOString(),
      });
    }
    exitCode = await waitForExit(vitest);
    if (timedOut) {
      console.error(
        `dyfj: test run exceeded the ${boundSec}s wall-clock bound`,
      );
      exitCode = 124;
    } else if (signalled) {
      exitCode = 1;
    }
  } finally {
    clearTimeout(timeout);
    Deno.removeSignalListener("SIGINT", onSigint);
    Deno.removeSignalListener("SIGTERM", onSigterm);
    await stopProcessGroup(vitestPgid);
    const leftovers = await sweepTestRuntime({
      tmpDir,
      ignorePids,
      ignorePgids,
      commandNeedles,
      lockFile,
      expectedGeneration: runLock.generation,
    });
    await markRunDone(tmpDir);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await releaseTestRunLock({
      tmpDir,
      lockFile,
      generation: runLock.generation,
    });
    if (reaperPid !== undefined) {
      await killPid(reaperPid, "SIGTERM");
    }
    if (!isEmptyReport(leftovers)) {
      console.error("dyfj: surviving test-runtime children after sweep:");
      console.error(formatSurvivorReport(leftovers));
      exitCode = exitCode === 0 ? 1 : exitCode;
    }
    try {
      await Deno.remove(donePath(tmpDir));
    } catch {
      // Already removed with the lock.
    }
  }
  return exitCode;
}

if (import.meta.main) {
  const args = Deno.args;
  const code = isSupervisedVitestInvocation(args)
    ? await supervised(args)
    : await passthrough(args);
  Deno.exit(code);
}
