import {
  type AnalysisInput,
  analyze,
  type Baseline,
  type CycleAllowEntry,
  type LayerRules,
  stronglyConnected,
} from "./arch-imports.ts";
import {
  functionSpans,
  parseImports,
  sizeReport,
} from "./arch-imports-lexer.ts";

function assertEquals<T>(actual: T, expected: T): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assertSome(values: readonly string[], needle: string): void {
  if (!values.some((value) => value.includes(needle))) {
    throw new Error(
      `Expected an entry including ${needle}, got ${JSON.stringify(values)}`,
    );
  }
}

const S = "prototype/src";

const RULES: LayerRules = {
  roots: [S],
  sourceRoot: S,
  exclude: [".test.ts"],
  units: [
    { dir: "kernel", layer: 0 },
    { dir: "contract", layer: 1 },
    { dir: "store", layer: 2 },
    { dir: "providers", layer: 2 },
    { dir: "context", layer: 2 },
    { dir: "tools", layer: 2 },
    { dir: "engine", layer: 3 },
    { dir: "extensions/*", layer: 4 },
    { dir: "server", layer: 5 },
    { dir: "cli", layer: 5 },
    { dir: "tooling", layer: 6, outside: true, path: "prototype/scripts" },
  ],
  sameLayerEdges: [
    { from: "context", to: "providers", typesOnly: true },
    { from: "tools", to: "store" },
  ],
  cli: {
    unit: "cli",
    allowedUnits: ["kernel", "contract"],
    allowedPaths: [`${S}/extensions/*/client.ts`],
  },
  files: { [`${S}/legacy-utils.ts`]: "store" },
};

const EMPTY: Baseline = { cycles: [], layer: [], cli: [], dynamic: [] };

function run(
  files: Record<string, string>,
  overrides: Partial<AnalysisInput> = {},
) {
  const sources = new Map(
    Object.entries({ [`${S}/legacy-utils.ts`]: "export {};", ...files }),
  );
  const extra = new Set(["prototype/testing/cycle.test.ts"]);
  return analyze({
    sources,
    rules: RULES,
    allowList: [],
    baseline: EMPTY,
    exists: (path) => sources.has(path) || extra.has(path),
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Parsing

Deno.test("parser finds static, re-export, type-only, and dynamic imports", () => {
  const records = parseImports(`
    import a from "./a";
    import { b, c } from "./b.ts";
    import type { T } from "./t";
    import { type U, type V } from "./u.ts";
    import { type W, x } from "./w";
    import "./side-effect";
    export { d } from "./d";
    export type { E } from "./e.ts";
    export * as ns from "./ns";
    export * from "npm:zod@4.4.3";
    const lazy = await import("./lazy");
    const computed = await import(name);
    const meta = import.meta.url;
  `);
  assertEquals(
    records.map((r) => [r.specifier, r.kind, r.typeOnly]),
    [
      ["./a", "static", false],
      ["./b.ts", "static", false],
      ["./t", "static", true],
      ["./u.ts", "static", true],
      ["./w", "static", false],
      ["./side-effect", "static", false],
      ["./d", "static", false],
      ["./e.ts", "static", true],
      ["./ns", "static", false],
      ["npm:zod@4.4.3", "static", false],
      ["./lazy", "dynamic", false],
      [null, "dynamic", false],
    ],
  );
});

Deno.test("parser ignores imports inside comments, strings, templates, and regexes", () => {
  const records = parseImports(`
    // import a from "./comment";
    /* import b from "./block"; */
    const s = 'import c from "./string"';
    const t = \`import d from "./template" \${ "x" } import("./in-template")\`;
    const r = /import e from "\\.\\/regex"/g;
    const ratio = total / count; import f from "./real";
    obj.import("./method");
  `);
  assertEquals(records.map((r) => r.specifier), ["./real"]);
});

Deno.test("extensionless and .ts specifiers resolve to the same module", () => {
  const result = run({
    [`${S}/kernel/a.ts`]: "export const a = 1;",
    [`${S}/engine/x.ts`]: 'import { a } from "../kernel/a";',
    [`${S}/engine/y.ts`]: 'import { a } from "../kernel/a.ts";',
  });
  assertEquals(result.errors, []);
  assertEquals(
    result.edges.map((e) => [e.from, e.to]),
    [
      [`${S}/engine/x.ts`, `${S}/kernel/a.ts`],
      [`${S}/engine/y.ts`, `${S}/kernel/a.ts`],
    ],
  );
});

Deno.test("an unresolved local import and an unmapped module fail", () => {
  const result = run({
    [`${S}/kernel/a.ts`]: 'import { gone } from "./gone";',
    [`${S}/mystery.ts`]: "export {};",
  });
  assertSome(result.errors, 'unresolved local import "./gone"');
  assertSome(
    result.errors,
    `unmapped module (add it to scripts/arch-layers.json): ${S}/mystery.ts`,
  );
});

Deno.test("a name mapping for a module that no longer exists fails", () => {
  const result = run({}, {
    rules: {
      ...RULES,
      files: { ...RULES.files, [`${S}/moved-away.ts`]: "store" },
    },
  });
  assertEquals(result.errors, [
    `mapped module no longer exists: ${S}/moved-away.ts`,
  ]);
});

// ---------------------------------------------------------------------------
// Rule types

Deno.test("Tarjan groups mutually reachable modules", () => {
  const adjacency = new Map([
    ["a", ["b"]],
    ["b", ["c"]],
    ["c", ["a", "d"]],
    ["d", []],
  ]);
  assertEquals(stronglyConnected(["a", "b", "c", "d"], adjacency), [
    ["a", "b", "c"],
    ["d"],
  ]);
});

Deno.test("an import cycle is a violation, type-only edges included", () => {
  const result = run({
    [`${S}/tools/a.ts`]: 'import { b } from "./b";',
    [`${S}/tools/b.ts`]: 'import type { A } from "./a.ts";',
  });
  assertEquals(result.current.cycles, [{
    members: [`${S}/tools/a.ts`, `${S}/tools/b.ts`],
    edges: [
      `${S}/tools/a.ts -> ${S}/tools/b.ts`,
      `${S}/tools/b.ts -> ${S}/tools/a.ts`,
    ],
  }]);
  assertEquals(result.added, [
    `cycle: ${S}/tools/a.ts -> ${S}/tools/b.ts`,
    `cycle: ${S}/tools/b.ts -> ${S}/tools/a.ts`,
  ]);
});

Deno.test("upward and non-listed same-layer edges are layer violations", () => {
  const result = run({
    [`${S}/kernel/k.ts`]: 'import { e } from "../engine/e";',
    [`${S}/engine/e.ts`]: "export const e = 1;",
    [`${S}/providers/p.ts`]: 'import { s } from "../legacy-utils";',
    [`${S}/legacy-utils.ts`]: "export const s = 1;",
    [`${S}/tools/t.ts`]: 'import { s } from "../legacy-utils.ts";',
    [`${S}/engine/uses-tooling.ts`]: 'import "../../scripts/tool";',
    ["prototype/scripts/tool.ts"]: 'import { e } from "../src/engine/e";',
  });
  assertEquals(result.current.layer, [
    // Runtime code may not import tooling outside the runtime graph.
    `${S}/engine/uses-tooling.ts -> prototype/scripts/tool.ts`,
    // Upward.
    `${S}/kernel/k.ts -> ${S}/engine/e.ts`,
    // Same layer, not listed. `tools -> store` is listed and passes, and
    // tooling may import the runtime.
    `${S}/providers/p.ts -> ${S}/legacy-utils.ts`,
  ]);
});

Deno.test("a types-only same-layer edge fails when it imports values", () => {
  const result = run({
    [`${S}/providers/p.ts`]: "export type P = 1; export const p = 1;",
    [`${S}/context/types.ts`]: 'import type { P } from "../providers/p";',
    [`${S}/context/values.ts`]: 'import { p } from "../providers/p";',
  });
  assertEquals(result.current.layer, [
    `${S}/context/values.ts -> ${S}/providers/p.ts`,
  ]);
});

Deno.test("cli/ may import only its allow-list", () => {
  const result = run({
    [`${S}/cli/main.ts`]: [
      'import { k } from "../kernel/k";',
      'import { c } from "../extensions/ideas/client";',
      'import { r } from "../extensions/ideas/registry";',
      'import { t } from "../tools/t";',
    ].join("\n"),
    [`${S}/kernel/k.ts`]: "export const k = 1;",
    [`${S}/extensions/ideas/client.ts`]: "export const c = 1;",
    [`${S}/extensions/ideas/registry.ts`]: "export const r = 1;",
    [`${S}/tools/t.ts`]: "export const t = 1;",
  });
  assertEquals(result.current.cli, [
    `${S}/cli/main.ts -> ${S}/extensions/ideas/registry.ts`,
    `${S}/cli/main.ts -> ${S}/tools/t.ts`,
  ]);
  assertEquals(result.current.layer, []);
});

Deno.test("dynamic local imports are violations; package imports are not", () => {
  const result = run({
    [`${S}/engine/e.ts`]: [
      'const { k } = await import("../kernel/k");',
      'const { k: again } = await import("../kernel/k.ts");',
      'const { parse } = await import("@std/toml");',
    ].join("\n"),
    [`${S}/kernel/k.ts`]: "export const k = 1;",
  });
  assertEquals(result.current.dynamic, [
    `${S}/engine/e.ts -> ${S}/kernel/k.ts`,
  ]);
});

Deno.test("deep imports past a mod.ts are reported, never failed", () => {
  const baseline: Baseline = EMPTY;
  const result = run({
    [`${S}/tools/mod.ts`]: 'export { t } from "./t";',
    [`${S}/tools/t.ts`]: "export const t = 1;",
    [`${S}/engine/e.ts`]: 'import { t } from "../tools/t";',
    [`${S}/engine/f.ts`]: 'import { t } from "../tools/mod.ts";',
  }, { baseline });
  assertEquals(result.deepImports, [`${S}/engine/e.ts -> ${S}/tools/t.ts`]);
  assertEquals(result.added, []);
});

// ---------------------------------------------------------------------------
// Named-cycle allow-list

const CYCLE = {
  [`${S}/tools/a.ts`]: 'import { b } from "./b";',
  [`${S}/tools/b.ts`]: 'const { a } = await import("./a");',
};

const ENTRY: CycleAllowEntry = {
  name: "tool round trip",
  edges: [
    `${S}/tools/a.ts -> ${S}/tools/b.ts`,
    `${S}/tools/b.ts -> ${S}/tools/a.ts`,
  ],
  justification: "An inherently bidirectional protocol round trip.",
  test: "prototype/testing/cycle.test.ts",
};

Deno.test("an allow-listed cycle passes, including its dynamic edge", () => {
  const result = run(CYCLE, { allowList: [ENTRY] });
  assertEquals(result.errors, []);
  assertEquals(result.current, EMPTY);
  assertEquals(result.added, []);
});

Deno.test("an allow-list entry whose cited test file is missing fails", () => {
  const result = run(CYCLE, {
    allowList: [{ ...ENTRY, test: "prototype/testing/missing.test.ts" }],
  });
  assertEquals(result.errors, [
    "allow-list entry tool round trip: test file does not exist: prototype/testing/missing.test.ts",
  ]);
});

Deno.test("a stale allow-list entry fails when its edges no longer occur", () => {
  const result = run({
    [`${S}/tools/a.ts`]: 'import { b } from "./b";',
    [`${S}/tools/b.ts`]: "export const b = 1;",
  }, { allowList: [ENTRY] });
  assertEquals(result.errors, [
    `allow-list entry tool round trip: edge no longer occurs: ${S}/tools/b.ts -> ${S}/tools/a.ts`,
  ]);
});

Deno.test("an allow-list entry needs a name, a justification, and a test", () => {
  const result = run(CYCLE, {
    allowList: [
      { name: "", edges: [], justification: " ", test: "" },
      { name: " ", edges: [], justification: " ", test: "" },
    ],
  });
  // Two blank names are each reported as missing, never as duplicates.
  const missing = [
    "missing name",
    "missing justification",
    "no edges",
    "missing test path",
  ];
  assertEquals(result.errors, [
    ...missing.map((m) => `allow-list entry #0: ${m}`),
    ...missing.map((m) => `allow-list entry #1: ${m}`),
  ]);
});

// ---------------------------------------------------------------------------
// Ratchet

Deno.test("the ratchet fails on a new violation and on a stale baseline entry", () => {
  const baseline: Baseline = {
    cycles: [],
    layer: [`${S}/kernel/k.ts -> ${S}/engine/gone.ts`],
    cli: [],
    dynamic: [],
  };
  const result = run({
    [`${S}/kernel/k.ts`]: 'import { e } from "../engine/e";',
    [`${S}/engine/e.ts`]: "export const e = 1;",
  }, { baseline });
  assertEquals(result.added, [`layer: ${S}/kernel/k.ts -> ${S}/engine/e.ts`]);
  assertEquals(result.stale, [
    `layer: ${S}/kernel/k.ts -> ${S}/engine/gone.ts`,
  ]);
});

Deno.test("the ratchet passes when the tree matches the baseline", () => {
  const files = {
    [`${S}/kernel/k.ts`]: 'import { e } from "../engine/e";',
    [`${S}/engine/e.ts`]: "export const e = 1;",
  };
  const first = run(files);
  const second = run(files, { baseline: first.current });
  assertEquals(second.added, []);
  assertEquals(second.stale, []);
});

// ---------------------------------------------------------------------------
// Size report

Deno.test("function spans cover declarations, methods, and arrows", () => {
  const spans = functionSpans([
    "export function alpha(a: string): { ok: boolean } {", // 1
    "  return { ok: true };",
    "}",
    "class K {",
    "  async beta<T>(x: T): Promise<T> {", // 5
    "    if (x) {",
    "      return x;",
    "    }",
    "    return x;",
    "  }", // 10
    "}",
    "const gamma = async (",
    "  y: number,",
    "): Promise<number> => {",
    "  return y;", // 15
    "};",
  ].join("\n"));
  assertEquals(
    spans.map((s) => [s.name, s.startLine, s.endLine]),
    [["alpha", 1, 3], ["beta", 5, 10], ["gamma", 12, 16]],
  );
});

Deno.test("the size report lists long modules and long functions", () => {
  const long = `function big() {\n${"  work();\n".repeat(150)}}\n`;
  const report = sizeReport(
    new Map([
      ["m/big.ts", long + "x;\n".repeat(460)],
      ["m/small.ts", "function small() {\n}\n"],
    ]),
  );
  assertEquals(report.modules, [{ path: "m/big.ts", lines: 612 }]);
  assertEquals(report.functions, [
    { path: "m/big.ts", name: "big", line: 1, lines: 152 },
  ]);
});
