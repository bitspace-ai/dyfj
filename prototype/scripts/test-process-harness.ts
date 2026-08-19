/**
 * Test-only process supervision: exclusive run lock, spawn manifest, survivor
 * discovery, and TERM-then-KILL reaping. Used by `run-vitest.ts` and the
 * detached sibling reaper. Does not change production launcher behavior.
 *
 * Coverage is documented on `run-vitest.ts`. In-process `afterEach` cannot
 * run under SIGKILL; this module is the path that can.
 */

export const DEFAULT_TEST_BOUND_SEC = 600;
export const FOCUSED_TEST_BOUND_SEC = 180;
export const REAP_TERM_GRACE_MS = 1_000;
export const REAPER_POLL_MS = 200;

export interface SpawnRecord {
  pid: number;
  pgid?: number;
  kind: string;
  sockets: string[];
  locks: string[];
  command?: string;
  startedAt: string;
}

export interface ProcessInfo {
  pid: number;
  ppid: number;
  pgid: number;
  command: string;
}

export interface SurvivorReport {
  processes: ProcessInfo[];
  sockets: string[];
  locks: string[];
}

export interface TestRunLock {
  pid: number;
  startedAt: string;
  boundSec: number;
  tmpDir: string;
}

export class TestRunConflictError extends Error {
  override readonly name = "TestRunConflictError";
  constructor(readonly existing: TestRunLock) {
    super(
      `a test run is already active (pid ${existing.pid}, started ${existing.startedAt}). ` +
        "Stop it before starting another.",
    );
  }
}

export function harnessDir(prototypeRoot: string): string {
  return `${prototypeRoot}/.vitest-tmp`;
}

export function lockPath(tmpDir: string): string {
  return `${tmpDir}/test-run.lock`;
}

export function donePath(tmpDir: string): string {
  return `${tmpDir}/test-run.done`;
}

export function manifestDir(tmpDir: string): string {
  return `${tmpDir}/spawn-manifest`;
}

export function vitestPgidPath(tmpDir: string): string {
  return `${tmpDir}/vitest.pgid`;
}

export function resolveBoundSec(
  args: string[],
  env: { get(name: string): string | undefined } = Deno.env,
): number {
  const raw = env.get("DYFJ_TEST_BOUND_SEC");
  if (raw !== undefined && raw !== "") {
    if (!/^[1-9][0-9]{0,5}$/.test(raw)) {
      throw new Error(`DYFJ_TEST_BOUND_SEC must be a positive integer, got ${raw}`);
    }
    return Number(raw);
  }
  const focused = args.some((arg) =>
    arg.endsWith(".test.ts") ||
    arg.endsWith(".spec.ts") ||
    arg === "-t" ||
    arg === "--testNamePattern" ||
    arg.startsWith("--testNamePattern=")
  );
  return focused ? FOCUSED_TEST_BOUND_SEC : DEFAULT_TEST_BOUND_SEC;
}

export function isSupervisedVitestInvocation(args: string[]): boolean {
  return args[0] === "run";
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function processIsAlive(pid: number): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  const status = await new Deno.Command("/bin/bash", {
    args: [
      "-c",
      'state=$(ps -o stat= -p "$1" 2>/dev/null) || exit 1; set -- $state; case "${1:-}" in ""|Z*) exit 1;; esac',
      "bash",
      String(pid),
    ],
    stdout: "null",
    stderr: "null",
  }).output();
  return status.success;
}

export async function listProcesses(): Promise<ProcessInfo[]> {
  const output = await new Deno.Command("/bin/ps", {
    args: ["-ax", "-o", "pid=,ppid=,pgid=,command="],
    stdout: "piped",
    stderr: "null",
  }).output();
  if (!output.success) return [];
  const text = new TextDecoder().decode(output.stdout);
  const processes: ProcessInfo[] = [];
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    processes.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      command: match[4],
    });
  }
  return processes;
}

async function sendKill(
  spec: string,
  signal: "SIGTERM" | "SIGKILL",
): Promise<void> {
  const flag = signal === "SIGKILL" ? "-KILL" : "-TERM";
  await new Deno.Command("/bin/kill", {
    args: [flag, spec],
    stdout: "null",
    stderr: "null",
  }).output().catch(() => undefined);
}

export async function killPid(
  pid: number,
  signal: "SIGTERM" | "SIGKILL",
): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 1) return;
  await sendKill(String(pid), signal);
}

export async function killProcessGroup(
  pgid: number,
  signal: "SIGTERM" | "SIGKILL",
): Promise<void> {
  if (!Number.isSafeInteger(pgid) || pgid <= 1) return;
  await sendKill(`-${pgid}`, signal);
}

export async function reapPidsAndCommandsContaining(
  pids: number[],
  needle: string,
  opts: { graceMs?: number } = {},
): Promise<void> {
  const targets = new Set(pids.filter((pid) => Number.isSafeInteger(pid) && pid > 1));
  if (needle !== "") {
    for (const proc of await listProcesses()) {
      if (proc.command.includes(needle)) targets.add(proc.pid);
    }
  }
  for (const pid of targets) await killPid(pid, "SIGTERM");
  await delay(opts.graceMs ?? 200);
  for (const pid of targets) await killPid(pid, "SIGKILL");
}

export async function ensureHarnessDirs(tmpDir: string): Promise<void> {
  await Deno.mkdir(manifestDir(tmpDir), { recursive: true });
}

export async function recordSpawn(
  tmpDir: string,
  record: SpawnRecord,
): Promise<void> {
  await ensureHarnessDirs(tmpDir);
  const path = `${manifestDir(tmpDir)}/${record.pid}-${crypto.randomUUID()}.json`;
  await Deno.writeTextFile(path, `${JSON.stringify(record)}\n`);
}

export async function loadManifest(tmpDir: string): Promise<SpawnRecord[]> {
  const dir = manifestDir(tmpDir);
  const records: SpawnRecord[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.isFile || !entry.name.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(await Deno.readTextFile(`${dir}/${entry.name}`));
        if (
          typeof parsed === "object" && parsed !== null &&
          Number.isSafeInteger(parsed.pid) && parsed.pid > 0
        ) {
          records.push(parsed as SpawnRecord);
        }
      } catch {
        // Ignore a truncated record from a killed writer.
      }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return records;
}

export async function clearManifest(tmpDir: string): Promise<void> {
  const dir = manifestDir(tmpDir);
  try {
    await Deno.remove(dir, { recursive: true });
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  await ensureHarnessDirs(tmpDir);
}

async function walkFiles(root: string, names: string[]): Promise<void> {
  try {
    for await (const entry of Deno.readDir(root)) {
      const path = `${root}/${entry.name}`;
      if (entry.isDirectory) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        await walkFiles(path, names);
      } else if (entry.isFile) {
        names.push(path);
      }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

function isTestLockName(name: string): boolean {
  return name.startsWith("start-test-runtime-") && name.endsWith(".lock");
}

function commandLooksLikeTestRuntime(
  command: string,
  tmpDir: string,
  sockets: string[],
  includeDetachedFixtures: boolean,
): boolean {
  if (command.includes(tmpDir)) return true;
  for (const socket of sockets) {
    if (socket !== "" && command.includes(socket)) return true;
  }
  if (includeDetachedFixtures && command.includes("acp-fixture-agent")) {
    return true;
  }
  return false;
}

export async function discoverSurvivors(opts: {
  tmpDir: string;
  extraHomes?: string[];
  ignorePids?: Set<number>;
  ignorePgids?: Set<number>;
  includeDetachedFixtures?: boolean;
}): Promise<SurvivorReport> {
  const tmpDir = opts.tmpDir;
  const ignorePids = opts.ignorePids ?? new Set();
  const ignorePgids = opts.ignorePgids ?? new Set();
  const files: string[] = [];
  await walkFiles(tmpDir, files);
  const sockets = files.filter((path) => path.endsWith(".sock"));
  const locks = files.filter((path) =>
    path.endsWith(".lock") &&
    (path.includes("/start-") || path.endsWith("/test-run.lock"))
  );
  for (const home of opts.extraHomes ?? []) {
    const runDir = `${home}/.dyfj/run`;
    try {
      for await (const entry of Deno.readDir(runDir)) {
        if (entry.isFile && isTestLockName(entry.name)) {
          locks.push(`${runDir}/${entry.name}`);
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }

  const manifest = await loadManifest(tmpDir);
  for (const record of manifest) {
    for (const socket of record.sockets) {
      if (!sockets.includes(socket)) sockets.push(socket);
    }
    for (const lock of record.locks) {
      if (!locks.includes(lock)) locks.push(lock);
    }
  }

  const processes: ProcessInfo[] = [];
  const seen = new Set<number>();
  for (const proc of await listProcesses()) {
    if (ignorePids.has(proc.pid) || ignorePgids.has(proc.pgid)) continue;
    if (proc.pid === Deno.pid || proc.pid === Deno.ppid) continue;
    const recorded = manifest.some((record) =>
      record.pid === proc.pid ||
      (record.pgid !== undefined && record.pgid === proc.pgid)
    );
    if (
      recorded ||
      commandLooksLikeTestRuntime(
        proc.command,
        tmpDir,
        sockets,
        opts.includeDetachedFixtures === true,
      )
    ) {
      if (!seen.has(proc.pid)) {
        seen.add(proc.pid);
        processes.push(proc);
      }
    }
  }

  const existingSockets: string[] = [];
  for (const socket of sockets) {
    try {
      await Deno.lstat(socket);
      existingSockets.push(socket);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  const existingLocks: string[] = [];
  for (const lock of locks) {
    if (lock === lockPath(tmpDir)) continue;
    try {
      await Deno.lstat(lock);
      existingLocks.push(lock);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  return { processes, sockets: existingSockets, locks: existingLocks };
}

export function isEmptyReport(report: SurvivorReport): boolean {
  return report.processes.length === 0 &&
    report.sockets.length === 0 &&
    report.locks.length === 0;
}

export function formatSurvivorReport(report: SurvivorReport): string {
  const lines: string[] = [];
  for (const proc of report.processes) {
    lines.push(`pid ${proc.pid} pgid ${proc.pgid}: ${proc.command}`);
  }
  for (const socket of report.sockets) lines.push(`socket ${socket}`);
  for (const lock of report.locks) lines.push(`lock ${lock}`);
  return lines.join("\n");
}

export async function reapSurvivors(
  report: SurvivorReport,
  opts: { graceMs?: number; protectedPgids?: Set<number> } = {},
): Promise<void> {
  const graceMs = opts.graceMs ?? REAP_TERM_GRACE_MS;
  const protectedPgids = opts.protectedPgids ?? new Set();
  const pgids = new Set<number>();
  for (const proc of report.processes) {
    if (proc.pgid > 1 && !protectedPgids.has(proc.pgid)) pgids.add(proc.pgid);
  }
  for (const pgid of pgids) await killProcessGroup(pgid, "SIGTERM");
  for (const proc of report.processes) await killPid(proc.pid, "SIGTERM");
  await delay(graceMs);
  for (const pgid of pgids) await killProcessGroup(pgid, "SIGKILL");
  for (const proc of report.processes) await killPid(proc.pid, "SIGKILL");
}

export async function removeSurvivorFiles(report: SurvivorReport): Promise<void> {
  for (const path of [...report.sockets, ...report.locks]) {
    try {
      await Deno.remove(path);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
}

export async function sweepTestRuntime(opts: {
  tmpDir: string;
  extraHomes?: string[];
  ignorePids?: Set<number>;
  ignorePgids?: Set<number>;
  graceMs?: number;
  includeDetachedFixtures?: boolean;
}): Promise<SurvivorReport> {
  const first = await discoverSurvivors(opts);
  await reapSurvivors(first, {
    graceMs: opts.graceMs,
    protectedPgids: opts.ignorePgids,
  });
  await removeSurvivorFiles(first);
  await clearManifest(opts.tmpDir);
  return await discoverSurvivors(opts);
}

export async function readLockFile(tmpDir: string): Promise<TestRunLock | null> {
  try {
    const parsed = JSON.parse(await Deno.readTextFile(lockPath(tmpDir)));
    if (
      typeof parsed !== "object" || parsed === null ||
      !Number.isSafeInteger(parsed.pid) || parsed.pid <= 0
    ) {
      return null;
    }
    return parsed as TestRunLock;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    return null;
  }
}

async function reclaimDeadLock(opts: {
  tmpDir: string;
  extraHomes?: string[];
  pid: number;
  includeDetachedFixtures?: boolean;
}): Promise<void> {
  const existing = await readLockFile(opts.tmpDir);
  if (existing === null) return;
  if (await processIsAlive(existing.pid)) {
    throw new TestRunConflictError(existing);
  }
  await sweepTestRuntime({
    tmpDir: opts.tmpDir,
    extraHomes: opts.extraHomes,
    ignorePids: new Set([opts.pid, Deno.pid]),
    includeDetachedFixtures: opts.includeDetachedFixtures,
  });
  try {
    await Deno.remove(lockPath(opts.tmpDir));
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

async function writeLockExclusive(lock: TestRunLock): Promise<void> {
  const file = await Deno.open(lockPath(lock.tmpDir), {
    write: true,
    createNew: true,
  });
  try {
    await file.write(new TextEncoder().encode(`${JSON.stringify(lock)}\n`));
  } finally {
    file.close();
  }
}

export async function acquireTestRunLock(opts: {
  tmpDir: string;
  boundSec: number;
  pid: number;
  extraHomes?: string[];
  includeDetachedFixtures?: boolean;
}): Promise<TestRunLock> {
  await ensureHarnessDirs(opts.tmpDir);
  await reclaimDeadLock(opts);
  const lock: TestRunLock = {
    pid: opts.pid,
    startedAt: new Date().toISOString(),
    boundSec: opts.boundSec,
    tmpDir: opts.tmpDir,
  };
  try {
    await writeLockExclusive(lock);
  } catch (error) {
    if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
    await reclaimDeadLock(opts);
    await writeLockExclusive(lock);
  }
  return lock;
}

export async function releaseTestRunLock(tmpDir: string): Promise<void> {
  try {
    await Deno.remove(lockPath(tmpDir));
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  try {
    await Deno.remove(donePath(tmpDir));
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  try {
    await Deno.remove(vitestPgidPath(tmpDir));
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

export async function markRunDone(tmpDir: string): Promise<void> {
  await Deno.writeTextFile(donePath(tmpDir), `${Deno.pid}\n`);
}

export async function runReaper(opts: {
  supervisorPid: number;
  deadlineEpochSec: number;
  tmpDir: string;
  extraHomes?: string[];
  includeDetachedFixtures?: boolean;
}): Promise<number> {
  const ignorePids = new Set([Deno.pid, opts.supervisorPid]);
  const ignorePgids = new Set<number>();
  while (true) {
    try {
      await Deno.lstat(donePath(opts.tmpDir));
      return 0;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const supervisorAlive = await processIsAlive(opts.supervisorPid);
    const timedOut = nowSec >= opts.deadlineEpochSec;
    if (!supervisorAlive || timedOut) {
      let vitestPgid: number | undefined;
      try {
        const raw = Number((await Deno.readTextFile(vitestPgidPath(opts.tmpDir))).trim());
        if (Number.isSafeInteger(raw) && raw > 1) vitestPgid = raw;
      } catch {
        // Vitest may not have recorded a group yet.
      }
      if (vitestPgid !== undefined) {
        await killProcessGroup(vitestPgid, "SIGTERM");
        await delay(REAP_TERM_GRACE_MS);
        await killProcessGroup(vitestPgid, "SIGKILL");
      }
      await sweepTestRuntime({
        tmpDir: opts.tmpDir,
        extraHomes: opts.extraHomes,
        ignorePids,
        ignorePgids,
        includeDetachedFixtures: opts.includeDetachedFixtures,
      });
      return timedOut ? 124 : 0;
    }
    await delay(REAPER_POLL_MS);
  }
}
