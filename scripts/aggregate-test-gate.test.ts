import { testSourcesFromPaths } from "../prototype/scripts/check-test-files.ts";
import { assertIntegrationTestAssignments } from "../prototype/scripts/integration-test-assignment.ts";
import { integrationChildEnvironment } from "../prototype/scripts/integration-child-environment.ts";
import { DENO_EXECUTABLE_DIAGNOSTIC } from "../prototype/scripts/deno-executable.ts";
import {
  type GateLane,
  productionLanes,
  runGate,
} from "./aggregate-test-gate.ts";
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
  const timeout = new Promise<never>((_, reject) =>
    timeoutId = setTimeout(
      () => reject(new Error("interrupted lane did not stop")),
      1_000,
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
