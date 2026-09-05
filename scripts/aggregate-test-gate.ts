import { selectedDenoExecutable } from "../prototype/scripts/deno-executable.ts";

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

const inheritedEnvironmentNames = [
  "PATH",
  "HOME",
  "CARGO_HOME",
  "RUSTUP_HOME",
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
    inheritedEnvironmentNames.flatMap((name) => {
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
): Promise<{ status?: Deno.CommandStatus; aborted: boolean }> {
  const status = child.status;
  if (!signal) return { status: await status, aborted: false };
  if (signal.aborted) {
    await stopChild(child, group);
    return { aborted: true };
  }

  let onAbort: (() => void) | undefined;
  const result = await Promise.race([
    status.then((value) => ({ type: "status" as const, value })),
    new Promise<{ type: "aborted" }>((resolve) => {
      onAbort = () => resolve({ type: "aborted" });
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    }),
  ]);
  if (onAbort) signal.removeEventListener("abort", onAbort);
  if (result.type === "status") return { status: result.value, aborted: false };

  await stopChild(child, group);
  return { aborted: true };
}

export function productionLanes(
  root = Deno.cwd(),
  denoExecutable = selectedDenoExecutable(),
): GateLane[] {
  const prototype = `${root}/prototype`;
  const core = `${root}/core`;
  const home = Deno.env.get("HOME");
  const homeRun = home !== undefined && home.startsWith("/")
    ? `,${home}/.dyfj/run`
    : "";
  const binding = bindingEnvironment();
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
        "--allow-env=PATH,HOME,TMPDIR,TEMP,TMP,CARGO_HOME,RUSTUP_HOME,DYFJ_AGGREGATE_SENTINEL,DYFJ_GATE_SUBJECT,DYFJ_GATE_RANGE_BASE,GITHUB_ACTIONS",
        "--allow-read=.,/tmp,/private/tmp,/var/folders,/private/var/folders",
        "--allow-write=/tmp,/private/tmp,/var/folders,/private/var/folders",
        `--allow-run=${denoExecutable},ln,git,/bin/bash`,
        "scripts/aggregate-test-gate.test.ts",
        "scripts/ci-workflow.test.ts",
        "scripts/public-safety-scan.test.ts",
        "scripts/subject-check.test.ts",
        "scripts/range-checks.test.ts",
        "scripts/dependency-policy.test.ts",
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
      args: [
        "check",
        "--sloppy-imports",
        "src/workbench.ts",
        "src/jsonrpc.ts",
        "src/jsonrpc-peer.ts",
        "src/uds-server.ts",
        "src/uds-path.ts",
        "src/uds-client.ts",
        "src/uds-serve.ts",
        "mcp/server.ts",
        "src/cli.ts",
        "scripts/esbuild-binary.ts",
        "scripts/deno-executable.ts",
        "scripts/integration-child-environment.ts",
        "scripts/run-vitest.ts",
        "scripts/test-process-harness.ts",
        "scripts/test-process-reaper.ts",
        "scripts/isolated-dolt-fixture.ts",
        "scripts/isolated-dolt-integration.ts",
      ],
      cwd: prototype,
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
      label: "Prototype unit Vitest suite",
      checkId: "test.aggregate",
      command: denoExecutable,
      commandLabel: "deno",
      args: [
        "run",
        "--allow-env",
        `--allow-read=.,..,/tmp,/private/tmp,/var/folders,/private/var/folders${homeRun}`,
        `--allow-write=.,/tmp,/private/tmp,/var/folders,/private/var/folders${homeRun}`,
        `--allow-run=${denoExecutable},/bin/kill,/bin/ps,/bin/bash`,
        "scripts/run-vitest.ts",
        "run",
        "--root",
        ".",
        "--pool=threads",
        "--exclude",
        "**/*.integration.{test,spec}.?(c|m)[jt]s?(x)",
        "--exclude",
        "scripts/test-process-harness.test.ts",
      ],
      cwd: prototype,
      env: { TMPDIR: "/tmp", DENO_BIN: denoExecutable },
    },
    {
      label: "Prototype process-harness Vitest suite",
      checkId: "test.aggregate",
      command: denoExecutable,
      commandLabel: "deno",
      args: [
        "run",
        "--allow-env",
        `--allow-read=.,..,/tmp,/private/tmp,/var/folders,/private/var/folders${homeRun}`,
        `--allow-write=.,/tmp,/private/tmp,/var/folders,/private/var/folders${homeRun}`,
        `--allow-run=${denoExecutable},/bin/kill,/bin/ps,/bin/bash`,
        "scripts/run-vitest.ts",
        "run",
        "scripts/test-process-harness.test.ts",
        "--root",
        ".",
        "--pool=threads",
      ],
      cwd: prototype,
      env: { TMPDIR: "/tmp", DENO_BIN: denoExecutable },
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
      args: ["test", "--allow-read=schema", "schema/validate-schema.test.ts"],
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
        "--allow-env=PATH,HOME,TMPDIR,TEMP,TMP,CARGO_HOME,RUSTUP_HOME,DENO_BIN,DYFJ_ROOT",
        "--allow-read=.,..",
        "--allow-write=/tmp,/private/tmp,/var/folders,/private/var/folders,.",
        `--allow-run=${denoExecutable},dolt,cargo`,
        "--allow-net=127.0.0.1",
        "scripts/isolated-dolt-integration.ts",
      ],
      cwd: prototype,
      env: { TMPDIR: "/tmp", DENO_BIN: denoExecutable },
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
  "Receipt schema validation",
  "Contract closure report generation",
  "Contract package tests",
  "Prototype source typecheck",
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
    try {
      const child = new Deno.Command(lane.command, {
        args: lane.args,
        cwd: lane.cwd,
        env: { ...safeEnvironment(), ...(lane.env ?? {}) },
        clearEnv: true,
        stdout: "inherit",
        stderr: "inherit",
        // Own process group per lane: the leader is the group leader, so its
        // pid is the group id interruption signals.
        detached: laneProcessGroups,
      }).spawn();
      const group = laneProcessGroups ? child.pid : undefined;
      const result = await statusOrAbort(child, group, options.signal);
      const elapsedMs = Math.round(performance.now() - start);
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
    });
  } finally {
    Deno.removeSignalListener("SIGINT", onSigint);
    Deno.removeSignalListener("SIGTERM", onSigterm);
  }
  Deno.exit(exitCode);
}
