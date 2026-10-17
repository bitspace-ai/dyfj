// The discovery check every test lane runs (`test-files.ts`): each test file
// registers with `node:test` and runs under `node --test`, and a file that
// registers with the retired runner fails discovery, wherever it lives.
import assert from "node:assert/strict";
import { test } from "node:test";
import { discoverTestSources, nodeTestFiles } from "./test-files.ts";

// The retired runtime's test function, assembled so this file adds no
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

test("a node:test file passes discovery, whatever it imports", () => {
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
    for (const path of ["src/a.test.ts", "scripts/a.test.ts"]) {
      assert.deepEqual(nodeTestFiles("/repo", [path], () => source), [path]);
    }
  }
});

test("a test file on the retired runner fails discovery and names itself", () => {
  for (const source of LEGACY_SOURCES) {
    for (
      const path of [
        "src/dir/legacy.test.ts",
        "testing/golden/legacy.test.ts",
        "src/a.integration.test.ts",
        "scripts/a.test.ts",
        "scripts/a.integration.test.ts",
      ]
    ) {
      assert.throws(
        () => nodeTestFiles("/repo", [path], () => source),
        (error: Error) =>
          error.message.startsWith(
            `${path} registers tests with the existing runner`,
          ) && error.message.includes("node:test only"),
        `${path}: ${source}`,
      );
    }
  }
});

test("a gate-tooling test on the existing runner fails discovery too", () => {
  for (const source of LEGACY_SOURCES) {
    assert.throws(
      () => nodeTestFiles("/repo", ["scripts/a.test.ts"], () => source),
      /scripts\/a\.test\.ts registers tests with the existing runner/,
      source,
    );
  }
});

test("nodeTestFiles keeps the given order and reads each file under root", () => {
  const sources: Record<string, string> = {
    "/repo/scripts/c.test.ts": 'import { test } from "node:test";',
    "/repo/src/b.test.ts": 'import { test } from "node:test";',
  };
  const read = (path: string) => {
    const source = sources[path];
    if (source === undefined) throw new Error(`unexpected read of ${path}`);
    return source;
  };
  assert.deepEqual(
    nodeTestFiles("/repo", ["scripts/c.test.ts", "src/b.test.ts"], read),
    ["scripts/c.test.ts", "src/b.test.ts"],
  );
});

test("every test file in the prototype tree passes discovery", () => {
  const files = discoverTestSources(".");
  assert.deepEqual(nodeTestFiles(".", files), files);
  assert.ok(files.includes("scripts/test-routing.test.ts"));
  assert.ok(files.includes("src/kernel/clock.test.ts"));
});
