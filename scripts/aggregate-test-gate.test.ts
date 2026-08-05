import { testSourcesFromPaths } from "../prototype/scripts/check-test-files.ts";
import { assertIntegrationTestAssignments } from "../prototype/scripts/integration-test-assignment.ts";
import { integrationChildEnvironment } from "../prototype/scripts/integration-child-environment.ts";
import {
  type GateLane,
  productionLanes,
  runGate,
} from "./aggregate-test-gate.ts";

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

Deno.test("isolated Dolt lane passes custom Rust toolchain roots to children", () => {
  const lane = productionLanes("/repo").find((candidate) =>
    candidate.label === "Isolated Dolt integration lane"
  );
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
        command: "deno",
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
    { label: "ok lane", command: "deno", args: ["eval", "Deno.exit(0)"] },
    { label: "broken lane", command: "deno", args: ["eval", "Deno.exit(12)"] },
    {
      label: "must not run",
      command: "deno",
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
            command: "deno",
            args: [
              "eval",
              "await new Promise((resolve) => setTimeout(resolve, 5_000))",
            ],
          },
          {
            label: "must not run",
            command: "deno",
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
      command: "deno",
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
