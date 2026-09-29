// Runs the real `deno info` parser, so it spawns Deno and belongs to the
// integration tier. Fixtures are `data:` modules: nothing is written to disk.
import { assertEquals, assertThrows } from "@std/assert";
import {
  denoInfo,
  discoverDenoTestSources,
  discoverUnitTests,
  vitestModulesFromDenoInfo,
} from "./test-files.ts";

function fixture(source: string): string {
  return `data:application/typescript,${encodeURIComponent(source)}`;
}

function vitestFixtures(sources: readonly string[]): boolean[] {
  const urls = sources.map(fixture);
  const vitest = vitestModulesFromDenoInfo(denoInfo(urls), urls);
  return urls.map((url) => vitest.has(url));
}

Deno.test("deno info classifies every Vitest import shape", () => {
  const sources = [
    'import { describe, expect, test } from "vitest";',
    "import { vi } from 'vitest';",
    'import { defineConfig } from "vitest/config";',
    'import { test } from "npm:vitest@3.2.6";',
    'import type { Mock } from "vitest";',
    'import {\n  describe,\n  test,\n} from "vitest";',
    'import "vitest";',
    'export { test } from "vitest";',
    // After other imports, including import attribute clauses.
    'import data from "./data.json" with { type: "json" }\nimport { test } from "vitest";',
    'import data from "./data.json" with { /* } */ type: "json" };\nimport { test } from "vitest";',
    // After code: static imports are hoisted wherever they appear.
    'Deno.test("x", () => {});\nimport { test } from "vitest";',
  ];
  assertEquals(vitestFixtures(sources), sources.map(() => true));
});

Deno.test("deno info classifies a test that reaches vitest through a helper", () => {
  const helper = fixture('export { expect, test } from "vitest";');
  const plain = fixture("export const value = 1;");
  assertEquals(
    vitestFixtures([
      `import { test } from ${JSON.stringify(helper)};`,
      `import { value } from ${JSON.stringify(plain)};`,
      `const { test } = await import(${JSON.stringify(helper)});`,
    ]),
    [true, false, false],
  );
});

Deno.test("deno info ignores import-shaped text that is not an import", () => {
  const sources = [
    'import { assertEquals } from "@std/assert";',
    'const label = "vitest";',
    "const fixture = 'import { test } from \"vitest\";';",
    'const fixture = `\nimport { test } from "vitest";\n`;',
    '// import { test } from "vitest";\nDeno.test("x", () => {});',
    '/*\nimport { test } from "vitest";\n*/\nDeno.test("x", () => {});',
    'const { test } = await import("vitest");',
  ];
  assertEquals(vitestFixtures(sources), sources.map(() => false));
});

Deno.test("a test file that does not parse fails classification", () => {
  const url = fixture("import { from;");
  assertThrows(
    () => vitestModulesFromDenoInfo(denoInfo([url]), [url]),
    Error,
    "cannot classify",
  );
});

Deno.test("the prototype tree classifies as expected", () => {
  const unit = discoverUnitTests(".");
  const denoTests = discoverDenoTestSources(".");
  // Deno.test unit files run in test.unit; Vitest files never do.
  assertEquals(unit.includes("testing/fakes/map-env.test.ts"), true);
  assertEquals(unit.includes("scripts/run-vitest.test.ts"), false);
  // Golden and integration Deno.test files stay out of the unit lane but
  // are still excluded from Vitest.
  assertEquals(unit.some((path) => path.startsWith("testing/golden/")), false);
  assertEquals(denoTests.includes("testing/golden/golden.test.ts"), true);
  assertEquals(
    denoTests.includes("scripts/test-files.integration.test.ts"),
    true,
  );
  assertEquals(denoTests.includes("scripts/run-vitest.test.ts"), false);
});
