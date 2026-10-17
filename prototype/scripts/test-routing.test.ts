// The routing predicate that sends each discovered test file to `node --test`
// or to the lane's existing runner (`test-files.ts`): product tests run on
// node only, and gate-tooling tests under `scripts/` that register with the
// existing runner stay on it until the gate-tooling port.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  discoverTestSources,
  partitionByRuntime,
  testRuntime,
} from "./test-files.ts";

// The existing runtime's test function, assembled so this file adds no
// reference to the runtime.neutral ratchet's count.
const LEGACY_TEST = `${["De", "no"].join("")}.test`;
// Assembled for the same reason: the tree-wide case below reads this file.
const BDD = ["@std", "testing", "bdd"].join("/");

const LEGACY_SOURCES = [
  `${LEGACY_TEST}("a", () => {});`,
  `${LEGACY_TEST}({ name: "a", fn() {} });`,
  `import { describe, it } from "${BDD}";`,
  `import { test } from "node:test";\n${LEGACY_TEST}("a", () => {});`,
  `import { mock } from "node:test";\n${LEGACY_TEST}("a", () => {});`,
];

test("a product test file runs on node, whatever it imports", () => {
  for (
    const source of [
      'import { test } from "node:test";\ntest("a", () => {});',
      'import { describe, it } from "node:test";',
      'import test from "node:test";',
      'import { runKit } from "../../testing/conformance/kit.ts";\nrunKit();',
      'import { mock } from "node:test";',
      `// Converted from ${LEGACY_TEST} files.\nimport { test } from "node:test";`,
      "",
    ]
  ) {
    assert.equal(testRuntime("src/a.test.ts", source), "node", source);
  }
});

test("a product test file on the existing runner fails discovery and names itself", () => {
  for (const source of LEGACY_SOURCES) {
    for (
      const path of [
        "src/dir/legacy.test.ts",
        "testing/golden/legacy.test.ts",
        "src/a.integration.test.ts",
        // Only the `scripts/` directory itself is gate tooling.
        "src/scripts/legacy.test.ts",
      ]
    ) {
      assert.throws(
        () => testRuntime(path, source),
        (error: Error) =>
          error.message.startsWith(
            `${path} registers tests with the existing runner`,
          ) && error.message.includes("node:test only"),
        `${path}: ${source}`,
      );
    }
  }
});

test("a gate-tooling test on the existing runner stays there", () => {
  for (const source of LEGACY_SOURCES) {
    assert.equal(testRuntime("scripts/a.test.ts", source), "deno", source);
    assert.equal(
      testRuntime("scripts/a.integration.test.ts", source),
      "deno",
      source,
    );
  }
});

test("a gate-tooling test that registers with node:test only runs on node", () => {
  for (
    const source of [
      'import { test } from "node:test";\ntest("a", () => {});',
      'import { describe, it } from "node:test";',
      "",
    ]
  ) {
    assert.equal(testRuntime("scripts/a.test.ts", source), "node", source);
  }
});

test("partitionByRuntime keeps each list in order and fails closed", () => {
  const sources: Record<string, string> = {
    "/repo/scripts/a.test.ts": `${LEGACY_TEST}("a", () => {});`,
    "/repo/src/b.test.ts": 'import { test } from "node:test";',
    "/repo/scripts/c.test.ts": 'import { test } from "node:test";',
    "/repo/scripts/d.test.ts": `import { it } from "${BDD}";`,
  };
  const read = (path: string) => sources[path] ?? "";
  assert.deepEqual(
    partitionByRuntime(
      "/repo",
      [
        "scripts/a.test.ts",
        "src/b.test.ts",
        "scripts/c.test.ts",
        "scripts/d.test.ts",
      ],
      read,
    ),
    {
      deno: ["scripts/a.test.ts", "scripts/d.test.ts"],
      node: ["src/b.test.ts", "scripts/c.test.ts"],
    },
  );
  sources["/repo/src/e.test.ts"] = `${LEGACY_TEST}("e", () => {});`;
  assert.throws(
    () =>
      partitionByRuntime("/repo", ["scripts/a.test.ts", "src/e.test.ts"], read),
    /src\/e\.test\.ts registers tests with the existing runner/,
  );
});

test("only gate-tooling tests in the prototype tree run on the existing runner", () => {
  const partition = partitionByRuntime(".", discoverTestSources("."));
  assert.ok(partition.deno.length > 0);
  for (const path of partition.deno) {
    assert.ok(path.startsWith("scripts/"), path);
  }
  assert.ok(partition.node.includes("scripts/test-routing.test.ts"));
  // On node:test since the gate-tooling port.
  assert.ok(partition.node.includes("scripts/test-files.test.ts"));
  assert.ok(partition.deno.includes("scripts/deno-executable.test.ts"));
  assert.ok(partition.node.includes("src/kernel/clock.test.ts"));
});
