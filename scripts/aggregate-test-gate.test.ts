import { testSourcesFromPaths } from "../prototype/scripts/check-test-files.ts";
import { assertIntegrationTestAssignments } from "../prototype/scripts/integration-test-assignment.ts";
import { integrationChildEnvironment } from "../prototype/scripts/integration-child-environment.ts";
import { DENO_EXECUTABLE_DIAGNOSTIC } from "../prototype/scripts/deno-executable.ts";
import {
  COMPOSED_FAIL_EXIT_CODE,
  composeGateStatus,
  FAST_LANE_LABELS,
  fastLanes,
  type GateLane,
  type LaneOutcome,
  parseGateArguments,
  productionLanes,
  REQUIRED_CHECK_IDS,
  runGate,
} from "./aggregate-test-gate.ts";
import { MANDATORY_CHECK_IDS } from "./assurance-receipt.ts";
import { fileURLToPath } from "node:url";

function assertEquals<T>(actual: T, expected: T): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assertStringIncludes(actual: string, expected: string): void {
  if (!actual.includes(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(actual)} to include ${expected}`,
    );
  }
}

function assertThrows(fn: () => unknown, expected: string): void {
  try {
    fn();
  } catch (error) {
    assertStringIncludes(String(error), expected);
    return;
  }
  throw new Error(`Expected function to throw ${expected}`);
}

Deno.test("recursive test discovery includes nested test files", () => {
  assertEquals(
    testSourcesFromPaths([
      "prototype/src/root.test.ts",
      "prototype/src/nested/deep.test.ts",
      "prototype/src/nested/component.spec.tsx",
      "prototype/src/nested/worker.test.mts",
      "prototype/src/nested/not-test.ts",
      "prototype/mcp/tool.test.ts",
    ]),
    [
      "prototype/mcp/tool.test.ts",
      "prototype/src/nested/component.spec.tsx",
      "prototype/src/nested/deep.test.ts",
      "prototype/src/nested/worker.test.mts",
      "prototype/src/root.test.ts",
    ],
  );
});

Deno.test("integration tests must have an explicit lane assignment", () => {
  assertThrows(
    () =>
      assertIntegrationTestAssignments(
        [
          "src/assigned.integration.test.ts",
          "src/assigned.integration.spec.tsx",
          "src/unassigned.integration.test.ts",
        ],
        [
          "src/assigned.integration.spec.tsx",
          "src/assigned.integration.test.ts",
        ],
      ),
    "missing=src/unassigned.integration.test.ts",
  );
});

Deno.test("aggregate gate source does not advertise a stale direct entrypoint", async () => {
  const source = await Deno.readTextFile("scripts/aggregate-test-gate.ts");
  if (source.startsWith("#!")) {
    throw new Error("aggregate gate retained a direct-execution shebang");
  }
});

Deno.test("aggregate lanes include the retired-surface scan", () => {
  const lane = productionLanes("/repo", "/fixtures/runtime/deno").find((
    candidate,
  ) => candidate.label === "Retired-surface scan");
  if (!lane) throw new Error("retired-surface scan lane is missing");
  assertEquals(lane.command, "/fixtures/runtime/deno");
  assertStringIncludes(lane.args.join(" "), "scripts/retired-surface-scan.ts");
});

Deno.test("aggregate lanes include both public-safety scan families", () => {
  for (const family of ["secret.tree", "public.boundary"]) {
    const lane = productionLanes("/repo", "/fixtures/runtime/deno").find((
      candidate,
    ) => candidate.checkId === family);
    if (!lane) throw new Error(`${family} scan lane is missing`);
    assertEquals(lane.command, "/fixtures/runtime/deno");
    assertStringIncludes(lane.args.join(" "), "scripts/public-safety-scan.ts");
    assertStringIncludes(lane.args.join(" "), `--family ${family}`);
  }
});

Deno.test("every stable required check id has a production lane", () => {
  const lanes = productionLanes("/repo", "/fixtures/runtime/deno");
  const covered = new Set(
    lanes.flatMap((lane) => lane.checkId === undefined ? [] : [lane.checkId]),
  );
  for (const id of REQUIRED_CHECK_IDS) {
    if (!covered.has(id)) {
      throw new Error(`required check ${id} has no production lane`);
    }
  }
  for (const lane of lanes) {
    if (lane.checkId === undefined) {
      throw new Error(`production lane without a check id: ${lane.label}`);
    }
  }
});

Deno.test("policy check lanes invoke their dedicated scripts", () => {
  const lanes = productionLanes("/repo", "/fixtures/runtime/deno");
  const expectations: Array<[string, string]> = [
    ["subject.resolve", "scripts/subject-check.ts"],
    ["subject.digest", "scripts/subject-check.ts"],
    ["secret.diff", "scripts/range-checks.ts"],
    ["diff.whitespace", "scripts/range-checks.ts"],
    ["markdown.links", "scripts/range-checks.ts"],
    ["shell.parse", "scripts/range-checks.ts"],
    ["dependency.policy", "scripts/dependency-policy.ts"],
    ["receipt.schema", "scripts/assurance-receipt.test.ts"],
  ];
  for (const [checkId, script] of expectations) {
    const lane = lanes.find((candidate) => candidate.checkId === checkId);
    if (!lane) throw new Error(`${checkId} lane is missing`);
    assertStringIncludes(lane.args.join(" "), script);
  }
});

Deno.test("binding-aware lanes forward the CI subject and range", () => {
  const sentinel = "f".repeat(40);
  const prior = Deno.env.get("DYFJ_GATE_SUBJECT");
  Deno.env.set("DYFJ_GATE_SUBJECT", sentinel);
  try {
    const lanes = productionLanes("/repo", "/fixtures/runtime/deno");
    for (const checkId of ["subject.resolve", "secret.diff"]) {
      const lane = lanes.find((candidate) => candidate.checkId === checkId);
      if (!lane) throw new Error(`${checkId} lane is missing`);
      assertEquals(lane.env?.DYFJ_GATE_SUBJECT, sentinel);
    }
  } finally {
    if (prior === undefined) Deno.env.delete("DYFJ_GATE_SUBJECT");
    else Deno.env.set("DYFJ_GATE_SUBJECT", prior);
  }
});

Deno.test("orchestration lane covers the CI workflow hygiene tests", () => {
  const lane = productionLanes("/repo", "/fixtures/runtime/deno").find((
    candidate,
  ) => candidate.label === "Aggregate gate orchestration tests");
  if (!lane) throw new Error("orchestration test lane is missing");
  assertStringIncludes(lane.args.join(" "), "scripts/ci-workflow.test.ts");
  // Lane children start from a cleared environment: the deterministic temp
  // root inside the write grant must be set explicitly, never inherited.
  assertEquals(lane.env?.TMPDIR, "/tmp");
});

Deno.test("fast lanes reuse the production lane definitions verbatim", () => {
  const production = productionLanes("/repo", "/fixtures/runtime/deno");
  const fast = fastLanes("/repo", "/fixtures/runtime/deno");
  assertEquals(fast.map((lane) => lane.label), [...FAST_LANE_LABELS]);
  for (const lane of fast) {
    assertEquals(
      lane,
      production.find((candidate) => candidate.label === lane.label),
    );
  }
});

Deno.test("fast lanes keep the scans and exclude the heavyweight suites", () => {
  const fast = fastLanes("/repo", "/fixtures/runtime/deno");
  const labels = fast.map((lane) => lane.label);
  for (
    const scan of [
      "Retired-surface scan",
      "Public-safety tree scan (secret.tree)",
      "Public-safety tree scan (public.boundary)",
    ]
  ) {
    if (!labels.includes(scan)) throw new Error(`${scan} missing from fast`);
  }
  const fastCheckIds = new Set(
    fast.flatMap((lane) => lane.checkId === undefined ? [] : [lane.checkId]),
  );
  for (const id of REQUIRED_CHECK_IDS) {
    if (id === "test.aggregate") continue;
    if (!fastCheckIds.has(id)) {
      throw new Error(`stable check ${id} missing from the fast subset`);
    }
  }
  for (
    const heavy of [
      "Prototype unit Vitest suite",
      "Offline-metadata Rust tests",
      "Isolated Dolt integration lane",
      "Current-schema apply validation",
      "Historical replay plus forward-migration validation",
    ]
  ) {
    if (labels.includes(heavy)) {
      throw new Error(`${heavy} must not run in the fast subset`);
    }
  }
});

Deno.test("a subset run reports its own success claim, not the full bar", async () => {
  const logs: string[] = [];
  const code = await runGate({
    lanes: [{
      label: "subset lane",
      command: Deno.execPath(),
      args: ["eval", "Deno.exit(0)"],
    }],
    successMessage: "✓ fast gate subset passed",
    out: { log: (message) => logs.push(message), error: () => {} },
  });
  assertEquals(code, 0);
  if (logs.includes("✓ aggregate test gate passed")) {
    throw new Error("subset run claimed the full green bar");
  }
  if (!logs.includes("✓ fast gate subset passed")) {
    throw new Error("subset run did not report its own success claim");
  }
});

Deno.test("gate arguments select the fast subset and fail closed otherwise", () => {
  assertEquals(parseGateArguments([]), { fast: false });
  assertEquals(parseGateArguments(["--fast"]), { fast: true });
  assertThrows(() => parseGateArguments(["--unknown"]), "unknown argument");
  assertThrows(
    () => parseGateArguments(["--fast", "extra"]),
    "unknown argument",
  );
});

Deno.test("isolated Dolt lane passes custom Rust toolchain roots to children", () => {
  const lane = productionLanes("/repo", "/fixtures/runtime/deno").find((
    candidate,
  ) => candidate.label === "Isolated Dolt integration lane");
  if (!lane) throw new Error("isolated Dolt integration lane is missing");
  assertStringIncludes(lane.args.join(" "), "CARGO_HOME");
  assertStringIncludes(lane.args.join(" "), "RUSTUP_HOME");
  assertEquals(lane.env?.TMPDIR, "/tmp");
  assertEquals(
    integrationChildEnvironment(
      { SQLX_OFFLINE: "true" },
      (name) =>
        ({
          CARGO_HOME: "/custom/cargo",
          RUSTUP_HOME: "/custom/rustup",
        })[name],
    ),
    {
      CARGO_HOME: "/custom/cargo",
      RUSTUP_HOME: "/custom/rustup",
      SQLX_OFFLINE: "true",
    },
  );
});

Deno.test("aggregate lanes use one selected Deno command and grant identity", () => {
  const selected = "/fixtures/runtime/deno";
  const lanes = productionLanes("/repo", selected);
  const denoLanes = lanes.filter((lane) => lane.commandLabel === "deno");
  if (denoLanes.length === 0) throw new Error("no Deno lanes found");
  for (const lane of denoLanes) {
    assertEquals(lane.command, selected);
    if (lane.args.some((argument) => argument.includes("--allow-run=deno"))) {
      throw new Error(`${lane.label} retained a name-only Deno grant`);
    }
  }
  for (
    const label of [
      "Aggregate gate orchestration tests",
      "Prototype unit Vitest suite",
      "Isolated Dolt integration lane",
    ]
  ) {
    const lane = denoLanes.find((candidate) => candidate.label === label);
    if (!lane) throw new Error(`${label} is missing`);
    const runGrant = lane.args.find((argument) =>
      argument.startsWith("--allow-run=")
    );
    if (!runGrant) throw new Error(`${label} has no run grant`);
    const granted = runGrant.slice("--allow-run=".length).split(",");
    if (!granted.includes(selected)) {
      throw new Error(`${label} does not grant the selected Deno executable`);
    }
  }
});

Deno.test("the focused Vitest launcher runs through direct selected Deno", async () => {
  await assertVitestLauncherRuns(Deno.execPath());
});

Deno.test({
  name: "the focused Vitest launcher runs through symlink-selected Deno",
  ignore: Deno.build.os === "windows",
  async fn() {
    const directory = await Deno.makeTempDir({
      prefix: "dyfj-deno-authority-",
    });
    const selected = `${directory}/selected-runtime`;
    try {
      const linked = await new Deno.Command("ln", {
        args: ["-s", Deno.execPath(), selected],
        stdout: "null",
        stderr: "piped",
      }).output();
      if (!linked.success) {
        throw new Error(
          `synthetic symlink setup failed (${linked.code}): ${
            new TextDecoder().decode(linked.stderr)
          }`,
        );
      }
      await assertVitestLauncherRuns(selected);
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  },
});

Deno.test("Deno executable selector CLI has fixed success and failure output", async () => {
  const script = "prototype/scripts/deno-executable.ts";
  const success = await new Deno.Command(Deno.execPath(), {
    args: ["run", script],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(success.code, 0);
  assertEquals(
    new TextDecoder().decode(success.stdout),
    `${Deno.execPath()}\n`,
  );
  assertEquals(new TextDecoder().decode(success.stderr), "");

  const failure = await new Deno.Command(Deno.execPath(), {
    args: ["run", script, "/fixtures/other/deno"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(failure.code, 64);
  assertEquals(new TextDecoder().decode(failure.stdout), "");
  assertEquals(
    new TextDecoder().decode(failure.stderr),
    `${DENO_EXECUTABLE_DIAGNOSTIC}\n`,
  );
});

Deno.test("an unselected executable remains denied", () => {
  const unselected = fileURLToPath(
    new URL("synthetic-unselected-runtime", import.meta.url),
  );
  try {
    new Deno.Command(unselected).outputSync();
  } catch (error) {
    if (error instanceof Deno.errors.NotCapable) return;
    throw error;
  }
  throw new Error("unselected executable unexpectedly ran");
});

async function assertVitestLauncherRuns(selected: string): Promise<void> {
  const prototypeRoot = fileURLToPath(new URL("../prototype", import.meta.url));
  const result = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-env",
      "--allow-read=.,..,/tmp,/private/tmp,/var/folders,/private/var/folders",
      `--allow-run=${selected}`,
      "scripts/run-vitest.ts",
      "--version",
    ],
    cwd: prototypeRoot,
    env: { DENO_BIN: selected },
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (result.code !== 0) {
    throw new Error(
      `focused Vitest launcher failed (${result.code}): ${
        new TextDecoder().decode(result.stderr)
      }`,
    );
  }
}

Deno.test("aggregate lane children do not inherit unrelated environment", async () => {
  const sentinel = "DYFJ_AGGREGATE_SENTINEL";
  const prior = Deno.env.get(sentinel);
  const priorTmpdir = Deno.env.get("TMPDIR");
  Deno.env.set(sentinel, "must-not-reach-child");
  Deno.env.set("TMPDIR", "/not-a-granted-temp-root");
  try {
    const code = await runGate({
      lanes: [{
        label: "environment lane",
        command: Deno.execPath(),
        args: [
          "eval",
          `if (Deno.env.get(${
            JSON.stringify(sentinel)
          }) !== undefined || Deno.env.get("TMPDIR") !== undefined) Deno.exit(1);`,
        ],
      }],
      out: { log: () => {}, error: () => {} },
    });
    assertEquals(code, 0);
  } finally {
    if (prior === undefined) Deno.env.delete(sentinel);
    else Deno.env.set(sentinel, prior);
    if (priorTmpdir === undefined) Deno.env.delete("TMPDIR");
    else Deno.env.set("TMPDIR", priorTmpdir);
  }
});

Deno.test("aggregate gate fails fast when a required lane fails", async () => {
  const logs: string[] = [];
  const errors: string[] = [];
  const lanes: GateLane[] = [
    {
      label: "ok lane",
      command: Deno.execPath(),
      args: ["eval", "Deno.exit(0)"],
    },
    {
      label: "broken lane",
      command: Deno.execPath(),
      args: ["eval", "Deno.exit(12)"],
    },
    {
      label: "must not run",
      command: Deno.execPath(),
      args: ["eval", "console.log('ran')"],
    },
  ];

  const code = await runGate({
    lanes,
    out: { log: (s) => logs.push(s), error: (s) => errors.push(s) },
  });

  assertEquals(code, 12);
  assertStringIncludes(logs.join("\n"), "ok lane");
  assertStringIncludes(errors.join("\n"), "broken lane: failure");
  if (logs.join("\n").includes("must not run")) {
    throw new Error("aggregate did not fail fast");
  }
});

Deno.test("aggregate gate stops its active lane on interruption", async () => {
  const logs: string[] = [];
  const errors: string[] = [];
  const abortController = new AbortController();
  const abortTimer = setTimeout(() => abortController.abort("SIGTERM"), 25);
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  // Well inside the ten-second shutdown bound, with room for the two
  // short-lived children that carry the lane's process-group signals.
  const timeout = new Promise<never>((_, reject) =>
    timeoutId = setTimeout(
      () => reject(new Error("interrupted lane did not stop")),
      5_000,
    )
  );

  try {
    const code = await Promise.race([
      runGate({
        signal: abortController.signal,
        lanes: [
          {
            label: "slow lane",
            command: Deno.execPath(),
            args: [
              "eval",
              "await new Promise((resolve) => setTimeout(resolve, 5_000))",
            ],
          },
          {
            label: "must not run",
            command: Deno.execPath(),
            args: ["eval", "console.log('ran')"],
          },
        ],
        out: { log: (s) => logs.push(s), error: (s) => errors.push(s) },
      }),
      timeout,
    ]);

    assertEquals(code, 143);
    assertStringIncludes(errors.join("\n"), "slow lane: interrupted");
    if (logs.join("\n").includes("must not run")) {
      throw new Error("aggregate ran a lane after interruption");
    }
  } finally {
    clearTimeout(abortTimer);
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
});

async function waitForPath(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await Deno.stat(path);
      return;
    } catch {
      if (Date.now() >= deadline) {
        throw new Error("timed out waiting for the lane descendant to start");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

// A running process holds its exclusive lock; the kernel drops it as soon as
// the process is gone. That makes the lock a liveness probe no pid check can
// confuse with a reused pid or an unreaped zombie.
async function lockFreedWithin(
  path: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const file = await Deno.open(path, {
      create: true,
      read: true,
      write: true,
    });
    try {
      if (file.tryLockSync(true)) {
        file.unlockSync();
        return true;
      }
    } finally {
      file.close();
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

Deno.test({
  name: "interrupting a lane terminates its descendants, not just the leader",
  // POSIX process groups only; Windows lanes keep the leader-only path.
  ignore: Deno.build.os === "windows",
  async fn() {
    const directory = await Deno.makeTempDir({
      prefix: "dyfj-gate-descendant-",
    });
    const lockPath = `${directory}/descendant.lock`;
    const readyPath = `${directory}/descendant.ready`;
    const descendantScript = `${directory}/descendant.ts`;
    const laneScript = `${directory}/lane.ts`;
    try {
      await Deno.writeTextFile(
        descendantScript,
        [
          `const lock = await Deno.open(${
            JSON.stringify(lockPath)
          }, { create: true, read: true, write: true });`,
          `if (!lock.tryLockSync(true)) Deno.exit(1);`,
          `await Deno.writeTextFile(${JSON.stringify(readyPath)}, "ready");`,
          `await new Promise((resolve) => setTimeout(resolve, 30_000));`,
        ].join("\n"),
      );
      // The lane leader is an ordinary parent: it starts one descendant and
      // waits, so a leader-only signal leaves the descendant running.
      await Deno.writeTextFile(
        laneScript,
        [
          `const descendant = new Deno.Command(Deno.execPath(), { args: [`,
          `  "run",`,
          `  ${JSON.stringify(`--allow-read=${directory}`)},`,
          `  ${JSON.stringify(`--allow-write=${directory}`)},`,
          `  ${JSON.stringify(descendantScript)},`,
          `] }).spawn();`,
          `await descendant.status;`,
        ].join("\n"),
      );

      const logs: string[] = [];
      const errors: string[] = [];
      const abortController = new AbortController();
      const gate = runGate({
        signal: abortController.signal,
        lanes: [{
          label: "descendant lane",
          checkId: "demo.descendant",
          command: Deno.execPath(),
          commandLabel: "deno",
          args: [
            "run",
            `--allow-read=${directory}`,
            `--allow-write=${directory}`,
            `--allow-run=${Deno.execPath()}`,
            laneScript,
          ],
        }],
        requiredCheckIds: ["demo.descendant"],
        out: { log: (s) => logs.push(s), error: (s) => errors.push(s) },
      });
      // Deterministic handshake: the descendant is running and holds the lock
      // before the gate is interrupted.
      await waitForPath(readyPath, 30_000);
      abortController.abort("SIGTERM");

      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const shutdownBound = new Promise<never>((_, reject) =>
        timeoutId = setTimeout(
          () =>
            reject(new Error("interrupted gate exceeded its shutdown bound")),
          20_000,
        )
      );
      let code: number;
      try {
        code = await Promise.race([gate, shutdownBound]);
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
      }

      assertEquals(code, 143);
      assertStringIncludes(errors.join("\n"), "descendant lane: interrupted");
      const statusLine = logs.find((line) => line.startsWith("gate-status "));
      if (!statusLine) throw new Error("gate did not emit a status line");
      assertEquals(
        JSON.parse(statusLine.slice("gate-status ".length)).result,
        "interrupted",
      );
      if (!await lockFreedWithin(lockPath, 5_000)) {
        throw new Error("a lane descendant outlived the interrupted gate");
      }
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  },
});

// A lane whose leader exits on its own — cleanly or with a failure code —
// while a descendant it started stays alive. The leader waits for the
// descendant's ready handshake first, so at the moment the leader exits the
// descendant is provably running and holding the lock.
async function withSurvivingDescendantLane(
  leaderExitCode: number,
  assertGate: (
    lane: GateLane,
    lockPath: string,
  ) => Promise<void>,
): Promise<void> {
  const directory = await Deno.makeTempDir({ prefix: "dyfj-gate-outlived-" });
  const lockPath = `${directory}/descendant.lock`;
  const readyPath = `${directory}/descendant.ready`;
  const descendantScript = `${directory}/descendant.ts`;
  const laneScript = `${directory}/lane.ts`;
  try {
    await Deno.writeTextFile(
      descendantScript,
      [
        `const lock = await Deno.open(${
          JSON.stringify(lockPath)
        }, { create: true, read: true, write: true });`,
        `if (!lock.tryLockSync(true)) Deno.exit(1);`,
        `await Deno.writeTextFile(${JSON.stringify(readyPath)}, "ready");`,
        `await new Promise((resolve) => setTimeout(resolve, 30_000));`,
      ].join("\n"),
    );
    await Deno.writeTextFile(
      laneScript,
      [
        `new Deno.Command(Deno.execPath(), { args: [`,
        `  "run",`,
        `  ${JSON.stringify(`--allow-read=${directory}`)},`,
        `  ${JSON.stringify(`--allow-write=${directory}`)},`,
        `  ${JSON.stringify(descendantScript)},`,
        `] }).spawn();`,
        `for (;;) {`,
        `  try { await Deno.stat(${JSON.stringify(readyPath)}); break; }`,
        `  catch { await new Promise((resolve) => setTimeout(resolve, 10)); }`,
        `}`,
        `Deno.exit(${leaderExitCode});`,
      ].join("\n"),
    );
    await assertGate({
      label: "outlived lane",
      checkId: "demo.outlived",
      command: Deno.execPath(),
      commandLabel: "deno",
      args: [
        "run",
        `--allow-read=${directory}`,
        `--allow-write=${directory}`,
        `--allow-run=${Deno.execPath()}`,
        laneScript,
      ],
    }, lockPath);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
}

Deno.test({
  name: "a passing lane's surviving descendant is torn down with its group",
  // POSIX process groups only; Windows lanes keep the leader-only path.
  ignore: Deno.build.os === "windows",
  async fn() {
    await withSurvivingDescendantLane(0, async (lane, lockPath) => {
      const logs: string[] = [];
      const errors: string[] = [];
      const start = performance.now();
      const code = await runGate({
        lanes: [lane],
        requiredCheckIds: ["demo.outlived"],
        out: { log: (s) => logs.push(s), error: (s) => errors.push(s) },
      });
      const elapsedMs = performance.now() - start;

      // The clean lane keeps its real result and success claim.
      assertEquals(code, 0);
      assertEquals(errors, []);
      if (!logs.includes("✓ aggregate test gate passed")) {
        throw new Error("a true pass did not report success");
      }
      const statusLine = logs.find((line) => line.startsWith("gate-status "));
      if (!statusLine) throw new Error("gate did not emit a status line");
      const status = JSON.parse(statusLine.slice("gate-status ".length));
      assertEquals(status.result, "pass");
      assertEquals(status.checks, [{ id: "demo.outlived", result: "pass" }]);
      // Well under the ten-second interruption budget: an ordinary lane must
      // not pay the full shutdown bound to clean up its group.
      if (elapsedMs >= 8_000) {
        throw new Error("a clean lane paid the full shutdown delay");
      }
      if (!await lockFreedWithin(lockPath, 5_000)) {
        throw new Error("a lane descendant outlived the passing gate");
      }
    });
  },
});

Deno.test({
  name: "a failing lane's surviving descendant is torn down with its group",
  // POSIX process groups only; Windows lanes keep the leader-only path.
  ignore: Deno.build.os === "windows",
  async fn() {
    await withSurvivingDescendantLane(7, async (lane, lockPath) => {
      const logs: string[] = [];
      const errors: string[] = [];
      const start = performance.now();
      const code = await runGate({
        lanes: [lane],
        requiredCheckIds: ["demo.outlived"],
        out: { log: (s) => logs.push(s), error: (s) => errors.push(s) },
      });
      const elapsedMs = performance.now() - start;

      // The leader's own exit code survives teardown untouched.
      assertEquals(code, 7);
      assertStringIncludes(errors.join("\n"), "outlived lane: failure");
      if (logs.includes("✓ aggregate test gate passed")) {
        throw new Error("gate claimed success over a failed lane");
      }
      const statusLine = logs.find((line) => line.startsWith("gate-status "));
      if (!statusLine) throw new Error("gate did not emit a status line");
      const status = JSON.parse(statusLine.slice("gate-status ".length));
      assertEquals(status.result, "fail");
      assertEquals(status.checks, [{ id: "demo.outlived", result: "fail" }]);
      if (elapsedMs >= 8_000) {
        throw new Error("a failing lane paid the full shutdown delay");
      }
      if (!await lockFreedWithin(lockPath, 5_000)) {
        throw new Error("a lane descendant outlived the failing gate");
      }
    });
  },
});

Deno.test("aggregate gate reports an interrupt after its final lane", async () => {
  const logs: string[] = [];
  const errors: string[] = [];
  const abortController = new AbortController();
  const code = await runGate({
    signal: abortController.signal,
    lanes: [{
      label: "final lane",
      command: Deno.execPath(),
      args: ["eval", "Deno.exit(0)"],
    }],
    out: {
      log: (message) => {
        logs.push(message);
        if (message.startsWith("✓ final lane:")) {
          abortController.abort("SIGTERM");
        }
      },
      error: (message) => errors.push(message),
    },
  });

  assertEquals(code, 143);
  if (logs.includes("✓ aggregate test gate passed")) {
    throw new Error("aggregate reported success after interruption");
  }
  assertEquals(errors, []);
});

Deno.test("a required gap or failure can never compose into a pass", () => {
  const required = ["subject.resolve", "test.aggregate"];
  const pass = (checkId: string): LaneOutcome => ({
    checkId,
    result: "pass",
  });
  assertEquals(
    composeGateStatus(
      [pass("subject.resolve"), pass("test.aggregate")],
      "full",
      required,
    ).result,
    "pass",
  );
  const forged: LaneOutcome[][] = [
    [pass("subject.resolve"), { checkId: "test.aggregate", result: "fail" }],
    [
      pass("subject.resolve"),
      { checkId: "test.aggregate", result: "unavailable" },
    ],
    [pass("subject.resolve"), { checkId: "test.aggregate", result: "skipped" }],
    // A required check with no lane at all is a gap, not a pass.
    [pass("subject.resolve")],
  ];
  for (const outcomes of forged) {
    const status = composeGateStatus(outcomes, "full", required);
    if (status.result === "pass") {
      throw new Error(
        `forged outcomes composed into a pass: ${JSON.stringify(outcomes)}`,
      );
    }
  }
});

Deno.test("interruption composes as interrupted, not failure", () => {
  const status = composeGateStatus(
    [
      { checkId: "subject.resolve", result: "pass" },
      { checkId: "test.aggregate", result: "interrupted" },
      { checkId: "secret.tree", result: "skipped" },
    ],
    "full",
    ["subject.resolve", "test.aggregate", "secret.tree"],
  );
  assertEquals(status.result, "interrupted");
  const failed = composeGateStatus(
    [{ checkId: "test.aggregate", result: "fail" }],
    "full",
    ["test.aggregate"],
  );
  assertEquals(failed.result, "fail");
});

Deno.test("a missing required lane exits nonzero and claims no success", async () => {
  const logs: string[] = [];
  const errors: string[] = [];
  // Every lane runs and exits zero, so the lane exit codes alone read green;
  // only the composed status knows `demo.missing` never ran.
  const code = await runGate({
    lanes: [{
      label: "present lane",
      checkId: "demo.present",
      command: Deno.execPath(),
      args: ["eval", "Deno.exit(0)"],
    }],
    requiredCheckIds: ["demo.present", "demo.missing"],
    successMessage: "✓ fast gate subset passed",
    out: { log: (s) => logs.push(s), error: (s) => errors.push(s) },
  });

  assertEquals(code, COMPOSED_FAIL_EXIT_CODE);
  if (code === 0) throw new Error("a required gap exited zero");
  for (
    const claim of ["✓ aggregate test gate passed", "✓ fast gate subset passed"]
  ) {
    if (logs.includes(claim)) {
      throw new Error("gate claimed success over a missing required check");
    }
  }
  const statusLine = logs.find((line) => line.startsWith("gate-status "));
  if (!statusLine) throw new Error("gate did not emit a status line");
  const status = JSON.parse(statusLine.slice("gate-status ".length));
  assertEquals(status.result, "fail");
  assertEquals(status.checks, [
    { id: "demo.missing", result: "skipped" },
    { id: "demo.present", result: "pass" },
  ]);
});

Deno.test("a lane that both passes and fails one check id cannot exit zero", async () => {
  const logs: string[] = [];
  const errors: string[] = [];
  // The failing lane supplies the concrete nonzero code that must survive.
  const code = await runGate({
    lanes: [
      {
        label: "passing shared lane",
        checkId: "demo.shared",
        command: Deno.execPath(),
        args: ["eval", "Deno.exit(0)"],
      },
      {
        label: "failing shared lane",
        checkId: "demo.shared",
        command: Deno.execPath(),
        args: ["eval", "Deno.exit(9)"],
      },
    ],
    requiredCheckIds: ["demo.shared"],
    out: { log: (s) => logs.push(s), error: (s) => errors.push(s) },
  });

  assertEquals(code, 9);
  if (logs.includes("✓ aggregate test gate passed")) {
    throw new Error("gate claimed success over a failed required check");
  }
  const statusLine = logs.find((line) => line.startsWith("gate-status "));
  if (!statusLine) throw new Error("gate did not emit a status line");
  const status = JSON.parse(statusLine.slice("gate-status ".length));
  assertEquals(status.result, "fail");
  assertEquals(status.checks, [{ id: "demo.shared", result: "fail" }]);
});

Deno.test("a fully covered green run still exits zero and claims success", async () => {
  const logs: string[] = [];
  const code = await runGate({
    lanes: [
      {
        label: "first covered lane",
        checkId: "demo.one",
        command: Deno.execPath(),
        args: ["eval", "Deno.exit(0)"],
      },
      {
        label: "second covered lane",
        checkId: "demo.two",
        command: Deno.execPath(),
        args: ["eval", "Deno.exit(0)"],
      },
    ],
    requiredCheckIds: ["demo.one", "demo.two"],
    out: { log: (message) => logs.push(message), error: () => {} },
  });

  assertEquals(code, 0);
  if (!logs.includes("✓ aggregate test gate passed")) {
    throw new Error("a true pass did not report success");
  }
  const statusLine = logs.find((line) => line.startsWith("gate-status "));
  if (!statusLine) throw new Error("gate did not emit a status line");
  const status = JSON.parse(statusLine.slice("gate-status ".length));
  assertEquals(status.result, "pass");
});

Deno.test("interruption stays distinct from a composed required gap", async () => {
  const logs: string[] = [];
  const errors: string[] = [];
  const abortController = new AbortController();
  const code = await runGate({
    signal: abortController.signal,
    lanes: [{
      label: "final lane",
      checkId: "demo.present",
      command: Deno.execPath(),
      args: ["eval", "Deno.exit(0)"],
    }],
    // `demo.missing` never runs, but the interrupt outranks the gap: the
    // gate must report interruption, not a plain failure.
    requiredCheckIds: ["demo.present", "demo.missing"],
    out: {
      log: (message) => {
        logs.push(message);
        if (message.startsWith("✓ final lane:")) {
          abortController.abort("SIGTERM");
        }
      },
      error: (message) => errors.push(message),
    },
  });

  assertEquals(code, 143);
  if (logs.includes("✓ aggregate test gate passed")) {
    throw new Error("gate reported success after interruption");
  }
  const statusLine = logs.find((line) => line.startsWith("gate-status "));
  if (!statusLine) throw new Error("gate did not emit a status line");
  const status = JSON.parse(statusLine.slice("gate-status ".length));
  assertEquals(status.result, "interrupted");
});

Deno.test("gate and receipt schema share one stable check-id vocabulary", () => {
  assertEquals([...REQUIRED_CHECK_IDS], [...MANDATORY_CHECK_IDS]);
});

Deno.test("gate diagnostics carry a bounded command label, never argv", async () => {
  // Assembled at runtime so no secret- or path-shaped literal sits in
  // tracked source; the argv content stands in for a credential or a
  // private operator path bound into a lane.
  const hostileArg = ["--token=sk-live-", "SECRET0123456789"].join("");
  const privateArg = ["", "Users", "someone", "private-overlay"].join("/");
  const logs: string[] = [];
  const errors: string[] = [];
  const code = await runGate({
    lanes: [{
      label: "argv lane",
      checkId: "demo.argv",
      command: Deno.execPath(),
      commandLabel: "deno",
      args: ["eval", `// ${hostileArg} ${privateArg}\nDeno.exit(4);`],
    }],
    out: { log: (s) => logs.push(s), error: (s) => errors.push(s) },
  });
  assertEquals(code, 4);
  const output = [...logs, ...errors].join("\n");
  assertStringIncludes(output, "▶ argv lane (deno)");
  for (const leaked of [hostileArg, privateArg, Deno.execPath(), "eval"]) {
    if (output.includes(leaked)) {
      throw new Error("lane argv or command path reached gate output");
    }
  }
});

Deno.test("an unavailable hostile command stays out of output and cannot pass", async () => {
  const hostileCommand = ["", "Users", "someone", "private-tools", "runner"]
    .join("/");
  const logs: string[] = [];
  const errors: string[] = [];
  const code = await runGate({
    lanes: [{
      label: "unavailable lane",
      checkId: "demo.required",
      command: hostileCommand,
      args: ["--credential", "hostile-value"],
    }],
    requiredCheckIds: ["demo.required"],
    out: { log: (s) => logs.push(s), error: (s) => errors.push(s) },
  });
  assertEquals(code, 127);
  const output = [...logs, ...errors].join("\n");
  assertStringIncludes(output, "▶ unavailable lane (command)");
  assertStringIncludes(output, "unavailable: command-not-runnable");
  for (
    const leaked of [hostileCommand, "Users", "hostile-value", "--credential"]
  ) {
    if (output.includes(leaked)) {
      throw new Error("hostile command content reached gate output");
    }
  }
  const statusLine = logs.find((line) => line.startsWith("gate-status "));
  if (!statusLine) throw new Error("gate did not emit a status line");
  const status = JSON.parse(statusLine.slice("gate-status ".length));
  assertEquals(status.result, "fail");
  assertEquals(status.checks, [{ id: "demo.required", result: "unavailable" }]);
});

Deno.test("the gate emits a bounded machine-readable status line", async () => {
  const logs: string[] = [];
  const code = await runGate({
    lanes: [
      {
        label: "passing lane",
        checkId: "demo.pass",
        command: Deno.execPath(),
        args: ["eval", "Deno.exit(0)"],
      },
      {
        label: "failing lane",
        checkId: "demo.fail",
        command: Deno.execPath(),
        args: ["eval", "Deno.exit(3)"],
      },
      {
        label: "unreached lane",
        checkId: "demo.unreached",
        command: Deno.execPath(),
        args: ["eval", "Deno.exit(0)"],
      },
    ],
    out: { log: (message) => logs.push(message), error: () => {} },
  });
  assertEquals(code, 3);
  const statusLine = logs.find((line) => line.startsWith("gate-status "));
  if (!statusLine) throw new Error("gate did not emit a status line");
  if (statusLine.length > 4_000) {
    throw new Error("gate status line is not bounded");
  }
  const status = JSON.parse(statusLine.slice("gate-status ".length));
  assertEquals(status.schema, "dyfj.gate.status/v1");
  assertEquals(status.result, "fail");
  assertEquals(status.checks, [
    { id: "demo.fail", result: "fail" },
    { id: "demo.pass", result: "pass" },
    { id: "demo.unreached", result: "skipped" },
  ]);
});
