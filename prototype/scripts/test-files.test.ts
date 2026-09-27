import { assertEquals, assertThrows } from "@std/assert";
import {
  type DenoInfoOutput,
  discoverTestSources,
  discoverTypecheckSources,
  isTypecheckSource,
  isUnitTest,
  isVitestSpecifier,
  rootModule,
  vitestModulesFromDenoInfo,
} from "./test-files.ts";
import { parseTypecheckScope } from "./typecheck.ts";
import { unitTestArgs } from "./run-unit-tests.ts";

// These tests run in the unit lane, which may not spawn processes, so they
// exercise classification over recorded `deno info --json` output. The real
// parser is exercised in `test-files.integration.test.ts`.

Deno.test("isVitestSpecifier matches bare, npm: and subpath specifiers", () => {
  for (
    const specifier of [
      "vitest",
      "vitest/config",
      "npm:vitest",
      "npm:vitest@3.2.6",
      "npm:vitest@3.2.6/config",
    ]
  ) {
    assertEquals(isVitestSpecifier(specifier), true, specifier);
  }
  for (
    const specifier of [
      "@std/assert",
      "vitest-extra",
      "./vitest.ts",
      "npm:vite",
    ]
  ) {
    assertEquals(isVitestSpecifier(specifier), false, specifier);
  }
});

Deno.test("vitestModulesFromDenoInfo reads static imports only", () => {
  const info: DenoInfoOutput = {
    modules: [
      {
        specifier: "file:///p/a.test.ts",
        dependencies: [{ specifier: "vitest" }, { specifier: "./cli.ts" }],
      },
      {
        specifier: "file:///p/b.test.ts",
        dependencies: [{ specifier: "@std/assert" }],
      },
      {
        specifier: "file:///p/c.test.ts",
        dependencies: [{ specifier: "vitest", isDynamic: true }],
      },
      {
        specifier: "file:///p/d.test.ts",
        dependencies: [{ specifier: "npm:vitest@3.2.6/config" }],
      },
      { specifier: "file:///p/e.test.ts" },
    ],
  };
  const urls = ["a", "b", "c", "d", "e"].map((n) => `file:///p/${n}.test.ts`);
  assertEquals(
    [...vitestModulesFromDenoInfo(info, urls)].sort(),
    ["file:///p/a.test.ts", "file:///p/d.test.ts"],
  );
});

Deno.test("vitestModulesFromDenoInfo follows static imports through helpers", () => {
  const dep = (target: string, isDynamic?: boolean) => ({
    specifier: `./${target}`,
    code: { specifier: `file:///p/${target}` },
    isDynamic,
  });
  const info: DenoInfoOutput = {
    modules: [
      // a.test -> helper -> vitest
      { specifier: "file:///p/a.test.ts", dependencies: [dep("helper.ts")] },
      {
        specifier: "file:///p/helper.ts",
        dependencies: [{ specifier: "vitest" }],
      },
      // b.test -> x <-> y (cycle), y -> vitest
      { specifier: "file:///p/b.test.ts", dependencies: [dep("x.ts")] },
      { specifier: "file:///p/x.ts", dependencies: [dep("y.ts")] },
      {
        specifier: "file:///p/y.ts",
        dependencies: [dep("x.ts"), { specifier: "vitest" }],
      },
      // c.test reaches the helper only through a dynamic import
      {
        specifier: "file:///p/c.test.ts",
        dependencies: [dep("helper.ts", true)],
      },
      // d.test -> plain module
      { specifier: "file:///p/d.test.ts", dependencies: [dep("plain.ts")] },
      { specifier: "file:///p/plain.ts" },
    ],
  };
  const urls = ["a", "b", "c", "d"].map((n) => `file:///p/${n}.test.ts`);
  assertEquals(
    [...vitestModulesFromDenoInfo(info, urls)].sort(),
    ["file:///p/a.test.ts", "file:///p/b.test.ts"],
  );
});

Deno.test("vitestModulesFromDenoInfo fails closed on a missing or broken module", () => {
  const info: DenoInfoOutput = {
    modules: [{ specifier: "file:///p/broken.test.ts", error: "parse error" }],
  };
  assertThrows(
    () => vitestModulesFromDenoInfo(info, ["file:///p/broken.test.ts"]),
    Error,
    "cannot classify",
  );
  assertThrows(
    () => vitestModulesFromDenoInfo(info, ["file:///p/absent.test.ts"]),
    Error,
    "not in graph",
  );
});

Deno.test("rootModule imports each URL once, in order", () => {
  const urls = ["file:///p/a b.test.ts", "file:///p/c.test.ts"];
  const url = rootModule(urls);
  const prefix = "data:application/typescript,";
  assertEquals(url.startsWith(prefix), true);
  assertEquals(
    decodeURIComponent(url.slice(prefix.length)),
    'import "file:///p/a b.test.ts";\nimport "file:///p/c.test.ts";\n',
  );
});

Deno.test("isUnitTest keeps integration, golden and Vitest files out", () => {
  assertEquals(isUnitTest("src/a.test.ts", false), true);
  assertEquals(isUnitTest("src/a.component.test.ts", false), true);
  assertEquals(isUnitTest("testing/fakes/a.test.ts", false), true);
  assertEquals(isUnitTest("src/a.test.ts", true), false);
  assertEquals(isUnitTest("src/a.integration.test.ts", false), false);
  assertEquals(isUnitTest("testing/golden/scenarios.test.ts", false), false);
  assertEquals(isUnitTest("src/a.ts", false), false);
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
        "vitest.config.ts",
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
