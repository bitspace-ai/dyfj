/**
 * Module-graph builder for the arch.imports lane, on Node (decision D32).
 *
 * Each scanned module is parsed by `arch-imports-parse.ts` (Node's type
 * stripping, then `acorn`), and its import references are resolved here:
 * - a relative specifier resolves to the file it names, extension included,
 *   as everywhere in the prototype. One that names no file, or names a
 *   scanned module that failed to parse, is an error: an extensionless
 *   specifier does not resolve and fails the lane;
 * - a bare specifier is a package and a `node:` specifier a builtin; neither
 *   is a graph edge, and both are reported as package imports.
 * Only edges between scanned modules are kept.
 *
 * Imports of one specifier in a module make one edge:
 * - it is a value edge when any of them loads the module at runtime, and
 *   type-only when all are `import type`, `export type ... from` or
 *   `typeof import(...)`. An import whose named bindings all carry an inline
 *   `type` modifier still loads the module under `verbatimModuleSyntax`, so it
 *   is a value edge;
 * - it is dynamic only when every value import is a dynamic `import()`.
 * Every `import()` expression, literal or not, is also reported on its own as
 * a dynamic import, so a dynamic import of a module the same file imports
 * statically is still seen.
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import { moduleFacts } from "./arch-imports-parse.ts";

export interface Edge {
  from: string;
  to: string;
  kind: "static" | "dynamic";
  typeOnly: boolean;
  line: number;
}

export interface DynamicImport {
  from: string;
  /** Scanned target module, or `null` for a non-literal `import()`. */
  to: string | null;
  line: number;
}

export interface EnvAccess {
  from: string;
  line: number;
  /** `Deno.env` or `process.env`. */
  via: string;
}

export interface DyfjKey {
  from: string;
  line: number;
  key: string;
}

export interface PackageImport {
  from: string;
  line: number;
  /** The specifier as written, e.g. `mysql2/promise` or `npm:mysql2@3`. */
  specifier: string;
}

export interface SqlWrite {
  from: string;
  line: number;
  /** The write statement's leading keywords, e.g. `INSERT INTO`. */
  statement: string;
}

export interface ModuleGraph {
  edges: Edge[];
  /** Every dynamic `import()` of a scanned module, and every non-literal one. */
  dynamicImports: DynamicImport[];
  /** Every direct process-environment access in a scanned module. */
  envAccesses: EnvAccess[];
  /** Every string literal that is exactly a `DYFJ_*` key. */
  dyfjKeys: DyfjKey[];
  /** Every non-relative import specifier. */
  packageImports: PackageImport[];
  /** Every string literal that begins with an SQL write statement. */
  sqlWrites: SqlWrite[];
  /** Scanned modules that failed to parse, and local imports that did not
   * resolve to a file. Any entry fails the lane. */
  errors: string[];
}

function isLocalSpecifier(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

const byLine = (d: { from: string; line: number }) =>
  `${d.from}:${String(d.line).padStart(8, "0")}`;

/**
 * Builds the graph of the scanned modules (`sources`: repo-relative path →
 * source). `exists` says whether a repo-relative path is a file.
 */
export function loadModuleGraph(
  root: string,
  sources: ReadonlyMap<string, string>,
  exists: (path: string) => boolean,
): ModuleGraph {
  const facts = new Map<string, ReturnType<typeof moduleFacts>>();
  const errors: string[] = [];
  for (const [path, source] of sources) {
    try {
      facts.set(path, moduleFacts(source));
    } catch {
      // A module that does not parse has no imports to report.
      errors.push(`module failed to load: ${path}`);
    }
  }
  const resolve = (from: string, specifier: string): string | undefined => {
    const target = fileURLToPath(
      new URL(specifier, pathToFileURL(`${root}/${from}`)),
    );
    return target.startsWith(`${root}/`)
      ? target.slice(root.length + 1)
      : undefined;
  };

  const graph: ModuleGraph = {
    edges: [],
    dynamicImports: [],
    envAccesses: [],
    dyfjKeys: [],
    packageImports: [],
    sqlWrites: [],
    errors,
  };
  for (const [from, module] of facts) {
    const bySpecifier = new Map<string, typeof module.imports>();
    for (const reference of module.imports) {
      const list = bySpecifier.get(reference.specifier) ?? [];
      list.push(reference);
      bySpecifier.set(reference.specifier, list);
    }
    for (const [specifier, references] of bySpecifier) {
      if (!isLocalSpecifier(specifier)) continue;
      const values = references.filter((r) => !r.typeOnly);
      const line = (values[0] ?? references[0]!).line;
      const to = resolve(from, specifier);
      if (
        to === undefined || !exists(to) ||
        (sources.has(to) && !facts.has(to))
      ) {
        errors.push(
          `unresolved local import "${specifier}" at ${from}:${line}`,
        );
        continue;
      }
      if (!sources.has(to)) continue;
      graph.edges.push({
        from,
        to,
        kind: values.length > 0 && values.every((r) => r.dynamic)
          ? "dynamic"
          : "static",
        typeOnly: values.length === 0,
        line,
      });
    }
    for (const d of module.dynamicImports) {
      if (d.specifier === null) {
        graph.dynamicImports.push({ from, to: null, line: d.line });
        continue;
      }
      if (!isLocalSpecifier(d.specifier)) continue;
      const to = resolve(from, d.specifier);
      if (to !== undefined && sources.has(to)) {
        graph.dynamicImports.push({ from, to, line: d.line });
      }
    }
    for (const a of module.envAccesses) graph.envAccesses.push({ from, ...a });
    for (const k of module.dyfjKeys) graph.dyfjKeys.push({ from, ...k });
    for (const p of module.packageImports) {
      graph.packageImports.push({ from, ...p });
    }
    for (const w of module.sqlWrites) graph.sqlWrites.push({ from, ...w });
  }

  const edgeKey = (e: Edge) => `${e.from} -> ${e.to} ${e.kind}`;
  graph.edges.sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)));
  const dynamicKey = (d: DynamicImport) => `${d.from}:${d.line}`;
  graph.dynamicImports.sort((a, b) =>
    dynamicKey(a).localeCompare(dynamicKey(b))
  );
  for (
    const list of [
      graph.envAccesses,
      graph.dyfjKeys,
      graph.packageImports,
      graph.sqlWrites,
    ] as { from: string; line: number }[][]
  ) {
    list.sort((a, b) => byLine(a).localeCompare(byLine(b)));
  }
  graph.errors = [...new Set(errors)].sort();
  return graph;
}
