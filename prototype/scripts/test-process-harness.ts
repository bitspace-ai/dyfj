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
export const LOCK_WRITE_GRACE_MS = 500;
export const TEST_RUN_DIR_ENV = "DYFJ_TEST_RUN_DIR";
export const OPERATOR_VITEST_LOCK_NAME = "dyfj-vitest-run.lock";

export interface SpawnRecord {
  pid: number;
  pgid?: number;
  kind: string;
  sockets: string[];
  locks: string[];
  command?: string;
  lstart?: string;
  generation?: string;
  tmpDir?: string;
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
  generation: string;
}

export interface VitestGroupIdentity {
  pgid: number;
  leaderPid: number;
  lstart: string;
  command: string;
  generation: string;
  tmpDir: string;
}

export interface ClaimOwner {
  pid: number;
  generation: string;
}

export type LockState =
  | { kind: "absent" }
  | { kind: "malformed"; mtimeMs: number }
  | { kind: "valid"; lock: TestRunLock; mtimeMs: number };

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

export function operatorVitestLockPath(home: string): string {
  return `${home}/.dyfj/run/${OPERATOR_VITEST_LOCK_NAME}`;
}

export function requireOperatorLockFile(
  home: string | undefined,
): string {
  if (home === undefined || !home.startsWith("/")) {
    throw new Error(
      "supervised Vitest requires an absolute HOME for the operator-scoped run lock",
    );
  }
  return operatorVitestLockPath(home);
}

export function claimDir(lockFile: string): string {
  return `${lockFile}.claim`;
}

function parentDir(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "." : path.slice(0, index);
}

function baseName(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? path : path.slice(index + 1);
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

export function resolveLockFile(tmpDir: string, lockFile?: string): string {
  return lockFile ?? lockPath(tmpDir);
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

export async function readProcessLstart(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const output = await new Deno.Command("/bin/ps", {
    args: ["-p", String(pid), "-o", "lstart="],
    stdout: "piped",
    stderr: "null",
  }).output();
  if (!output.success) return null;
  const text = new TextDecoder().decode(output.stdout).trim();
  return text === "" ? null : text;
}

export async function captureProcessIdentity(
  pid: number,
): Promise<{ pgid: number; lstart: string; command: string } | null> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const lstart = await readProcessLstart(pid);
    const proc = (await listProcesses()).find((entry) => entry.pid === pid);
    if (lstart !== null && proc !== undefined) {
      return { pgid: proc.pgid, lstart, command: proc.command };
    }
    await delay(25);
  }
  return null;
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

export function killArguments(
  spec: string,
  signal: "SIGTERM" | "SIGKILL",
): string[] {
  const flag = signal === "SIGKILL" ? "-KILL" : "-TERM";
  return [flag, "--", spec];
}

async function sendKill(
  spec: string,
  signal: "SIGTERM" | "SIGKILL",
): Promise<void> {
  await new Deno.Command("/bin/kill", {
    args: killArguments(spec, signal),
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
  const callerPgids = await callerProcessGroups();
  if (callerPgids.size === 0) {
    console.error(
      `dyfj: refusing to signal process group ${pgid}: caller process group is unavailable`,
    );
    return;
  }
  if (callerPgids.has(pgid)) {
    console.error(
      `dyfj: refusing to signal process group ${pgid}: group contains the caller or its parent`,
    );
    return;
  }
  await sendKill(`-${pgid}`, signal);
}

async function callerProcessGroups(): Promise<Set<number>> {
  const callerPids = new Set([Deno.pid, Deno.ppid]);
  return new Set(
    (await listProcesses())
      .filter((proc) => callerPids.has(proc.pid) && proc.pgid > 1)
      .map((proc) => proc.pgid),
  );
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

function spawnRecordCanAuthorizeProcess(
  record: SpawnRecord,
): record is SpawnRecord & {
  lstart: string;
  command: string;
  tmpDir: string;
  generation: string;
} {
  return typeof record.lstart === "string" && record.lstart !== "" &&
    typeof record.command === "string" && record.command !== "" &&
    typeof record.tmpDir === "string" && record.tmpDir !== "" &&
    typeof record.generation === "string" && record.generation !== "";
}

async function manifestAuthorizesProcess(
  proc: ProcessInfo,
  manifest: SpawnRecord[],
  tmpDir: string,
  expectedGeneration: string | undefined,
): Promise<boolean> {
  if (expectedGeneration === undefined || expectedGeneration === "") return false;
  for (const record of manifest) {
    if (record.pid !== proc.pid) continue;
    if (!spawnRecordCanAuthorizeProcess(record)) continue;
    if (record.tmpDir !== tmpDir) continue;
    if (record.generation !== expectedGeneration) continue;
    const lstart = await readProcessLstart(proc.pid);
    if (lstart === record.lstart && proc.command === record.command) return true;
  }
  return false;
}

function commandLooksLikeTestRuntime(
  command: string,
  tmpDir: string,
  sockets: string[],
  commandNeedles: string[],
): boolean {
  if (tmpDir !== "" && command.includes(tmpDir)) return true;
  for (const socket of sockets) {
    if (socket !== "" && command.includes(socket)) return true;
  }
  for (const needle of commandNeedles) {
    if (needle !== "" && command.includes(needle)) return true;
  }
  return false;
}

function isRunScopedLock(
  path: string,
  tmpDir: string,
  recordedLocks: string[],
): boolean {
  if (path === lockPath(tmpDir) || path.endsWith(`/${OPERATOR_VITEST_LOCK_NAME}`)) {
    return false;
  }
  if (path.startsWith(`${tmpDir}/`)) return true;
  return recordedLocks.includes(path);
}

export async function discoverSurvivors(opts: {
  tmpDir: string;
  ignorePids?: Set<number>;
  ignorePgids?: Set<number>;
  commandNeedles?: string[];
  lockFile?: string;
  expectedGeneration?: string;
}): Promise<SurvivorReport> {
  const tmpDir = opts.tmpDir;
  const ignorePids = opts.ignorePids ?? new Set();
  const ignorePgids = opts.ignorePgids ?? new Set();
  const commandNeedles = opts.commandNeedles ?? [];
  const exclusiveLock = resolveLockFile(tmpDir, opts.lockFile);
  const files: string[] = [];
  await walkFiles(tmpDir, files);
  const sockets = files.filter((path) => path.endsWith(".sock"));
  const manifest = await loadManifest(tmpDir);
  const recordedLocks = manifest.flatMap((record) => record.locks);
  const locks = files.filter((path) =>
    path.endsWith(".lock") &&
    (path.includes("/start-") || path.endsWith("/test-run.lock")) &&
    isRunScopedLock(path, tmpDir, recordedLocks)
  );
  for (const record of manifest) {
    for (const socket of record.sockets) {
      if (!sockets.includes(socket)) sockets.push(socket);
    }
    for (const lock of record.locks) {
      if (!locks.includes(lock) && isRunScopedLock(lock, tmpDir, recordedLocks)) {
        locks.push(lock);
      }
    }
  }

  const processes: ProcessInfo[] = [];
  const seen = new Set<number>();
  for (const proc of await listProcesses()) {
    if (ignorePids.has(proc.pid) || ignorePgids.has(proc.pgid)) continue;
    if (proc.pid === Deno.pid || proc.pid === Deno.ppid) continue;
    const recorded = await manifestAuthorizesProcess(
      proc,
      manifest,
      tmpDir,
      opts.expectedGeneration,
    );
    if (
      recorded ||
      commandLooksLikeTestRuntime(proc.command, tmpDir, sockets, commandNeedles)
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
    if (lock === exclusiveLock) continue;
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
  opts: {
    graceMs?: number;
    protectedPgids?: Set<number>;
    individualOnlyPgids?: Set<number>;
  } = {},
): Promise<void> {
  const graceMs = opts.graceMs ?? REAP_TERM_GRACE_MS;
  const protectedPgids = opts.protectedPgids ?? new Set();
  const individualOnlyPgids = opts.individualOnlyPgids ?? new Set();
  const survivorPids = new Set(report.processes.map((proc) => proc.pid));
  const pgids = new Set<number>();
  for (const proc of report.processes) {
    if (
      proc.pgid > 1 &&
      survivorPids.has(proc.pgid) &&
      !protectedPgids.has(proc.pgid) &&
      !individualOnlyPgids.has(proc.pgid)
    ) {
      pgids.add(proc.pgid);
    }
  }
  for (const pgid of pgids) await killProcessGroup(pgid, "SIGTERM");
  for (const proc of report.processes) {
    if (protectedPgids.has(proc.pgid)) continue;
    await killPid(proc.pid, "SIGTERM");
  }
  await delay(graceMs);
  for (const pgid of pgids) await killProcessGroup(pgid, "SIGKILL");
  for (const proc of report.processes) {
    if (protectedPgids.has(proc.pgid)) continue;
    await killPid(proc.pid, "SIGKILL");
  }
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

export async function readVitestGroupIdentity(
  tmpDir: string,
): Promise<VitestGroupIdentity | null> {
  try {
    const parsed = JSON.parse(await Deno.readTextFile(vitestPgidPath(tmpDir)));
    if (
      typeof parsed !== "object" || parsed === null ||
      !Number.isSafeInteger(parsed.pgid) || parsed.pgid <= 1 ||
      !Number.isSafeInteger(parsed.leaderPid) || parsed.leaderPid <= 1 ||
      typeof parsed.lstart !== "string" || parsed.lstart === "" ||
      typeof parsed.command !== "string" || parsed.command === "" ||
      typeof parsed.generation !== "string" || parsed.generation === "" ||
      typeof parsed.tmpDir !== "string" || parsed.tmpDir === ""
    ) {
      return null;
    }
    return parsed as VitestGroupIdentity;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    return null;
  }
}

export async function writeVitestGroupIdentity(
  tmpDir: string,
  identity: VitestGroupIdentity,
): Promise<void> {
  await Deno.writeTextFile(
    vitestPgidPath(tmpDir),
    `${JSON.stringify(identity)}\n`,
  );
}

function refuseVitestGroup(pgid: number, reason: string): void {
  console.error(
    `dyfj: refusing to signal process group ${pgid}: ${reason}`,
  );
}

export async function reapSavedVitestGroup(
  tmpDir: string,
  expectedGeneration?: string,
): Promise<void> {
  const saved = await readVitestGroupIdentity(tmpDir);
  if (saved === null) return;
  if (saved.tmpDir !== tmpDir) {
    refuseVitestGroup(
      saved.pgid,
      "saved tmp dir does not match the recovery directory",
    );
    return;
  }
  if (expectedGeneration === undefined || expectedGeneration === "") {
    refuseVitestGroup(
      saved.pgid,
      "no recovering run generation was supplied",
    );
    return;
  }
  if (saved.generation !== expectedGeneration) {
    refuseVitestGroup(
      saved.pgid,
      "saved generation does not match the recovering run",
    );
    return;
  }
  const members = (await listProcesses()).filter((proc) =>
    proc.pgid === saved.pgid
  );
  if (members.length === 0) return;
  const leader = members.find((proc) => proc.pid === saved.leaderPid);
  if (leader === undefined) {
    refuseVitestGroup(
      saved.pgid,
      "saved leader is gone and descendant identity is not established",
    );
    return;
  }
  const lstart = await readProcessLstart(leader.pid);
  if (lstart !== saved.lstart || leader.command !== saved.command) {
    refuseVitestGroup(
      saved.pgid,
      "saved Vitest identity does not match live processes",
    );
    return;
  }
  await killProcessGroup(saved.pgid, "SIGTERM");
  await delay(REAP_TERM_GRACE_MS);
  await killProcessGroup(saved.pgid, "SIGKILL");
}

async function clearRunArtifacts(tmpDir: string): Promise<void> {
  for (const path of [donePath(tmpDir), vitestPgidPath(tmpDir)]) {
    try {
      await Deno.remove(path);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
}

export async function sweepTestRuntime(opts: {
  tmpDir: string;
  ignorePids?: Set<number>;
  ignorePgids?: Set<number>;
  protectedPgids?: Set<number>;
  graceMs?: number;
  commandNeedles?: string[];
  lockFile?: string;
  expectedGeneration?: string;
}): Promise<SurvivorReport> {
  const first = await discoverSurvivors(opts);
  const protectedPgids = new Set(opts.ignorePgids ?? []);
  if (opts.protectedPgids !== undefined) {
    for (const pgid of opts.protectedPgids) protectedPgids.add(pgid);
  }
  const individualOnlyPgids = await callerProcessGroups();
  if (individualOnlyPgids.size === 0) {
    for (const proc of first.processes) individualOnlyPgids.add(proc.pgid);
  }
  await reapSurvivors(first, {
    graceMs: opts.graceMs,
    protectedPgids,
    individualOnlyPgids,
  });
  await removeSurvivorFiles(first);
  const leftover = await discoverSurvivors(opts);
  await clearManifest(opts.tmpDir);
  return leftover;
}

function parseLockBody(raw: string): TestRunLock | null {
  try {
    const parsed = JSON.parse(raw);
    if (
      typeof parsed !== "object" || parsed === null ||
      !Number.isSafeInteger(parsed.pid) || parsed.pid <= 0 ||
      typeof parsed.tmpDir !== "string" || parsed.tmpDir === "" ||
      typeof parsed.startedAt !== "string" ||
      !Number.isSafeInteger(parsed.boundSec) || parsed.boundSec <= 0 ||
      typeof parsed.generation !== "string" || parsed.generation === ""
    ) {
      return null;
    }
    return {
      pid: parsed.pid,
      startedAt: parsed.startedAt,
      boundSec: parsed.boundSec,
      tmpDir: parsed.tmpDir,
      generation: parsed.generation,
    };
  } catch {
    return null;
  }
}

export async function readLockState(lockFile: string): Promise<LockState> {
  try {
    const [raw, stat] = await Promise.all([
      Deno.readTextFile(lockFile),
      Deno.stat(lockFile),
    ]);
    const mtimeMs = stat.mtime?.getTime() ?? 0;
    const lock = parseLockBody(raw);
    if (lock === null) return { kind: "malformed", mtimeMs };
    return { kind: "valid", lock, mtimeMs };
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return { kind: "absent" };
    return { kind: "malformed", mtimeMs: 0 };
  }
}

export async function readLockFile(
  tmpDir: string,
  lockFile?: string,
): Promise<TestRunLock | null> {
  const state = await readLockState(resolveLockFile(tmpDir, lockFile));
  return state.kind === "valid" ? state.lock : null;
}

function claimOwnerPath(lockFile: string): string {
  return `${claimDir(lockFile)}/owner`;
}

async function readClaimOwner(lockFile: string): Promise<ClaimOwner | null> {
  try {
    const parsed = JSON.parse(await Deno.readTextFile(claimOwnerPath(lockFile)));
    if (
      typeof parsed !== "object" || parsed === null ||
      !Number.isSafeInteger(parsed.pid) || parsed.pid <= 0 ||
      typeof parsed.generation !== "string" || parsed.generation === ""
    ) {
      return null;
    }
    return { pid: parsed.pid, generation: parsed.generation };
  } catch {
    return null;
  }
}

async function conflictFromExisting(lockFile: string, owner: ClaimOwner | null): Promise<never> {
  const state = await readLockState(lockFile);
  if (state.kind === "valid") throw new TestRunConflictError(state.lock);
  throw new TestRunConflictError({
    pid: owner?.pid ?? 0,
    startedAt: new Date(0).toISOString(),
    boundSec: 1,
    tmpDir: "",
    generation: owner?.generation ?? "unknown",
  });
}

async function tryStealStaleClaim(lockFile: string): Promise<boolean> {
  const dir = claimDir(lockFile);
  const owner = await readClaimOwner(lockFile);
  if (owner !== null && await processIsAlive(owner.pid)) return false;
  if (owner === null) {
    try {
      const mtime = (await Deno.stat(dir)).mtime?.getTime() ?? 0;
      if (mtime > 0 && Date.now() - mtime < LOCK_WRITE_GRACE_MS) return false;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return true;
      throw error;
    }
  }
  const tombstone = `${dir}.dead.${crypto.randomUUID()}`;
  try {
    await Deno.rename(dir, tombstone);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return true;
    return false;
  }
  await Deno.remove(tombstone, { recursive: true }).catch(() => undefined);
  return true;
}

async function takeClaim(
  lockFile: string,
  pid: number,
  generation: string,
): Promise<void> {
  const dir = claimDir(lockFile);
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await Deno.mkdir(dir);
      await Deno.writeTextFile(
        claimOwnerPath(lockFile),
        `${JSON.stringify({ pid, generation })}\n`,
      );
      return;
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
    }
    if (await tryStealStaleClaim(lockFile)) continue;
    const owner = await readClaimOwner(lockFile);
    await conflictFromExisting(lockFile, owner);
  }
  throw new Error("could not acquire the test-run claim directory");
}

async function dropClaim(lockFile: string, generation: string): Promise<void> {
  const owner = await readClaimOwner(lockFile);
  if (owner !== null && owner.generation !== generation) return;
  const dir = claimDir(lockFile);
  const tombstone = `${dir}.dead.${crypto.randomUUID()}`;
  try {
    await Deno.rename(dir, tombstone);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
  await Deno.remove(tombstone, { recursive: true }).catch(() => undefined);
}

export function isLockStagingName(lockFile: string, name: string): boolean {
  const base = baseName(lockFile);
  return name.startsWith(`${base}.`) && name.endsWith(".writing");
}

export async function sweepStagingFiles(lockFile: string): Promise<void> {
  const dir = parentDir(lockFile);
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.isFile || !isLockStagingName(lockFile, entry.name)) continue;
      const path = `${dir}/${entry.name}`;
      const pidMatch = entry.name.slice(baseName(lockFile).length + 1).match(
        /^(\d+)\./,
      );
      const stagingPid = pidMatch === null ? 0 : Number(pidMatch[1]);
      const dead = stagingPid <= 1 || !await processIsAlive(stagingPid);
      if (!dead) continue;
      await Deno.remove(path).catch(() => undefined);
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

export async function writeLockExclusive(
  lockFile: string,
  lock: TestRunLock,
): Promise<void> {
  const body = `${JSON.stringify(lock)}\n`;
  const staging =
    `${lockFile}.${lock.pid}.${crypto.randomUUID()}.writing`;
  await Deno.mkdir(parentDir(lockFile), { recursive: true });
  await Deno.writeTextFile(staging, body);
  try {
    await Deno.link(staging, lockFile);
  } finally {
    await Deno.remove(staging).catch(() => undefined);
  }
}

async function removeLockFile(lockFile: string): Promise<void> {
  try {
    await Deno.remove(lockFile);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

async function sweepLockedTmpDir(opts: {
  tmpDir: string;
  ignorePids?: Set<number>;
  commandNeedles?: string[];
  lockFile?: string;
  expectedGeneration?: string;
}): Promise<void> {
  await reapSavedVitestGroup(opts.tmpDir, opts.expectedGeneration);
  await sweepTestRuntime({
    tmpDir: opts.tmpDir,
    ignorePids: opts.ignorePids,
    commandNeedles: opts.commandNeedles,
    lockFile: opts.lockFile,
    expectedGeneration: opts.expectedGeneration,
    graceMs: 200,
  });
  await clearRunArtifacts(opts.tmpDir);
}

async function reclaimDeadLock(opts: {
  tmpDir: string;
  lockFile: string;
  pid: number;
  commandNeedles?: string[];
}): Promise<void> {
  const ignorePids = new Set([opts.pid, Deno.pid]);
  await sweepStagingFiles(opts.lockFile);
  const state = await readLockState(opts.lockFile);
  if (state.kind === "absent") return;
  if (state.kind === "malformed") {
    await sweepLockedTmpDir({
      tmpDir: opts.tmpDir,
      ignorePids,
      commandNeedles: opts.commandNeedles,
      lockFile: opts.lockFile,
    });
    await removeLockFile(opts.lockFile);
    return;
  }
  if (await processIsAlive(state.lock.pid)) {
    throw new TestRunConflictError(state.lock);
  }
  const generation = state.lock.generation;
  await sweepLockedTmpDir({
    tmpDir: opts.tmpDir,
    ignorePids,
    commandNeedles: opts.commandNeedles,
    lockFile: opts.lockFile,
    expectedGeneration: generation,
  });
  const current = await readLockState(opts.lockFile);
  if (current.kind === "valid" && current.lock.generation !== generation) return;
  await removeLockFile(opts.lockFile);
}

export async function acquireTestRunLock(opts: {
  tmpDir: string;
  boundSec: number;
  pid: number;
  lockFile?: string;
  commandNeedles?: string[];
}): Promise<TestRunLock> {
  await ensureHarnessDirs(opts.tmpDir);
  const lockFile = resolveLockFile(opts.tmpDir, opts.lockFile);
  await Deno.mkdir(parentDir(lockFile), { recursive: true });
  const generation = crypto.randomUUID();
  const lock: TestRunLock = {
    pid: opts.pid,
    startedAt: new Date().toISOString(),
    boundSec: opts.boundSec,
    tmpDir: opts.tmpDir,
    generation,
  };
  await takeClaim(lockFile, opts.pid, generation);
  try {
    await reclaimDeadLock({
      tmpDir: opts.tmpDir,
      lockFile,
      pid: opts.pid,
      commandNeedles: opts.commandNeedles,
    });
    await writeLockExclusive(lockFile, lock);
    return lock;
  } catch (error) {
    if (error instanceof Deno.errors.AlreadyExists) {
      const state = await readLockState(lockFile);
      if (state.kind === "valid") throw new TestRunConflictError(state.lock);
    }
    throw error;
  } finally {
    await dropClaim(lockFile, generation);
  }
}

export async function releaseTestRunLock(opts: {
  tmpDir: string;
  lockFile?: string;
  generation: string;
}): Promise<void> {
  const lockFile = resolveLockFile(opts.tmpDir, opts.lockFile);
  const generation = opts.generation;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await takeClaim(lockFile, Deno.pid, generation);
    } catch (error) {
      if (!(error instanceof TestRunConflictError)) throw error;
      const state = await readLockState(lockFile);
      if (state.kind !== "valid" || state.lock.generation !== generation) {
        await clearRunArtifacts(opts.tmpDir);
        return;
      }
      await delay(50);
      continue;
    }
    try {
      const state = await readLockState(lockFile);
      if (state.kind === "valid" && state.lock.generation === generation) {
        await removeLockFile(lockFile);
      }
      await sweepStagingFiles(lockFile);
      await clearRunArtifacts(opts.tmpDir);
      return;
    } finally {
      await dropClaim(lockFile, generation);
    }
  }
  await clearRunArtifacts(opts.tmpDir);
}

export async function markRunDone(tmpDir: string): Promise<void> {
  await Deno.writeTextFile(donePath(tmpDir), `${Deno.pid}\n`);
}

export async function runReaper(opts: {
  supervisorPid: number;
  deadlineEpochSec: number;
  tmpDir: string;
  commandNeedles?: string[];
  lockFile?: string;
  expectedGeneration?: string;
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
      await reapSavedVitestGroup(opts.tmpDir, opts.expectedGeneration);
      await sweepTestRuntime({
        tmpDir: opts.tmpDir,
        ignorePids,
        ignorePgids,
        commandNeedles: opts.commandNeedles,
        lockFile: opts.lockFile,
        expectedGeneration: opts.expectedGeneration,
      });
      return timedOut ? 124 : 0;
    }
    await delay(REAPER_POLL_MS);
  }
}

if (import.meta.main) {
  const command = Deno.args[0];
  if (command !== "acquire-hold") {
    throw new Error("usage: test-process-harness.ts acquire-hold");
  }
  const tmpDir = Deno.env.get("DYFJ_LOCK_TMP");
  const lockFile = Deno.env.get("DYFJ_LOCK_FILE");
  const resultPath = Deno.env.get("DYFJ_LOCK_RESULT");
  if (tmpDir === undefined || lockFile === undefined || resultPath === undefined) {
    throw new Error("acquire-hold requires DYFJ_LOCK_TMP, DYFJ_LOCK_FILE, and DYFJ_LOCK_RESULT");
  }
  try {
    const lock = await acquireTestRunLock({
      tmpDir,
      lockFile,
      boundSec: 30,
      pid: Deno.pid,
    });
    await Deno.writeTextFile(resultPath, `acquired ${lock.generation}\n`);
    while (true) await delay(1_000);
  } catch (error) {
    if (error instanceof TestRunConflictError) {
      await Deno.writeTextFile(
        resultPath,
        `conflict ${error.existing.generation}\n`,
      );
      Deno.exit(2);
    }
    const name = error instanceof Error ? error.name : "Error";
    const detail = (error instanceof Error ? error.message : String(error))
      .replaceAll(/\s+/g, " ")
      .slice(0, 500);
    await Deno.writeTextFile(resultPath, `error ${name}: ${detail}\n`);
    throw error;
  }
}
