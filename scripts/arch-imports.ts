/**
 * arch.imports: module-boundary checker for the prototype runtime.
 *
 * Implements `specs/01-architecture.md` sections 3-4 in ratchet mode:
 *
 * - Parses static imports, re-exports, and dynamic `import()` of local modules
 *   under the roots listed in `arch-layers.json`. Test files and test fixtures
 *   are not part of the module graph and are skipped. Local specifiers resolve
 *   with or without an explicit `.ts` extension.
 * - Maps every module to a unit (target directory) and layer. Modules that have
 *   not moved yet are mapped by name in `arch-layers.json`; a module the rules
 *   do not map fails the lane, so a new file cannot escape the rules.
 * - Violations: import cycles (Tarjan SCCs; every edge inside a strongly
 *   connected component, type-only edges included), upward or non-listed
 *   same-layer edges, `cli/` allow-list breaches, and dynamic local imports.
 *   Edges named by an entry in `arch-cycles.json` (the named-cycle allow-list,
 *   AGENTS.md rule 1) are subtracted.
 * - Ratchet: violations are compared with `arch-imports-baseline.json`. A
 *   violation not in the baseline fails, and so does a baseline entry that no
 *   longer occurs, which forces the baseline to shrink as work lands.
 * - Report only, never failing: deep imports that bypass a directory's
 *   `mod.ts`, and a size report of modules over 600 lines and functions over
 *   150 lines. Function detection is lexical and best-effort.
 *
 * Usage (from the repository root):
 *   deno run --allow-read=. scripts/arch-imports.ts
 *   deno run --allow-read=. --allow-write=scripts/arch-imports-baseline.json \
 *     scripts/arch-imports.ts --write-baseline
 */

// ---------------------------------------------------------------------------
// Tokenizer

export interface Token {
  kind: "id" | "str" | "num" | "punct" | "tmpl" | "regex";
  value: string;
  line: number;
}

const REGEX_AFTER_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);

function isIdStart(ch: string): boolean {
  return /[A-Za-z_$]/.test(ch);
}

function isIdPart(ch: string): boolean {
  return /[\w$]/.test(ch);
}

function regexAllowed(prev: Token | undefined): boolean {
  if (prev === undefined) return true;
  if (prev.kind === "id") return REGEX_AFTER_KEYWORDS.has(prev.value);
  if (prev.kind === "punct") {
    return prev.value !== ")" && prev.value !== "]";
  }
  return false;
}

/**
 * A lexer that is exact about comments, strings, template literals (including
 * nested `${}` expressions), and regex literals, which is all the import
 * parser and the function-size scan need.
 */
export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let line = 1;
  let i = 0;
  // Brace depths at which a template literal's `${` expression was opened.
  const templateStack: number[] = [];
  let braceDepth = 0;

  const scanTemplate = (startLine: number) => {
    // Called with `i` just past the opening backtick or a closing `}`.
    while (i < source.length) {
      const ch = source[i]!;
      if (ch === "\\") {
        if (source[i + 1] === "\n") line++;
        i += 2;
        continue;
      }
      if (ch === "\n") line++;
      if (ch === "`") {
        i++;
        tokens.push({ kind: "tmpl", value: "`", line: startLine });
        return;
      }
      if (ch === "$" && source[i + 1] === "{") {
        i += 2;
        tokens.push({ kind: "tmpl", value: "`", line: startLine });
        templateStack.push(braceDepth);
        braceDepth++;
        return;
      }
      i++;
    }
  };

  while (i < source.length) {
    const ch = source[i]!;
    if (ch === "\n") {
      line++;
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      i += 2;
      while (
        i < source.length && !(source[i] === "*" && source[i + 1] === "/")
      ) {
        if (source[i] === "\n") line++;
        i++;
      }
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const startLine = line;
      let value = "";
      i++;
      while (i < source.length && source[i] !== ch) {
        if (source[i] === "\\") {
          value += source[i + 1] ?? "";
          if (source[i + 1] === "\n") line++;
          i += 2;
          continue;
        }
        if (source[i] === "\n") break;
        value += source[i];
        i++;
      }
      i++;
      tokens.push({ kind: "str", value, line: startLine });
      continue;
    }
    if (ch === "`") {
      i++;
      scanTemplate(line);
      continue;
    }
    if (ch === "/" && regexAllowed(tokens[tokens.length - 1])) {
      const startLine = line;
      let inClass = false;
      i++;
      while (i < source.length) {
        const c = source[i]!;
        if (c === "\\") {
          i += 2;
          continue;
        }
        if (c === "\n") break;
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) break;
        i++;
      }
      i++;
      while (i < source.length && isIdPart(source[i]!)) i++;
      tokens.push({ kind: "regex", value: "/", line: startLine });
      continue;
    }
    if (isIdStart(ch)) {
      const start = i;
      while (i < source.length && isIdPart(source[i]!)) i++;
      tokens.push({ kind: "id", value: source.slice(start, i), line });
      continue;
    }
    if (/[0-9]/.test(ch)) {
      const start = i;
      while (i < source.length && /[\w.]/.test(source[i]!)) i++;
      tokens.push({ kind: "num", value: source.slice(start, i), line });
      continue;
    }
    if (ch === "{") {
      braceDepth++;
      tokens.push({ kind: "punct", value: ch, line });
      i++;
      continue;
    }
    if (ch === "}") {
      braceDepth--;
      if (
        templateStack.length > 0 &&
        templateStack[templateStack.length - 1] === braceDepth
      ) {
        templateStack.pop();
        i++;
        scanTemplate(line);
        continue;
      }
      tokens.push({ kind: "punct", value: ch, line });
      i++;
      continue;
    }
    if (ch === "=" && source[i + 1] === ">") {
      tokens.push({ kind: "punct", value: "=>", line });
      i += 2;
      continue;
    }
    if (
      ch === "?" && source[i + 1] === "." && !/[0-9]/.test(source[i + 2] ?? "")
    ) {
      tokens.push({ kind: "punct", value: "?.", line });
      i += 2;
      continue;
    }
    if (ch === "." && source[i + 1] === "." && source[i + 2] === ".") {
      tokens.push({ kind: "punct", value: "...", line });
      i += 3;
      continue;
    }
    tokens.push({ kind: "punct", value: ch, line });
    i++;
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Import parsing

export interface ImportRecord {
  specifier: string | null; // null: a non-literal dynamic import
  kind: "static" | "dynamic";
  typeOnly: boolean;
  line: number;
}

function isPunct(token: Token | undefined, value: string): boolean {
  return token !== undefined && token.kind === "punct" && token.value === value;
}

function isId(token: Token | undefined, value: string): boolean {
  return token !== undefined && token.kind === "id" && token.value === value;
}

// An import/export clause holds only names, braces, commas, `*`, `as`, and
// `type`. Returns the index of the `from` keyword, or -1 if this is not a
// `... from "x"` form.
function findFrom(tokens: Token[], start: number): number {
  for (let j = start; j < tokens.length; j++) {
    const t = tokens[j]!;
    if (t.kind === "id") {
      if (t.value === "from" && tokens[j + 1]?.kind === "str") return j;
      continue;
    }
    if (t.kind === "punct" && ["{", "}", ",", "*"].includes(t.value)) continue;
    return -1;
  }
  return -1;
}

// `import type ...`, `export type {...}`, or a braced clause in which every
// element carries its own `type` modifier.
function clauseIsTypeOnly(
  tokens: Token[],
  start: number,
  from: number,
): boolean {
  const first = tokens[start];
  if (
    isId(first, "type") && !isId(tokens[start + 1], "from") &&
    !isPunct(tokens[start + 1], ",")
  ) {
    return true;
  }
  if (!isPunct(first, "{")) return false;
  let elementStart = true;
  let sawElement = false;
  for (let j = start + 1; j < from; j++) {
    const t = tokens[j]!;
    if (isPunct(t, "}")) break;
    if (isPunct(t, ",")) {
      elementStart = true;
      continue;
    }
    if (elementStart) {
      if (
        !isId(t, "type") || isPunct(tokens[j + 1], ",") ||
        isPunct(tokens[j + 1], "}")
      ) {
        return false;
      }
      sawElement = true;
      elementStart = false;
    }
  }
  return sawElement;
}

export function parseImports(source: string): ImportRecord[] {
  const tokens = tokenize(source);
  const records: ImportRecord[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind !== "id" || (t.value !== "import" && t.value !== "export")) {
      continue;
    }
    const prev = tokens[i - 1];
    if (isPunct(prev, ".") || isPunct(prev, "?.")) continue;
    const next = tokens[i + 1];
    if (t.value === "import" && isPunct(next, "(")) {
      const arg = tokens[i + 2];
      const after = tokens[i + 3];
      const literal = arg?.kind === "str" &&
        (isPunct(after, ")") || isPunct(after, ","));
      records.push({
        specifier: literal ? arg!.value : null,
        kind: "dynamic",
        typeOnly: false,
        line: t.line,
      });
      continue;
    }
    if (t.value === "import" && next?.kind === "str") {
      records.push({
        specifier: next.value,
        kind: "static",
        typeOnly: false,
        line: t.line,
      });
      continue;
    }
    if (t.value === "export") {
      const lead = isId(next, "type") ? tokens[i + 2] : next;
      if (!isPunct(lead, "{") && !isPunct(lead, "*")) continue;
    }
    const from = findFrom(tokens, i + 1);
    if (from < 0) continue;
    records.push({
      specifier: tokens[from + 1]!.value,
      kind: "static",
      typeOnly: clauseIsTypeOnly(tokens, i + 1, from),
      line: t.line,
    });
  }
  return records;
}

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
  files: Record<string, string>;
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

export interface Edge {
  from: string;
  to: string;
  kind: "static" | "dynamic";
  typeOnly: boolean;
  line: number;
}

export function edgeKey(from: string, to: string): string {
  return `${from} -> ${to}`;
}

function normalizePath(path: string): string {
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") out.pop();
    else out.push(segment);
  }
  return out.join("/");
}

export function resolveSpecifier(
  importer: string,
  specifier: string,
  exists: (path: string) => boolean,
): string | undefined {
  const dir = importer.split("/").slice(0, -1).join("/");
  const base = normalizePath(`${dir}/${specifier}`);
  for (
    const candidate of [
      base,
      `${base}.ts`,
      `${base}/mod.ts`,
      `${base}/index.ts`,
    ]
  ) {
    if (exists(candidate)) return candidate;
  }
  return undefined;
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
  /** Repo-relative module path -> source text, for every scanned module. */
  sources: ReadonlyMap<string, string>;
  rules: LayerRules;
  allowList: readonly CycleAllowEntry[];
  baseline: Baseline;
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

export function flattenBaseline(baseline: Baseline): string[] {
  return [
    ...baseline.cycles.flatMap((c) => c.edges.map((e) => `cycle: ${e}`)),
    ...baseline.layer.map((e) => `layer: ${e}`),
    ...baseline.cli.map((e) => `cli: ${e}`),
    ...baseline.dynamic.map((e) => `dynamic: ${e}`),
  ].sort();
}

export function validateAllowList(
  allowList: readonly CycleAllowEntry[],
  edgeKeys: ReadonlySet<string>,
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
    names.add(entry.name);
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

export function analyze(input: AnalysisInput): AnalysisResult {
  const { sources, rules } = input;
  const errors: string[] = [];
  const modules = [...sources.keys()].sort();
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
    if (!sources.has(path)) {
      errors.push(`mapped module no longer exists: ${path}`);
    }
  }

  const edges: Edge[] = [];
  const nonLiteral: string[] = [];
  for (const path of modules) {
    for (const record of parseImports(sources.get(path)!)) {
      if (record.specifier === null) {
        nonLiteral.push(`${path}:${record.line}`);
        continue;
      }
      if (
        !record.specifier.startsWith("./") &&
        !record.specifier.startsWith("../")
      ) {
        continue;
      }
      const target = resolveSpecifier(path, record.specifier, input.exists);
      if (target === undefined) {
        errors.push(`unresolved local import at ${path}:${record.line}`);
        continue;
      }
      // Imports of files outside the scanned roots (schema, contracts, JSON)
      // are not module-graph edges.
      if (!sources.has(target)) continue;
      edges.push({
        from: path,
        to: target,
        kind: record.kind,
        typeOnly: record.typeOnly,
        line: record.line,
      });
    }
  }

  const edgeKeys = new Set(edges.map((e) => edgeKey(e.from, e.to)));
  errors.push(...validateAllowList(input.allowList, edgeKeys, input.exists));
  const allowed = new Set(
    input.allowList.flatMap((entry) => entry.edges ?? []),
  );

  // Cycles.
  const adjacency = new Map<string, string[]>();
  for (const e of edges) {
    const list = adjacency.get(e.from) ?? [];
    if (!list.includes(e.to)) list.push(e.to);
    adjacency.set(e.from, list);
  }
  for (const list of adjacency.values()) list.sort();
  const cycles: Baseline["cycles"] = [];
  for (const component of stronglyConnected(modules, adjacency)) {
    const members = new Set(component);
    const selfLoop = component.length === 1 &&
      (adjacency.get(component[0]!) ?? []).includes(component[0]!);
    if (component.length < 2 && !selfLoop) continue;
    const inside = sortedUnique(
      edges.filter((e) => members.has(e.from) && members.has(e.to))
        .map((e) => edgeKey(e.from, e.to)),
    ).filter((key) => !allowed.has(key));
    if (inside.length > 0) cycles.push({ members: component, edges: inside });
  }

  // Layer direction and the cli/ allow-list.
  const layer: string[] = [];
  const cli: string[] = [];
  const deepImports: string[] = [];
  const edgeTypeOnly = new Map<string, boolean>();
  for (const e of edges) {
    const key = edgeKey(e.from, e.to);
    edgeTypeOnly.set(key, (edgeTypeOnly.get(key) ?? true) && e.typeOnly);
  }
  for (const key of [...edgeTypeOnly.keys()].sort()) {
    if (allowed.has(key)) continue;
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
  const dynamic = sortedUnique([
    ...edges.filter((e) => e.kind === "dynamic")
      .map((e) => edgeKey(e.from, e.to))
      .filter((key) => !allowed.has(key)),
    ...nonLiteral.map((at) => `${at} -> <non-literal>`),
  ]);

  const current: Baseline = { cycles, layer, cli, dynamic };
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
// Size report

export const MODULE_LINE_LIMIT = 600;
export const FUNCTION_LINE_LIMIT = 150;

export interface FunctionSpan {
  name: string;
  startLine: number;
  endLine: number;
}

const CONTROL_KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "with",
  "return",
  "typeof",
  "await",
  "new",
]);

function matchingForward(tokens: Token[], open: number): number {
  const pairs: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
  const close = pairs[tokens[open]!.value]!;
  let depth = 0;
  for (let j = open; j < tokens.length; j++) {
    if (isPunct(tokens[j], tokens[open]!.value)) depth++;
    else if (isPunct(tokens[j], close)) {
      depth--;
      if (depth === 0) return j;
    }
  }
  return tokens.length - 1;
}

function matchingBackward(
  tokens: Token[],
  close: number,
  open: string,
): number {
  const closer = tokens[close]!.value;
  let depth = 0;
  for (let j = close; j >= 0; j--) {
    if (isPunct(tokens[j], closer)) depth++;
    else if (isPunct(tokens[j], open)) {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}

// After a parameter list's `)`, skip an optional return type annotation and
// return the index of the body `{`, or -1 when there is no body here.
function bodyAfterParams(tokens: Token[], close: number): number {
  let j = close + 1;
  if (isPunct(tokens[j], "{")) return j;
  if (!isPunct(tokens[j], ":")) return -1;
  j++;
  let typeStart = true;
  while (j < tokens.length) {
    const t = tokens[j]!;
    if (t.kind === "punct") {
      if (t.value === "{") {
        if (typeStart) {
          j = matchingForward(tokens, j) + 1;
          typeStart = false;
          continue;
        }
        return j;
      }
      if (t.value === "(" || t.value === "[") {
        j = matchingForward(tokens, j) + 1;
        typeStart = false;
        continue;
      }
      if (t.value === "<") {
        let depth = 0;
        for (; j < tokens.length; j++) {
          if (isPunct(tokens[j], "<")) depth++;
          else if (isPunct(tokens[j], ">")) {
            depth--;
            if (depth === 0) break;
          }
        }
        j++;
        typeStart = false;
        continue;
      }
      if (["|", "&", ".", "=>", ","].includes(t.value)) {
        typeStart = true;
        j++;
        continue;
      }
      if (t.value === "?" || t.value === ":") {
        typeStart = true;
        j++;
        continue;
      }
      return -1;
    }
    typeStart = false;
    j++;
  }
  return -1;
}

function nameBefore(tokens: Token[], index: number): string {
  // `const name = ...`, `name: ...`, or `name = ...` before an arrow function.
  for (let j = index - 1; j >= Math.max(0, index - 60); j--) {
    const t = tokens[j]!;
    if (isPunct(t, ")")) {
      // A parameter list (and any return type after it) sits between the
      // name and the arrow.
      j = matchingBackward(tokens, j, "(");
      continue;
    }
    if (isPunct(t, ":") && isPunct(tokens[j - 1], ")")) continue;
    if (isPunct(t, "=") || isPunct(t, ":")) {
      const candidate = tokens[j - 1];
      if (candidate?.kind === "id" || candidate?.kind === "str") {
        return candidate.value;
      }
      return "<anonymous>";
    }
    if (isPunct(t, ";") || isPunct(t, "{") || isPunct(t, "}")) break;
  }
  return "<anonymous>";
}

// The first token of an arrow function's parameters: the `(` of a
// parenthesized list (past any return type annotation), or the bare parameter.
function arrowStart(tokens: Token[], arrow: number): number {
  for (let j = arrow - 1; j >= Math.max(0, arrow - 60); j--) {
    const t = tokens[j]!;
    if (isPunct(t, ")")) {
      const open = matchingBackward(tokens, j, "(");
      if (j === arrow - 1 || isPunct(tokens[j + 1], ":")) {
        return Math.max(open, 0);
      }
      j = open;
      continue;
    }
    if (
      isPunct(t, ";") || isPunct(t, "{") || isPunct(t, "}") || isPunct(t, "=")
    ) break;
  }
  return Math.max(arrow - 1, 0);
}

/** Lexical, best-effort function spans: declarations, methods, arrows. */
export function functionSpans(source: string): FunctionSpan[] {
  const tokens = tokenize(source);
  const spans: FunctionSpan[] = [];
  const seenBodies = new Set<number>();
  const push = (name: string, startLine: number, body: number) => {
    if (body < 0 || seenBodies.has(body)) return;
    seenBodies.add(body);
    const end = matchingForward(tokens, body);
    spans.push({ name, startLine, endLine: tokens[end]!.line });
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (isPunct(t, "=>") && isPunct(tokens[i + 1], "{")) {
      const start = arrowStart(tokens, i);
      push(
        nameBefore(tokens, Math.max(start, 0)),
        tokens[Math.max(start, 0)]!.line,
        i + 1,
      );
      continue;
    }
    if (!isPunct(t, "(")) continue;
    let head = i - 1;
    if (isPunct(tokens[head], ">")) {
      let depth = 0;
      for (; head >= 0; head--) {
        if (isPunct(tokens[head], ">")) depth++;
        else if (isPunct(tokens[head], "<")) {
          depth--;
          if (depth === 0) break;
        }
      }
      head--;
    }
    const nameToken = tokens[head];
    if (nameToken === undefined || nameToken.kind !== "id") continue;
    if (CONTROL_KEYWORDS.has(nameToken.value)) continue;
    const isFunctionKeyword = nameToken.value === "function";
    const beforeName = tokens[head - 1];
    const declared = isFunctionKeyword || isId(beforeName, "function") ||
      beforeName === undefined ||
      (beforeName.kind === "punct" &&
        [";", "{", "}", ","].includes(beforeName.value)) ||
      (beforeName.kind === "id" &&
        [
          "async",
          "static",
          "get",
          "set",
          "public",
          "private",
          "protected",
          "readonly",
          "override",
        ]
          .includes(beforeName.value)) ||
      isPunct(beforeName, "*");
    if (!declared) continue;
    const close = matchingForward(tokens, i);
    const body = bodyAfterParams(tokens, close);
    const name = isFunctionKeyword ? nameBefore(tokens, head) : nameToken.value;
    push(name, nameToken.line, body);
  }
  return spans.sort((a, b) => a.startLine - b.startLine);
}

export function countLines(source: string): number {
  if (source === "") return 0;
  const lines = source.split("\n").length;
  return source.endsWith("\n") ? lines - 1 : lines;
}

export interface SizeReport {
  modules: { path: string; lines: number }[];
  functions: { path: string; name: string; line: number; lines: number }[];
}

export function sizeReport(sources: ReadonlyMap<string, string>): SizeReport {
  const modules: SizeReport["modules"] = [];
  const functions: SizeReport["functions"] = [];
  for (const [path, source] of [...sources.entries()].sort()) {
    const lines = countLines(source);
    if (lines > MODULE_LINE_LIMIT) modules.push({ path, lines });
    for (const span of functionSpans(source)) {
      const length = span.endLine - span.startLine + 1;
      if (length > FUNCTION_LINE_LIMIT) {
        functions.push({
          path,
          name: span.name,
          line: span.startLine,
          lines: length,
        });
      }
    }
  }
  modules.sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path));
  functions.sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path));
  return { modules, functions };
}

// ---------------------------------------------------------------------------
// Entry point

const LABEL = "arch.imports";
const RULES_PATH = "scripts/arch-layers.json";
const CYCLES_PATH = "scripts/arch-cycles.json";
const BASELINE_PATH = "scripts/arch-imports-baseline.json";

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
  if (args.some((a) => a !== "--write-baseline")) {
    console.error(`${LABEL}: usage: [--write-baseline]`);
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
  const result = analyze({
    sources,
    rules,
    allowList,
    baseline,
    exists: existsIn(root),
  });

  const sizes = sizeReport(sources);
  console.log(`${LABEL}: size report (non-failing)`);
  for (const m of sizes.modules) {
    console.log(
      `  module over ${MODULE_LINE_LIMIT} lines: ${m.path} (${m.lines})`,
    );
  }
  for (const f of sizes.functions) {
    console.log(
      `  function over ${FUNCTION_LINE_LIMIT} lines: ${f.path}:${f.line} ${f.name} (${f.lines})`,
    );
  }
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
  const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
  Deno.exit(await main(Deno.args, root));
}
