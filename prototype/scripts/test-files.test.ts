import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  discoverIntegrationTests,
  discoverTestSources,
  discoverUnitTests,
  isIntegrationLaneTest,
  isUnitTest,
} from "./test-files.ts";
import { parseTestFileArgs, TEST_FILE_USAGE } from "./run-unit-tests.ts";

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

test("test:file takes test paths and one optional --filter", () => {
  assert.deepStrictEqual(parseTestFileArgs(["src/a.test.ts"]), {
    files: ["src/a.test.ts"],
  });
  assert.deepStrictEqual(
    parseTestFileArgs(["src/a.test.ts", "--filter", "x y", "src/b.test.ts"]),
    { files: ["src/a.test.ts", "src/b.test.ts"], filter: "x y" },
  );
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
