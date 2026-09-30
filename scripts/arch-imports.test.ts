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
import {
  functionSpans,
  hardLimitViolations,
  type SizeException,
  sizeReport,
} from "./arch-imports-size.ts";

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
const LINT_CONFIG = fileURLToPath(
  new URL("./arch-imports-lint.json", import.meta.url),
);

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

// Writes the fixture modules into a temporary tree and builds the graph with
// the real `deno info`, so every rule test runs through the same parser as the
// lane.
async function run(
  files: Record<string, string>,
  overrides: Partial<AnalysisInput> = {},
) {
  const all: Record<string, string> = {
    [`${S}/legacy-utils.ts`]: "export {};",
    [`${S}/store/journal.ts`]: "export {};",
    ...files,
  };
  const root = Deno.realPathSync(await Deno.makeTempDir());
  try {
    for (const [path, source] of Object.entries(all)) {
      await Deno.mkdir(`${root}/${path.split("/").slice(0, -1).join("/")}`, {
        recursive: true,
      });
      await Deno.writeTextFile(`${root}/${path}`, source);
    }
    const modules = Object.keys(all);
    const graph = await loadModuleGraph(
      root,
      new Set(modules),
      Deno.execPath(),
      LINT_CONFIG,
    );
    const extra = new Set(["prototype/testing/cycle.test.ts"]);
    return analyze({
      modules,
      graph,
      rules: RULES,
      allowList: [],
      baseline: EMPTY,
      declaredEnvKeys: new Set(["DYFJ_DECLARED"]),
      exists: (path) => path in all || extra.has(path),
      ...overrides,
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Graph

const E = `${S}/engine`;

function edgesFrom(
  result: Awaited<ReturnType<typeof run>>,
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

Deno.test("the graph has static, re-export, type-only, and dynamic edges", async () => {
  const result = await run({
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

Deno.test("import-like text outside real imports adds no edges", async () => {
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
  const result = await run({
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

Deno.test("a module that does not parse fails the lane", async () => {
  const result = await run({ [`${E}/broken.ts`]: "export const = ;" });
  assertEquals(result.errors, [`module failed to load: ${E}/broken.ts`]);
});

Deno.test("an extensionless local import does not resolve", async () => {
  const result = await run({
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

Deno.test("an unresolved local import and an unmapped module fail", async () => {
  const result = await run({
    [`${S}/kernel/a.ts`]: 'import { gone } from "./gone.ts";',
    [`${S}/mystery.ts`]: "export {};",
  });
  assertSome(result.errors, 'unresolved local import "./gone.ts"');
  assertSome(
    result.errors,
    `unmapped module (add it to scripts/arch-layers.json): ${S}/mystery.ts`,
  );
});

Deno.test("a name mapping for a module that no longer exists fails", async () => {
  const result = await run({}, {
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

Deno.test("an import cycle is a violation, type-only edges included", async () => {
  const result = await run({
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

Deno.test("upward and non-listed same-layer edges are layer violations", async () => {
  const result = await run({
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

Deno.test("a types-only same-layer edge fails when it imports values", async () => {
  const result = await run({
    [`${S}/providers/p.ts`]: "export type P = 1; export const p = 1;",
    [`${S}/context/types.ts`]: 'import type { P } from "../providers/p.ts";',
    [`${S}/context/values.ts`]: 'import { p } from "../providers/p.ts";',
  });
  assertEquals(result.current.layer, [
    `${S}/context/values.ts -> ${S}/providers/p.ts`,
  ]);
});

Deno.test("cli/ may import only its allow-list", async () => {
  const result = await run({
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

Deno.test("only server/ and cli/ may import extensions/, whatever the layer", async () => {
  const result = await run({
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

Deno.test("an importOnlyFrom rule must name declared units", async () => {
  const result = await run({}, {
    rules: {
      ...RULES,
      importOnlyFrom: [{ unit: "extensions/*", importers: ["servr"] }],
    },
  });
  assertSome(result.errors, "importOnlyFrom rule: unit is not declared: servr");
});

Deno.test("dynamic local imports are violations; package imports are not", async () => {
  const result = await run({
    [`${S}/engine/e.ts`]: [
      'const { k } = await import("../kernel/k.ts");',
      'const { k: again } = await import("../kernel/k.ts");',
      'const { parse } = await import("@std/toml");',
    ].join("\n"),
    [`${S}/kernel/k.ts`]: "export const k = 1;",
  });
  assertEquals(result.current.dynamic, [
    `${S}/engine/e.ts -> ${S}/kernel/k.ts`,
  ]);
});

Deno.test("a dynamic import is a violation even beside a static one", async () => {
  // deno_graph merges these into one static dependency; the lint pass still
  // sees the dynamic import.
  const result = await run({
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

Deno.test("a non-literal dynamic import is a violation", async () => {
  const result = await run({
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

Deno.test("deep imports past a mod.ts are reported, never failed", async () => {
  const baseline: Baseline = EMPTY;
  const result = await run({
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

Deno.test("an allow-listed cycle passes, including its dynamic edge", async () => {
  const result = await run(CYCLE, { allowList: [ENTRY] });
  assertEquals(result.errors, []);
  assertEquals(result.current, EMPTY);
  assertEquals(result.added, []);
});

Deno.test("an allow-listed cycle still fails layer and cli/ rules", async () => {
  const up = `${S}/kernel/k.ts -> ${S}/engine/e.ts`;
  const down = `${S}/engine/e.ts -> ${S}/kernel/k.ts`;
  const result = await run({
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

Deno.test("an allow-list entry naming a non-cycle edge fails", async () => {
  const edge = `${S}/engine/e.ts -> ${S}/kernel/k.ts`;
  const result = await run({
    [`${S}/engine/e.ts`]: 'const { k } = await import("../kernel/k.ts");',
    [`${S}/kernel/k.ts`]: "export const k = 1;",
  }, { allowList: [{ ...ENTRY, edges: [edge] }] });
  assertEquals(result.errors, [
    `allow-list entry tool round trip: edge is not part of an import cycle: ${edge}`,
  ]);
});

Deno.test("an allow-list entry whose cited test file is missing fails", async () => {
  const result = await run(CYCLE, {
    allowList: [{ ...ENTRY, test: "prototype/testing/missing.test.ts" }],
  });
  assertEquals(result.errors, [
    "allow-list entry tool round trip: test file does not exist: prototype/testing/missing.test.ts",
  ]);
});

Deno.test("a stale allow-list entry fails when its edges no longer occur", async () => {
  const result = await run({
    [`${S}/tools/a.ts`]: 'import { b } from "./b.ts";',
    [`${S}/tools/b.ts`]: "export const b = 1;",
  }, { allowList: [ENTRY] });
  // The surviving edge is no longer part of a cycle, so it is flagged too.
  assertEquals(result.errors, [
    `allow-list entry tool round trip: edge is not part of an import cycle: ${S}/tools/a.ts -> ${S}/tools/b.ts`,
    `allow-list entry tool round trip: edge no longer occurs: ${S}/tools/b.ts -> ${S}/tools/a.ts`,
  ]);
});

Deno.test("an allow-list entry needs a name, a justification, and a test", async () => {
  const result = await run(CYCLE, {
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

Deno.test("the ratchet fails on a new violation and on a stale baseline entry", async () => {
  const baseline: Baseline = {
    cycles: [],
    layer: [`${S}/kernel/k.ts -> ${S}/engine/gone.ts`],
    cli: [],
    dynamic: [],
    env: [],
    envKeys: [],
  };
  const result = await run({
    [`${S}/kernel/k.ts`]: 'import { e } from "../engine/e.ts";',
    [`${S}/engine/e.ts`]: "export const e = 1;",
  }, { baseline });
  assertEquals(result.added, [`layer: ${S}/kernel/k.ts -> ${S}/engine/e.ts`]);
  assertEquals(result.stale, [
    `layer: ${S}/kernel/k.ts -> ${S}/engine/gone.ts`,
  ]);
});

Deno.test("the ratchet passes when the tree matches the baseline", async () => {
  const files = {
    [`${S}/kernel/k.ts`]: 'import { e } from "../engine/e.ts";',
    [`${S}/engine/e.ts`]: "export const e = 1;",
  };
  const first = await run(files);
  const second = await run(files, { baseline: first.current });
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

// Hard limits (PRD-11 R2): a runtime module over 1,000 lines or a function
// over 200 fails unless an exception names it; an excepted one may only shrink.
const bigModule = "x;\n".repeat(1001);
const bigFunction = `function big() {\n${"  work();\n".repeat(200)}}\n`;
const runtimeOnly = (path: string) => path.startsWith("src/");

Deno.test("an unexcepted module or function over its hard limit fails", () => {
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

Deno.test("an excepted module or function passes at or under its recorded size", () => {
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

Deno.test("an excepted module that grows past its recorded size fails", () => {
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

Deno.test("an exception for something back under its limit must be removed", () => {
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

Deno.test("hard limits skip modules outside the runtime", () => {
  assertEquals(
    hardLimitViolations(
      new Map([["prototype/scripts/tool.ts", bigModule + bigFunction]]),
      runtimeOnly,
      [],
    ),
    [],
  );
});

Deno.test("a size exception without a reason, or listed twice, fails", () => {
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

Deno.test("a size exceptions file that is not an array of objects fails, not throws", () => {
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

Deno.test("the committed size exceptions each carry a reason", async () => {
  const committed = JSON.parse(
    await Deno.readTextFile(
      fileURLToPath(new URL("./arch-size-exceptions.json", import.meta.url)),
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

Deno.test("direct env access is a violation outside config/ and named entrypoints", async () => {
  const result = await run({
    [`${S}/config/env.ts`]: "export const e = Deno.env;",
    [`${S}/legacy-config.ts`]: 'Deno.env.get("HOME");',
    [`${S}/server/main.ts`]: 'Deno.env.get("HOME");',
    ["prototype/scripts/tool.ts"]: 'Deno.env.get("HOME");',
    [`${S}/engine/deno.ts`]: 'Deno.env.get("HOME");',
    [`${S}/engine/global.ts`]: 'globalThis.Deno.env.get("HOME");',
    [`${S}/engine/computed.ts`]: 'Deno["env"].get("HOME");',
    [`${S}/engine/computed-template.ts`]: "process[`env`].HOME;",
    [`${S}/engine/destructure.ts`]: "const { env } = Deno; env.get('HOME');",
    [`${S}/engine/node.ts`]:
      'import process from "node:process"; process.env.HOME;',
    [`${S}/engine/named.ts`]: 'import { env } from "node:process"; env.HOME;',
    [`${S}/engine/other.ts`]:
      'import process from "node:process"; process.stdin; Deno.args;',
    [`${S}/engine/namespace.ts`]:
      'import * as p from "node:process"; p.env.HOME;',
    [`${S}/engine/default-alias.ts`]:
      'import nodeProcess from "node:process"; nodeProcess.env.HOME;',
    [`${S}/engine/default-named.ts`]:
      'import { default as q } from "process"; q["env"].HOME;',
    [`${S}/engine/const-alias.ts`]: "const d = Deno; d.env.get('HOME');",
    [`${S}/engine/global-alias.ts`]:
      "const d = globalThis.Deno; const e = d; e.env.get('HOME');",
    [`${S}/engine/global-object-alias.ts`]:
      "const g = globalThis; g.process.env.HOME;",
    [`${S}/engine/global-destructure.ts`]:
      "const { Deno: D } = globalThis; D.env.get('HOME');",
    [`${S}/engine/alias-destructure.ts`]:
      'import * as p from "node:process"; const { env } = p; env.HOME;',
    [`${S}/engine/reexport.ts`]: 'export { env } from "node:process";',
    [`${S}/engine/other-alias.ts`]:
      'import * as p from "node:process"; p.stdin; const d = Deno; d.args;',
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
    `${S}/engine/computed.ts: Deno.env`,
    `${S}/engine/const-alias.ts: Deno.env`,
    `${S}/engine/default-alias.ts: process.env`,
    `${S}/engine/default-named.ts: process.env`,
    `${S}/engine/deno.ts: Deno.env`,
    `${S}/engine/destructure.ts: Deno.env`,
    `${S}/engine/global-alias.ts: Deno.env`,
    `${S}/engine/global-destructure.ts: Deno.env`,
    `${S}/engine/global-object-alias.ts: process.env`,
    `${S}/engine/global.ts: Deno.env`,
    `${S}/engine/named.ts: process.env`,
    `${S}/engine/namespace.ts: process.env`,
    `${S}/engine/node.ts: process.env`,
    `${S}/engine/reexport.ts: process.env`,
    `${S}/legacy-config.ts: Deno.env`,
  ]);
  assertSome(result.added, `env: ${S}/engine/deno.ts: Deno.env`);
});

Deno.test("an undeclared DYFJ_* key in any scanned module is a violation", async () => {
  const result = await run({
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

Deno.test("env entrypoints must name one existing unit or module and justify it", async () => {
  const result = await run({}, {
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

Deno.test("a confined package is a violation outside its units and entrypoints", async () => {
  const result = await run({
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

Deno.test("an SQL write literal is a violation outside the journal and entrypoints", async () => {
  const result = await run({
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

Deno.test("package and sql-write rules must name existing units and modules and justify entrypoints", async () => {
  const result = await run({}, {
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

Deno.test("packageName strips registries, versions and subpaths", () => {
  assertEquals(
    [
      "mysql2",
      "mysql2/promise",
      "npm:mysql2@3.24.4/promise",
      "npm:@scope/pkg@1.0.0/sub",
      "@scope/pkg",
      "jsr:@std/assert@1",
    ].map(packageName),
    ["mysql2", "mysql2", "mysql2", "@scope/pkg", "@scope/pkg", "@std/assert"],
  );
});
