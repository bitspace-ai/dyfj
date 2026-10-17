import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { connect } from "node:net";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { testSourcesFromPaths } from "../prototype/scripts/test-files.ts";
import { integrationChildEnvironment } from "../prototype/scripts/integration-child-environment.ts";
import { parallelJobs } from "../prototype/scripts/node-test-lane.ts";
import {
  COMPOSED_FAIL_EXIT_CODE,
  composeGateStatus,
  defaultLaneRecordDir,
  DOCS_ONLY_LANE_LABELS,
  docsOnlyEligible,
  FAST_LANE_LABELS,
  fastLanes,
  type GateLane,
  INHERITED_ENVIRONMENT_NAMES,
  LANE_DEADLINE_EXIT_CODE,
  LANE_DEADLINES_MS,
  laneDeadlineMs,
  type LaneOutcome,
  MAX_TEST_BOUND_SEC,
  orphanedLaneGroup,
  parseGateArguments,
  parseProcessList,
  planGate,
  productionLanes,
  REQUIRED_CHECK_IDS,
  runGate,
} from "./aggregate-test-gate.ts";
import { test } from "node:test";
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


// Runs a lane's command directly, outside the gate, and captures its output.
function runLaneDirectly(
  lane: GateLane,
): { code: number | null; stdout: string; stderr: string } {
  const result = spawnSync(lane.command, lane.args, {
    cwd: lane.cwd,
    encoding: "utf8",
    stdio: "pipe",
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
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

test("recursive test discovery includes nested test files", () => {
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

test("aggregate gate source does not advertise a stale direct entrypoint", async () => {
  const source = await readFile("scripts/aggregate-test-gate.ts", "utf8");
  if (source.startsWith("#!")) {
    throw new Error("aggregate gate retained a direct-execution shebang");
  }
});

test("the npm install precondition runs first, read-only, in full and fast", () => {
  const lanes = productionLanes("/repo");
  const lane = lanes[0];
  if (!lane) throw new Error("no production lanes");
  assertEquals(lane.label, "npm install precondition (node_modules)");
  assertEquals(lane.checkId, "test.aggregate");
  assertEquals(lane.command, "node");
  assertEquals(lane.cwd, "/repo");
  // It checks what npm installed at the workspace root; it never installs.
  assertEquals(lane.args, ["scripts/node-modules-check.ts", "/repo"]);
  assertEquals(FAST_LANE_LABELS[0], lane.label);
  assertEquals(DOCS_ONLY_LANE_LABELS.includes(lane.label), false);
});

test("aggregate lanes include the retired-surface scan", () => {
  const lane = productionLanes("/repo").find((
    candidate,
  ) => candidate.label === "Retired-surface scan");
  if (!lane) throw new Error("retired-surface scan lane is missing");
  assertEquals(lane.command, "node");
  assertEquals(lane.args, ["scripts/retired-surface-scan.ts"]);
});

test("the tsc lane runs the root workspace's tsc in full and fast", () => {
  const lane = productionLanes("/repo").find((
    candidate,
  ) => candidate.label === "TypeScript typecheck (typecheck.tsc)");
  if (!lane) throw new Error("typecheck.tsc lane is missing");
  assertEquals(lane.checkId, "test.aggregate");
  assertEquals(lane.command, "node");
  assertEquals(lane.args, [
    "node_modules/typescript/bin/tsc",
    "--project",
    "tsconfig.json",
  ]);
  assertEquals(lane.cwd, "/repo");
  assertEquals(FAST_LANE_LABELS.includes(lane.label), true);
});

test("aggregate lanes include the test.unit suite", () => {
  const lane = productionLanes("/repo").find((
    candidate,
  ) => candidate.label === "Prototype unit test suite (test.unit)");
  if (!lane) throw new Error("test.unit lane is missing");
  assertEquals(lane.checkId, "test.aggregate");
  // The runner itself leads the lane group, not an npm script.
  assertEquals(lane.command, "node");
  assertEquals(lane.args, ["scripts/run-unit-tests.ts"]);
  assertEquals(lane.cwd, "/repo/prototype");
  assertEquals(lane.env?.TMPDIR, "/tmp");
  if (!FAST_LANE_LABELS.includes(lane.label)) {
    throw new Error("test.unit must also run in the fast subset");
  }
});

test("the three test lanes carry deadlines and run their runners on Node", () => {
  const lanes = productionLanes("/repo");
  for (
    const [label, deadline] of [
      ["Prototype unit test suite (test.unit)", LANE_DEADLINES_MS.unit],
      ["Isolated Dolt integration lane", LANE_DEADLINES_MS.integration],
      ["Golden characterization suite (test.golden)", LANE_DEADLINES_MS.golden],
    ] as const
  ) {
    const lane = lanes.find((candidate) => candidate.label === label);
    if (!lane) throw new Error(`${label} is missing`);
    // The runner forwards no DYFJ_TEST_BOUND_SEC here, so the defaults apply.
    assertEquals(lane.deadlineMs, laneDeadlineMs(deadline, undefined));
    // A plain `node` runner reads the supervision names the gate adds to
    // its environment (`runGate`).
    assertEquals(lane.command, "node");
    assertEquals(lane.args.length, 1);
  }
  // Every other lane is unsupervised.
  assertEquals(
    lanes.filter((lane) => lane.deadlineMs !== undefined).length,
    3,
  );
});

test("DYFJ_TEST_BOUND_SEC overrides a lane deadline with whole seconds", () => {
  assertEquals(laneDeadlineMs(120_000, undefined), 120_000);
  assertEquals(laneDeadlineMs(120_000, "30"), 30_000);
  // The largest bound whose backstop still fits a timer, and one past it.
  assertEquals(MAX_TEST_BOUND_SEC, 2_147_423);
  assertEquals(laneDeadlineMs(120_000, "2147423"), 2_147_423_000);
  for (
    const bad of ["0", "-5", "1.5", "abc", "", "99999999", "2147424", "3000000"]
  ) {
    assertEquals(laneDeadlineMs(120_000, bad), 120_000);
  }
});

test("lane records live under an absolute HOME only", () => {
  assertEquals(
    defaultLaneRecordDir("/srv/operator"),
    "/srv/operator/.dyfj/run/gate-lanes",
  );
  assertEquals(defaultLaneRecordDir(undefined), undefined);
  assertEquals(defaultLaneRecordDir("relative"), undefined);
});

test("recovery signals only a group that still carries the lane token", () => {
  const token = "0f8b7c2e-5a41-4d7e-9c3b-2e1f0a9d8c7b";
  const record = { gatePid: 100, group: 200, token };
  const marker = `node --test a.test.ts -- --dyfj-lane=${token}`;
  assertEquals(
    orphanedLaneGroup(record, [
      {
        pid: 100,
        group: 100,
        command: "node scripts/aggregate-test-gate.ts",
      },
      { pid: 201, group: 200, command: marker },
    ]),
    "gate-alive",
  );
  assertEquals(
    orphanedLaneGroup(record, [{ pid: 201, group: 200, command: marker }]),
    "recover",
  );
  // The gate's pid reused by something else: the gate is gone.
  assertEquals(
    orphanedLaneGroup(record, [
      { pid: 100, group: 100, command: "sleep 30" },
      { pid: 201, group: 200, command: marker },
    ]),
    "recover",
  );
  // The token in another group, or the group without the token.
  assertEquals(
    orphanedLaneGroup(record, [
      { pid: 301, group: 300, command: marker },
      { pid: 201, group: 200, command: "sleep 30" },
    ]),
    "drop",
  );
  assertEquals(
    parseProcessList("  201   200 node --test -- x\n garbage\n 5 5 sh"),
    [
      { pid: 201, group: 200, command: "node --test -- x" },
      { pid: 5, group: 5, command: "sh" },
    ],
  );
});

test("aggregate lanes include the contract package tests", () => {
  const lane = productionLanes("/repo").find((
    candidate,
  ) => candidate.label === "Contract package tests");
  if (!lane) throw new Error("contract package test lane is missing");
  assertEquals(lane.checkId, "test.aggregate");
  assertStringIncludes(
    lane.args.join(" "),
    "contracts/workbench/first-product/v1/validate.test.ts",
  );
  assertStringIncludes(
    lane.args.join(" "),
    "contracts/workbench/first-product/v1/executable-closure.test.ts",
  );
  assertStringIncludes(
    lane.args.join(" "),
    "contracts/workbench/first-product/v1/executable-closure-report.test.ts",
  );
  // The files register with node:test, so the lane runs them under
  // `node --test` through the shared Node runner, which spawns only `node`.
  assertEquals(lane.command, "node");
  assertEquals(lane.args.slice(0, 4), [
    "scripts/run-node-test-files.ts",
    "--lane",
    "contracts",
    "contracts/workbench/first-product/v1/validate.test.ts",
  ]);
  if (!FAST_LANE_LABELS.includes(lane.label)) {
    throw new Error("contract package tests must also run in the fast subset");
  }
});

test("aggregate lanes compare a regenerated closure report", () => {
  const lane = productionLanes("/repo").find((
    candidate,
  ) => candidate.label === "Contract closure report generation");
  if (!lane) {
    throw new Error("contract closure report generation lane is missing");
  }
  assertEquals(lane.checkId, "test.aggregate");
  assertStringIncludes(
    lane.args.join(" "),
    "contracts/workbench/first-product/v1/executable-closure-report.ts",
  );
  assertStringIncludes(
    lane.args.join(" "),
    "--compare-path contracts/workbench/first-product/v1/executable-closure-report.json",
  );
  // It runs on Node and compares only: no output path, so it writes
  // nothing.
  assertEquals(lane.command, "node");
  if (lane.args.includes("--output-path")) {
    throw new Error("closure report lane must not request an output path");
  }
  if (!FAST_LANE_LABELS.includes(lane.label)) {
    throw new Error(
      "contract closure report generation must also run in the fast subset",
    );
  }
});

test("closure report comparison succeeds and leaves the report unchanged", async () => {
  const lane = productionLanes(process.cwd()).find((candidate) =>
    candidate.label === "Contract closure report generation"
  );
  if (!lane) throw new Error("closure comparison lane missing");
  const path =
    "contracts/workbench/first-product/v1/executable-closure-report.json";
  const before = await readFile(path, "utf8");
  const result = runLaneDirectly(lane);
  assertEquals(result.code, 0);
  assertEquals(await readFile(path, "utf8"), before);
});

test("closure report lane fails when regeneration differs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dyfj-closure-report-mismatch-"));
  const committedPath =
    "contracts/workbench/first-product/v1/executable-closure-report.json";
  const alteredPath = `${directory}/altered-report.json`;
  try {
    const committed = await readFile(committedPath, "utf8");
    await writeFile(alteredPath, `${committed}\n`);
    const lane = productionLanes(process.cwd()).find((
      candidate,
    ) => candidate.label === "Contract closure report generation");
    if (!lane) {
      throw new Error("contract closure report generation lane is missing");
    }
    const compareIndex = lane.args.indexOf("--compare-path");
    if (compareIndex < 0) {
      throw new Error("closure report lane lacks comparison arguments");
    }
    lane.args[compareIndex + 1] = alteredPath;

    const result = runLaneDirectly(lane);
    assertEquals(result.code, 1);
    assertStringIncludes(
      result.stderr,
      "executable closure report mismatch: committed report differs from fresh regeneration",
    );
    assertEquals(await readFile(committedPath, "utf8"), committed);
    assertEquals(await readFile(alteredPath, "utf8"), `${committed}\n`);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("aggregate lanes include both public-safety scan families", () => {
  for (const family of ["secret.tree", "public.boundary"]) {
    const lane = productionLanes("/repo").find((
      candidate,
    ) => candidate.checkId === family);
    if (!lane) throw new Error(`${family} scan lane is missing`);
    assertEquals(lane.command, "node");
    assertEquals(lane.args, [
      "scripts/public-safety-scan.ts",
      "--family",
      family,
    ]);
  }
});

test("every stable required check id has a production lane", () => {
  const lanes = productionLanes("/repo");
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

test("policy check lanes invoke their dedicated scripts", () => {
  const lanes = productionLanes("/repo");
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

test("the ported static-check lanes run their scripts on node", () => {
  const lanes = productionLanes("/repo");
  for (
    const checkId of [
      "subject.resolve",
      "subject.digest",
      "secret.tree",
      "public.boundary",
      "secret.diff",
      "diff.whitespace",
      "markdown.links",
      "shell.parse",
      "dependency.policy",
    ]
  ) {
    const lane = lanes.find((candidate) => candidate.checkId === checkId);
    if (!lane) throw new Error(`${checkId} lane is missing`);
    assertEquals(lane.command, "node");
    assertEquals(lane.args[0]?.startsWith("scripts/"), true);
    assertEquals(lane.args.some((arg) => arg.startsWith("--allow")), false);
  }
});

test("the ratchet.base lane runs on node with the range binding", () => {
  const lanes = productionLanes("/repo");
  const lane = lanes.find((candidate) =>
    candidate.label === "Ratchet lists against the merge base (ratchet.base)"
  );
  if (!lane) throw new Error("ratchet.base lane is missing");
  assertEquals(lane.checkId, "test.aggregate");
  assertEquals(lane.command, "node");
  assertEquals(lane.args, ["scripts/ratchet-base.ts"]);
  assertEquals(lane.cwd, "/repo");
  // The same binding the range lanes get, so it sees DYFJ_GATE_RANGE_BASE.
  const range = lanes.find((candidate) => candidate.checkId === "secret.diff");
  assertEquals(lane.env, range?.env);
  assertEquals(FAST_LANE_LABELS.includes(lane.label), true);
  assertEquals(REQUIRED_CHECK_IDS.includes("ratchet.base"), false);
});

test("the receipt.schema lane runs its tests on node through the shared runner", () => {
  const lane = productionLanes("/repo").find((
    candidate,
  ) => candidate.checkId === "receipt.schema");
  if (!lane) throw new Error("receipt.schema lane is missing");
  assertEquals(lane.label, "Receipt schema validation");
  assertEquals(lane.command, "node");
  assertEquals(lane.args, [
    "scripts/run-node-test-files.ts",
    "--lane",
    "receipt.schema",
    "scripts/assurance-receipt.test.ts",
  ]);
  assertEquals(lane.cwd, "/repo");
});

test("the arch.imports lane runs the checker read-only", () => {
  const lane = productionLanes("/repo").find((
    candidate,
  ) => candidate.label === "Architecture import rules (arch.imports)");
  if (!lane) throw new Error("arch.imports lane is missing");
  assertEquals(lane.checkId, "test.aggregate");
  assertEquals(lane.cwd, "/repo");
  assertStringIncludes(lane.args.join(" "), "scripts/arch-imports.ts");
  // On Node, with no runtime permission flags to grant anything.
  assertEquals(lane.command, "node");
  assertEquals(lane.args, ["scripts/arch-imports.ts"]);
  assertEquals(FAST_LANE_LABELS.includes(lane.label), true);
});

test("binding-aware lanes forward the CI subject and range", () => {
  const sentinel = "f".repeat(40);
  const prior = process.env.DYFJ_GATE_SUBJECT;
  process.env.DYFJ_GATE_SUBJECT = sentinel;
  try {
    const lanes = productionLanes("/repo");
    for (const checkId of ["subject.resolve", "secret.diff"]) {
      const lane = lanes.find((candidate) => candidate.checkId === checkId);
      if (!lane) throw new Error(`${checkId} lane is missing`);
      assertEquals(lane.env?.DYFJ_GATE_SUBJECT, sentinel);
    }
  } finally {
    if (prior === undefined) delete process.env.DYFJ_GATE_SUBJECT;
    else process.env.DYFJ_GATE_SUBJECT = prior;
  }
});

test("orchestration lane covers the CI workflow hygiene tests", () => {
  const lane = productionLanes("/repo").find((
    candidate,
  ) => candidate.label === "Aggregate gate orchestration tests");
  if (!lane) throw new Error("orchestration test lane is missing");
  assertStringIncludes(lane.args.join(" "), "scripts/ci-workflow.test.ts");
  // The files register with node:test and run under `node --test` through
  // the shared Node runner.
  assertEquals(lane.command, "node");
  assertEquals(lane.args.slice(0, 3), [
    "scripts/run-node-test-files.ts",
    "--lane",
    "gate.orchestration",
  ]);
  // Lane children start from a cleared environment: the deterministic temp
  // root must be set explicitly, never inherited.
  assertEquals(lane.env, { TMPDIR: "/tmp" });
});

test("fast lanes reuse the production lane definitions verbatim", () => {
  const production = productionLanes("/repo");
  const fast = fastLanes("/repo");
  assertEquals(fast.map((lane) => lane.label), [...FAST_LANE_LABELS]);
  for (const lane of fast) {
    assertEquals(
      lane,
      production.find((candidate) => candidate.label === lane.label),
    );
  }
});

test("fast lanes keep the scans and exclude the heavyweight suites", () => {
  const fast = fastLanes("/repo");
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
      "Offline-metadata Rust tests",
      "Isolated Dolt integration lane",
      "Golden characterization suite (test.golden)",
      "Current-schema apply validation",
      "Historical replay plus forward-migration validation",
      "Schema codegen freshness (schema.codegen)",
      "Schema equivalence (schema.equivalence)",
    ]
  ) {
    if (labels.includes(heavy)) {
      throw new Error(`${heavy} must not run in the fast subset`);
    }
  }
});

const planEnv = (values: Record<string, string>) => (name: string) =>
  values[name];

const pullRequest = planEnv({
  GITHUB_ACTIONS: "true",
  GITHUB_EVENT_NAME: "pull_request",
});

test("a Markdown-only pull request runs only the policy lanes", async () => {
  const plan = await planGate({
    fast: false,
    env: pullRequest,
    root: "/repo",
    changeScope: () => Promise.resolve("markdown-only"),
  });
  const production = productionLanes("/repo");
  assertEquals(plan.mode, "docs-only");
  assertEquals(plan.lanes.map((lane) => lane.label), [
    ...DOCS_ONLY_LANE_LABELS,
  ]);
  for (const lane of plan.lanes) {
    assertEquals(
      lane,
      production.find((candidate) => candidate.label === lane.label),
    );
  }
  // Every lane left out is named, and together they are the whole gate.
  assertEquals(
    [...plan.lanes.map((lane) => lane.label), ...plan.skipped!.labels].sort(),
    production.map((lane) => lane.label).sort(),
  );
  for (
    const skipped of [
      "Prototype unit test suite (test.unit)",
      "Isolated Dolt integration lane",
      "Golden characterization suite (test.golden)",
      "Schema codegen freshness (schema.codegen)",
      "Architecture import rules (arch.imports)",
      "Offline-metadata Rust tests",
    ]
  ) {
    if (!plan.skipped!.labels.includes(skipped)) {
      throw new Error(`${skipped} must be skipped on a docs-only change`);
    }
  }
  // The policy lanes still report every required check id.
  assertEquals(plan.requiredCheckIds, REQUIRED_CHECK_IDS);
  const ids = new Set(plan.lanes.map((lane) => lane.checkId));
  for (const id of REQUIRED_CHECK_IDS) {
    if (!ids.has(id)) throw new Error(`docs-only run does not report ${id}`);
  }
  // Lanes that read this repository's Markdown must run on a docs-only change.
  for (
    const reader of [
      "Retired-surface scan",
      "Contract closure report generation",
      "Contract package tests",
    ]
  ) {
    if (!plan.lanes.some((lane) => lane.label === reader)) {
      throw new Error(`${reader} reads Markdown and must run`);
    }
  }
});

test("a pull request with any non-Markdown path runs the full gate", async () => {
  const plan = await planGate({
    fast: false,
    env: pullRequest,
    root: "/repo",
    changeScope: () => Promise.resolve("other"),
  });
  assertEquals(plan.mode, "full");
  assertEquals(
    plan.lanes,
    productionLanes("/repo"),
  );
  assertEquals(plan.skipped, undefined);
  assertEquals(plan.requiredCheckIds, REQUIRED_CHECK_IDS);
});

test("push, dispatch and local runs keep the full gate on a Markdown-only range", async () => {
  for (
    const env of [
      planEnv({ GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "push" }),
      planEnv({
        GITHUB_ACTIONS: "true",
        GITHUB_EVENT_NAME: "workflow_dispatch",
      }),
      planEnv({ GITHUB_EVENT_NAME: "pull_request" }),
      planEnv({}),
    ]
  ) {
    let asked = false;
    const plan = await planGate({
      fast: false,
      env,
      root: "/repo",
      changeScope: () => {
        asked = true;
        return Promise.resolve("markdown-only");
      },
    });
    assertEquals(plan.mode, "full");
    assertEquals(plan.skipped, undefined);
    assertEquals(
      plan.lanes.length,
      productionLanes("/repo").length,
    );
    if (asked) throw new Error("a non-pull-request run classified its range");
  }
  assertEquals(docsOnlyEligible(pullRequest), true);
});

test("the fast subset is unaffected by change scope", async () => {
  const plan = await planGate({
    fast: true,
    env: pullRequest,
    root: "/repo",
    changeScope: () => Promise.resolve("markdown-only"),
  });
  assertEquals(plan.mode, "fast");
  assertEquals(plan.lanes.map((lane) => lane.label), [...FAST_LANE_LABELS]);
  assertEquals(plan.skipped, undefined);
});

test("a docs-only run names every lane it skips and its own claim", async () => {
  const logs: string[] = [];
  const code = await runGate({
    lanes: [{
      label: "policy lane",
      checkId: "demo.policy",
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
    }],
    mode: "docs-only",
    requiredCheckIds: ["demo.policy"],
    successMessage: "✓ docs-only gate passed",
    skipped: {
      reason: "every path is Markdown",
      labels: ["suite lane", "rust lane"],
    },
    out: { log: (message) => logs.push(message), error: () => {} },
  });
  assertEquals(code, 0);
  const header = logs.indexOf("▷ every path is Markdown; skipping 2 lanes:");
  if (header === -1) throw new Error("gate did not announce the skipped lanes");
  assertEquals(logs.slice(header + 1, header + 3), [
    "  - suite lane",
    "  - rust lane",
  ]);
  const statusLine = logs.find((line) => line.startsWith("gate-status "));
  assertEquals(
    JSON.parse(statusLine!.slice("gate-status ".length)).mode,
    "docs-only",
  );
  if (logs.includes("✓ aggregate test gate passed")) {
    throw new Error("a docs-only run claimed the full green bar");
  }
  if (!logs.includes("✓ docs-only gate passed")) {
    throw new Error("a docs-only run did not report its own claim");
  }
});

test("a subset run reports its own success claim, not the full bar", async () => {
  const logs: string[] = [];
  const code = await runGate({
    lanes: [{
      label: "subset lane",
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
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

test("gate arguments select the fast subset and fail closed otherwise", () => {
  assertEquals(parseGateArguments([]), { fast: false });
  assertEquals(parseGateArguments(["--fast"]), { fast: true });
  assertThrows(() => parseGateArguments(["--unknown"]), "unknown argument");
  assertThrows(
    () => parseGateArguments(["--fast", "extra"]),
    "unknown argument",
  );
});

test("aggregate lanes include the golden characterization suite", async () => {
  const lanes = productionLanes("/repo");
  const lane = lanes.find((candidate) =>
    candidate.label === "Golden characterization suite (test.golden)"
  );
  if (!lane) throw new Error("golden characterization lane is missing");
  assertEquals(lane.checkId, "test.aggregate");
  // The runner and its tests run on Node (decision D32).
  assertEquals(lane.command, "node");
  assertEquals(lane.cwd, "/repo/prototype");
  assertEquals(lane.env, { TMPDIR: "/tmp" });
  assertEquals(lane.args, ["testing/golden/run.ts"]);
  if (FAST_LANE_LABELS.includes(lane.label)) {
    throw new Error("golden lane must not run in the fast subset");
  }
  const runner = await readFile("prototype/testing/golden/run.ts", "utf8");
  // The lane can never rewrite its own snapshots: only an explicit update
  // turns on update mode, without which the one snapshot writer refuses
  // (`testing/golden/snapshots.ts`, pinned by its own tests).
  assertStringIncludes(
    runner,
    'const update = suiteArgs.includes("--update");',
  );
  assertEquals(runner.includes("testing/golden/snapshots"), false);
  assertStringIncludes(
    runner,
    'env: update ? { ...env, [GOLDEN_UPDATE_ENV]: "1" } : env,',
  );
});

test("aggregate lanes include schema catalog, codegen, and equivalence checks", () => {
  const lanes = productionLanes("/repo");
  const catalog = lanes.find((candidate) =>
    candidate.label === "Local model catalog data validation"
  );
  if (!catalog) throw new Error("local model catalog lane is missing");
  // The catalog tests register with node:test and run through the shared
  // Node runner; its node --test child spawns dolt unsandboxed.
  assertEquals(catalog.command, "node");
  assertEquals(catalog.args, [
    "scripts/run-node-test-files.ts",
    "--lane",
    "schema.catalog",
    "schema/model-catalog.test.ts",
  ]);
  assertEquals(catalog.checkId, "test.aggregate");
  assertEquals(catalog.cwd, "/repo");
  const codegen = lanes.find((candidate) =>
    candidate.label === "Schema codegen freshness (schema.codegen)"
  );
  if (!codegen) throw new Error("schema.codegen lane is missing");
  assertEquals(codegen.args.slice(-2), ["schema/codegen.ts", "--check"]);
  // `--check` compares against the committed file and never rewrites it.
  const equivalence = lanes.find((candidate) =>
    candidate.label === "Schema equivalence (schema.equivalence)"
  );
  if (!equivalence) throw new Error("schema.equivalence lane is missing");
  assertEquals(equivalence.args.at(-1), "schema/equivalence.ts");
  const applyLanes = lanes.filter((candidate) =>
    candidate.label === "Current-schema apply validation" ||
    candidate.label === "Historical replay plus forward-migration validation"
  );
  assertEquals(applyLanes.length, 2);
  for (const lane of [codegen, equivalence, ...applyLanes]) {
    assertEquals(lane.checkId, "test.aggregate");
    assertEquals(lane.cwd, "/repo");
    // The schema CLIs run as plain node, with no permission flag: the gate's
    // lanes have no per-lane sandbox.
    assertEquals(lane.command, "node");
    assertEquals(lane.args[0]?.startsWith("schema/"), true);
  }
});

test("isolated Dolt lane passes custom Rust toolchain roots to children", () => {
  const lane = productionLanes("/repo").find((
    candidate,
  ) => candidate.label === "Isolated Dolt integration lane");
  if (!lane) throw new Error("isolated Dolt integration lane is missing");
  // A plain `node` runner reads every name the gate forwards.
  assertEquals(lane.command, "node");
  for (const name of ["CARGO_HOME", "RUSTUP_HOME"]) {
    if (!INHERITED_ENVIRONMENT_NAMES.includes(name)) {
      throw new Error(`the gate does not forward ${name} to lanes`);
    }
  }
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

test("a caller's Rust homes reach the integration lane's children", () => {
  // The gate forwards them into the lane's cleared environment, and the
  // lane's runner passes them on to the Rust schema round trip.
  const lane = productionLanes("/repo").find((
    candidate,
  ) => candidate.label === "Isolated Dolt integration lane");
  if (!lane) throw new Error("isolated Dolt integration lane is missing");
  assertEquals(lane.command, "node");
  const homes = { CARGO_HOME: "/custom/cargo", RUSTUP_HOME: "/custom/rustup" };
  for (const name of Object.keys(homes)) {
    if (!INHERITED_ENVIRONMENT_NAMES.includes(name)) {
      throw new Error(`the gate does not forward ${name} to lanes`);
    }
  }
  assertEquals(
    integrationChildEnvironment(
      {},
      (name) => (homes as Record<string, string>)[name],
    ),
    homes,
  );
});

test("no lane carries a runtime permission flag", () => {
  for (const lane of productionLanes("/repo")) {
    if (lane.args.some((argument) => /^--(allow|deny)-/.test(argument))) {
      throw new Error(`${lane.label} carries a runtime permission flag`);
    }
  }
});

test("aggregate lane children do not inherit unrelated environment", async () => {
  const sentinel = "DYFJ_AGGREGATE_SENTINEL";
  const prior = process.env[sentinel];
  const priorTmpdir = process.env.TMPDIR;
  process.env[sentinel] = "must-not-reach-child";
  process.env.TMPDIR = "/not-a-granted-temp-root";
  try {
    const code = await runGate({
      lanes: [{
        label: "environment lane",
        command: process.execPath,
        args: [
          "-e",
          `if (process.env[${
            JSON.stringify(sentinel)
          }] !== undefined || process.env.TMPDIR !== undefined) process.exit(1);`,
        ],
      }],
      out: { log: () => {}, error: () => {} },
    });
    assertEquals(code, 0);
  } finally {
    if (prior === undefined) delete process.env[sentinel];
    else process.env[sentinel] = prior;
    if (priorTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = priorTmpdir;
  }
});

test("aggregate gate runs every lane and reports every failure", async () => {
  const logs: string[] = [];
  const errors: string[] = [];
  const lanes: GateLane[] = [
    {
      label: "ok lane",
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
    },
    {
      label: "broken lane",
      command: process.execPath,
      args: ["-e", "process.exit(12)"],
    },
    {
      label: "later lane",
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
    },
    {
      label: "second broken lane",
      command: process.execPath,
      args: ["-e", "process.exit(7)"],
    },
  ];

  const code = await runGate({
    lanes,
    out: { log: (s) => logs.push(s), error: (s) => errors.push(s) },
  });

  // The first failing lane's code, as a gate that stopped there would return.
  assertEquals(code, 12);
  assertStringIncludes(logs.join("\n"), "✓ later lane: success");
  assertStringIncludes(errors.join("\n"), "broken lane: failure");
  assertStringIncludes(errors.join("\n"), "second broken lane: failure");
  const summary = errors.indexOf("✗ 2 of 4 lanes failed:");
  if (summary === -1) throw new Error("gate did not summarize its failures");
  assertEquals(errors.slice(summary + 1, summary + 3), [
    "  - broken lane",
    "  - second broken lane",
  ]);
  if (logs.includes("✓ aggregate test gate passed")) {
    throw new Error("a failing run claimed success");
  }
});

test("a lane past its deadline is reported and later lanes still run", async () => {
  const logs: string[] = [];
  const errors: string[] = [];
  const code = await runGate({
    lanes: [
      {
        label: "hanging lane",
        command: process.execPath,
        args: ["-e", "setTimeout(() => {}, 30_000)"],
        deadlineMs: 500,
      },
      {
        label: "later lane",
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
      },
      {
        label: "failing lane",
        command: process.execPath,
        args: ["-e", "process.exit(5)"],
      },
    ],
    out: { log: (s) => logs.push(s), error: (s) => errors.push(s) },
  });

  // The deadline lane failed first, so its code is the gate's.
  assertEquals(code, LANE_DEADLINE_EXIT_CODE);
  assertStringIncludes(errors.join("\n"), "hanging lane: failure");
  assertStringIncludes(errors.join("\n"), "s deadline");
  assertStringIncludes(logs.join("\n"), "✓ later lane: success");
  const summary = errors.indexOf("✗ 2 of 3 lanes failed:");
  if (summary === -1) throw new Error("gate did not summarize its failures");
  assertEquals(errors.slice(summary + 1, summary + 3), [
    "  - hanging lane",
    "  - failing lane",
  ]);
});

test("a lane that cannot start is reported and later lanes still run", async () => {
  const logs: string[] = [];
  const errors: string[] = [];
  const code = await runGate({
    lanes: [
      {
        label: "missing tool lane",
        command: "/nonexistent/dyfj-gate-test-tool",
        args: [],
      },
      {
        label: "failing lane",
        command: process.execPath,
        args: ["-e", "process.exit(3)"],
      },
    ],
    out: { log: (s) => logs.push(s), error: (s) => errors.push(s) },
  });

  assertEquals(code, 127);
  assertStringIncludes(errors.join("\n"), "failing lane: failure");
  assertStringIncludes(errors.join("\n"), "✗ 2 of 2 lanes failed:");
});

test("an interruption after a failure keeps the failure's exit code", async () => {
  const errors: string[] = [];
  let statusLine: string | undefined;
  const abortController = new AbortController();
  const code = await runGate({
    signal: abortController.signal,
    lanes: [
      {
        label: "failing lane",
        checkId: "demo.failing",
        command: process.execPath,
        args: ["-e", "process.exit(9)"],
      },
      {
        // Stands in for an operator's interrupt arriving between lanes.
        label: "interrupting lane",
        checkId: "demo.interrupting",
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
      },
      {
        label: "must not run",
        checkId: "demo.after",
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
      },
    ],
    out: {
      log: (s) => {
        if (s.startsWith("gate-status ")) statusLine = s;
        if (s.startsWith("✓ interrupting lane")) {
          abortController.abort("SIGINT");
        }
        if (s.includes("must not run")) {
          throw new Error("aggregate ran a lane after interruption");
        }
      },
      error: (s) => errors.push(s),
    },
  });

  assertEquals(code, 9);
  assertStringIncludes(errors.join("\n"), "✗ 1 of 3 lanes failed:");
  const status = JSON.parse(statusLine!.slice("gate-status ".length));
  // The run stopped early, so it reads interrupted; the failure stays visible.
  assertEquals(status.result, "interrupted");
  assertEquals(status.checks, [
    { id: "demo.after", result: "interrupted" },
    { id: "demo.failing", result: "fail" },
    { id: "demo.interrupting", result: "pass" },
  ]);
});

test("aggregate gate stops its active lane on interruption", async () => {
  const logs: string[] = [];
  const errors: string[] = [];
  const abortController = new AbortController();
  const abortTimer = setTimeout(() => abortController.abort("SIGTERM"), 25);
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  // Well inside the ten-second shutdown bound.
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
            command: process.execPath,
            args: [
              "-e",
              "setTimeout(() => {}, 5_000)",
            ],
          },
          {
            label: "must not run",
            command: process.execPath,
            args: ["-e", "console.log('ran')"],
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
      await stat(path);
      return;
    } catch {
      if (Date.now() >= deadline) {
        throw new Error("timed out waiting for the lane descendant to start");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

// A running descendant listens on a Unix socket; the kernel closes it as soon
// as the process is gone, so a refused connection is a liveness probe no pid
// check can confuse with a reused pid or an unreaped zombie.
async function socketFreedWithin(
  path: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const listening = await new Promise<boolean>((resolve) => {
      const socket = connect(path);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (!listening) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// The lane descendant: it listens on the socket named by its first argument,
// writes the ready file named by its second once it is listening, and waits.
const DESCENDANT_PROGRAM = [
  `import { createServer } from "node:net";`,
  `import { writeFileSync } from "node:fs";`,
  `const [socketPath, readyPath] = process.argv.slice(2);`,
  `createServer().listen(socketPath, () => writeFileSync(readyPath, "ready"));`,
  `setTimeout(() => {}, 30_000);`,
].join("\n");

// POSIX process groups only; Windows lanes keep the leader-only path.
test("interrupting a lane terminates its descendants, not just the leader", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "dyfj-gate-descendant-"));
  const socketPath = `${directory}/d.sock`;
  const readyPath = `${directory}/descendant.ready`;
  const descendantScript = `${directory}/descendant.mjs`;
  const laneScript = `${directory}/lane.mjs`;
  try {
    await writeFile(descendantScript, DESCENDANT_PROGRAM);
    // The lane leader is an ordinary parent: it starts one descendant in
    // its own group and waits, so a leader-only signal leaves the
    // descendant running.
    await writeFile(
      laneScript,
      [
        `import { spawn } from "node:child_process";`,
        `const descendant = spawn(process.execPath, [`,
        `  ${JSON.stringify(descendantScript)},`,
        `  ${JSON.stringify(socketPath)},`,
        `  ${JSON.stringify(readyPath)},`,
        `], { stdio: "ignore" });`,
        `await new Promise((resolve) => descendant.once("exit", resolve));`,
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
        command: process.execPath,
        commandLabel: "node",
        args: [laneScript],
      }],
      requiredCheckIds: ["demo.descendant"],
      out: { log: (s) => logs.push(s), error: (s) => errors.push(s) },
    });
    // Deterministic handshake: the descendant is running and listening
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
    if (!await socketFreedWithin(socketPath, 5_000)) {
      throw new Error("a lane descendant outlived the interrupted gate");
    }
  } finally {
    await rm(directory, { recursive: true });
  }
});

// A lane whose leader exits on its own — cleanly or with a failure code —
// while a descendant it started stays alive. The leader waits for the
// descendant's ready handshake first, so at the moment the leader exits the
// descendant is provably running and listening.
async function withSurvivingDescendantLane(
  leaderExitCode: number,
  assertGate: (
    lane: GateLane,
    socketPath: string,
  ) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "dyfj-gate-outlived-"));
  const socketPath = `${directory}/d.sock`;
  const readyPath = `${directory}/descendant.ready`;
  const descendantScript = `${directory}/descendant.mjs`;
  const laneScript = `${directory}/lane.mjs`;
  try {
    await writeFile(descendantScript, DESCENDANT_PROGRAM);
    await writeFile(
      laneScript,
      [
        `import { spawn } from "node:child_process";`,
        `import { existsSync } from "node:fs";`,
        `spawn(process.execPath, [`,
        `  ${JSON.stringify(descendantScript)},`,
        `  ${JSON.stringify(socketPath)},`,
        `  ${JSON.stringify(readyPath)},`,
        `], { stdio: "ignore" }).unref();`,
        `while (!existsSync(${JSON.stringify(readyPath)})) {`,
        `  await new Promise((resolve) => setTimeout(resolve, 10));`,
        `}`,
        `process.exit(${leaderExitCode});`,
      ].join("\n"),
    );
    await assertGate({
      label: "outlived lane",
      checkId: "demo.outlived",
      command: process.execPath,
      commandLabel: "node",
      args: [laneScript],
    }, socketPath);
  } finally {
    await rm(directory, { recursive: true });
  }
}

// POSIX process groups only; Windows lanes keep the leader-only path.
test("a passing lane's surviving descendant is torn down with its group", { skip: process.platform === "win32" }, async () => {
  await withSurvivingDescendantLane(0, async (lane, socketPath) => {
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
    if (!await socketFreedWithin(socketPath, 5_000)) {
      throw new Error("a lane descendant outlived the passing gate");
    }
  });
});

// POSIX process groups only; Windows lanes keep the leader-only path.
test("a failing lane's surviving descendant is torn down with its group", { skip: process.platform === "win32" }, async () => {
  await withSurvivingDescendantLane(7, async (lane, socketPath) => {
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
    if (!await socketFreedWithin(socketPath, 5_000)) {
      throw new Error("a lane descendant outlived the failing gate");
    }
  });
});

test("aggregate gate reports an interrupt after its final lane", async () => {
  const logs: string[] = [];
  const errors: string[] = [];
  const abortController = new AbortController();
  const code = await runGate({
    signal: abortController.signal,
    lanes: [{
      label: "final lane",
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
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

test("a required gap or failure can never compose into a pass", () => {
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

test("interruption composes as interrupted, not failure", () => {
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
  // A run interrupted after a failure is incomplete: it reads interrupted,
  // and the failed check still reads fail.
  const both = composeGateStatus(
    [
      { checkId: "secret.tree", result: "fail" },
      { checkId: "test.aggregate", result: "interrupted" },
    ],
    "full",
    ["secret.tree", "test.aggregate"],
  );
  assertEquals(both.result, "interrupted");
  assertEquals(both.checks, [
    { id: "secret.tree", result: "fail" },
    { id: "test.aggregate", result: "interrupted" },
  ]);
});

test("a missing required lane exits nonzero and claims no success", async () => {
  const logs: string[] = [];
  const errors: string[] = [];
  // Every lane runs and exits zero, so the lane exit codes alone read green;
  // only the composed status knows `demo.missing` never ran.
  const code = await runGate({
    lanes: [{
      label: "present lane",
      checkId: "demo.present",
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
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

test("a lane that both passes and fails one check id cannot exit zero", async () => {
  const logs: string[] = [];
  const errors: string[] = [];
  // The failing lane supplies the concrete nonzero code that must survive.
  const code = await runGate({
    lanes: [
      {
        label: "passing shared lane",
        checkId: "demo.shared",
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
      },
      {
        label: "failing shared lane",
        checkId: "demo.shared",
        command: process.execPath,
        args: ["-e", "process.exit(9)"],
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

test("a fully covered green run still exits zero and claims success", async () => {
  const logs: string[] = [];
  const code = await runGate({
    lanes: [
      {
        label: "first covered lane",
        checkId: "demo.one",
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
      },
      {
        label: "second covered lane",
        checkId: "demo.two",
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
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

test("interruption stays distinct from a composed required gap", async () => {
  const logs: string[] = [];
  const errors: string[] = [];
  const abortController = new AbortController();
  const code = await runGate({
    signal: abortController.signal,
    lanes: [{
      label: "final lane",
      checkId: "demo.present",
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
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

test("gate and receipt schema share one stable check-id vocabulary", () => {
  assertEquals([...REQUIRED_CHECK_IDS], [...MANDATORY_CHECK_IDS]);
});

test("gate diagnostics carry a bounded command label, never argv", async () => {
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
      command: process.execPath,
      commandLabel: "node",
      args: ["-e", `// ${hostileArg} ${privateArg}\nprocess.exit(4);`],
    }],
    out: { log: (s) => logs.push(s), error: (s) => errors.push(s) },
  });
  assertEquals(code, 4);
  const output = [...logs, ...errors].join("\n");
  assertStringIncludes(output, "▶ argv lane (node)");
  for (
    const leaked of [hostileArg, privateArg, process.execPath, "process.exit"]
  ) {
    if (output.includes(leaked)) {
      throw new Error("lane argv or command path reached gate output");
    }
  }
});

test("an unavailable hostile command stays out of output and cannot pass", async () => {
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

test("the gate emits a bounded machine-readable status line", async () => {
  const logs: string[] = [];
  const code = await runGate({
    lanes: [
      {
        label: "passing lane",
        checkId: "demo.pass",
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
      },
      {
        label: "failing lane",
        checkId: "demo.fail",
        command: process.execPath,
        args: ["-e", "process.exit(3)"],
      },
      {
        label: "lane after the failure",
        checkId: "demo.after",
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
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
    { id: "demo.after", result: "pass" },
    { id: "demo.fail", result: "fail" },
    { id: "demo.pass", result: "pass" },
  ]);
});

// Tripwires for the close-out of decision D32: the gate and its test runners
// run on Node alone. No lane starts deno, and no lane or runner hands a child
// a DENO_ variable.
const RETIRED_RUNTIME = /(^|\/)deno$/i;
const RETIRED_RUNTIME_VARIABLE = /^DENO_/i;

test("no gate lane starts deno or forwards a DENO_ variable", () => {
  const offenders: string[] = [];
  for (const lane of productionLanes(process.cwd())) {
    const words = [lane.command, lane.commandLabel ?? "", ...lane.args];
    if (words.some((word) => RETIRED_RUNTIME.test(word))) {
      offenders.push(`${lane.label} starts deno`);
    }
    for (const name of Object.keys(lane.env ?? {})) {
      if (RETIRED_RUNTIME_VARIABLE.test(name)) {
        offenders.push(`${lane.label} forwards ${name}`);
      }
    }
  }
  for (const name of INHERITED_ENVIRONMENT_NAMES) {
    if (RETIRED_RUNTIME_VARIABLE.test(name)) {
      offenders.push(`every lane inherits ${name}`);
    }
  }
  assertEquals(offenders, []);
});

test("no test runner forwards a DENO_ variable", async () => {
  const everyName = (name: string) => `/set/${name}`;
  const lists: Record<string, unknown> = {
    "integration child environment": Object.keys(
      integrationChildEnvironment({}, everyName),
    ),
    "unit runner": (await import("../prototype/scripts/run-unit-tests.ts"))
      .UNIT_LANE_ENVIRONMENT_NAMES,
    "node test-file runner": (await import("./run-node-test-files.ts"))
      .FORWARDED_ENVIRONMENT_NAMES,
  };
  for (const [runner, names] of Object.entries(lists)) {
    if (!Array.isArray(names)) {
      throw new Error(`${runner} does not export its forwarded names`);
    }
    const forwarded = names.filter((name) =>
      RETIRED_RUNTIME_VARIABLE.test(String(name))
    );
    assertEquals([runner, forwarded], [runner, []]);
  }
});

test("node --test parallelism does not read DENO_JOBS", () => {
  const saved = process.env.DENO_JOBS;
  process.env.DENO_JOBS = "1";
  try {
    assertEquals(parallelJobs(), availableParallelism());
  } finally {
    if (saved === undefined) delete process.env.DENO_JOBS;
    else process.env.DENO_JOBS = saved;
  }
});
