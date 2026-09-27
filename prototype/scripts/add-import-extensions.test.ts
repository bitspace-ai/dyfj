// add-import-extensions: ignore-file
import { describe, expect, test } from "vitest";
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
  test("adds the resolved extension to static, type, and re-export forms", () => {
    const source = [
      'import { a } from "./utils";',
      "import type { B } from './utils';",
      'export * from "./store";',
      'import "../scripts/tool";',
      'import View from "./view";',
    ].join("\n");
    expect(rewrite(source)).toEqual({
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

  test("covers dynamic imports split across lines and typeof import", () => {
    const source = [
      "const m = await import(",
      '  "./utils"',
      ");",
      'type T = typeof import("./utils");',
    ].join("\n");
    expect(rewrite(source).source).toBe(
      [
        "const m = await import(",
        '  "./utils.ts"',
        ");",
        'type T = typeof import("./utils.ts");',
      ].join("\n"),
    );
  });

  test("covers Vitest module helpers, including a generic argument", () => {
    const source = [
      'vi.mock("./utils", () => ({}));',
      "await vi.importActual<",
      '  typeof import("./utils")',
      '>("./utils");',
    ].join("\n");
    expect(rewrite(source).source).toBe(
      [
        'vi.mock("./utils.ts", () => ({}));',
        "await vi.importActual<",
        '  typeof import("./utils.ts")',
        '>("./utils.ts");',
      ].join("\n"),
    );
  });

  test("leaves explicit extensions, packages, and non-import strings alone", () => {
    const source = [
      'import { a } from "./utils.ts";',
      'import data from "./data.json";',
      'import { z } from "zod";',
      'const path = "./utils";',
      'new URL("./tool", import.meta.url);',
    ].join("\n");
    expect(rewrite(source)).toEqual({ source, unresolved: [] });
  });

  test("reports a specifier that resolves to no file and leaves it as is", () => {
    const source = 'import { gone } from "./missing";';
    expect(rewrite(source)).toEqual({ source, unresolved: ["./missing"] });
  });

  test("skips a file carrying the ignore marker", () => {
    const source = `${IGNORE_MARKER}\nimport { a } from "./utils";`;
    expect(rewrite(source)).toEqual({ source, unresolved: [] });
  });
});
