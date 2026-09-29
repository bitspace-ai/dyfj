// add-import-extensions: ignore-file
import { assertEquals, assertStrictEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { addImportExtensions, IGNORE_MARKER } from "./add-import-extensions.ts";

const FILES = new Set([
  "/repo/src/utils.ts",
  "/repo/src/view.tsx",
  "/repo/src/store/index.ts",
  "/repo/scripts/tool.ts",
]);
const exists = (path: string) => FILES.has(path);

function rewrite(source: string) {
  return addImportExtensions(source, "/repo/src", exists);
}

describe("addImportExtensions", () => {
  it("adds the resolved extension to static, type, and re-export forms", () => {
    const source = [
      'import { a } from "./utils";',
      "import type { B } from './utils';",
      'export * from "./store";',
      'import "../scripts/tool";',
      'import View from "./view";',
    ].join("\n");
    assertEquals(rewrite(source), {
      source: [
        'import { a } from "./utils.ts";',
        "import type { B } from './utils.ts';",
        'export * from "./store/index.ts";',
        'import "../scripts/tool.ts";',
        'import View from "./view.tsx";',
      ].join("\n"),
      unresolved: [],
    });
  });

  it("covers dynamic imports split across lines and typeof import", () => {
    const source = [
      "const m = await import(",
      '  "./utils"',
      ");",
      'type T = typeof import("./utils");',
    ].join("\n");
    assertStrictEquals(
      rewrite(source).source,
      [
        "const m = await import(",
        '  "./utils.ts"',
        ");",
        'type T = typeof import("./utils.ts");',
      ].join("\n"),
    );
  });

  it("covers Vitest module helpers, including a generic argument", () => {
    const source = [
      'vi.mock("./utils", () => ({}));',
      "await vi.importActual<",
      '  typeof import("./utils")',
      '>("./utils");',
    ].join("\n");
    assertStrictEquals(
      rewrite(source).source,
      [
        'vi.mock("./utils.ts", () => ({}));',
        "await vi.importActual<",
        '  typeof import("./utils.ts")',
        '>("./utils.ts");',
      ].join("\n"),
    );
  });

  it("leaves explicit extensions, packages, and non-import strings alone", () => {
    const source = [
      'import { a } from "./utils.ts";',
      'import data from "./data.json";',
      'import { z } from "zod";',
      'const path = "./utils";',
      'new URL("./tool", import.meta.url);',
    ].join("\n");
    assertEquals(rewrite(source), { source, unresolved: [] });
  });

  it("reports a specifier that resolves to no file and leaves it as is", () => {
    const source = 'import { gone } from "./missing";';
    assertEquals(rewrite(source), { source, unresolved: ["./missing"] });
  });

  it("skips a file carrying the ignore marker", () => {
    const source = `${IGNORE_MARKER}\nimport { a } from "./utils";`;
    assertEquals(rewrite(source), { source, unresolved: [] });
  });
});
