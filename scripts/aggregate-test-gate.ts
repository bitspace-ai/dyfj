import { selectedDenoExecutable } from "../prototype/scripts/deno-executable.ts";
import {
  isLaneToken,
  LANE_BACKSTOP_ENV,
  LANE_DEADLINE_ENV,
  LANE_ENV_NAMES,
  LANE_TOKEN_ENV,
  laneTokenArgument,
  MAX_TIMER_DELAY_MS,
} from "../prototype/scripts/lane-supervision.ts";

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

export interface GateStatus {
  schema: "dyfj.gate.status/v1";
  mode: "full" | "fast";
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
  mode?: "full" | "fast";
  requiredCheckIds?: readonly string[];
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

export const INHERITED_ENVIRONMENT_NAMES: readonly string[] = [
  "PATH",
  "HOME",
  "CARGO_HOME",
  "RUSTUP_HOME",
  // A caller's Deno cache, so nested Deno processes in the lanes reuse it
  // instead of fetching modules again.
  "DENO_DIR",
];

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
const laneProcessGroups = Deno.build.os !== "windows";

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
// The largest DYFJ_TEST_BOUND_SEC whose deadline and backstop both fit a Deno
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
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
}

function safeEnvironment(): Record<string, string> {
  return Object.fromEntries(
    INHERITED_ENVIRONMENT_NAMES.flatMap((name) => {
      const value = Deno.env.get(name);
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

// Signalling a process group needs `Deno.kill`, which requires unscoped run
// permission the gate deliberately does not hold. The selected Deno — already
// the one executable the gate is granted to run — carries the group signal in
// a short-lived child instead. Its argv holds a code-authored program with a
// validated numeric group id substituted in, and its streams are discarded,
// so no lane value reaches gate output.
function groupSignalExecutable(): string | undefined {
  try {
    return selectedDenoExecutable(readOptionalEnv);
  } catch {
    return undefined;
  }
}

// Code-authored group programs. Both take a validated numeric group id and a
// code-authored grace bound only; no lane value is ever substituted in, and
// the child's streams are discarded.
function laneGroupSignalProgram(group: number): string {
  return `try { Deno.kill(${-group}, "SIGTERM"); } catch { /* gone */ }`;
}

// Bounded group teardown, run once the leader has been reaped: ask the group
// to stop, return the moment nothing is left in it, and force-kill whatever
// is still there when the grace expires. `SIGCONT` is the liveness probe —
// it is delivered to a live group and raises on an empty one.
function laneGroupTeardownProgram(group: number, graceMs: number): string {
  return [
    `const signal = (name) => {`,
    `  try { Deno.kill(${-group}, name); return true; } catch { return false; }`,
    `};`,
    `if (!signal("SIGTERM")) Deno.exit(0);`,
    `const deadline = Date.now() + ${Math.max(0, Math.round(graceMs))};`,
    `for (;;) {`,
    `  if (!signal("SIGCONT")) Deno.exit(0);`,
    `  if (Date.now() >= deadline) break;`,
    `  await new Promise((resolve) => setTimeout(resolve, 20));`,
    `}`,
    `signal("SIGKILL");`,
  ].join("\n");
}

async function runLaneGroupProgram(
  group: number | undefined,
  program: (group: number) => string,
): Promise<void> {
  if (group === undefined || !Number.isSafeInteger(group) || group <= 1) return;
  const executable = groupSignalExecutable();
  if (executable === undefined) return;
  try {
    await new Deno.Command(executable, {
      args: ["eval", "--allow-run", program(group)],
      env: safeEnvironment(),
      clearEnv: true,
      stdout: "null",
      stderr: "null",
    }).output();
  } catch {
    // Best effort: teardown mechanics never change a lane's own result.
  }
}

// Windows lanes have no process group, so `group` is undefined there and this
// is a no-op: the leader-only path stays explicit.
function signalLaneGroup(group: number | undefined): Promise<void> {
  return runLaneGroupProgram(group, laneGroupSignalProgram);
}

function tearDownLaneGroup(
  group: number | undefined,
  graceMs: number,
): Promise<void> {
  return runLaneGroupProgram(
    group,
    (id) => laneGroupTeardownProgram(id, graceMs),
  );
}

function killLane(
  child: ReturnType<Deno.Command["spawn"]>,
  signal: "SIGTERM" | "SIGKILL",
): void {
  try {
    child.kill(signal);
  } catch {
    // The lane leader already exited.
  }
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
  child: ReturnType<Deno.Command["spawn"]>,
  group: number | undefined,
): Promise<void> {
  const deadline = performance.now() + laneShutdownTimeoutMs;
  await signalLaneGroup(group);
  killLane(child, "SIGTERM");
  await settledWithin(child.status, deadline - performance.now());
  killLane(child, "SIGKILL");
  await child.status.catch(() => undefined);
  await tearDownLaneGroup(group, deadline - performance.now());
}

async function statusOrAbort(
  child: ReturnType<Deno.Command["spawn"]>,
  group: number | undefined,
  signal: AbortSignal | undefined,
  deadlineMs?: number,
): Promise<
  { status?: Deno.CommandStatus; aborted: boolean; pastDeadline?: boolean }
> {
  const status = child.status;
  if (signal?.aborted) {
    await stopChild(child, group);
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
  await stopChild(child, group);
  return result.type === "deadline"
    ? { aborted: false, pastDeadline: true }
    : { aborted: true };
}

// --- Lane records and recovery -------------------------------------------
//
// Each running test lane has a record naming the gate's pid, the lane's
// process group and the lane token its runner puts on the `deno test` command
// line. The gate removes it when the lane ends, so a record left behind means
// the gate died mid-lane. At its next start the gate reads each such record.
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

// Listing processes needs a run grant the gate does not hold, so the selected
// Deno lists them in a short-lived child, as it signals lane groups. `-ww`
// asks for unlimited width: the lane token trails the command line, and macOS
// `ps` otherwise truncates the command column.
const LIST_PROCESSES_PROGRAM = [
  `const out = await new Deno.Command("ps", {`,
  `  args: ["-A", "-ww", "-o", "pid=,pgid=,command="],`,
  `  stdout: "piped", stderr: "null",`,
  `}).output();`,
  `await Deno.stdout.write(out.stdout);`,
].join("\n");

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

async function listProcesses(): Promise<ProcessEntry[] | undefined> {
  const executable = groupSignalExecutable();
  if (executable === undefined) return undefined;
  try {
    const output = await new Deno.Command(executable, {
      args: ["eval", "--allow-run", LIST_PROCESSES_PROGRAM],
      env: safeEnvironment(),
      clearEnv: true,
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!output.success) return undefined;
    return parseProcessList(new TextDecoder().decode(output.stdout));
  } catch {
    return undefined;
  }
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
    names = [];
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile && entry.name.endsWith(".json")) names.push(entry.name);
    }
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
      record = parseLaneRecord(await Deno.readTextFile(path));
    } catch {
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
    await Deno.remove(path).catch(() => undefined);
  }
}

async function writeLaneRecord(
  dir: string | undefined,
  record: LaneRecord,
): Promise<string | undefined> {
  if (dir === undefined || !laneProcessGroups) return undefined;
  const path = `${dir}/${record.token}.json`;
  try {
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(path, JSON.stringify(record));
    return path;
  } catch {
    return undefined; // Best effort: recovery is lost, the lane still runs.
  }
}

export function productionLanes(
  root = Deno.cwd(),
  denoExecutable = selectedDenoExecutable(),
): GateLane[] {
  const prototype = `${root}/prototype`;
  const core = `${root}/core`;
  const binding = bindingEnvironment();
  const laneEnv = LANE_ENV_NAMES.join(",");
  const bound = readOptionalEnv(TEST_BOUND_ENV);
  const subjectLane = (check: string): GateLane => ({
    label: check === "subject.resolve"
      ? "Subject resolution"
      : "Subject digest recomputation",
    checkId: check,
    command: denoExecutable,
    commandLabel: "deno",
    args: [
      "run",
      "--allow-env=DYFJ_GATE_SUBJECT,GITHUB_ACTIONS",
      "--allow-run=git",
      "scripts/subject-check.ts",
      "--check",
      check,
    ],
    cwd: root,
    env: binding,
  });
  const treeScanLane = (family: string): GateLane => ({
    label: `Public-safety tree scan (${family})`,
    checkId: family,
    command: denoExecutable,
    commandLabel: "deno",
    args: [
      "run",
      `--allow-read=${root}`,
      "--allow-run=git",
      "scripts/public-safety-scan.ts",
      "--family",
      family,
    ],
    cwd: root,
  });
  const rangeLane = (label: string, check: string): GateLane => ({
    label,
    checkId: check,
    command: denoExecutable,
    commandLabel: "deno",
    args: [
      "run",
      "--allow-env=DYFJ_GATE_RANGE_BASE,GITHUB_ACTIONS",
      `--allow-read=${root}`,
      check === "shell.parse" ? "--allow-run=git,/bin/bash" : "--allow-run=git",
      "scripts/range-checks.ts",
      "--check",
      check,
    ],
    cwd: root,
    env: binding,
  });
  return [
    subjectLane("subject.resolve"),
    subjectLane("subject.digest"),
    {
      label: "Retired-surface scan",
      checkId: "test.aggregate",
      command: denoExecutable,
      commandLabel: "deno",
      args: [
        "test",
        `--allow-read=${root}`,
        "--allow-run=git",
        "scripts/retired-surface-scan.ts",
      ],
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
      command: denoExecutable,
      commandLabel: "deno",
      args: [
        "run",
        "--allow-env=DYFJ_GATE_RANGE_BASE,GITHUB_ACTIONS",
        `--allow-read=${root}`,
        "--allow-run=git",
        "scripts/dependency-policy.ts",
      ],
      cwd: root,
      env: binding,
    },
    {
      // Module-boundary ratchet (specs/01-architecture.md section 4): runs
      // under the aggregate check id rather than a new required id, so the
      // receipt check-id vocabulary is unchanged. It builds the module graph
      // with `deno info`, run through the same selected Deno binary.
      label: "Architecture import rules (arch.imports)",
      checkId: "test.aggregate",
      command: denoExecutable,
      commandLabel: "deno",
      args: [
        "run",
        "--no-prompt",
        `--allow-read=${root}`,
        `--allow-run=${denoExecutable}`,
        "scripts/arch-imports.ts",
        `--deno=${denoExecutable}`,
      ],
      cwd: root,
    },
    {
      label: "Receipt schema validation",
      checkId: "receipt.schema",
      command: denoExecutable,
      commandLabel: "deno",
      args: ["test", "scripts/assurance-receipt.test.ts"],
      cwd: root,
    },
    {
      label: "Aggregate gate orchestration tests",
      checkId: "test.aggregate",
      command: denoExecutable,
      commandLabel: "deno",
      args: [
        "test",
        "--allow-env=PATH,HOME,TMPDIR,TEMP,TMP,CARGO_HOME,RUSTUP_HOME,DENO_DIR,DYFJ_AGGREGATE_SENTINEL,DYFJ_GATE_SUBJECT,DYFJ_GATE_RANGE_BASE,GITHUB_ACTIONS",
        "--allow-read=.,/tmp,/private/tmp,/var/folders,/private/var/folders",
        "--allow-write=/tmp,/private/tmp,/var/folders,/private/var/folders",
        `--allow-run=${denoExecutable},ln,git,/bin/bash`,
        "scripts/aggregate-test-gate.test.ts",
        "scripts/ci-workflow.test.ts",
        "scripts/public-safety-scan.test.ts",
        "scripts/subject-check.test.ts",
        "scripts/range-checks.test.ts",
        "scripts/dependency-policy.test.ts",
        "scripts/arch-imports.test.ts",
        "scripts/git-hooks.test.ts",
        "scripts/lane-supervision.test.ts",
      ],
      cwd: root,
      // Lane children run with a cleared environment, so the temp root the
      // write grant covers must be forwarded explicitly or makeTempDir in
      // the orchestration tests resolves outside the sandbox and is denied.
      env: { TMPDIR: "/tmp" },
    },
    {
      label: "Prototype source typecheck",
      command: denoExecutable,
      checkId: "test.aggregate",
      commandLabel: "deno",
      // The file list is derived by globbing in `scripts/test-files.ts`, the
      // same source the `check` task uses; nothing is hand-listed here.
      args: ["task", "check:sources"],
      cwd: prototype,
      env: { DENO_BIN: denoExecutable },
    },
    {
      label: "Prototype test-file typecheck",
      checkId: "test.aggregate",
      command: denoExecutable,
      commandLabel: "deno",
      args: ["task", "check:tests"],
      cwd: prototype,
      env: { DENO_BIN: denoExecutable },
    },
    {
      label: "Prototype unit Deno.test suite (test.unit)",
      checkId: "test.aggregate",
      command: denoExecutable,
      commandLabel: "deno",
      // The runner itself, not `deno task test:unit`: it has to lead the lane
      // group so its end-of-run group stop reaches the group and nothing else.
      args: [
        "run",
        `--allow-env=PATH,HOME,TMPDIR,TEMP,TMP,DENO_BIN,DENO_JOBS,${laneEnv}`,
        "--allow-read=.",
        `--allow-run=${denoExecutable}`,
        "scripts/run-unit-tests.ts",
      ],
      cwd: prototype,
      env: { TMPDIR: "/tmp", DENO_BIN: denoExecutable },
      deadlineMs: laneDeadlineMs(LANE_DEADLINES_MS.unit, bound),
    },
    {
      label: "Contract closure report generation",
      checkId: "test.aggregate",
      command: denoExecutable,
      commandLabel: "deno",
      args: [
        "run",
        "--no-prompt",
        "--deny-write",
        "--allow-read=.",
        "contracts/workbench/first-product/v1/executable-closure-report.ts",
        "--compare-path",
        "contracts/workbench/first-product/v1/executable-closure-report.json",
      ],
      cwd: root,
    },
    {
      label: "Contract package tests",
      checkId: "test.aggregate",
      command: denoExecutable,
      commandLabel: "deno",
      args: [
        "test",
        "--allow-read=.",
        "contracts/workbench/first-product/v1/validate.test.ts",
        "contracts/workbench/first-product/v1/executable-closure.test.ts",
        "contracts/workbench/first-product/v1/executable-closure-report.test.ts",
      ],
      cwd: root,
    },
    {
      label: "Schema unit tests",
      checkId: "test.aggregate",
      command: denoExecutable,
      commandLabel: "deno",
      args: [
        "test",
        "--allow-read=schema",
        "schema/validate-schema.test.ts",
        "schema/codegen.test.ts",
        "schema/equivalence.test.ts",
      ],
      cwd: root,
    },
    {
      label: "Current-schema apply validation",
      checkId: "test.aggregate",
      command: denoExecutable,
      commandLabel: "deno",
      args: [
        "run",
        "--allow-read=schema",
        "--allow-write=/tmp,/private/tmp,/var/folders,/private/var/folders",
        "--allow-run=dolt",
        "schema/validate-schema.ts",
        "--current-only",
      ],
      cwd: root,
    },
    {
      label: "Historical replay plus forward-migration validation",
      checkId: "test.aggregate",
      command: denoExecutable,
      commandLabel: "deno",
      args: [
        "run",
        "--allow-read=schema",
        "--allow-write=/tmp,/private/tmp,/var/folders,/private/var/folders",
        "--allow-run=dolt",
        "schema/validate-schema.ts",
        "--history-only",
      ],
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
      command: denoExecutable,
      commandLabel: "deno",
      args: [
        "run",
        "--allow-read=schema,prototype/src/store/generated",
        "--allow-write=/tmp,/private/tmp,/var/folders,/private/var/folders",
        "--allow-run=dolt",
        "schema/codegen.ts",
        "--check",
      ],
      cwd: root,
    },
    {
      label: "Schema equivalence (schema.equivalence)",
      checkId: "test.aggregate",
      command: denoExecutable,
      commandLabel: "deno",
      args: [
        "run",
        "--allow-read=schema",
        "--allow-write=/tmp,/private/tmp,/var/folders,/private/var/folders",
        "--allow-run=dolt",
        "schema/equivalence.ts",
      ],
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
      command: denoExecutable,
      commandLabel: "deno",
      args: [
        "run",
        `--allow-env=PATH,HOME,TMPDIR,TEMP,TMP,CARGO_HOME,RUSTUP_HOME,DENO_BIN,DENO_DIR,DYFJ_ROOT,${laneEnv}`,
        // Read on the temp roots lets the lane resolve the real path of the
        // temp directory it hands the Deno.test files (macOS /tmp is a symlink).
        "--allow-read=.,..,/tmp,/private/tmp,/var/folders,/private/var/folders",
        "--allow-write=/tmp,/private/tmp,/var/folders,/private/var/folders,.",
        `--allow-run=${denoExecutable},dolt,cargo`,
        "--allow-net=127.0.0.1",
        "scripts/isolated-dolt-integration.ts",
      ],
      cwd: prototype,
      env: { TMPDIR: "/tmp", DENO_BIN: denoExecutable },
      deadlineMs: laneDeadlineMs(LANE_DEADLINES_MS.integration, bound),
    },
    // Golden characterization suite (`test.golden`): black-box snapshots of
    // the engine server and CLI over an isolated Dolt fixture. The runner
    // itself needs no network; it grants the tests loopback and the exact
    // engine sockets it creates.
    {
      label: "Golden characterization suite (test.golden)",
      checkId: "test.aggregate",
      command: denoExecutable,
      commandLabel: "deno",
      args: [
        "run",
        `--allow-env=PATH,HOME,TMPDIR,TEMP,TMP,DENO_BIN,${laneEnv}`,
        "--allow-read=.",
        "--allow-write=/tmp,/private/tmp,/var/folders,/private/var/folders",
        `--allow-run=${denoExecutable}`,
        "testing/golden/run.ts",
      ],
      cwd: prototype,
      env: { TMPDIR: "/tmp", DENO_BIN: denoExecutable },
      deadlineMs: laneDeadlineMs(LANE_DEADLINES_MS.golden, bound),
    },
  ];
}

// The fast subset reuses the production lane definitions verbatim — it is a
// local-feedback selection, not a second lane ontology. Every stable policy
// check runs; only the heavyweight suite lanes are deferred to the full
// gate, which stays the single repository green bar.
export const FAST_LANE_LABELS: readonly string[] = [
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
  "Receipt schema validation",
  "Contract closure report generation",
  "Contract package tests",
  "Prototype source typecheck",
  "Prototype unit Deno.test suite (test.unit)",
];

export function fastLanes(
  root = Deno.cwd(),
  denoExecutable = selectedDenoExecutable(),
): GateLane[] {
  const byLabel = new Map(
    productionLanes(root, denoExecutable).map((lane) => [lane.label, lane]),
  );
  return FAST_LANE_LABELS.map((label) => {
    const lane = byLabel.get(label);
    if (!lane) {
      throw new Error(`fast lane is not a production lane: ${label}`);
    }
    return lane;
  });
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
  mode: "full" | "fast",
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
  const result = anyFail
    ? "fail"
    : anyInterrupted
    ? "interrupted"
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
  const lanes = options.lanes ?? productionLanes(options.root ?? Deno.cwd());
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
  // The composed status is the authority on the process result: a lane exit
  // code alone can read zero while a required check is missing, failed,
  // unavailable, or skipped. The first concrete nonzero lane code is
  // preserved when there is one; composition-only gaps fall back to the
  // deterministic codes above. Only a composed `pass` can return zero.
  const finish = (laneCode: number): number => {
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
  for (let index = 0; index < lanes.length; index++) {
    const lane = lanes[index]!;
    const outcome = outcomes[index]!;
    if (options.signal?.aborted) {
      outcome.result = "interrupted";
      return finish(interruptedExitCode(options.signal));
    }
    const commandLabel = laneCommandLabel(lane);
    const start = performance.now();
    out.log(`▶ ${lane.label} (${commandLabel})`);
    const token = lane.deadlineMs === undefined
      ? undefined
      : crypto.randomUUID();
    const supervision: Record<string, string> = token === undefined ? {} : {
      [LANE_DEADLINE_ENV]: String(lane.deadlineMs),
      [LANE_BACKSTOP_ENV]: String(lane.deadlineMs! + LANE_BACKSTOP_MARGIN_MS),
      [LANE_TOKEN_ENV]: token,
    };
    let recordPath: string | undefined;
    try {
      const child = new Deno.Command(lane.command, {
        args: lane.args,
        cwd: lane.cwd,
        env: { ...safeEnvironment(), ...(lane.env ?? {}), ...supervision },
        clearEnv: true,
        stdout: "inherit",
        stderr: "inherit",
        // Own process group per lane: the leader is the group leader, so its
        // pid is the group id interruption signals.
        detached: laneProcessGroups,
      }).spawn();
      const group = laneProcessGroups ? child.pid : undefined;
      if (token !== undefined && group !== undefined) {
        recordPath = await writeLaneRecord(options.laneRecordDir, {
          gatePid: Deno.pid,
          group,
          token,
        });
      }
      const result = await statusOrAbort(
        child,
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
        return finish(LANE_DEADLINE_EXIT_CODE);
      }
      if (result.aborted) {
        outcome.result = "interrupted";
        out.error(`✗ ${lane.label}: interrupted (${elapsedMs}ms)`);
        return finish(interruptedExitCode(options.signal!));
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
        return finish(status.code || 1);
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
      return finish(127);
    } finally {
      if (recordPath !== undefined) {
        await Deno.remove(recordPath).catch(() => undefined);
      }
    }
  }
  if (options.signal?.aborted) {
    outcomes.push({ result: "interrupted" });
    return finish(interruptedExitCode(options.signal));
  }
  const code = finish(0);
  // The success claim is made only when the composed status itself passed.
  if (code === 0) {
    out.log(options.successMessage ?? "✓ aggregate test gate passed");
  }
  return code;
}

if (import.meta.main) {
  let fast: boolean;
  try {
    fast = parseGateArguments(Deno.args).fast;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(64);
  }
  const abortController = new AbortController();
  const onSigint = () => abortController.abort("SIGINT");
  const onSigterm = () => abortController.abort("SIGTERM");
  Deno.addSignalListener("SIGINT", onSigint);
  Deno.addSignalListener("SIGTERM", onSigterm);
  let exitCode: number;
  try {
    exitCode = await runGate({
      signal: abortController.signal,
      lanes: fast ? fastLanes() : undefined,
      mode: fast ? "fast" : "full",
      requiredCheckIds: fast ? undefined : REQUIRED_CHECK_IDS,
      successMessage: fast
        ? "✓ fast gate subset passed (not the full green bar; run `deno task test`)"
        : undefined,
      laneRecordDir: defaultLaneRecordDir(readOptionalEnv("HOME")),
    });
  } finally {
    Deno.removeSignalListener("SIGINT", onSigint);
    Deno.removeSignalListener("SIGTERM", onSigterm);
  }
  Deno.exit(exitCode);
}
