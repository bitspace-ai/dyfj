import { assertEquals, assertThrows } from "@std/assert";
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
import { unitTestArgs } from "./run-unit-tests.ts";

Deno.test("isUnitTest keeps integration and golden files out", () => {
  assertEquals(isUnitTest("src/a.test.ts"), true);
  assertEquals(isUnitTest("src/a.component.test.ts"), true);
  assertEquals(isUnitTest("testing/fakes/a.test.ts"), true);
  assertEquals(isUnitTest("src/a.integration.test.ts"), false);
  assertEquals(isUnitTest("testing/golden/scenarios.test.ts"), false);
  assertEquals(isUnitTest("src/a.ts"), false);
});

Deno.test("isIntegrationLaneTest takes integration files outside the golden suite", () => {
  assertEquals(isIntegrationLaneTest("src/a.integration.test.ts"), true);
  assertEquals(isIntegrationLaneTest("scripts/a.integration.test.ts"), true);
  assertEquals(isIntegrationLaneTest("src/a.test.ts"), false);
  assertEquals(
    isIntegrationLaneTest("testing/golden/a.integration.test.ts"),
    false,
  );
  assertEquals(isIntegrationLaneTest("src/a.integration.ts"), false);
});

Deno.test("the prototype tree splits into unit and integration lanes", () => {
  const unit = discoverUnitTests(".");
  const integration = discoverIntegrationTests(".");
  assertEquals(unit.includes("testing/fakes/map-env.test.ts"), true);
  assertEquals(unit.some((path) => path.startsWith("testing/golden/")), false);
  assertEquals(unit.some((path) => integration.includes(path)), false);
  assertEquals(
    integration.includes("scripts/isolated-dolt-fixture.integration.test.ts"),
    true,
  );
  assertEquals(
    integration.some((path) => path.startsWith("testing/golden/")),
    false,
  );
});

Deno.test("isTypecheckSource takes modules, not tests or declarations", () => {
  assertEquals(isTypecheckSource("src/cli.ts"), true);
  assertEquals(isTypecheckSource("testing/fakes/map-env.ts"), true);
  assertEquals(isTypecheckSource("src/cli.test.ts"), false);
  assertEquals(isTypecheckSource("src/a.integration.test.ts"), false);
  assertEquals(isTypecheckSource("src/types.d.ts"), false);
  assertEquals(isTypecheckSource("scripts/dyfj-launcher.sh"), false);
});

Deno.test("discovery walks every source root and nothing else", async () => {
  const root = await Deno.makeTempDir({ prefix: "dyfj-test-files-" });
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
        "examples/outside.ts",
        "root-config.ts",
      ]
    ) {
      const directory = path.slice(0, path.lastIndexOf("/"));
      if (directory) {
        await Deno.mkdir(`${root}/${directory}`, { recursive: true });
      }
      await Deno.writeTextFile(`${root}/${path}`, "");
    }
    assertEquals(discoverTypecheckSources(root), [
      "mcp/server.ts",
      "scripts/tool.ts",
      "src/cli.ts",
      "src/nested/deep.ts",
      "testing/fakes/map-env.ts",
    ]);
    assertEquals(discoverTestSources(root), [
      "src/cli.test.ts",
      "src/memory.integration.test.ts",
      "testing/fakes/map-env.test.ts",
      "testing/golden/run.test.ts",
    ]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("parseTypecheckScope accepts exactly one known scope", () => {
  assertEquals(parseTypecheckScope(["sources"]), "sources");
  assertEquals(parseTypecheckScope(["tests"]), "tests");
  assertThrows(() => parseTypecheckScope([]));
  assertThrows(() => parseTypecheckScope(["all"]));
  assertThrows(() => parseTypecheckScope(["sources", "tests"]));
});

Deno.test("the unit lane runs in parallel, sanitized, with no run, net or env grant", () => {
  const args = unitTestArgs(["testing/fakes/map-env.test.ts"]);
  assertEquals(args.slice(0, 2), ["test", "--parallel"]);
  assertEquals(args.at(-1), "testing/fakes/map-env.test.ts");
  for (const banned of ["--allow-run", "--allow-net", "--allow-env", "-A"]) {
    assertEquals(
      args.some((argument) => argument.startsWith(banned)),
      false,
      banned,
    );
  }
  // The pinned Deno makes the op and resource sanitizers opt-in; the lane
  // opts in.
  assertEquals(args.includes("--sanitize-ops"), true);
  assertEquals(args.includes("--sanitize-resources"), true);
});
