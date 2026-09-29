/**
 * arch.imports: module-boundary checker for the prototype runtime.
 *
 * Implements `specs/01-architecture.md` sections 3-4 in ratchet mode:
 *
 * - Builds the module graph of every module under the roots listed in
 *   `arch-layers.json` with `deno info` (`arch-imports-graph.ts`): static
 *   imports, re-exports, and dynamic `import()`, with type-only edges marked.
 *   Every dynamic `import()`, literal or not, comes from `deno lint` with the
 *   plugin in `arch-imports-lint-plugin.ts`.
 *   Test files and test fixtures are not part of the graph and are skipped.
 * - Maps every module to a unit (target directory) and layer. Modules that have
 *   not moved yet are mapped by name in `arch-layers.json`; a module the rules
 *   do not map fails the lane, so a new file cannot escape the rules.
 * - Violations: import cycles (Tarjan SCCs; every edge inside a strongly
 *   connected component, type-only edges included), upward or non-listed
 *   same-layer edges, imports of a unit from outside its `importOnlyFrom`
 *   importers (only `server/` and `cli/` import `extensions/`), `cli/`
 *   allow-list breaches, dynamic local imports,
 *   direct `Deno.env`/`process.env` access outside `config/` and the
 *   entrypoints named in `arch-layers.json`, and `DYFJ_*` key literals in
 *   any scanned module (runtime, `mcp/` and the `scripts/` tooling) that
 *   `CONFIG_SCHEMA` does not declare; a confined package (`mysql2`) imported
 *   outside the units and entrypoints allowed to use it; and a string literal
 *   that begins with an SQL write statement outside the modules allowed to
 *   write (`store/`'s journal, and the named entrypoints).
 *   An entry in `arch-cycles.json` (AGENTS.md rule 1) must name edges inside a
 *   cycle, and exempts them from the cycle and dynamic-import rules only.
 * - Ratchet: violations are compared with `arch-imports-baseline.json`. A
 *   violation not in the baseline fails, and so does a baseline entry that no
 *   longer occurs, which forces the baseline to shrink as work lands.
 * - Report only, never failing: deep imports that bypass a directory's
 *   `mod.ts`, and the size report (`arch-imports-size.ts`).
 *
 * Usage (from the repository root; `--deno=<path>` selects the Deno binary
 * that runs `deno info`, default `deno` on PATH):
 *   deno run --allow-read=. --allow-run=deno scripts/arch-imports.ts
 *   deno run --allow-read=. --allow-run=deno \
 *     --allow-write=scripts/arch-imports-baseline.json \
 *     scripts/arch-imports.ts --write-baseline
 */

import {
  type Edge,
  loadModuleGraph,
  type ModuleGraph,
} from "./arch-imports-graph.ts";
import { repoRootFromMeta } from "./scan-lib.ts";
import { formatSizeReport, sizeReport } from "./arch-imports-size.ts";
import { CONFIG_SCHEMA } from "../prototype/src/config/schema.ts";

// ---------------------------------------------------------------------------
// Rules

export interface UnitRule {
  dir: string;
  layer: number;
  outside?: boolean;
  path?: string;
}

export interface LayerRules {
  roots: string[];
  sourceRoot: string;
  exclude: string[];
  units: UnitRule[];
  sameLayerEdges: { from: string; to: string; typesOnly?: boolean }[];
  cli: { unit: string; allowedUnits: string[]; allowedPaths: string[] };
  /**
   * Units only some units may import, whatever their layers (spec section
   * 6: the core never imports `extensions/`; only `server/` and `cli/` do).
   * `unit` and each importer are declared unit patterns. A breach is a
   * layer violation.
   */
  importOnlyFrom?: { unit: string; importers: string[] }[];
  env: EnvRules;
  packages: PackageRule[];
  sqlWrites: SqlWriteRules;
  files: Record<string, string>;
}

/**
 * A package only some units may import (spec section 4): `name` is the
 * package name as it appears in a specifier (`mysql2` matches `mysql2`,
 * `mysql2/promise` and `npm:mysql2@3/promise`).
 */
export interface PackageRule {
  name: string;
  allowedUnits: string[];
  entrypoints: EnvEntrypoint[];
}

/**
 * Where SQL write statements may be written (spec 02 section 2): the named
 * modules (the journal) and the named entrypoints, each justified.
 */
export interface SqlWriteRules {
  allowedPaths: string[];
  entrypoints: EnvEntrypoint[];
}

/**
 * Where the process environment may be read directly (spec section 4): the
 * units in `allowedUnits` (the `Env` port's home) and the named entrypoints.
 * An entrypoint names either a `unit` (as declared) or an exact module `path`,
 * and must justify its exemption.
 */
export interface EnvRules {
  allowedUnits: string[];
  entrypoints: EnvEntrypoint[];
}

export interface EnvEntrypoint {
  unit?: string;
  path?: string;
  justification: string;
}

export interface CycleAllowEntry {
  name: string;
  edges: string[];
  justification: string;
  test: string;
}

export interface Baseline {
  cycles: { members: string[]; edges: string[] }[];
  layer: string[];
  cli: string[];
  dynamic: string[];
  /** `<module>: Deno.env|process.env` read outside config/ and entrypoints. */
  env: string[];
  /** `<module>: DYFJ_*` key in a scanned module that the schema lacks. */
  envKeys: string[];
  /** `<module>: <package>` import of a confined package outside its units. */
  packages?: string[];
  /** `<module>: <statement>` SQL write literal outside the allowed modules. */
  sqlWrites?: string[];
}

interface Unit {
  name: string; // concrete, e.g. "extensions/ideas"
  pattern: string; // as declared, e.g. "extensions/*"
  layer: number;
  outside: boolean;
}

function matchPattern(pattern: string, value: string): boolean {
  const a = pattern.split("/");
  const b = value.split("/");
  if (a.length !== b.length) return false;
  return a.every((seg, index) => seg === "*" || seg === b[index]);
}

// Longest declared unit directory that prefixes `rest` (a path under the
// source root), with `*` matching exactly one segment.
function unitFromDirectory(rules: LayerRules, rest: string): Unit | undefined {
  const segments = rest.split("/").slice(0, -1);
  let best: Unit | undefined;
  let bestLength = -1;
  for (const rule of rules.units) {
    if (rule.path !== undefined) continue;
    const length = rule.dir.split("/").length;
    if (length > segments.length || length <= bestLength) continue;
    const concrete = segments.slice(0, length).join("/");
    if (!matchPattern(rule.dir, concrete)) continue;
    best = {
      name: concrete,
      pattern: rule.dir,
      layer: rule.layer,
      outside: rule.outside === true,
    };
    bestLength = length;
  }
  return best;
}

export function unitFor(rules: LayerRules, path: string): Unit | undefined {
  const named = rules.files[path];
  if (named !== undefined) {
    const rule = rules.units.find((u) => matchPattern(u.dir, named));
    if (rule === undefined) return undefined;
    return {
      name: named,
      pattern: rule.dir,
      layer: rule.layer,
      outside: rule.outside === true,
    };
  }
  for (const rule of rules.units) {
    if (rule.path !== undefined && path.startsWith(`${rule.path}/`)) {
      return {
        name: rule.dir,
        pattern: rule.dir,
        layer: rule.layer,
        outside: rule.outside === true,
      };
    }
  }
  if (path.startsWith(`${rules.sourceRoot}/`)) {
    return unitFromDirectory(rules, path.slice(rules.sourceRoot.length + 1));
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Graph analysis

export function edgeKey(from: string, to: string): string {
  return `${from} -> ${to}`;
}

/** Tarjan's strongly connected components, members sorted, SCCs sorted. */
export function stronglyConnected(
  nodes: readonly string[],
  adjacency: ReadonlyMap<string, readonly string[]>,
): string[][] {
  let index = 0;
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const result: string[][] = [];
  const visit = (node: string) => {
    indices.set(node, index);
    low.set(node, index);
    index++;
    stack.push(node);
    onStack.add(node);
    for (const next of adjacency.get(node) ?? []) {
      if (!indices.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node)!, low.get(next)!));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node)!, indices.get(next)!));
      }
    }
    if (low.get(node) === indices.get(node)) {
      const component: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
      } while (member !== node);
      result.push(component.sort());
    }
  };
  for (const node of [...nodes].sort()) {
    if (!indices.has(node)) visit(node);
  }
  return result.sort((a, b) => a[0]!.localeCompare(b[0]!));
}

export interface AnalysisInput {
  /** Repo-relative path of every scanned module. */
  modules: readonly string[];
  /** Edges between scanned modules, plus load and resolution errors. */
  graph: ModuleGraph;
  rules: LayerRules;
  allowList: readonly CycleAllowEntry[];
  baseline: Baseline;
  /** Every env key declared in the config schema (`CONFIG_SCHEMA`). */
  declaredEnvKeys: ReadonlySet<string>;
  /** Whether a repo-relative path exists (resolution and allow-list tests). */
  exists: (path: string) => boolean;
}

export interface AnalysisResult {
  edges: Edge[];
  current: Baseline;
  /** Violations not in the baseline. */
  added: string[];
  /** Baseline entries that no longer occur. */
  stale: string[];
  /** Allow-list and mapping errors; any entry fails the lane. */
  errors: string[];
  /** Report only. */
  deepImports: string[];
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function validateExemptions(
  rule: string,
  rules: LayerRules,
  units: ReadonlyMap<string, Unit>,
  allowedUnits: readonly string[],
  entrypoints: readonly EnvEntrypoint[],
): string[] {
  const errors: string[] = [];
  const declared = new Set(rules.units.map((u) => u.dir));
  for (const unit of allowedUnits) {
    if (!declared.has(unit)) {
      errors.push(`${rule} rule: allowed unit is not declared: ${unit}`);
    }
  }
  entrypoints.forEach((entry, position) => {
    const label = entry.path ?? entry.unit ?? `#${position}`;
    if ((entry.unit === undefined) === (entry.path === undefined)) {
      errors.push(
        `${rule} entrypoint ${label}: name exactly one of unit or path`,
      );
    } else if (entry.unit !== undefined && !declared.has(entry.unit)) {
      errors.push(`${rule} entrypoint ${label}: unit is not declared`);
    } else if (entry.path !== undefined && !units.has(entry.path)) {
      errors.push(`${rule} entrypoint ${label}: module does not exist`);
    }
    if (
      typeof entry.justification !== "string" ||
      entry.justification.trim() === ""
    ) {
      errors.push(`${rule} entrypoint ${label}: missing justification`);
    }
  });
  return errors;
}

export function validateEnvRules(
  rules: LayerRules,
  units: ReadonlyMap<string, Unit>,
): string[] {
  return validateExemptions(
    "env",
    rules,
    units,
    rules.env.allowedUnits,
    rules.env.entrypoints,
  );
}

export function validatePackageAndSqlRules(
  rules: LayerRules,
  units: ReadonlyMap<string, Unit>,
): string[] {
  const errors: string[] = [];
  for (const rule of rules.packages) {
    errors.push(
      ...validateExemptions(
        `package ${rule.name}`,
        rules,
        units,
        rule.allowedUnits,
        rule.entrypoints,
      ),
    );
  }
  for (const path of rules.sqlWrites.allowedPaths) {
    if (!units.has(path)) {
      errors.push(`sql-write rule: allowed module does not exist: ${path}`);
    }
  }
  errors.push(
    ...validateExemptions(
      "sql-write",
      rules,
      units,
      [],
      rules.sqlWrites.entrypoints,
    ),
  );
  return errors;
}

/** `mysql2/promise`, `npm:mysql2@3/promise` -> `mysql2`; scoped names kept. */
export function packageName(specifier: string): string {
  const bare = specifier.replace(/^(?:npm|jsr):/, "");
  const segments = bare.split("/");
  const strip = (segment: string) => segment.replace(/(.)@.*$/, "$1");
  return bare.startsWith("@")
    ? `${segments[0]}/${strip(segments[1] ?? "")}`
    : strip(segments[0]!);
}

export function flattenBaseline(baseline: Baseline): string[] {
  return [
    ...baseline.cycles.flatMap((c) => c.edges.map((e) => `cycle: ${e}`)),
    ...baseline.layer.map((e) => `layer: ${e}`),
    ...baseline.cli.map((e) => `cli: ${e}`),
    ...baseline.dynamic.map((e) => `dynamic: ${e}`),
    ...baseline.env.map((e) => `env: ${e}`),
    ...baseline.envKeys.map((e) => `env-key: ${e}`),
    ...(baseline.packages ?? []).map((e) => `package: ${e}`),
    ...(baseline.sqlWrites ?? []).map((e) => `sql-write: ${e}`),
  ].sort();
}

export function validateAllowList(
  allowList: readonly CycleAllowEntry[],
  edgeKeys: ReadonlySet<string>,
  cycleEdgeKeys: ReadonlySet<string>,
  exists: (path: string) => boolean,
): string[] {
  const errors: string[] = [];
  const names = new Set<string>();
  allowList.forEach((entry, position) => {
    const label = typeof entry.name === "string" && entry.name.trim() !== ""
      ? entry.name
      : `#${position}`;
    if (typeof entry.name !== "string" || entry.name.trim() === "") {
      errors.push(`allow-list entry ${label}: missing name`);
    } else if (names.has(entry.name)) {
      errors.push(`allow-list entry ${label}: duplicate name`);
    }
    if (typeof entry.name === "string" && entry.name.trim() !== "") {
      names.add(entry.name);
    }
    if (
      typeof entry.justification !== "string" ||
      entry.justification.trim() === ""
    ) {
      errors.push(`allow-list entry ${label}: missing justification`);
    }
    if (!Array.isArray(entry.edges) || entry.edges.length === 0) {
      errors.push(`allow-list entry ${label}: no edges`);
    } else {
      for (const edge of entry.edges) {
        if (!edgeKeys.has(edge)) {
          errors.push(
            `allow-list entry ${label}: edge no longer occurs: ${edge}`,
          );
        } else if (!cycleEdgeKeys.has(edge)) {
          errors.push(
            `allow-list entry ${label}: edge is not part of an import cycle: ${edge}`,
          );
        }
      }
    }
    if (typeof entry.test !== "string" || entry.test.trim() === "") {
      errors.push(`allow-list entry ${label}: missing test path`);
    } else if (!exists(entry.test)) {
      errors.push(
        `allow-list entry ${label}: test file does not exist: ${entry.test}`,
      );
    }
  });
  return errors;
}

/** Every strongly connected component that forms a cycle, with its edges. */
export function cycleComponents(
  modules: readonly string[],
  edges: readonly Edge[],
): { members: string[]; edges: string[] }[] {
  const adjacency = new Map<string, string[]>();
  for (const e of edges) {
    const list = adjacency.get(e.from) ?? [];
    if (!list.includes(e.to)) list.push(e.to);
    adjacency.set(e.from, list);
  }
  for (const list of adjacency.values()) list.sort();
  const result: { members: string[]; edges: string[] }[] = [];
  for (const component of stronglyConnected(modules, adjacency)) {
    const members = new Set(component);
    const selfLoop = component.length === 1 &&
      (adjacency.get(component[0]!) ?? []).includes(component[0]!);
    if (component.length < 2 && !selfLoop) continue;
    const inside = sortedUnique(
      edges.filter((e) => members.has(e.from) && members.has(e.to))
        .map((e) => edgeKey(e.from, e.to)),
    );
    result.push({ members: component, edges: inside });
  }
  return result;
}

export type { Edge };

export function analyze(input: AnalysisInput): AnalysisResult {
  const { rules } = input;
  const errors: string[] = [];
  const modules = [...input.modules].sort();
  const known = new Set(modules);
  const units = new Map<string, Unit>();
  for (const path of modules) {
    const unit = unitFor(rules, path);
    if (unit === undefined) {
      errors.push(
        `unmapped module (add it to scripts/arch-layers.json): ${path}`,
      );
    } else {
      units.set(path, unit);
    }
  }
  for (const path of Object.keys(rules.files)) {
    if (!known.has(path)) {
      errors.push(`mapped module no longer exists: ${path}`);
    }
  }

  const edges = input.graph.edges;
  errors.push(...input.graph.errors);

  // Allow-list entries may name only edges that sit inside an import cycle.
  const components = cycleComponents(modules, edges);
  const edgeKeys = new Set(edges.map((e) => edgeKey(e.from, e.to)));
  const cycleEdgeKeys = new Set(components.flatMap((c) => c.edges));
  errors.push(
    ...validateAllowList(
      input.allowList,
      edgeKeys,
      cycleEdgeKeys,
      input.exists,
    ),
  );
  const allowed = new Set(
    input.allowList.flatMap((entry) => entry.edges ?? []),
  );
  const cycles: Baseline["cycles"] = components
    .map((c) => ({
      members: c.members,
      edges: c.edges.filter((key) => !allowed.has(key)),
    }))
    .filter((c) => c.edges.length > 0);

  // Layer direction and the cli/ allow-list.
  const layer: string[] = [];
  const cli: string[] = [];
  const deepImports: string[] = [];
  const edgeTypeOnly = new Map<string, boolean>();
  for (const e of edges) {
    const key = edgeKey(e.from, e.to);
    edgeTypeOnly.set(key, (edgeTypeOnly.get(key) ?? true) && e.typeOnly);
  }
  // Allow-listed edges still obey layer and cli/ rules (spec section 4).
  for (const key of [...edgeTypeOnly.keys()].sort()) {
    const [from, to] = key.split(" -> ") as [string, string];
    const a = units.get(from);
    const b = units.get(to);
    if (a === undefined || b === undefined) continue;
    if (a.name !== b.name) {
      if (b.outside && !a.outside) {
        layer.push(key);
      } else if (b.layer > a.layer) {
        layer.push(key);
      } else if (b.layer === a.layer) {
        const listed = rules.sameLayerEdges.find((s) =>
          s.from === a.pattern && s.to === b.pattern
        );
        if (
          listed === undefined || (listed.typesOnly && !edgeTypeOnly.get(key))
        ) {
          layer.push(key);
        }
      }
      const restricted = rules.importOnlyFrom?.find((r) =>
        r.unit === b.pattern
      );
      if (
        restricted !== undefined && !restricted.importers.includes(a.pattern) &&
        layer[layer.length - 1] !== key
      ) {
        layer.push(key);
      }
    }
    if (a.name === rules.cli.unit && b.name !== rules.cli.unit) {
      const ok = rules.cli.allowedUnits.includes(b.pattern) ||
        rules.cli.allowedPaths.some((p) => matchPattern(p, to));
      if (!ok) cli.push(key);
    }
    const targetDir = to.split("/").slice(0, -1).join("/");
    const fromDir = from.split("/").slice(0, -1).join("/");
    if (
      !to.endsWith("/mod.ts") && targetDir !== fromDir &&
      !fromDir.startsWith(`${targetDir}/`) &&
      input.exists(`${targetDir}/mod.ts`)
    ) {
      deepImports.push(key);
    }
  }

  // Dynamic local imports.
  const dynamic = sortedUnique(
    input.graph.dynamicImports.map((d) =>
      d.to === null
        ? `${d.from}:${d.line} -> <non-literal>`
        : edgeKey(d.from, d.to)
    ).filter((key) => !allowed.has(key)),
  );

  // Direct process-environment access and undeclared DYFJ_* keys.
  errors.push(...validateEnvRules(rules, units));
  const declaredUnits = new Set(rules.units.map((u) => u.dir));
  for (const rule of rules.importOnlyFrom ?? []) {
    for (const unit of [rule.unit, ...rule.importers]) {
      if (!declaredUnits.has(unit)) {
        errors.push(`importOnlyFrom rule: unit is not declared: ${unit}`);
      }
    }
  }
  // A unit exempts only the modules that physically live in it: a legacy
  // module mapped into the unit by name (`files`) has not moved yet and gets
  // no exemption.
  const exempt = (
    path: string,
    allowedUnits: readonly string[],
    entrypoints: readonly EnvEntrypoint[],
  ): boolean => {
    const unit = path in rules.files ? undefined : units.get(path);
    if (unit !== undefined && allowedUnits.includes(unit.pattern)) {
      return true;
    }
    return entrypoints.some((entry) =>
      entry.path === path ||
      (entry.unit !== undefined && unit !== undefined &&
        entry.unit === unit.pattern)
    );
  };
  const envAllowed = (path: string): boolean =>
    exempt(path, rules.env.allowedUnits, rules.env.entrypoints);
  const env = sortedUnique(
    input.graph.envAccesses.filter((a) => !envAllowed(a.from)).map((a) =>
      `${a.from}: ${a.via}`
    ),
  );
  // Every scanned module, runtime and tooling alike, names only declared keys.
  const envKeys = sortedUnique(
    input.graph.dyfjKeys.filter((k) =>
      units.has(k.from) && !input.declaredEnvKeys.has(k.key)
    ).map((k) => `${k.from}: ${k.key}`),
  );

  // Confined packages and SQL writes.
  errors.push(...validatePackageAndSqlRules(rules, units));
  const packages = sortedUnique(
    input.graph.packageImports.flatMap((i) => {
      const name = packageName(i.specifier);
      const rule = rules.packages.find((r) => r.name === name);
      if (rule === undefined) return [];
      return exempt(i.from, rule.allowedUnits, rule.entrypoints)
        ? []
        : [`${i.from}: ${name}`];
    }),
  );
  const sqlWrites = sortedUnique(
    input.graph.sqlWrites.filter((w) =>
      !rules.sqlWrites.allowedPaths.includes(w.from) &&
      !exempt(w.from, [], rules.sqlWrites.entrypoints)
    ).map((w) => `${w.from}: ${w.statement}`),
  );

  const current: Baseline = {
    cycles,
    layer,
    cli,
    dynamic,
    env,
    envKeys,
    packages,
    sqlWrites,
  };
  const now = new Set(flattenBaseline(current));
  const before = new Set(flattenBaseline(input.baseline));
  return {
    edges,
    current,
    added: [...now].filter((v) => !before.has(v)),
    stale: [...before].filter((v) => !now.has(v)),
    errors,
    deepImports,
  };
}

// ---------------------------------------------------------------------------
// Entry point

const LABEL = "arch.imports";
const RULES_PATH = "scripts/arch-layers.json";
const CYCLES_PATH = "scripts/arch-cycles.json";
const BASELINE_PATH = "scripts/arch-imports-baseline.json";
const LINT_CONFIG_PATH = "scripts/arch-imports-lint.json";

async function collectSources(
  root: string,
  rules: LayerRules,
): Promise<Map<string, string>> {
  const sources = new Map<string, string>();
  const walk = async (relative: string) => {
    let entries: Deno.DirEntry[];
    try {
      entries = [...Deno.readDirSync(`${root}/${relative}`)];
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      throw error;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory) {
        if (entry.name !== "node_modules") await walk(path);
      } else if (
        entry.isFile && path.endsWith(".ts") &&
        !rules.exclude.some((suffix) => path.endsWith(suffix))
      ) {
        sources.set(path, await Deno.readTextFile(`${root}/${path}`));
      }
    }
  };
  for (const scanRoot of rules.roots) await walk(scanRoot);
  return sources;
}

function existsIn(root: string): (path: string) => boolean {
  return (path) => {
    try {
      return Deno.statSync(`${root}/${path}`).isFile;
    } catch {
      return false;
    }
  };
}

export function renderBaseline(baseline: Baseline): string {
  return `${JSON.stringify(baseline, null, 2)}\n`;
}

export function countBaseline(baseline: Baseline): number {
  return flattenBaseline(baseline).length;
}

export async function main(
  args: readonly string[],
  root: string,
): Promise<number> {
  const write = args.includes("--write-baseline");
  const denoArg = args.find((a) => a.startsWith("--deno="));
  if (args.some((a) => a !== "--write-baseline" && a !== denoArg)) {
    console.error(`${LABEL}: usage: [--deno=<path>] [--write-baseline]`);
    return 64;
  }
  const rules = JSON.parse(
    await Deno.readTextFile(`${root}/${RULES_PATH}`),
  ) as LayerRules;
  const allowList = JSON.parse(
    await Deno.readTextFile(`${root}/${CYCLES_PATH}`),
  ) as CycleAllowEntry[];
  const baseline = JSON.parse(
    await Deno.readTextFile(`${root}/${BASELINE_PATH}`),
  ) as Baseline;
  const sources = await collectSources(root, rules);
  const modules = [...sources.keys()];
  const graph = await loadModuleGraph(
    root,
    new Set(modules),
    denoArg?.slice("--deno=".length) ?? "deno",
    `${root}/${LINT_CONFIG_PATH}`,
  );
  const result = analyze({
    modules,
    graph,
    rules,
    allowList,
    baseline,
    declaredEnvKeys: new Set(CONFIG_SCHEMA.map((spec) => spec.envVar)),
    exists: existsIn(root),
  });

  console.log(`${LABEL}: size report (non-failing)`);
  for (const line of formatSizeReport(sizeReport(sources))) console.log(line);
  if (result.deepImports.length > 0) {
    console.log(`${LABEL}: deep imports bypassing mod.ts (non-failing)`);
    for (const d of result.deepImports) console.log(`  ${d}`);
  }

  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(`${LABEL}: ${error}`);
    return 1;
  }
  if (write) {
    await Deno.writeTextFile(
      `${root}/${BASELINE_PATH}`,
      renderBaseline(result.current),
    );
    console.log(
      `${LABEL}: wrote baseline (${countBaseline(result.current)} entries)`,
    );
    return 0;
  }
  for (const v of result.added) {
    console.error(`${LABEL}: new violation (not in baseline): ${v}`);
  }
  for (const v of result.stale) {
    console.error(
      `${LABEL}: baseline entry no longer occurs; shrink the baseline: ${v}`,
    );
  }
  if (result.added.length > 0 || result.stale.length > 0) return 1;
  console.log(
    `${LABEL}: ${countBaseline(result.current)} baselined violations, none new`,
  );
  return 0;
}

if (import.meta.main) {
  Deno.exit(await main(Deno.args, repoRootFromMeta().replace(/\/$/, "")));
}
