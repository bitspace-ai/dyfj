import { assertEquals, assertThrows } from "@std/assert";
import {
  discoverDenoTestSources,
  discoverTestSources,
  discoverTypecheckSources,
  discoverUnitTests,
  importsVitest,
  isTypecheckSource,
  isUnitTest,
  leadingImportSpecifiers,
} from "./test-files.ts";
import { parseTypecheckScope } from "./typecheck.ts";
import { unitTestArgs } from "./run-unit-tests.ts";

Deno.test("importsVitest recognises every import shape in use", () => {
  for (
    const source of [
      'import { describe, expect, test } from "vitest";',
      "import { vi } from 'vitest';",
      'import { defineConfig } from "vitest/config";',
      'import { test } from "npm:vitest@3.2.6";',
      'import type { Mock } from "vitest";',
      'import {\n  describe,\n  test,\n} from "vitest";',
      'import "vitest";',
    ]
  ) {
    assertEquals(importsVitest(source), true, source);
  }
  for (
    const source of [
      'import { assertEquals } from "@std/assert";',
      "// vitest is retired at phase-1 exit",
      'const label = "vitest";',
      // Import text inside a string literal is data, not an import.
      "const fixture = 'import { test } from \"vitest\";';",
      "  'import { test } from \"vitest\";',",
      // Nor inside a multi-line template literal after the import block.
      'import { assert } from "@std/assert";\n' +
      'const fixture = `\nimport { test } from "vitest";\n`;',
      // Nor in a comment, a dynamic import, or after the first statement.
      '// import { test } from "vitest";\nDeno.test("x", () => {});',
      '/*\nimport { test } from "vitest";\n*/\nDeno.test("x", () => {});',
      'const { test } = await import("vitest");',
      'Deno.test("x", () => {});\nimport { test } from "vitest";',
    ]
  ) {
    assertEquals(importsVitest(source), false, source);
  }
});

Deno.test("leadingImportSpecifiers reads only the leading import block", () => {
  const source = [
    "#!/usr/bin/env -S deno run",
    "/**",
    ' * import { nope } from "doc-comment";',
    " */",
    "// a line comment",
    'import { a, type B } from "./a.ts";',
    "import {",
    "  c,",
    '} from "npm:c@1";',
    'import "./side-effect.ts";',
    'import data from "./data.json" with { type: "json" };',
    'export * from "./re-export.ts";',
    'export { d } from "./d.ts"',
    'import e from "./e.ts"',
    "",
    "const x = 1;",
    'import { late } from "./late.ts";',
  ].join("\n");
  assertEquals(leadingImportSpecifiers(source), [
    "./a.ts",
    "npm:c@1",
    "./side-effect.ts",
    "./data.json",
    "./re-export.ts",
    "./d.ts",
    "./e.ts",
  ]);
  assertEquals(leadingImportSpecifiers("export const x = 1;"), []);
  assertEquals(leadingImportSpecifiers(""), []);
});

Deno.test("isUnitTest keeps integration, golden and Vitest files out", () => {
  const deno = 'import { assertEquals } from "@std/assert";';
  const vitest = 'import { test } from "vitest";';
  assertEquals(isUnitTest("src/a.test.ts", deno), true);
  assertEquals(isUnitTest("src/a.component.test.ts", deno), true);
  assertEquals(isUnitTest("testing/fakes/a.test.ts", deno), true);
  assertEquals(isUnitTest("src/a.test.ts", vitest), false);
  assertEquals(isUnitTest("src/a.integration.test.ts", deno), false);
  assertEquals(isUnitTest("testing/golden/scenarios.test.ts", deno), false);
  assertEquals(isUnitTest("src/a.ts", deno), false);
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
    const files: Record<string, string> = {
      "src/cli.ts": "",
      "src/nested/deep.ts": "",
      "src/cli.test.ts": 'import { test } from "vitest";',
      "src/clock.test.ts": 'import { assert } from "@std/assert";',
      "src/memory.integration.test.ts": 'import { test } from "vitest";',
      "src/node_modules/pkg/index.ts": "",
      "mcp/server.ts": "",
      "scripts/tool.ts": "",
      "testing/fakes/map-env.ts": "",
      "testing/fakes/map-env.test.ts": "Deno.test('x', () => {});",
      "testing/golden/run.test.ts": "Deno.test('x', () => {});",
      "examples/outside.ts": "",
      "vitest.config.ts": "",
    };
    for (const [path, text] of Object.entries(files)) {
      const directory = path.slice(0, path.lastIndexOf("/"));
      await Deno.mkdir(`${root}/${directory}`, { recursive: true });
      await Deno.writeTextFile(`${root}/${path}`, text);
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
      "src/clock.test.ts",
      "src/memory.integration.test.ts",
      "testing/fakes/map-env.test.ts",
      "testing/golden/run.test.ts",
    ]);
    assertEquals(discoverUnitTests(root), [
      "src/clock.test.ts",
      "testing/fakes/map-env.test.ts",
    ]);
    assertEquals(discoverDenoTestSources(root), [
      "src/clock.test.ts",
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
