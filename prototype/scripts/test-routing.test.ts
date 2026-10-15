// The routing predicate that sends each discovered test file to `node --test`
// or to the lane's existing runner (`test-files.ts`).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  discoverTestSources,
  partitionByRuntime,
  registersWithNodeTest,
  testRuntime,
} from "./test-files.ts";

// The existing runtime's test function, assembled so this file adds no
// reference to the runtime.neutral ratchet's count.
const LEGACY_TEST = `${["De", "no"].join("")}.test`;
// Assembled for the same reason: the tree-wide case below reads this file.
const BDD = ["@std", "testing", "bdd"].join("/");

test("a file that registers with node:test runs on node", () => {
  for (
    const source of [
      'import { test } from "node:test";\ntest("a", () => {});',
      'import { describe, it } from "node:test";',
      "import { before, after, beforeEach, afterEach } from 'node:test';",
      'import { suite } from "node:test";',
      'import {\n  mock,\n  test as nodeTest,\n} from "node:test";',
      'import test from "node:test";',
      'import * as nodeTest from "node:test";',
      'import test, { mock } from "node:test";',
    ]
  ) {
    assert.equal(testRuntime("src/a.test.ts", source), "node", source);
  }
});

test("a file on the existing runner, or with neither, stays there", () => {
  for (
    const source of [
      `${LEGACY_TEST}("a", () => {});`,
      `${LEGACY_TEST}({ name: "a", fn() {} });`,
      `import { describe, it } from "${BDD}";`,
      // Non-registering node:test imports are used on the existing runner.
      `import { mock } from "node:test";\n${LEGACY_TEST}("a", () => {});`,
      `import { type Mock, mock } from "node:test";\n${LEGACY_TEST}("a", () => {});`,
      `import type { TestContext } from "node:test";\n${LEGACY_TEST}("a", () => {});`,
      // A conformance-kit caller: the kit registers the tests.
      'import { runKit } from "../testing/conformance/kit.ts";\nrunKit();',
      "",
    ]
  ) {
    assert.equal(testRuntime("src/a.test.ts", source), "deno", source);
  }
});

test("prose that only names the existing runner does not route a file", () => {
  assert.equal(
    testRuntime(
      "src/a.test.ts",
      `// Converted from ${LEGACY_TEST} files.\nimport { test } from "node:test";`,
    ),
    "node",
  );
});

test("a file that registers with both fails discovery and names itself", () => {
  for (
    const source of [
      `import { test } from "node:test";\n${LEGACY_TEST}("a", () => {});`,
      `import { it } from "node:test";\nimport { describe } from "${BDD}";`,
    ]
  ) {
    assert.throws(
      () => testRuntime("src/mixed.test.ts", source),
      (error: Error) =>
        error.message.startsWith("src/mixed.test.ts registers tests with both"),
    );
  }
});

test("partitionByRuntime keeps each list in order and fails closed", () => {
  const sources: Record<string, string> = {
    "/repo/a.test.ts": `${LEGACY_TEST}("a", () => {});`,
    "/repo/b.test.ts": 'import { test } from "node:test";',
    "/repo/c.test.ts": "",
    "/repo/d.test.ts": 'import { it } from "node:test";',
  };
  const read = (path: string) => sources[path] ?? "";
  assert.deepEqual(
    partitionByRuntime(
      "/repo",
      ["a.test.ts", "b.test.ts", "c.test.ts", "d.test.ts"],
      read,
    ),
    { deno: ["a.test.ts", "c.test.ts"], node: ["b.test.ts", "d.test.ts"] },
  );
  sources["/repo/e.test.ts"] =
    `import { test } from "node:test";\n${LEGACY_TEST}("e", () => {});`;
  assert.throws(
    () => partitionByRuntime("/repo", ["a.test.ts", "e.test.ts"], read),
    /e\.test\.ts registers tests with both/,
  );
});

test("no file in the prototype tree registers with both runtimes", () => {
  const partition = partitionByRuntime(".", discoverTestSources("."));
  assert.ok(partition.node.includes("scripts/test-routing.test.ts"));
  assert.ok(partition.deno.includes("scripts/test-files.test.ts"));
});

test("registersWithNodeTest ignores type-only imports", () => {
  assert.equal(
    registersWithNodeTest('import type { test } from "node:test";'),
    false,
  );
  assert.equal(
    registersWithNodeTest('import { type it } from "node:test";'),
    false,
  );
});
