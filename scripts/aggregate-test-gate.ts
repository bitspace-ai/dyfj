import {
  type ChildProcess,
  execFile,
  spawn,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { realpathSync } from "node:fs";
import { constants } from "node:os";
import process from "node:process";
import {
  isLaneToken,
  LANE_BACKSTOP_ENV,
  LANE_DEADLINE_ENV,
  LANE_PARENT_ENV,
  LANE_TOKEN_ENV,
  laneTokenArgument,
  MAX_TIMER_DELAY_MS,
} from "../prototype/scripts/lane-supervision.ts";
import type { ChangeScope } from "./change-scope.ts";

export interface GateLane {
  label: string;
  // Stable deterministic check id this lane reports under. Suite lanes share
  // `test.aggregate`; policy lanes carry their own stable id.
  checkId?: string;
  command: string;
  commandLabel?: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  // A test lane: the gate stops it at this deadline, and its runner is
  // supervised (`prototype/scripts/lane-supervision.ts`).
  deadlineMs?: number;
}

export type LaneResult =
  | "pass"
  | "fail"
  | "unavailable"
  | "interrupted"
  | "skipped";

export interface LaneOutcome {
  checkId?: string;
  result: LaneResult;
}

// `docs-only` is a pull-request run whose release range changes Markdown
// only, so only the policy lanes ran (`planGate`).
export type GateMode = "full" | "fast" | "docs-only";

export interface GateStatus {
  schema: "dyfj.gate.status/v1";
  mode: GateMode;
  checks: { id: string; result: LaneResult }[];
  result: "pass" | "fail" | "interrupted";
}

export interface RunGateOptions {
  root?: string;
  lanes?: GateLane[];
  out?: Pick<Console, "log" | "error">;
  signal?: AbortSignal;
  // Truthful final claim: a lane subset must not report itself as the full
  // green bar.
  successMessage?: string;
  mode?: GateMode;
  requiredCheckIds?: readonly string[];
  // Lanes this run leaves out, and why. The gate names each one before it
  // starts, so a subset run never skips a lane silently.
  skipped?: { reason: string; labels: readonly string[] };
  // Where the gate records each running test lane's process group, so a later
  // run can recover a group left behind when the gate and its runner were both
  // killed. Undefined keeps no records and recovers nothing.
  laneRecordDir?: string;
}

// The stable deterministic floor: every id must be present and passing for a
// full-gate status to read `pass`. A skipped, unavailable, or failed
// required check can never compose into a passing result.
export const REQUIRED_CHECK_IDS: readonly string[] = [
  "subject.resolve",
  "subject.digest",
  "test.aggregate",
  "secret.tree",
  "secret.diff",
  "public.boundary",
  "diff.whitespace",
  "markdown.links",
  "shell.parse",
  "dependency.policy",
  "receipt.schema",
];

// The temp directory a test lane gets. Tests bind Unix sockets under it, and a
// socket path holds at most 103 bytes on macOS (104 with its terminator), so
// the long default there (`/var/folders/...`, about 49 bytes) cannot be used:
// the lane keeps `/tmp`. A caller's `TMPDIR` is forwarded when its real path
// leaves room for the longest socket path the lanes build under it
// (`LANE_SOCKET_SUFFIX_RESERVE`: the integration lane's `dyfj-test-*`
// directory, a test's own temp directory and a runtime socket inside it, with
// margin). That is what lets a lane run in a sandbox that grants only its own
// scratch directory as `TMPDIR` (BIT-806).
export const FALLBACK_LANE_TMPDIR = "/tmp";
export const SOCKET_PATH_LIMIT_BYTES = 103;
export const LANE_SOCKET_SUFFIX_RESERVE = 72;

export function laneTempDir(
  tmpdir: string | undefined,
  realpath: (path: string) => string = realpathSync,
): string {
  if (tmpdir === undefined || !tmpdir.startsWith("/")) {
    return FALLBACK_LANE_TMPDIR;
  }
  let resolved: string;
  try {
    resolved = realpath(tmpdir);
  } catch {
    return FALLBACK_LANE_TMPDIR; // Not there, so not a directory to use.
  }
  // The path that is measured is the path that is returned: a short alias of
  // a long directory (or a long alias of a short one) is judged, and handed to
  // the lane, by where it really is, because that is what a socket path under
  // it will be.
  const measured = resolved.replace(/\/+$/, "");
  const bytes = new TextEncoder().encode(measured).length;
  return bytes + LANE_SOCKET_SUFFIX_RESERVE <= SOCKET_PATH_LIMIT_BYTES
    ? measured
    : FALLBACK_LANE_TMPDIR;
}

export const INHERITED_ENVIRONMENT_NAMES: readonly string[] = [
  "PATH",
  "HOME",
  "CARGO_HOME",
  "RUSTUP_HOME",
];

// Names the unit, gate-orchestration and isolated-Dolt integration lanes also
// receive: whether this is a CI run. Suites whose environment-dependent skips
// must not apply under CI read them (`prototype/testing/unix-socket-bind.ts`,
// `prototype/testing/nested-sandbox.ts`, BIT-806). Each lane's runner forwards
// them on to its `node --test` child (`scripts/run-node-test-files.ts`,
// `prototype/scripts/run-unit-tests.ts`,
// `prototype/scripts/integration-child-environment.ts`).
export const CI_ENVIRONMENT_NAMES: readonly string[] = ["CI", "GITHUB_ACTIONS"];

function ciEnvironment(): Record<string, string> {
  return Object.fromEntries(
    CI_ENVIRONMENT_NAMES.flatMap((name) => {
      const value = readOptionalEnv(name);
      return value === undefined ? [] : [[name, value]];
    }),
  );
}

// Subject and release-range bindings supplied by CI (or an operator) are the
// only additional names forwarded into binding-aware lanes; children are
// still spawned with a cleared environment.
const bindingEnvironmentNames = [
  "DYFJ_GATE_SUBJECT",
  "DYFJ_GATE_RANGE_BASE",
  "GITHUB_ACTIONS",
];

const laneShutdownTimeoutMs = 10_000;

// A lane can start descendants of its own (a test runner's workers, a fixture
// daemon). Signalling only the lane leader leaves those descendants running
// past the shutdown bound, so every lane leader is spawned as its own
// process-group leader and teardown signals the whole group. Windows has no
// POSIX process groups, so lanes there keep the leader-only path.
const laneProcessGroups = process.platform !== "win32";

// A lane leader exiting on its own does not end the lane: descendants it
// started stay in the lane group and keep running. Ordinary completion —
// success or failure — therefore tears the group down too, with a grace far
// below the interruption budget so a clean lane never pays a long delay. The
// teardown returns as soon as the group is empty, so a lane with no surviving
// descendant waits for nothing at all.
const laneGroupGraceMs = 2_000;

// Test-lane deadlines, from measured run times (`test.unit` about 12–22 s,
// the isolated-Dolt integration lane about 95–120 s). DYFJ_TEST_BOUND_SEC, a
// whole number of seconds, overrides all of them. A lane past its deadline is
// torn down like an interrupted one and fails with a message naming it.
export const TEST_BOUND_ENV = "DYFJ_TEST_BOUND_SEC";
export const LANE_DEADLINES_MS = {
  unit: 120_000,
  integration: 900_000,
  golden: 900_000,
} as const;
// The runner's own backstop sits this far past the gate's deadline, so it
// fires only when the gate is no longer there to enforce the deadline.
export const LANE_BACKSTOP_MARGIN_MS = 60_000;
// The largest DYFJ_TEST_BOUND_SEC whose deadline and backstop both fit a
// timer (about 24 days). A larger value is ignored, as a malformed one is.
export const MAX_TEST_BOUND_SEC = Math.floor(
  (MAX_TIMER_DELAY_MS - LANE_BACKSTOP_MARGIN_MS) / 1000,
);
// Exit code for a lane stopped at its deadline (as `timeout(1)` reports).
export const LANE_DEADLINE_EXIT_CODE = 124;

export function laneDeadlineMs(
  defaultMs: number,
  bound: string | undefined,
): number {
  if (
    bound !== undefined && /^[1-9][0-9]{0,6}$/.test(bound) &&
    Number(bound) <= MAX_TEST_BOUND_SEC
  ) {
    return Number(bound) * 1000;
  }
  return defaultMs;
}

/** The operator-scoped directory for lane records, under an absolute HOME. */
export function defaultLaneRecordDir(
  home: string | undefined,
): string | undefined {
  if (home === undefined || !home.startsWith("/")) return undefined;
  return `${home}/.dyfj/run/gate-lanes`;
}

// Composition can detect a required gap that no lane ever reported — a
// required check with no lane at all, so every lane exited zero and there is
// no concrete lane code to preserve. The gate still has to exit nonzero, so
// it reports this deterministic code.
export const COMPOSED_FAIL_EXIT_CODE = 1;

// Fallback for a composed `interrupted` status reached without a concrete
// interruption code; the signal-derived codes (130/143) are preferred.
const COMPOSED_INTERRUPTED_EXIT_CODE = 130;

// Gate-owned diagnostics are value-free: a lane line names the lane and a
// code-authored bounded command label only. Raw command paths and argv can
// carry operator paths, bound environment values, or arbitrary payloads, so
// they never reach gate output; anything that is not a safe simple command
// name collapses to the fixed word `command`.
const SAFE_COMMAND_LABEL = /^[A-Za-z][A-Za-z0-9._-]{0,31}$/;

function laneCommandLabel(lane: GateLane): string {
  for (const candidate of [lane.commandLabel, lane.command]) {
    if (candidate !== undefined && SAFE_COMMAND_LABEL.test(candidate)) {
      return candidate;
    }
  }
  return "command";
}

function readOptionalEnv(name: string): string | undefined {
  return process.env[name];
}

function safeEnvironment(): Record<string, string> {
  return Object.fromEntries(
    INHERITED_ENVIRONMENT_NAMES.flatMap((name) => {
      const value = readOptionalEnv(name);
      return value === undefined ? [] : [[name, value]];
    }),
  );
}

function bindingEnvironment(): Record<string, string> {
  return Object.fromEntries(
    bindingEnvironmentNames.flatMap((name) => {
      const value = readOptionalEnv(name);
      return value === undefined ? [] : [[name, value]];
    }),
  );
}

function interruptedExitCode(signal: AbortSignal): number {
  return signal.reason === "SIGTERM" ? 143 : 130;
}

// Signals a lane's process group. A group id is validated before use, so a
// bad id can never reach `kill(-1)` or the gate's own group.
function signalGroup(
  group: number | undefined,
  signal: NodeJS.Signals | 0,
): boolean {
  if (group === undefined || !Number.isSafeInteger(group) || group <= 1) {
    return false;
  }
  try {
    process.kill(-group, signal);
    return true;
  } catch {
    return false; // The group is empty or gone.
  }
}

// Windows lanes have no process group, so `group` is undefined there and this
// is a no-op: the leader-only path stays explicit.
function signalLaneGroup(group: number | undefined): void {
  signalGroup(group, "SIGTERM");
}

// Bounded group teardown, run once the leader has been reaped: ask the group
// to stop, return the moment nothing is left in it, and force-kill whatever
// is still there when the grace expires. Signal 0 is the liveness probe: it
// succeeds on a live group and fails on an empty one.
async function tearDownLaneGroup(
  group: number | undefined,
  graceMs: number,
): Promise<void> {
  if (!signalGroup(group, "SIGTERM")) return;
  const deadline = Date.now() + Math.max(0, Math.round(graceMs));
  for (;;) {
    if (!signalGroup(group, 0)) return;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  signalGroup(group, "SIGKILL");
}

function killLane(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch {
    // The lane leader already exited.
  }
}

interface LaneStatus {
  code: number;
}

// The leader's exit as a status. A leader killed by a signal reads as
// 128 + the signal number, as a shell reports it.
function exitStatus(child: ChildProcess): Promise<LaneStatus> {
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      if (code !== null) return resolve({ code });
      const number = signal === null ? undefined : constants.signals[signal];
      resolve({ code: number === undefined ? 1 : 128 + number });
    });
  });
}

// Resolves once the leader has started, and rejects when it cannot start,
// with no command path or argv in what reaches the gate's output. A later
// error (a signal the leader is already gone for) changes nothing.
function started(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.on("error", () => reject(new Error("command-not-runnable")));
  });
}

async function settledWithin(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  if (timeoutMs <= 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    promise.catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
}

// Bounded lane teardown on interruption: the lane group is asked to stop, the
// leader is given the remaining shutdown budget to exit on its own, and is
// force-killed and reaped after it. Reaping the leader first matters — a
// zombie leader is still a live member of its own group — so the group
// teardown that follows sees only surviving descendants and returns as soon
// as they are gone.
async function stopChild(
  child: ChildProcess,
  status: Promise<LaneStatus>,
  group: number | undefined,
): Promise<void> {
  const deadline = performance.now() + laneShutdownTimeoutMs;
  signalLaneGroup(group);
  killLane(child, "SIGTERM");
  await settledWithin(status, deadline - performance.now());
  killLane(child, "SIGKILL");
  await status;
  await tearDownLaneGroup(group, deadline - performance.now());
}

async function statusOrAbort(
  child: ChildProcess,
  status: Promise<LaneStatus>,
  group: number | undefined,
  signal: AbortSignal | undefined,
  deadlineMs?: number,
): Promise<
  { status?: LaneStatus; aborted: boolean; pastDeadline?: boolean }
> {
  if (signal?.aborted) {
    await stopChild(child, status, group);
    return { aborted: true };
  }

  let onAbort: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    status.then((value) => ({ type: "status" as const, value })),
    new Promise<{ type: "aborted" }>((resolve) => {
      if (!signal) return;
      onAbort = () => resolve({ type: "aborted" });
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    }),
    new Promise<{ type: "deadline" }>((resolve) => {
      if (deadlineMs === undefined) return;
      timer = setTimeout(() => resolve({ type: "deadline" }), deadlineMs);
    }),
  ]);
  if (onAbort) signal?.removeEventListener("abort", onAbort);
  if (timer !== undefined) clearTimeout(timer);
  if (result.type === "status") return { status: result.value, aborted: false };

  // Past the deadline or interrupted: the same bounded teardown either way.
  await stopChild(child, status, group);
  return result.type === "deadline"
    ? { aborted: false, pastDeadline: true }
    : { aborted: true };
}

// --- Lane records and recovery -------------------------------------------
//
// Each running test lane has a record naming the gate's pid, the lane's
// process group and the lane token, which the runner's token carrier (an idle
// same-group `node` child) holds on its command line for the whole run. The
// gate removes it when the lane ends, so a record left behind means the gate
// died mid-lane. At its next start the gate reads each such record.
// If the recording gate is still running (a concurrent gate), the record is
// left alone. Otherwise the gate signals the recorded group only when a live
// member of that group still carries the lane token, so a reused process or
// group id is never signalled; either way the record is then dropped.

interface LaneRecord {
  gatePid: number;
  group: number;
  token: string;
}

interface ProcessEntry {
  pid: number;
  group: number;
  command: string;
}

function parseLaneRecord(text: string): LaneRecord | undefined {
  try {
    const value = JSON.parse(text);
    if (
      Number.isSafeInteger(value?.gatePid) && value.gatePid > 1 &&
      Number.isSafeInteger(value?.group) && value.group > 1 &&
      typeof value?.token === "string" && isLaneToken(value.token)
    ) {
      return { gatePid: value.gatePid, group: value.group, token: value.token };
    }
  } catch {
    // Not a record.
  }
  return undefined;
}

// `-ww` asks for unlimited width: the lane token trails the command line, and
// macOS `ps` otherwise truncates the command column.
const LIST_PROCESSES_ARGS = ["-A", "-ww", "-o", "pid=,pgid=,command="];

export function parseProcessList(text: string): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (match) {
      entries.push({
        pid: Number(match[1]),
        group: Number(match[2]),
        command: match[3],
      });
    }
  }
  return entries;
}

function listProcesses(): Promise<ProcessEntry[] | undefined> {
  return new Promise((resolve) => {
    execFile(
      "ps",
      LIST_PROCESSES_ARGS,
      { env: safeEnvironment(), maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => {
        resolve(error ? undefined : parseProcessList(stdout));
      },
    );
  });
}

/** Whether `record` still names a live lane group this gate may stop. */
export function orphanedLaneGroup(
  record: LaneRecord,
  processes: readonly ProcessEntry[],
): "gate-alive" | "recover" | "drop" {
  const gate = processes.find((entry) => entry.pid === record.gatePid);
  if (gate !== undefined && gate.command.includes("aggregate-test-gate")) {
    return "gate-alive";
  }
  const marker = laneTokenArgument(record.token);
  return processes.some((entry) =>
      entry.group === record.group && entry.command.includes(marker)
    )
    ? "recover"
    : "drop";
}

export async function recoverOrphanedLaneGroups(
  dir: string,
  out: Pick<Console, "log" | "error">,
): Promise<void> {
  if (!laneProcessGroups) return;
  let names: string[];
  try {
    names = (await readdir(dir, { withFileTypes: true }))
      .filter((entry) =>
        entry.isFile() &&
        (entry.name.endsWith(".json") || entry.name.endsWith(".json.partial"))
      )
      .map((entry) => entry.name);
  } catch {
    return; // No records, or no access: nothing to recover.
  }
  if (names.length === 0) return;
  const processes = await listProcesses();
  if (processes === undefined) return;
  for (const name of names) {
    const path = `${dir}/${name}`;
    let record: LaneRecord | undefined;
    try {
      record = parseLaneRecord(await readFile(path, "utf8"));
    } catch {
      continue;
    }
    // A partial record that does not parse may still be being written: it is
    // left alone until it is older than any write could take.
    if (
      record === undefined && name.endsWith(".partial") &&
      !(await olderThan(path, PARTIAL_RECORD_MAX_AGE_MS))
    ) {
      continue;
    }
    const verdict = record === undefined
      ? "drop"
      : orphanedLaneGroup(record, processes);
    if (verdict === "gate-alive") continue;
    if (verdict === "recover") {
      out.log(
        "▶ stopping a test-lane process group left by an earlier gate run",
      );
      await tearDownLaneGroup(record!.group, laneGroupGraceMs);
    }
    await rm(path, { force: true }).catch(() => undefined);
  }
}

// A partial record is complete once parsed; one that is still malformed after
// this long was left by a gate that died mid-write.
const PARTIAL_RECORD_MAX_AGE_MS = 60_000;

async function olderThan(path: string, ageMs: number): Promise<boolean> {
  try {
    return Date.now() - (await stat(path)).mtimeMs > ageMs;
  } catch {
    return false;
  }
}

async function writeLaneRecord(
  dir: string | undefined,
  record: LaneRecord,
): Promise<string | undefined> {
  if (dir === undefined || !laneProcessGroups) return undefined;
  const path = `${dir}/${record.token}.json`;
  // Written under another name and renamed into place, so a concurrent
  // gate's recovery never drops a record that is only partly written. A
  // complete record still under that name, left by a gate killed before the
  // rename, is recovered like any other.
  const partial = `${path}.partial`;
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(partial, JSON.stringify(record));
    await rename(partial, path);
    return path;
  } catch {
    return undefined; // Best effort: recovery is lost, the lane still runs.
  }
}

export function productionLanes(root = process.cwd()): GateLane[] {
  const prototype = `${root}/prototype`;
  const core = `${root}/core`;
  const binding = bindingEnvironment();
  const bound = readOptionalEnv(TEST_BOUND_ENV);
  const tempDir = laneTempDir(readOptionalEnv("TMPDIR"));
  const subjectLane = (check: string): GateLane => ({
    label: check === "subject.resolve"
      ? "Subject resolution"
      : "Subject digest recomputation",
    checkId: check,
    command: "node",
    args: ["scripts/subject-check.ts", "--check", check],
    cwd: root,
    env: binding,
  });
  const treeScanLane = (family: string): GateLane => ({
    label: `Public-safety tree scan (${family})`,
    checkId: family,
    command: "node",
    args: ["scripts/public-safety-scan.ts", "--family", family],
    cwd: root,
  });
  const rangeLane = (label: string, check: string): GateLane => ({
    label,
    checkId: check,
    command: "node",
    args: ["scripts/range-checks.ts", "--check", check],
    cwd: root,
    env: binding,
  });
  return [
    {
      // npm install precondition: the test lanes run against the node_modules
      // npm installed, so a missing or stale install fails here first, with
      // the remedy. Under the aggregate check id because it judges this
      // checkout's installed state, not the committed tree that
      // dependency.policy validates from a clean checkout. It only reads: the
      // gate never runs npm.
      label: "npm install precondition (node_modules)",
      checkId: "test.aggregate",
      command: "node",
      args: ["scripts/node-modules-check.ts", root],
      cwd: root,
    },
    subjectLane("subject.resolve"),
    subjectLane("subject.digest"),
    {
      label: "Retired-surface scan",
      checkId: "test.aggregate",
      command: "node",
      args: ["scripts/retired-surface-scan.ts"],
      cwd: root,
    },
    treeScanLane("secret.tree"),
    treeScanLane("public.boundary"),
    rangeLane("Release-range secret scan", "secret.diff"),
    rangeLane("Release-range whitespace check", "diff.whitespace"),
    rangeLane("Changed-Markdown link check", "markdown.links"),
    rangeLane("Changed-shell parse check", "shell.parse"),
    {
      label: "Dependency policy check",
      checkId: "dependency.policy",
      command: "node",
      args: ["scripts/dependency-policy.ts"],
      cwd: root,
      env: binding,
    },
    {
      // Module-boundary ratchet (specs/01-architecture.md section 4): runs
      // under the aggregate check id rather than a new required id, so the
      // receipt check-id vocabulary is unchanged. It runs on Node (decision
      // D32), parsing with Node's type stripping and acorn; it only reads.
      label: "Architecture import rules (arch.imports)",
      checkId: "test.aggregate",
      command: "node",
      args: ["scripts/arch-imports.ts"],
      cwd: root,
    },
    {
      // The arch.imports checker's own tests register with node:test, so
      // they run under `node --test` through the shared Node runner (decision
      // D32). They build their graphs in memory and only read the committed
      // rules.
      label: "Architecture import rules tests",
      checkId: "test.aggregate",
      command: "node",
      args: [
        "scripts/run-node-test-files.ts",
        "--lane",
        "arch.imports",
        "scripts/arch-imports.test.ts",
      ],
      cwd: root,
    },
    {
      // Runtime-neutrality ratchet (decision D32): counts references to the
      // host runtime's global object in tracked TypeScript against a
      // committed, shrink-only list. Also under the aggregate check id. It
      // lists the tracked files with `git` and only reads.
      label: "Runtime-neutral ratchet (runtime.neutral)",
      checkId: "test.aggregate",
      command: "node",
      args: ["scripts/runtime-neutral.ts"],
      cwd: root,
    },
    {
      // Ratchet lists against the merge base: an entry of the runtime.neutral
      // or size-exception list may grow, or appear, only with a growth_reason
      // added in the same change, and the arch.imports baseline may not gain
      // an entry at all. The base comes from DYFJ_GATE_RANGE_BASE, else the
      // merge base with origin/main locally. Under the aggregate check id; it
      // reads git and the three lists and writes nothing.
      label: "Ratchet lists against the merge base (ratchet.base)",
      checkId: "test.aggregate",
      command: "node",
      args: ["scripts/ratchet-base.ts"],
      cwd: root,
      env: binding,
    },
    {
      // The validator's tests register with node:test, so they run under
      // `node --test` through the shared Node runner (decision D32). They
      // build their receipts in memory and only read the validator.
      label: "Receipt schema validation",
      checkId: "receipt.schema",
      command: "node",
      args: [
        "scripts/run-node-test-files.ts",
        "--lane",
        "receipt.schema",
        "scripts/assurance-receipt.test.ts",
      ],
      cwd: root,
    },
    {
      label: "Aggregate gate orchestration tests",
      checkId: "test.aggregate",
      // These files register with node:test, so they run under `node --test`
      // with the per-file handle check, through the shared Node runner
      // (decision D32).
      command: "node",
      args: [
        "scripts/run-node-test-files.ts",
        "--lane",
        "gate.orchestration",
        "scripts/aggregate-test-gate.test.ts",
        "scripts/ci-workflow.test.ts",
        "scripts/public-safety-scan.test.ts",
        "scripts/subject-check.test.ts",
        "scripts/range-checks.test.ts",
        "scripts/dependency-policy.test.ts",
        "scripts/node-modules-check.test.ts",
        "scripts/runtime-neutral.test.ts",
        "scripts/typecheck-tsc.test.ts",
        "scripts/node-load-probe.test.ts",
        "scripts/git-hooks.test.ts",
        "scripts/lane-supervision.test.ts",
        "scripts/node-lane-supervision.test.ts",
        "scripts/change-scope.test.ts",
        "scripts/retired-surface-scan.test.ts",
        "scripts/ratchet-base.test.ts",
      ],
      cwd: root,
      env: { TMPDIR: tempDir, ...ciEnvironment() },
    },
    {
      // TypeScript typecheck (decision D32): `tsc --noEmit` from the root npm
      // workspace's devDependencies, over the root tsconfig.json, which
      // includes every source and test file. `erasableSyntaxOnly` rejects syntax Node cannot strip,
      // such as a constructor parameter property. Under the aggregate check
      // id; it only reads.
      label: "TypeScript typecheck (typecheck.tsc)",
      checkId: "test.aggregate",
      command: "node",
      args: ["node_modules/typescript/bin/tsc", "--project", "tsconfig.json"],
      cwd: root,
    },
    {
      label: "Prototype unit test suite (test.unit)",
      checkId: "test.aggregate",
      // The runner itself, not `npm run test:unit`: it has to lead the lane
      // group so its end-of-run group stop reaches the group and nothing
      // else. It runs every unit test file under `node --test`.
      command: "node",
      args: ["scripts/run-unit-tests.ts"],
      cwd: prototype,
      env: { TMPDIR: tempDir, ...ciEnvironment() },
      deadlineMs: laneDeadlineMs(LANE_DEADLINES_MS.unit, bound),
    },
    {
      label: "Contract closure report generation",
      checkId: "test.aggregate",
      // Compares the regenerated report with the committed one; with
      // `--compare-path` it writes nothing.
      command: "node",
      args: [
        "contracts/workbench/first-product/v1/executable-closure-report.ts",
        "--compare-path",
        "contracts/workbench/first-product/v1/executable-closure-report.json",
      ],
      cwd: root,
    },
    {
      // These files register with node:test, so they run under `node --test`
      // with the per-file handle check, through the shared Node runner
      // (decision D32), as the schema unit tests below do. The suite only
      // reads its schemas and fixtures; the tests run with no permission
      // sandbox.
      label: "Contract package tests",
      checkId: "test.aggregate",
      command: "node",
      args: [
        "scripts/run-node-test-files.ts",
        "--lane",
        "contracts",
        "contracts/workbench/first-product/v1/validate.test.ts",
        "contracts/workbench/first-product/v1/executable-closure.test.ts",
        "contracts/workbench/first-product/v1/executable-closure-report.test.ts",
      ],
      cwd: root,
    },
    {
      // These files register with node:test, so they run under `node --test`
      // with the per-file handle check, through the shared Node runner
      // (decision D32). The runner reads the repository and spawns `node`;
      // the tests run with no permission sandbox.
      label: "Schema unit tests",
      checkId: "test.aggregate",
      command: "node",
      args: [
        "scripts/run-node-test-files.ts",
        "--lane",
        "schema.unit",
        "schema/validate-schema.test.ts",
        "schema/codegen.test.ts",
        "schema/equivalence.test.ts",
      ],
      cwd: root,
    },
    {
      // Registers with node:test, so it runs under `node --test` through the
      // shared Node runner, like the schema unit tests. Its tests apply the
      // schema to disposable Dolt repositories through `schema/dolt-apply.ts`
      // and run unsandboxed; `dolt` gets the variables the runner forwards.
      label: "Local model catalog data validation",
      checkId: "test.aggregate",
      command: "node",
      args: [
        "scripts/run-node-test-files.ts",
        "--lane",
        "schema.catalog",
        "schema/model-catalog.test.ts",
      ],
      cwd: root,
    },
    // The four schema lanes below run their CLIs as plain `node`, written to
    // `node:` builtins (decision D32). Each reaches `schema/dolt-apply.ts`,
    // which spawns `dolt` through node:child_process and makes its repository
    // with node:fs.
    {
      label: "Current-schema apply validation",
      checkId: "test.aggregate",
      command: "node",
      args: ["schema/validate-schema.ts", "--current-only"],
      cwd: root,
    },
    {
      label: "Historical replay plus forward-migration validation",
      checkId: "test.aggregate",
      command: "node",
      args: ["schema/validate-schema.ts", "--history-only"],
      cwd: root,
    },
    // Schema lanes (specs/02-data-layer.md sections 3 and 4), under the
    // aggregate check id like arch.imports. `schema.codegen` regenerates the
    // row types in memory and fails when the committed file differs;
    // `schema.equivalence` fails when current + catalog and history +
    // migrations produce different structures.
    {
      label: "Schema codegen freshness (schema.codegen)",
      checkId: "test.aggregate",
      command: "node",
      args: ["schema/codegen.ts", "--check"],
      cwd: root,
    },
    {
      label: "Schema equivalence (schema.equivalence)",
      checkId: "test.aggregate",
      command: "node",
      args: ["schema/equivalence.ts"],
      cwd: root,
    },
    {
      label: "Offline-metadata Rust tests",
      checkId: "test.aggregate",
      command: "cargo",
      args: ["test"],
      cwd: core,
      env: { SQLX_OFFLINE: "true" },
    },
    {
      label: "Isolated Dolt integration lane",
      checkId: "test.aggregate",
      // The runner starts the isolated Dolt fixture and runs every
      // integration file under `node --test` against it.
      command: "node",
      args: ["scripts/isolated-dolt-integration.ts"],
      cwd: prototype,
      env: { TMPDIR: tempDir, ...ciEnvironment() },
      deadlineMs: laneDeadlineMs(LANE_DEADLINES_MS.integration, bound),
    },
    // Golden characterization suite (`test.golden`): black-box snapshots of
    // the engine server and CLI over an isolated Dolt fixture. The runner and
    // its tests run on Node, under `node --test`, unsandboxed.
    {
      label: "Golden characterization suite (test.golden)",
      checkId: "test.aggregate",
      command: "node",
      args: ["testing/golden/run.ts"],
      cwd: prototype,
      env: { TMPDIR: tempDir },
      deadlineMs: laneDeadlineMs(LANE_DEADLINES_MS.golden, bound),
    },
  ];
}

// The fast subset reuses the production lane definitions verbatim — it is a
// local-feedback selection, not a second lane ontology. Every stable policy
// check runs; only the heavyweight suite lanes are deferred to the full
// gate, which stays the single repository green bar.
export const FAST_LANE_LABELS: readonly string[] = [
  "npm install precondition (node_modules)",
  "Subject resolution",
  "Subject digest recomputation",
  "Retired-surface scan",
  "Public-safety tree scan (secret.tree)",
  "Public-safety tree scan (public.boundary)",
  "Release-range secret scan",
  "Release-range whitespace check",
  "Changed-Markdown link check",
  "Changed-shell parse check",
  "Dependency policy check",
  "Architecture import rules (arch.imports)",
  "Runtime-neutral ratchet (runtime.neutral)",
  "Ratchet lists against the merge base (ratchet.base)",
  "Receipt schema validation",
  "Contract closure report generation",
  "Contract package tests",
  "TypeScript typecheck (typecheck.tsc)",
  "Prototype unit test suite (test.unit)",
];

function laneSubset(labels: readonly string[], root: string): GateLane[] {
  const byLabel = new Map(
    productionLanes(root).map((lane) => [lane.label, lane]),
  );
  return labels.map((label) => {
    const lane = byLabel.get(label);
    if (!lane) {
      throw new Error(`subset lane is not a production lane: ${label}`);
    }
    return lane;
  });
}

export function fastLanes(root = process.cwd()): GateLane[] {
  return laneSubset(FAST_LANE_LABELS, root);
}

// A pull request whose release range changes Markdown files only runs these
// lanes and skips the rest (`planGate`): the policy lanes, which together
// report every required check id so the status can still compose to `pass`,
// plus every lane that reads this repository's own Markdown. The
// retired-surface scan reads it, and both contract lanes do: the closure
// report checks the `closure-claim` markers in `README.md`, `CHANGELOG.md`
// and the contract package README. No skipped lane reads it, so none can
// change result on such a change. The push to main runs the full gate, so
// anything a docs-only pull request skipped is still checked there.
export const DOCS_ONLY_LANE_LABELS: readonly string[] = [
  "Subject resolution",
  "Subject digest recomputation",
  "Retired-surface scan",
  "Public-safety tree scan (secret.tree)",
  "Public-safety tree scan (public.boundary)",
  "Release-range secret scan",
  "Release-range whitespace check",
  "Changed-Markdown link check",
  "Changed-shell parse check",
  "Dependency policy check",
  "Receipt schema validation",
  "Contract closure report generation",
  "Contract package tests",
];

export function docsOnlyLanes(root = process.cwd()): GateLane[] {
  return laneSubset(DOCS_ONLY_LANE_LABELS, root);
}

// Only a pull-request run of the CI gate may take the docs-only path. A push
// to main, a manual dispatch and every local run keep the full gate.
export function docsOnlyEligible(
  env: (name: string) => string | undefined,
): boolean {
  return env("GITHUB_ACTIONS") === "true" &&
    env("GITHUB_EVENT_NAME") === "pull_request";
}

// Classification runs in a short-lived `node` child, which runs git. Its only
// output is one code-authored word; anything else, a failure included, reads
// as `other` and keeps the full gate.
export function releaseChangeScope(root: string): Promise<ChangeScope> {
  return new Promise((resolve) => {
    execFile(
      "node",
      ["scripts/change-scope.ts"],
      { cwd: root, env: { ...safeEnvironment(), ...bindingEnvironment() } },
      (error, stdout) => {
        resolve(
          !error && stdout.trim() === "markdown-only"
            ? "markdown-only"
            : "other",
        );
      },
    );
  });
}

export interface GatePlan {
  lanes: GateLane[];
  mode: GateMode;
  requiredCheckIds?: readonly string[];
  successMessage?: string;
  skipped?: { reason: string; labels: readonly string[] };
}

export interface PlanGateOptions {
  fast: boolean;
  env: (name: string) => string | undefined;
  root?: string;
  // Injected by tests; defaults to `releaseChangeScope`.
  changeScope?: () => Promise<ChangeScope>;
}

export async function planGate(options: PlanGateOptions): Promise<GatePlan> {
  const root = options.root ?? process.cwd();
  if (options.fast) {
    return {
      lanes: fastLanes(root),
      mode: "fast",
      successMessage:
        "✓ fast gate subset passed (not the full green bar; run `npm test`)",
    };
  }
  const production = productionLanes(root);
  if (docsOnlyEligible(options.env)) {
    const scope = await (options.changeScope ??
      (() => releaseChangeScope(root)))();
    if (scope === "markdown-only") {
      const lanes = docsOnlyLanes(root);
      return {
        lanes,
        mode: "docs-only",
        requiredCheckIds: REQUIRED_CHECK_IDS,
        successMessage:
          "✓ docs-only gate passed (the lanes a Markdown-only change can affect; the push to main runs the full gate)",
        skipped: {
          reason:
            "every path this pull request changes is Markdown, so only the policy and Markdown-reading lanes run",
          labels: production
            .map((lane) => lane.label)
            .filter((label) => !DOCS_ONLY_LANE_LABELS.includes(label)),
        },
      };
    }
  }
  return {
    lanes: production,
    mode: "full",
    requiredCheckIds: REQUIRED_CHECK_IDS,
  };
}

// Fail closed on anything unrecognized: an unknown flag must not silently run
// a different lane selection than the caller intended.
export function parseGateArguments(
  args: readonly string[],
): { fast: boolean } {
  let fast = false;
  for (const argument of args) {
    if (argument === "--fast") {
      fast = true;
      continue;
    }
    throw new Error(
      "aggregate test gate: unknown argument (only --fast is supported)",
    );
  }
  return { fast };
}

// Bounded, value-free, machine-readable status for the executed lanes: check
// ids and result classes only. Fail-closed by construction — a required
// check that did not run, was unavailable, or failed can never compose into
// `pass`; interruption is reported as its own outcome, distinct from
// failure. This line is a diagnostic of this run's checks only: it is not an
// assurance receipt (`receipt.schema` validates that envelope contract) and
// claims no remote review, acceptance testing, publication, or runtime
// authority.
export function composeGateStatus(
  outcomes: readonly LaneOutcome[],
  mode: GateMode,
  requiredCheckIds: readonly string[],
): GateStatus {
  const severity: Record<LaneResult, number> = {
    pass: 0,
    skipped: 1,
    interrupted: 2,
    unavailable: 3,
    fail: 4,
  };
  const byId = new Map<string, LaneResult>();
  for (const outcome of outcomes) {
    if (outcome.checkId === undefined) continue;
    const current = byId.get(outcome.checkId);
    if (current === undefined || severity[outcome.result] > severity[current]) {
      byId.set(outcome.checkId, outcome.result);
    }
  }
  for (const id of requiredCheckIds) {
    if (!byId.has(id)) byId.set(id, "skipped");
  }
  const all: LaneResult[] = [
    ...outcomes.map((outcome) => outcome.result),
    ...requiredCheckIds.map((id) => byId.get(id) ?? "skipped"),
  ];
  const anyFail = all.some((r) => r === "fail" || r === "unavailable");
  const anyInterrupted = all.some((r) => r === "interrupted");
  const anySkipped = all.some((r) => r === "skipped");
  // An interrupted run is incomplete, so it reads `interrupted` even when an
  // earlier lane failed: every lane runs past a failure, and only an
  // interruption can leave later lanes unrun. The failed check still reads
  // `fail` in `checks`, and the exit code is still the failure's.
  const result = anyInterrupted
    ? "interrupted"
    : anyFail
    ? "fail"
    : anySkipped
    ? "fail"
    : "pass";
  const checks = [...byId.entries()]
    .map(([id, laneResult]) => ({ id, result: laneResult }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return { schema: "dyfj.gate.status/v1", mode, checks, result };
}

export async function runGate(options: RunGateOptions = {}): Promise<number> {
  const out = options.out ?? console;
  const lanes = options.lanes ?? productionLanes(options.root ?? process.cwd());
  const mode = options.mode ?? "full";
  const required = options.requiredCheckIds ??
    [
      ...new Set(
        lanes.flatMap((lane) =>
          lane.checkId === undefined ? [] : [lane.checkId]
        ),
      ),
    ];
  const outcomes: LaneOutcome[] = lanes.map((lane) => ({
    checkId: lane.checkId,
    result: "skipped",
  }));
  // A failing lane does not stop the gate: every later lane still runs, so
  // one run reports every failure. Only interruption stops it early. The
  // first failing lane's code is kept, so the process exit code is the one a
  // stop-at-first-failure gate would have returned.
  const failedLabels: string[] = [];
  let firstFailureCode = 0;
  const laneFailed = (label: string, code: number): void => {
    failedLabels.push(label);
    if (firstFailureCode === 0) firstFailureCode = code;
  };
  // The composed status is the authority on the process result: a lane exit
  // code alone can read zero while a required check is missing, failed,
  // unavailable, or skipped. The first concrete nonzero lane code is
  // preserved when there is one; composition-only gaps fall back to the
  // deterministic codes above. Only a composed `pass` can return zero.
  const finish = (laneCode: number): number => {
    if (failedLabels.length > 0) {
      out.error(
        `✗ ${failedLabels.length} of ${lanes.length} lanes failed:`,
      );
      for (const label of failedLabels) out.error(`  - ${label}`);
    }
    const status = composeGateStatus(outcomes, mode, required);
    out.log(`gate-status ${JSON.stringify(status)}`);
    if (status.result === "pass") return laneCode === 0 ? 0 : laneCode;
    if (status.result === "interrupted") {
      return laneCode === 0 ? COMPOSED_INTERRUPTED_EXIT_CODE : laneCode;
    }
    return laneCode === 0 ? COMPOSED_FAIL_EXIT_CODE : laneCode;
  };
  if (options.laneRecordDir !== undefined) {
    await recoverOrphanedLaneGroups(options.laneRecordDir, out);
  }
  if (options.skipped !== undefined && options.skipped.labels.length > 0) {
    out.log(
      `▷ ${options.skipped.reason}; skipping ${options.skipped.labels.length} lanes:`,
    );
    for (const label of options.skipped.labels) out.log(`  - ${label}`);
  }
  for (let index = 0; index < lanes.length; index++) {
    const lane = lanes[index]!;
    const outcome = outcomes[index]!;
    if (options.signal?.aborted) {
      outcome.result = "interrupted";
      return finish(firstFailureCode || interruptedExitCode(options.signal));
    }
    const commandLabel = laneCommandLabel(lane);
    const start = performance.now();
    out.log(`▶ ${lane.label} (${commandLabel})`);
    const token = lane.deadlineMs === undefined
      ? undefined
      : randomUUID();
    const supervision: Record<string, string> = token === undefined ? {} : {
      [LANE_DEADLINE_ENV]: String(lane.deadlineMs),
      [LANE_BACKSTOP_ENV]: String(lane.deadlineMs! + LANE_BACKSTOP_MARGIN_MS),
      [LANE_TOKEN_ENV]: token,
      // The runner's expected parent: it stops its lane once its parent is
      // anything else.
      [LANE_PARENT_ENV]: String(process.pid),
    };
    let recordPath: string | undefined;
    try {
      // The child gets only the environment built here: the inherited
      // names, the lane's own and the supervision values.
      const child = spawn(lane.command, lane.args, {
        cwd: lane.cwd,
        env: { ...safeEnvironment(), ...(lane.env ?? {}), ...supervision },
        stdio: ["ignore", "inherit", "inherit"],
        // Own process group per lane: the leader is the group leader, so its
        // pid is the group id interruption signals.
        detached: laneProcessGroups,
      });
      const exited = exitStatus(child);
      await started(child);
      const group = laneProcessGroups ? child.pid : undefined;
      if (token !== undefined && group !== undefined) {
        recordPath = await writeLaneRecord(options.laneRecordDir, {
          gatePid: process.pid,
          group,
          token,
        });
      }
      const result = await statusOrAbort(
        child,
        exited,
        group,
        options.signal,
        lane.deadlineMs,
      );
      const elapsedMs = Math.round(performance.now() - start);
      if (result.pastDeadline) {
        outcome.result = "fail";
        out.error(
          `✗ ${lane.label}: failure (${elapsedMs}ms, stopped at its ${
            Math.round(lane.deadlineMs! / 1000)
          } s deadline)`,
        );
        laneFailed(lane.label, LANE_DEADLINE_EXIT_CODE);
        continue;
      }
      if (result.aborted) {
        outcome.result = "interrupted";
        out.error(`✗ ${lane.label}: interrupted (${elapsedMs}ms)`);
        return finish(firstFailureCode || interruptedExitCode(options.signal!));
      }
      const status = result.status!;
      // The leader's real status is already captured above; an ordinary exit
      // still leaves the lane group for the gate to clean up, and teardown
      // never changes what the lane reports.
      await tearDownLaneGroup(group, laneGroupGraceMs);
      if (status.code !== 0) {
        outcome.result = "fail";
        out.error(
          `✗ ${lane.label}: failure (${elapsedMs}ms, exit ${status.code})`,
        );
        laneFailed(lane.label, status.code || 1);
        continue;
      }
      outcome.result = "pass";
      out.log(`✓ ${lane.label}: success (${elapsedMs}ms)`);
    } catch {
      const elapsedMs = Math.round(performance.now() - start);
      outcome.result = "unavailable";
      // Fixed class and hint only: the platform exception embeds the raw
      // command path and is never relayed.
      out.error(
        `✗ ${lane.label}: failure (${elapsedMs}ms, unavailable: ` +
          "command-not-runnable; check that the tool is installed and permitted)",
      );
      laneFailed(lane.label, 127);
    } finally {
      if (recordPath !== undefined) {
        await rm(recordPath, { force: true }).catch(() => undefined);
      }
    }
  }
  if (options.signal?.aborted) {
    outcomes.push({ result: "interrupted" });
    return finish(firstFailureCode || interruptedExitCode(options.signal));
  }
  const code = finish(firstFailureCode);
  // The success claim is made only when the composed status itself passed.
  if (code === 0) {
    out.log(options.successMessage ?? "✓ aggregate test gate passed");
  }
  return code;
}

if (import.meta.main) {
  let fast = false;
  try {
    fast = parseGateArguments(process.argv.slice(2)).fast;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(64);
  }
  const plan = await planGate({ fast, env: readOptionalEnv });
  const abortController = new AbortController();
  const onSigint = () => abortController.abort("SIGINT");
  const onSigterm = () => abortController.abort("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  let exitCode: number;
  try {
    exitCode = await runGate({
      signal: abortController.signal,
      lanes: plan.lanes,
      mode: plan.mode,
      requiredCheckIds: plan.requiredCheckIds,
      successMessage: plan.successMessage,
      skipped: plan.skipped,
      laneRecordDir: defaultLaneRecordDir(readOptionalEnv("HOME")),
    });
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
  process.exit(exitCode);
}
