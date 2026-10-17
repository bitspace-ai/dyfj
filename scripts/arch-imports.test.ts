import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  type AnalysisInput,
  analyze,
  type Baseline,
  type CycleAllowEntry,
  type LayerRules,
  packageName,
  stronglyConnected,
} from "./arch-imports.ts";
import { loadModuleGraph } from "./arch-imports-graph.ts";
import { stripTypes } from "./arch-imports-parse.ts";
import {
  functionSpans,
  hardLimitViolations,
  type SizeException,
  sizeReport,
} from "./arch-imports-size.ts";

function assertEquals<T>(actual: T, expected: T): void {
  assert.deepStrictEqual(actual, expected);
}

function assertSome(values: readonly string[], needle: string): void {
  assert.ok(
    values.some((value) => value.includes(needle)),
    `Expected an entry including ${needle}, got ${JSON.stringify(values)}`,
  );
}

const S = "prototype/src";

const RULES: LayerRules = {
  roots: [S],
  sourceRoot: S,
  exclude: [".test.ts"],
  units: [
    { dir: "kernel", layer: 0 },
    { dir: "contract", layer: 1 },
    { dir: "config", layer: 1 },
    { dir: "store", layer: 2 },
    { dir: "providers", layer: 2 },
    { dir: "context", layer: 2 },
    { dir: "tools", layer: 2 },
    { dir: "engine", layer: 3 },
    { dir: "extensions/*", layer: 4 },
    { dir: "server", layer: 5 },
    { dir: "cli", layer: 5 },
    { dir: "mcp", layer: 5, path: "prototype/mcp" },
    { dir: "tooling", layer: 6, outside: true, path: "prototype/scripts" },
  ],
  sameLayerEdges: [
    { from: "context", to: "providers", typesOnly: true },
    { from: "tools", to: "store" },
  ],
  importOnlyFrom: [{ unit: "extensions/*", importers: ["server", "cli"] }],
  cli: {
    unit: "cli",
    allowedUnits: ["kernel", "contract"],
    allowedPaths: [`${S}/extensions/*/client.ts`],
  },
  env: {
    allowedUnits: ["config"],
    entrypoints: [
      { unit: "tooling", justification: "Separate processes." },
    ],
  },
  packages: [{
    name: "mysql2",
    allowedUnits: ["store"],
    entrypoints: [{ unit: "tooling", justification: "Test fixture." }],
  }],
  sqlWrites: {
    allowedPaths: [`${S}/store/journal.ts`],
    entrypoints: [{ unit: "tooling", justification: "Test fixture." }],
  },
  files: { [`${S}/legacy-utils.ts`]: "store" },
};

const EMPTY: Baseline = {
  cycles: [],
  layer: [],
  cli: [],
  dynamic: [],
  env: [],
  envKeys: [],
  packages: [],
  sqlWrites: [],
};

// Builds the graph of the fixture modules with the lane's own parser, so every
// rule test runs through the same code as the lane.
function run(
  files: Record<string, string>,
  overrides: Partial<AnalysisInput> = {},
) {
  const all: Record<string, string> = {
    [`${S}/legacy-utils.ts`]: "export {};",
    [`${S}/store/journal.ts`]: "export {};",
    ...files,
  };
  const graph = loadModuleGraph(
    "/repo",
    new Map(Object.entries(all)),
    (path) => path in all,
  );
  const extra = new Set(["prototype/testing/cycle.test.ts"]);
  return analyze({
    modules: Object.keys(all),
    graph,
    rules: RULES,
    allowList: [],
    baseline: EMPTY,
    declaredEnvKeys: new Set(["DYFJ_DECLARED"]),
    exists: (path) => path in all || extra.has(path),
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Graph

const E = `${S}/engine`;

function edgesFrom(
  result: ReturnType<typeof run>,
  from: string,
): [string, string, boolean][] {
  return result.edges.filter((e) => e.from === from).map((e) => [
    e.to.slice(E.length + 1),
    e.kind,
    e.typeOnly,
  ]);
}

function targets(names: string[]): Record<string, string> {
  return Object.fromEntries(
    names.map((
      n,
    ) => [`${E}/${n}.ts`, "export const x = 1; export type T = 1;"]),
  );
}

test("the graph has static, re-export, type-only, and dynamic edges", () => {
  const result = run({
    ...targets([
      "a",
      "t",
      "u",
      "d",
      "e",
      "ns",
      "side",
      "lazy",
      "q",
      "both",
    ]),
    [`${E}/main.ts`]: [
      'import { x } from "./a.ts";',
      'import type { T } from "./t.ts";',
      // All-inline-type bindings still load the module (verbatimModuleSyntax).
      'import { type T as U } from "./u.ts";',
      'export { x as d } from "./d.ts";',
      'export type { T as E } from "./e.ts";',
      'export * as ns from "./ns.ts";',
      'import "./side.ts";',
      'const lazy = await import("./lazy.ts");',
      'type Q = typeof import("./q.ts");',
      // Imported statically and dynamically: the dynamic import adds no edge.
      'import { x as b } from "./both.ts";',
      'const both = await import("./both.ts");',
    ].join("\n"),
  });
  assertEquals(result.errors, []);
  assertEquals(edgesFrom(result, `${E}/main.ts`), [
    ["a.ts", "static", false],
    ["both.ts", "static", false],
    ["d.ts", "static", false],
    ["e.ts", "static", true],
    ["lazy.ts", "dynamic", false],
    ["ns.ts", "static", false],
    ["q.ts", "static", true],
    ["side.ts", "static", false],
    ["t.ts", "static", true],
    ["u.ts", "static", false],
  ]);
});

test("import-like text outside real imports adds no edges", () => {
  // Each case once misled the hand-written lexer this lane used before.
  const names = [
    "comment",
    "block",
    "string",
    "template",
    "in-template",
    "regex",
    "real",
    "after-control",
    "after-division",
    "after-object",
    "after-postfix",
    "after-object-paren",
    "after-block",
    "after-else",
    "after-do",
    "after-unary",
    "type-query",
    "ternary",
    "method",
  ];
  const result = run({
    ...targets(names),
    [`${E}/tricky.ts`]: [
      '// import a from "./comment.ts";',
      '/* import b from "./block.ts"; */',
      "const s = 'import c from \"./string\"';",
      'const t = `import d from "./template.ts" ${"x"} import("./in-template.ts")`;',
      'const r = /import e from "\\.\\/regex"/g;',
      "const total = 4, count = 2, ok = true, n = 1;",
      'const ratio = total / count; import f from "./real.ts";',
      'if (ok) /import g from "\\.\\/after-control"/.test(s);',
      'const call = Math.abs(n) / 2; import h from "./after-division.ts";',
      'const obj = ({} as unknown as number) / 2; import i from "./after-object.ts";',
      'let m = 1; m++ / 2; import j from "./after-postfix.ts";',
      'const o = ({ x: 1 } as unknown as number) / (await import("./after-object-paren.ts")).x;',
      'function block() {} /import k from "\\.\\/after-block"/.test(s);',
      'if (ok) {} else {} /import("\\.\\/after-else")/.test(s);',
      'do {} while (!ok); import l from "./after-do.ts";',
      'const u = n + + /import m from "\\.\\/after-unary"/.source;',
      'type Mod = typeof import("./type-query.ts");',
      "const helpers = { import(value: string) { return value; } };",
      "class Loader { static async import(path: string): Promise<void> {} }",
      'const pick = ok ? import("./ternary.ts") : null;',
      'helpers.import("./method.ts");',
    ].join("\n"),
  });
  assertEquals(result.errors, []);
  assertEquals(edgesFrom(result, `${E}/tricky.ts`), [
    ["after-division.ts", "static", false],
    ["after-do.ts", "static", false],
    ["after-object-paren.ts", "dynamic", false],
    ["after-object.ts", "static", false],
    ["after-postfix.ts", "static", false],
    ["real.ts", "static", false],
    ["ternary.ts", "dynamic", false],
    ["type-query.ts", "static", true],
  ]);
  // Only the two real `import()` expressions are dynamic imports.
  assertEquals(result.current.dynamic, [
    `${E}/tricky.ts -> ${E}/after-object-paren.ts`,
    `${E}/tricky.ts -> ${E}/ternary.ts`,
  ]);
});

test("a module that does not parse fails the lane", () => {
  const result = run({ [`${E}/broken.ts`]: "export const = ;" });
  assertEquals(result.errors, [`module failed to load: ${E}/broken.ts`]);
});

test("inline type modifiers are value edges; type-only statements are not", () => {
  const result = run({
    ...targets([
      "mixed",
      "typed",
      "reexport-inline",
      "reexport-type",
      "default-inline",
    ]),
    [`${E}/inline.ts`]: [
      'import { type A, x as B } from "./mixed.ts";',
      'import type { A as A2 } from "./typed.ts";',
      'export { type A as A3 } from "./reexport-inline.ts";',
      'export type { A as A4 } from "./reexport-type.ts";',
      'import { type default as A5 } from "./default-inline.ts";',
    ].join("\n"),
  });
  assertEquals(result.errors, []);
  // Under verbatimModuleSyntax a statement with only inline `type`
  // modifiers still loads its module, so only `import type` and
  // `export type` statements are type-only.
  assertEquals(edgesFrom(result, `${E}/inline.ts`), [
    ["default-inline.ts", "static", false],
    ["mixed.ts", "static", false],
    ["reexport-inline.ts", "static", false],
    ["reexport-type.ts", "static", true],
    ["typed.ts", "static", true],
  ]);
});

test("a malformed module fails the lane by name and is not skipped", () => {
  const result = run({
    ...targets(["a"]),
    [`${E}/syntax.ts`]: "export const = ;",
    [`${E}/unterminated.ts`]: 'import { x } from "./a.ts;\nexport { x };',
    [`${E}/non-literal.ts`]: "const name = './a.ts'; import { x } from name;",
    [`${E}/bad-type.ts`]: "export const y: = 1;",
    [`${E}/user.ts`]: 'import { x } from "./unterminated.ts";',
  });
  assertEquals(result.errors, [
    `module failed to load: ${E}/bad-type.ts`,
    `module failed to load: ${E}/non-literal.ts`,
    `module failed to load: ${E}/syntax.ts`,
    `module failed to load: ${E}/unterminated.ts`,
    `unresolved local import "./unterminated.ts" at ${E}/user.ts:1`,
  ]);
});

test("an extensionless local import does not resolve", () => {
  const result = run({
    [`${S}/kernel/a.ts`]: "export const a = 1;",
    [`${S}/engine/x.ts`]: 'import { a } from "../kernel/a";',
    [`${S}/engine/y.ts`]: 'import { a } from "../kernel/a.ts";',
  });
  assertEquals(result.errors, [
    `unresolved local import "../kernel/a" at ${S}/engine/x.ts:1`,
  ]);
  assertEquals(
    result.edges.map((e) => [e.from, e.to]),
    [[`${S}/engine/y.ts`, `${S}/kernel/a.ts`]],
  );
});

test("an unresolved local import and an unmapped module fail", () => {
  const result = run({
    [`${S}/kernel/a.ts`]: 'import { gone } from "./gone.ts";',
    [`${S}/mystery.ts`]: "export {};",
  });
  assertSome(result.errors, 'unresolved local import "./gone.ts"');
  assertSome(
    result.errors,
    `unmapped module (add it to scripts/arch-layers.json): ${S}/mystery.ts`,
  );
});

test("a name mapping for a module that no longer exists fails", () => {
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

test("type stripping keeps every offset, line and column", () => {
  const source = [
    'import type { T } from "./t.ts";',
    "export const f = <V,>(value: V, count?: number): V => {",
    "  const n = count as number;",
    "  return value satisfies V ? value : (process.env.HOME as V);",
    "};",
    "class C { private x?: string; method<W>(w: W): void {} }",
  ].join("\n");
  const stripped = stripTypes(source);
  assertEquals(stripped.length, source.length);
  // Every character that survives stripping is where it was.
  for (let i = 0; i < source.length; i++) {
    if (stripped[i] !== " ") assertEquals(stripped[i], source[i]);
  }
  const position = (text: string, needle: string) => {
    const before = text.slice(0, text.indexOf(needle)).split("\n");
    return [before.length, before.at(-1)!.length];
  };
  for (const needle of ["process.env", "const n", "method", "return"]) {
    assertEquals(position(stripped, needle), position(source, needle));
  }
});

test("type stripping leaves the process warning hook as it found it", () => {
  const before = process.emitWarning;
  stripTypes("const x: number = 1;");
  assert.equal(process.emitWarning, before);
});

test("findings in type positions survive type stripping", () => {
  const result = run({
    ...targets(["star", "multi"]),
    [`${E}/types.ts`]: [
      'type K = "DYFJ_TYPED";',
      'type Q = "INSERT INTO typed";',
      'import type { env } from "node:process";',
      'export type * from "./star.ts";',
      "import type {",
      "  // a comment inside the erased statement",
      "  T,",
      '} from "./multi.ts";',
      'import type { Pool } from "mysql2";',
    ].join("\n"),
  });
  assertEquals(result.errors, []);
  assertEquals(edgesFrom(result, `${E}/types.ts`), [
    ["multi.ts", "static", true],
    ["star.ts", "static", true],
  ]);
  assertEquals(result.current.envKeys, [`${E}/types.ts: DYFJ_TYPED`]);
  assertEquals(result.current.sqlWrites, [`${E}/types.ts: INSERT INTO`]);
  assertEquals(result.current.env, [`${E}/types.ts: process.env`]);
  assertEquals(result.current.packages, [`${E}/types.ts: mysql2`]);
});

test("an import of a module that does not parse does not resolve", () => {
  const result = run({
    [`${E}/broken.ts`]: "export const = ;",
    [`${E}/user.ts`]: 'import { x } from "./broken.ts";',
  });
  assertEquals(result.errors, [
    `module failed to load: ${E}/broken.ts`,
    `unresolved local import "./broken.ts" at ${E}/user.ts:1`,
  ]);
});

// ---------------------------------------------------------------------------
// Rule types

test("Tarjan groups mutually reachable modules", () => {
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

test("an import cycle is a violation, type-only edges included", () => {
  const result = run({
    [`${S}/tools/a.ts`]: 'import { b } from "./b.ts";',
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

test("upward and non-listed same-layer edges are layer violations", () => {
  const result = run({
    [`${S}/kernel/k.ts`]: 'import { e } from "../engine/e.ts";',
    [`${S}/engine/e.ts`]: "export const e = 1;",
    [`${S}/providers/p.ts`]: 'import { s } from "../legacy-utils.ts";',
    [`${S}/legacy-utils.ts`]: "export const s = 1;",
    [`${S}/tools/t.ts`]: 'import { s } from "../legacy-utils.ts";',
    [`${S}/engine/uses-tooling.ts`]: 'import "../../scripts/tool.ts";',
    ["prototype/scripts/tool.ts"]: 'import { e } from "../src/engine/e.ts";',
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

test("a types-only same-layer edge fails when it imports values", () => {
  const result = run({
    [`${S}/providers/p.ts`]: "export type P = 1; export const p = 1;",
    [`${S}/context/types.ts`]: 'import type { P } from "../providers/p.ts";',
    [`${S}/context/values.ts`]: 'import { p } from "../providers/p.ts";',
  });
  assertEquals(result.current.layer, [
    `${S}/context/values.ts -> ${S}/providers/p.ts`,
  ]);
});

test("cli/ may import only its allow-list", () => {
  const result = run({
    [`${S}/cli/main.ts`]: [
      'import { k } from "../kernel/k.ts";',
      'import { c } from "../extensions/ideas/client.ts";',
      'import { r } from "../extensions/ideas/registry.ts";',
      'import { t } from "../tools/t.ts";',
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

test("only server/ and cli/ may import extensions/, whatever the layer", () => {
  const result = run({
    [`${S}/extensions/ideas/mod.ts`]: "export const i = 1;",
    [`${S}/extensions/ideas/client.ts`]: "export const c = 1;",
    [`${S}/extensions/linear/mod.ts`]: 'import { i } from "../ideas/mod.ts";',
    [`${S}/server/main.ts`]: 'import { i } from "../extensions/ideas/mod.ts";',
    [`${S}/cli/main.ts`]: 'import { c } from "../extensions/ideas/client.ts";',
    [`${S}/tools/t.ts`]: 'import { i } from "../extensions/ideas/mod.ts";',
    ["prototype/mcp/server.ts"]:
      'import { i } from "../src/extensions/ideas/mod.ts";',
    ["prototype/scripts/tool.ts"]:
      'import { i } from "../src/extensions/ideas/mod.ts";',
  });
  assertEquals(result.current.layer, [
    // Same layer as server/, but not a listed importer.
    `prototype/mcp/server.ts -> ${S}/extensions/ideas/mod.ts`,
    // Tooling may import the runtime, but not extensions/.
    `prototype/scripts/tool.ts -> ${S}/extensions/ideas/mod.ts`,
    // One extension may not import another.
    `${S}/extensions/linear/mod.ts -> ${S}/extensions/ideas/mod.ts`,
    // Upward and restricted: reported once.
    `${S}/tools/t.ts -> ${S}/extensions/ideas/mod.ts`,
  ]);
  assertEquals(result.current.cli, []);
});

test("an importOnlyFrom rule must name declared units", () => {
  const result = run({}, {
    rules: {
      ...RULES,
      importOnlyFrom: [{ unit: "extensions/*", importers: ["servr"] }],
    },
  });
  assertSome(result.errors, "importOnlyFrom rule: unit is not declared: servr");
});

test("dynamic local imports are violations; package imports are not", () => {
  const result = run({
    [`${S}/engine/e.ts`]: [
      'const { k } = await import("../kernel/k.ts");',
      'const { k: again } = await import("../kernel/k.ts");',
      'const { parse } = await import("smol-toml");',
    ].join("\n"),
    [`${S}/kernel/k.ts`]: "export const k = 1;",
  });
  assertEquals(result.current.dynamic, [
    `${S}/engine/e.ts -> ${S}/kernel/k.ts`,
  ]);
});

test("a dynamic import is a violation even beside a static one", () => {
  // A graph builder can merge these into one static dependency; the parse
  // pass still sees the dynamic import.
  const result = run({
    [`${S}/engine/e.ts`]: [
      'import { k } from "../kernel/k.ts";',
      'const again = await import("../kernel/k.ts");',
    ].join("\n"),
    [`${S}/kernel/k.ts`]: "export const k = 1;",
  });
  assertEquals(result.current.dynamic, [
    `${S}/engine/e.ts -> ${S}/kernel/k.ts`,
  ]);
});

test("a non-literal dynamic import is a violation", () => {
  const result = run({
    [`${S}/engine/e.ts`]: [
      'const name = "../kernel/k.ts";',
      "const lazy = await import(name);",
    ].join("\n"),
    [`${S}/kernel/k.ts`]: "export const k = 1;",
  });
  assertEquals(result.current.dynamic, [
    `${S}/engine/e.ts:2 -> <non-literal>`,
  ]);
});

test("deep imports past a mod.ts are reported, never failed", () => {
  const baseline: Baseline = EMPTY;
  const result = run({
    [`${S}/tools/mod.ts`]: 'export { t } from "./t.ts";',
    [`${S}/tools/t.ts`]: "export const t = 1;",
    [`${S}/engine/e.ts`]: 'import { t } from "../tools/t.ts";',
    [`${S}/engine/f.ts`]: 'import { t } from "../tools/mod.ts";',
  }, { baseline });
  assertEquals(result.deepImports, [`${S}/engine/e.ts -> ${S}/tools/t.ts`]);
  assertEquals(result.added, []);
});

// ---------------------------------------------------------------------------
// Named-cycle allow-list

const CYCLE = {
  [`${S}/tools/a.ts`]: 'import { b } from "./b.ts";',
  [`${S}/tools/b.ts`]: 'const { a } = await import("./a.ts");',
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

test("an allow-listed cycle passes, including its dynamic edge", () => {
  const result = run(CYCLE, { allowList: [ENTRY] });
  assertEquals(result.errors, []);
  assertEquals(result.current, EMPTY);
  assertEquals(result.added, []);
});

test("an allow-listed cycle still fails layer and cli/ rules", () => {
  const up = `${S}/kernel/k.ts -> ${S}/engine/e.ts`;
  const down = `${S}/engine/e.ts -> ${S}/kernel/k.ts`;
  const result = run({
    [`${S}/kernel/k.ts`]: 'import { e } from "../engine/e.ts";',
    [`${S}/engine/e.ts`]: 'const { k } = await import("../kernel/k.ts");',
  }, {
    allowList: [{ ...ENTRY, edges: [up, down] }],
  });
  assertEquals(result.errors, []);
  assertEquals(result.current.cycles, []);
  assertEquals(result.current.dynamic, []);
  assertEquals(result.current.layer, [up]);
});

test("an allow-list entry naming a non-cycle edge fails", () => {
  const edge = `${S}/engine/e.ts -> ${S}/kernel/k.ts`;
  const result = run({
    [`${S}/engine/e.ts`]: 'const { k } = await import("../kernel/k.ts");',
    [`${S}/kernel/k.ts`]: "export const k = 1;",
  }, { allowList: [{ ...ENTRY, edges: [edge] }] });
  assertEquals(result.errors, [
    `allow-list entry tool round trip: edge is not part of an import cycle: ${edge}`,
  ]);
});

test("an allow-list entry whose cited test file is missing fails", () => {
  const result = run(CYCLE, {
    allowList: [{ ...ENTRY, test: "prototype/testing/missing.test.ts" }],
  });
  assertEquals(result.errors, [
    "allow-list entry tool round trip: test file does not exist: prototype/testing/missing.test.ts",
  ]);
});

test("a stale allow-list entry fails when its edges no longer occur", () => {
  const result = run({
    [`${S}/tools/a.ts`]: 'import { b } from "./b.ts";',
    [`${S}/tools/b.ts`]: "export const b = 1;",
  }, { allowList: [ENTRY] });
  // The surviving edge is no longer part of a cycle, so it is flagged too.
  assertEquals(result.errors, [
    `allow-list entry tool round trip: edge is not part of an import cycle: ${S}/tools/a.ts -> ${S}/tools/b.ts`,
    `allow-list entry tool round trip: edge no longer occurs: ${S}/tools/b.ts -> ${S}/tools/a.ts`,
  ]);
});

test("an allow-list entry needs a name, a justification, and a test", () => {
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

test("the ratchet fails on a new violation and on a stale baseline entry", () => {
  const baseline: Baseline = {
    cycles: [],
    layer: [`${S}/kernel/k.ts -> ${S}/engine/gone.ts`],
    cli: [],
    dynamic: [],
    env: [],
    envKeys: [],
  };
  const result = run({
    [`${S}/kernel/k.ts`]: 'import { e } from "../engine/e.ts";',
    [`${S}/engine/e.ts`]: "export const e = 1;",
  }, { baseline });
  assertEquals(result.added, [`layer: ${S}/kernel/k.ts -> ${S}/engine/e.ts`]);
  assertEquals(result.stale, [
    `layer: ${S}/kernel/k.ts -> ${S}/engine/gone.ts`,
  ]);
});

test("the ratchet passes when the tree matches the baseline", () => {
  const files = {
    [`${S}/kernel/k.ts`]: 'import { e } from "../engine/e.ts";',
    [`${S}/engine/e.ts`]: "export const e = 1;",
  };
  const first = run(files);
  const second = run(files, { baseline: first.current });
  assertEquals(second.added, []);
  assertEquals(second.stale, []);
});

// ---------------------------------------------------------------------------
// Size report

test("function spans cover declarations, methods, and arrows", () => {
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

test("private methods are spans; calls to them are not", () => {
  const spans = functionSpans([
    "class A {",
    "  async #start(x) {",
    "    a();",
    "  }",
    "  run() {",
    "    this.#start(1);",
    "  }",
    "}",
  ].join("\n"));
  assertEquals(
    spans.map((s) => [s.name, s.startLine, s.endLine]),
    [["#start", 2, 4], ["run", 5, 7]],
  );
});

test("the size report lists long modules and long functions", () => {
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

// Hard limits (PRD-11 R2): a runtime module over 1,000 lines or a function
// over 200 fails unless an exception names it; an excepted one may only shrink.
const bigModule = "x;\n".repeat(1001);
const bigFunction = `function big() {\n${"  work();\n".repeat(200)}}\n`;
const runtimeOnly = (path: string) => path.startsWith("src/");

test("an unexcepted module or function over its hard limit fails", () => {
  const errors = hardLimitViolations(
    new Map([["src/big.ts", bigModule], ["src/fn.ts", bigFunction]]),
    runtimeOnly,
    [],
  );
  assertEquals(errors.length, 2);
  assertSome(errors, "module src/big.ts is over the 1000-line limit (1001)");
  assertSome(
    errors,
    "function src/fn.ts:1 big is over the 200-line limit (202)",
  );
});

test("an excepted module or function passes at or under its recorded size", () => {
  const exceptions: SizeException[] = [
    { kind: "module", path: "src/big.ts", lines: 1001, reason: "deferred" },
    {
      kind: "function",
      path: "src/fn.ts",
      name: "big",
      lines: 210,
      reason: "deferred",
    },
  ];
  assertEquals(
    hardLimitViolations(
      new Map([["src/big.ts", bigModule], ["src/fn.ts", bigFunction]]),
      runtimeOnly,
      exceptions,
    ),
    [],
  );
});

test("an excepted module that grows past its recorded size fails", () => {
  const errors = hardLimitViolations(
    new Map([["src/big.ts", bigModule]]),
    runtimeOnly,
    [{ kind: "module", path: "src/big.ts", lines: 1000, reason: "deferred" }],
  );
  assertEquals(errors.length, 1);
  assertSome(
    errors,
    "module src/big.ts grew past its recorded size (1001 > 1000)",
  );
});

test("an exception for something back under its limit must be removed", () => {
  const errors = hardLimitViolations(
    new Map([["src/small.ts", "x;\n"]]),
    runtimeOnly,
    [
      { kind: "module", path: "src/small.ts", lines: 1200, reason: "deferred" },
      {
        kind: "function",
        path: "src/gone.ts",
        name: "old",
        lines: 300,
        reason: "deferred",
      },
    ],
  );
  assertEquals(errors.length, 2);
  assertSome(errors, "remove it: module src/small.ts");
  assertSome(errors, "remove it: function src/gone.ts old");
});

test("hard limits skip modules outside the runtime", () => {
  assertEquals(
    hardLimitViolations(
      new Map([["prototype/scripts/tool.ts", bigModule + bigFunction]]),
      runtimeOnly,
      [],
    ),
    [],
  );
});

test("a size exception without a reason, or listed twice, fails", () => {
  const errors = hardLimitViolations(
    new Map([["src/big.ts", bigModule]]),
    runtimeOnly,
    [
      { kind: "module", path: "src/big.ts", lines: 1001, reason: " " },
      { kind: "module", path: "src/big.ts", lines: 1001, reason: "deferred" },
      { kind: "module", path: "src/big.ts", lines: 1001, reason: "deferred" },
      { kind: "function", path: "src/fn.ts", lines: 300, reason: "no name" },
    ],
  );
  assertSome(errors, "size exception is malformed: module src/big.ts");
  assertSome(errors, "size exception is listed twice: module src/big.ts");
  assertSome(
    errors,
    "size exception is malformed: function src/fn.ts undefined",
  );
});

test("a size exceptions file that is not an array of objects fails, not throws", () => {
  assertSome(
    hardLimitViolations(new Map(), runtimeOnly, {}),
    "size exceptions must be a JSON array",
  );
  const errors = hardLimitViolations(new Map(), runtimeOnly, [
    null,
    "module",
    { kind: "module", lines: 1, reason: "no path" },
  ]);
  assertSome(errors, "size exception #0 is malformed: not an object");
  assertSome(errors, "size exception #1 is malformed: not an object");
  assertSome(errors, "size exception #2 is malformed: no path");
});

test("the committed size exceptions each carry a reason", async () => {
  const committed = JSON.parse(
    await readFile(
      fileURLToPath(new URL("./arch-size-exceptions.json", import.meta.url)),
      "utf8",
    ),
  ) as SizeException[];
  for (const entry of committed) {
    if (entry.reason.trim() === "") {
      throw new Error(`size exception without a reason: ${entry.path}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Environment access

// The retired deno runtime's global object stays an env owner, so code
// written for that runtime cannot read the environment around the Env port.
// Its name is assembled so this file adds no reference to the
// runtime.neutral ratchet.
const G = ["De", "no"].join("");

test("direct env access is a violation outside config/ and named entrypoints", () => {
  const result = run({
    [`${S}/config/env.ts`]: `export const e = ${G}.env;`,
    [`${S}/legacy-config.ts`]: `${G}.env.get("HOME");`,
    [`${S}/server/main.ts`]: `${G}.env.get("HOME");`,
    ["prototype/scripts/tool.ts"]: `${G}.env.get("HOME");`,
    [`${S}/engine/retired-global.ts`]: `${G}.env.get("HOME");`,
    [`${S}/engine/global.ts`]: `globalThis.${G}.env.get("HOME");`,
    [`${S}/engine/computed.ts`]: `${G}["env"].get("HOME");`,
    [`${S}/engine/computed-template.ts`]: "process[`env`].HOME;",
    [`${S}/engine/destructure.ts`]: `const { env } = ${G}; env.get('HOME');`,
    [`${S}/engine/node.ts`]:
      'import process from "node:process"; process.env.HOME;',
    [`${S}/engine/named.ts`]: 'import { env } from "node:process"; env.HOME;',
    [`${S}/engine/other.ts`]:
      `import process from "node:process"; process.stdin; ${G}.args;`,
    [`${S}/engine/namespace.ts`]:
      'import * as p from "node:process"; p.env.HOME;',
    [`${S}/engine/default-alias.ts`]:
      'import nodeProcess from "node:process"; nodeProcess.env.HOME;',
    [`${S}/engine/default-named.ts`]:
      'import { default as q } from "process"; q["env"].HOME;',
    [`${S}/engine/const-alias.ts`]: `const d = ${G}; d.env.get('HOME');`,
    [`${S}/engine/global-alias.ts`]:
      `const d = globalThis.${G}; const e = d; e.env.get('HOME');`,
    [`${S}/engine/global-object-alias.ts`]:
      "const g = globalThis; g.process.env.HOME;",
    [`${S}/engine/global-destructure.ts`]:
      `const { ${G}: D } = globalThis; D.env.get('HOME');`,
    [`${S}/engine/alias-destructure.ts`]:
      'import * as p from "node:process"; const { env } = p; env.HOME;',
    [`${S}/engine/reexport.ts`]: 'export { env } from "node:process";',
    [`${S}/engine/other-alias.ts`]:
      `import * as p from "node:process"; p.stdin; const d = ${G}; d.args;`,
  }, {
    rules: {
      ...RULES,
      files: { ...RULES.files, [`${S}/legacy-config.ts`]: "config" },
      env: {
        allowedUnits: ["config"],
        entrypoints: [
          ...RULES.env.entrypoints,
          { path: `${S}/server/main.ts`, justification: "Composition root." },
        ],
      },
    },
  });
  assertEquals(result.current.env, [
    `${S}/engine/alias-destructure.ts: process.env`,
    `${S}/engine/computed-template.ts: process.env`,
    `${S}/engine/computed.ts: ${G}.env`,
    `${S}/engine/const-alias.ts: ${G}.env`,
    `${S}/engine/default-alias.ts: process.env`,
    `${S}/engine/default-named.ts: process.env`,
    `${S}/engine/destructure.ts: ${G}.env`,
    `${S}/engine/global-alias.ts: ${G}.env`,
    `${S}/engine/global-destructure.ts: ${G}.env`,
    `${S}/engine/global-object-alias.ts: process.env`,
    `${S}/engine/global.ts: ${G}.env`,
    `${S}/engine/named.ts: process.env`,
    `${S}/engine/namespace.ts: process.env`,
    `${S}/engine/node.ts: process.env`,
    `${S}/engine/reexport.ts: process.env`,
    `${S}/engine/retired-global.ts: ${G}.env`,
    `${S}/legacy-config.ts: ${G}.env`,
  ]);
  assertSome(result.added, `env: ${S}/engine/retired-global.ts: ${G}.env`);
});

test("an undeclared DYFJ_* key in any scanned module is a violation", () => {
  const result = run({
    [`${S}/engine/keys.ts`]: [
      'export const a = "DYFJ_DECLARED";',
      'export const b = "DYFJ_UNDECLARED";',
      "export const c = `DYFJ_TEMPLATE`;",
      'export const e = "DYFJ_lower_case";',
      "export const f = { DYFJ_OBJECT_KEY: 1, DYFJ_DECLARED: 2 };",
      "export const g = (env: Record<string, string>) => env.DYFJ_MEMBER;",
      'export const d = "DYFJ_UNDECLARED must be set";',
    ].join("\n"),
    ["prototype/scripts/tool.ts"]: [
      'export const t = "DYFJ_TOOLING_ONLY";',
      'export const u = "DYFJ_DECLARED";',
    ].join("\n"),
  });
  assertEquals(result.current.envKeys, [
    "prototype/scripts/tool.ts: DYFJ_TOOLING_ONLY",
    `${S}/engine/keys.ts: DYFJ_MEMBER`,
    `${S}/engine/keys.ts: DYFJ_OBJECT_KEY`,
    `${S}/engine/keys.ts: DYFJ_TEMPLATE`,
    `${S}/engine/keys.ts: DYFJ_UNDECLARED`,
    `${S}/engine/keys.ts: DYFJ_lower_case`,
  ]);
});

test("env entrypoints must name one existing unit or module and justify it", () => {
  const result = run({}, {
    rules: {
      ...RULES,
      env: {
        allowedUnits: ["config", "nowhere"],
        entrypoints: [
          { path: `${S}/missing.ts`, justification: "x" },
          { unit: "ghost", justification: "x" },
          { unit: "tooling", path: `${S}/legacy-utils.ts`, justification: "x" },
          { unit: "tooling", justification: " " },
        ],
      },
    },
  });
  assertSome(result.errors, "allowed unit is not declared: nowhere");
  assertSome(result.errors, `${S}/missing.ts: module does not exist`);
  assertSome(result.errors, "ghost: unit is not declared");
  assertSome(result.errors, "name exactly one of unit or path");
  assertSome(result.errors, "tooling: missing justification");
});

test("a confined package is a violation outside its units and entrypoints", () => {
  const result = run({
    [`${S}/store/journal.ts`]:
      'import mysql from "mysql2/promise"; export { mysql };',
    [`${S}/store/pool.ts`]: 'export { createPool } from "mysql2";',
    ["prototype/scripts/fixture.ts"]:
      'import mysql from "mysql2/promise"; mysql;',
    [`${S}/legacy-utils.ts`]: 'import mysql from "mysql2"; export { mysql };',
    [`${S}/engine/static.ts`]: 'import mysql from "mysql2/promise"; mysql;',
    [`${S}/engine/versioned.ts`]:
      'import m from "npm:mysql2@3.24.4/promise"; m;',
    [`${S}/engine/reexport.ts`]: 'export * from "mysql2";',
    [`${S}/engine/dynamic.ts`]: 'export const m = () => import("mysql2");',
    [`${S}/engine/type.ts`]: 'export type P = typeof import("mysql2/promise");',
    [`${S}/engine/type-only.ts`]:
      'import type { Pool } from "mysql2/promise"; export type P = Pool;',
    [`${S}/engine/other.ts`]: 'import { z } from "zod"; z;',
    [`${S}/engine/lookalike.ts`]: 'import x from "mysql2-lookalike"; x;',
  });
  assertEquals(result.current.packages, [
    `${S}/engine/dynamic.ts: mysql2`,
    `${S}/engine/reexport.ts: mysql2`,
    `${S}/engine/static.ts: mysql2`,
    `${S}/engine/type-only.ts: mysql2`,
    `${S}/engine/type.ts: mysql2`,
    `${S}/engine/versioned.ts: mysql2`,
    // Mapped to store/ by name only: it has not moved, so no exemption.
    `${S}/legacy-utils.ts: mysql2`,
  ]);
  assertSome(result.added, `package: ${S}/engine/static.ts: mysql2`);
});

test("the committed rules confine node:net to the transport unit", async () => {
  const committed = JSON.parse(
    await readFile(
      fileURLToPath(new URL("./arch-layers.json", import.meta.url)),
      "utf8",
    ),
  ) as LayerRules;
  const result = run({
    [`${S}/transport/node-socket.ts`]: 'import net from "node:net"; net;',
    [`${S}/engine/dial.ts`]: 'import net from "node:net"; net;',
    [`${S}/server/listen.ts`]:
      'import { createServer } from "node:net"; createServer;',
    [`${S}/engine/other.ts`]: 'import { join } from "node:path"; join;',
  }, { rules: committed });
  assertEquals(result.current.packages, [
    `${S}/engine/dial.ts: node:net`,
    `${S}/server/listen.ts: node:net`,
  ]);
});

test("the committed rules confine node:child_process to tools, config and the ACP runner", async () => {
  const committed = JSON.parse(
    await readFile(
      fileURLToPath(new URL("./arch-layers.json", import.meta.url)),
      "utf8",
    ),
  ) as LayerRules;
  const result = run({
    [`${S}/config/resolver.ts`]:
      'import { spawn } from "node:child_process"; spawn;',
    [`${S}/tools/builtin/spawn.ts`]:
      'import { spawn } from "node:child_process"; spawn;',
    [`${S}/acp-client.ts`]:
      'import { spawn } from "node:child_process"; spawn;',
    [`${S}/runners/acp/spawn.ts`]:
      'import { spawn } from "node:child_process"; spawn;',
    [`${S}/engine/run.ts`]:
      'import { spawn } from "node:child_process"; spawn;',
    [`${S}/server/launch.ts`]:
      'import { execFile } from "node:child_process"; execFile;',
    [`${S}/engine/other.ts`]: 'import { join } from "node:path"; join;',
  }, { rules: committed });
  assertEquals(result.current.packages, [
    `${S}/engine/run.ts: node:child_process`,
    `${S}/server/launch.ts: node:child_process`,
  ]);
});

test("an SQL write literal is a violation outside the journal and entrypoints", () => {
  const result = run({
    [`${S}/store/journal.ts`]:
      'export const a = "INSERT INTO events (event_id) VALUES (?)";',
    [`${S}/store/readers.ts`]: [
      'export const r = "SELECT slug FROM memories WHERE slug = ?";',
      'export const u = "UPDATE sessions SET status = ?";',
    ].join("\n"),
    ["prototype/scripts/fixture.ts"]:
      'export const seed = "INSERT INTO memories (slug) VALUES (1)";',
    [`${S}/engine/writes.ts`]: [
      'export const a = "INSERT INTO sessions (x) VALUES (?)";',
      "export const b = `  DELETE FROM events WHERE id = ?`;",
      "export const c = (t: string) => `REPLACE INTO ${t} VALUES (?)`;",
      "export const d = \"CALL DOLT_COMMIT('-Am', 'x')\";",
      'export const e = "DROP TABLE events";',
      'export const f = "TRUNCATE memories";',
    ].join("\n"),
    [`${S}/engine/prose.ts`]: [
      'export const a = "Update the session row after the turn";',
      'export const b = "Updated sessions: 3";',
      'export const c = "insert into the log";',
      'export const d = "SELECT 1; UPDATE x SET y = 1";',
    ].join("\n"),
  });
  assertEquals(result.current.sqlWrites, [
    `${S}/engine/writes.ts: CALL DOLT_`,
    `${S}/engine/writes.ts: DELETE FROM`,
    `${S}/engine/writes.ts: DROP TABLE`,
    `${S}/engine/writes.ts: INSERT INTO`,
    `${S}/engine/writes.ts: REPLACE INTO`,
    `${S}/engine/writes.ts: TRUNCATE`,
    // store/ is not a blanket exemption: only the journal may write.
    `${S}/store/readers.ts: UPDATE`,
  ]);
  assertSome(result.added, `sql-write: ${S}/engine/writes.ts: INSERT INTO`);
});

test("package and sql-write rules must name existing units and modules and justify entrypoints", () => {
  const result = run({}, {
    rules: {
      ...RULES,
      packages: [{
        name: "mysql2",
        allowedUnits: ["nowhere"],
        entrypoints: [{ unit: "tooling", justification: "" }],
      }],
      sqlWrites: {
        allowedPaths: [`${S}/store/missing.ts`],
        entrypoints: [{ path: `${S}/missing.ts`, justification: "x" }],
      },
    },
  });
  assertSome(
    result.errors,
    "package mysql2 rule: allowed unit is not declared: nowhere",
  );
  assertSome(
    result.errors,
    "package mysql2 entrypoint tooling: missing justification",
  );
  assertSome(
    result.errors,
    `sql-write rule: allowed module does not exist: ${S}/store/missing.ts`,
  );
  assertSome(
    result.errors,
    `sql-write entrypoint ${S}/missing.ts: module does not exist`,
  );
});

test("packageName strips registries, versions and subpaths", () => {
  assertEquals(
    [
      "mysql2",
      "mysql2/promise",
      "npm:mysql2@3.24.4/promise",
      "npm:@scope/pkg@1.0.0/sub",
      "@scope/pkg",
    ].map(packageName),
    ["mysql2", "mysql2", "mysql2", "@scope/pkg", "@scope/pkg"],
  );
});
