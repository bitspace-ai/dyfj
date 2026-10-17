import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  discoverIntegrationTests,
  discoverTestSources,
  discoverTypecheckSources,
  discoverUnitTests,
  isIntegrationLaneTest,
  isTypecheckSource,
  isUnitTest,
} from "./test-files.ts";
import { parseTypecheckScope } from "./typecheck.ts";
import {
  parseTestFileArgs,
  TEST_FILE_USAGE,
  unitTestArgs,
} from "./run-unit-tests.ts";

test("isUnitTest keeps integration and golden files out", () => {
  assert.deepStrictEqual(isUnitTest("src/a.test.ts"), true);
  assert.deepStrictEqual(isUnitTest("src/a.component.test.ts"), true);
  assert.deepStrictEqual(isUnitTest("testing/fakes/a.test.ts"), true);
  assert.deepStrictEqual(isUnitTest("src/a.integration.test.ts"), false);
  assert.deepStrictEqual(isUnitTest("testing/golden/scenarios.test.ts"), false);
  assert.deepStrictEqual(isUnitTest("src/a.ts"), false);
});

test("isIntegrationLaneTest takes integration files outside the golden suite", () => {
  assert.deepStrictEqual(isIntegrationLaneTest("src/a.integration.test.ts"), true);
  assert.deepStrictEqual(isIntegrationLaneTest("scripts/a.integration.test.ts"), true);
  assert.deepStrictEqual(isIntegrationLaneTest("src/a.test.ts"), false);
  assert.deepStrictEqual(
    isIntegrationLaneTest("testing/golden/a.integration.test.ts"),
    false,
  );
  assert.deepStrictEqual(isIntegrationLaneTest("src/a.integration.ts"), false);
});

test("the prototype tree splits into unit and integration lanes", () => {
  const unit = discoverUnitTests(".");
  const integration = discoverIntegrationTests(".");
  assert.deepStrictEqual(unit.includes("testing/fakes/map-env.test.ts"), true);
  assert.deepStrictEqual(unit.some((path) => path.startsWith("testing/golden/")), false);
  assert.deepStrictEqual(unit.some((path) => integration.includes(path)), false);
  assert.deepStrictEqual(
    integration.includes("scripts/isolated-dolt-fixture.integration.test.ts"),
    true,
  );
  assert.deepStrictEqual(
    integration.some((path) => path.startsWith("testing/golden/")),
    false,
  );
});

test("isTypecheckSource takes modules, not tests or declarations", () => {
  assert.deepStrictEqual(isTypecheckSource("src/cli.ts"), true);
  assert.deepStrictEqual(isTypecheckSource("testing/fakes/map-env.ts"), true);
  assert.deepStrictEqual(isTypecheckSource("src/cli.test.ts"), false);
  assert.deepStrictEqual(isTypecheckSource("src/a.integration.test.ts"), false);
  assert.deepStrictEqual(isTypecheckSource("src/types.d.ts"), false);
  assert.deepStrictEqual(isTypecheckSource("scripts/dyfj-launcher.sh"), false);
});

test("discovery walks every source root and nothing else", async () => {
  const root = await mkdtemp(join(tmpdir(), "dyfj-test-files-"));
  try {
    for (
      const path of [
        "src/cli.ts",
        "src/nested/deep.ts",
        "src/cli.test.ts",
        "src/memory.integration.test.ts",
        "src/node_modules/pkg/index.ts",
        "mcp/server.ts",
        "scripts/tool.ts",
        "testing/fakes/map-env.ts",
        "testing/fakes/map-env.test.ts",
        "testing/golden/run.test.ts",
        "diagnostics/workbench-events.ts",
        "diagnostics/workbench-events.test.ts",
        "examples/example.ts",
        "root-config.ts",
      ]
    ) {
      const directory = path.slice(0, path.lastIndexOf("/"));
      if (directory) {
        await mkdir(`${root}/${directory}`, { recursive: true });
      }
      await writeFile(`${root}/${path}`, "");
    }
    assert.deepStrictEqual(discoverTypecheckSources(root), [
      "diagnostics/workbench-events.ts",
      "examples/example.ts",
      "mcp/server.ts",
      "scripts/tool.ts",
      "src/cli.ts",
      "src/nested/deep.ts",
      "testing/fakes/map-env.ts",
    ]);
    assert.deepStrictEqual(discoverTestSources(root), [
      "diagnostics/workbench-events.test.ts",
      "src/cli.test.ts",
      "src/memory.integration.test.ts",
      "testing/fakes/map-env.test.ts",
      "testing/golden/run.test.ts",
    ]);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("parseTypecheckScope accepts exactly one known scope", () => {
  assert.deepStrictEqual(parseTypecheckScope(["sources"]), "sources");
  assert.deepStrictEqual(parseTypecheckScope(["tests"]), "tests");
  assert.throws(() => parseTypecheckScope([]));
  assert.throws(() => parseTypecheckScope(["all"]));
  assert.throws(() => parseTypecheckScope(["sources", "tests"]));
});

test("the unit lane's gate-tooling subset runs in parallel, sanitized, with no run or net grant and env only for the temp directory", () => {
  const args = unitTestArgs(["testing/fakes/map-env.test.ts"]);
  assert.deepStrictEqual(args.slice(0, 2), ["test", "--parallel"]);
  assert.deepStrictEqual(args.at(-1), "testing/fakes/map-env.test.ts");
  for (const banned of ["--allow-run", "--allow-net", "-A"]) {
    assert.deepStrictEqual(
      args.some((argument) => argument.startsWith(banned)),
      false,
      banned,
    );
  }
  // node:os tmpdir() reads TMPDIR, then TMP and TEMP when it is unset; no
  // other variable is granted.
  assert.deepStrictEqual(
    args.filter((argument) => argument.startsWith("--allow-env")),
    ["--allow-env=TMPDIR,TMP,TEMP"],
  );
  // The pinned Deno makes the op and resource sanitizers opt-in; the lane
  // opts in.
  assert.deepStrictEqual(args.includes("--sanitize-ops"), true);
  assert.deepStrictEqual(args.includes("--sanitize-resources"), true);
});

test("test:file takes test paths and one optional --filter", () => {
  assert.deepStrictEqual(parseTestFileArgs(["src/a.test.ts"]), {
    files: ["src/a.test.ts"],
  });
  assert.deepStrictEqual(
    parseTestFileArgs(["src/a.test.ts", "--filter", "x y", "src/b.test.ts"]),
    { files: ["src/a.test.ts", "src/b.test.ts"], filter: "x y" },
  );
  const args = unitTestArgs(["src/a.test.ts"], "x y");
  assert.deepStrictEqual(args.slice(-3), ["--filter", "x y", "src/a.test.ts"]);
  assert.deepStrictEqual(args.includes("--sanitize-ops"), true);
});

test("test:file rejects anything but test paths and one --filter", () => {
  for (
    const args of [
      [],
      ["--filter", "x"],
      ["src/a.test.ts", "--filter"],
      ["src/a.test.ts", "--filter", "x", "--filter", "y"],
      ["src/a.test.ts", "--no-check"],
      ["src/a.test.ts", "--sanitize-ops=false"],
      ["src/a.test.ts", "-A"],
      ["src/a.ts"],
    ]
  ) {
    assert.throws(() => parseTestFileArgs(args), (error: unknown) => error instanceof Error && error.message.includes(TEST_FILE_USAGE));
  }
});
