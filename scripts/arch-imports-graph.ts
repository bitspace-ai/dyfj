/**
 * Module-graph loader for the arch.imports lane, built on `deno info --json`
 * (the deno_graph parser Deno itself uses) instead of a hand-written lexer.
 *
 * Every scanned module becomes a root of one `deno info` call, through a
 * generated `data:` module that side-effect-imports each file, so modules no
 * entry point reaches are still covered. The call is offline (`--no-remote`,
 * `--no-npm`) and config-free; only local `file:` edges are kept, and package
 * specifiers that do not resolve offline are ignored. Local specifiers must
 * carry their extension, as everywhere in the prototype; an extensionless one
 * does not resolve and fails the lane.
 *
 * What deno_graph reports, and how it maps onto edges:
 * - A dependency with a `code` entry is a value edge; one with only a `type`
 *   entry (`import type`, `export type`, `typeof import(...)`) is type-only. An
 *   import whose named bindings all carry an inline `type` modifier still loads
 *   the module under `verbatimModuleSyntax`, so deno_graph reports a value edge.
 * - `isDynamic` is set only when every value import of that specifier is a
 *   dynamic `import()`, so deno_graph alone would miss a dynamic import of a
 *   module the same file also imports statically, and it has no entry for an
 *   `import()` whose argument is not a string literal.
 *
 * Dynamic imports therefore come from a second parser pass: `deno lint` with
 * the repository-owned plugin `arch-imports-lint-plugin.ts`, which reports
 * every `import()` expression in the AST, literal or not. Both passes use
 * Deno's own parser; neither is a hand-written lexer.
 */

import { fileURLToPath, pathToFileURL } from "node:url";

export interface Edge {
  from: string;
  to: string;
  kind: "static" | "dynamic";
  typeOnly: boolean;
  line: number;
}

export interface DenoInfoDependency {
  specifier: string;
  code?: { specifier?: string; error?: string; span?: DenoInfoSpan };
  type?: { specifier?: string; error?: string; span?: DenoInfoSpan };
  isDynamic?: boolean;
}

interface DenoInfoSpan {
  start: { line: number; character: number };
}

export interface DenoInfoModule {
  specifier: string;
  error?: string;
  dependencies?: DenoInfoDependency[];
}

export interface DenoInfoOutput {
  modules: DenoInfoModule[];
}

export interface DynamicImport {
  from: string;
  /** Scanned target module, or `null` for a non-literal `import()`. */
  to: string | null;
  line: number;
}

export interface ModuleGraph {
  edges: Edge[];
  /** Every dynamic `import()` of a scanned module, and every non-literal one. */
  dynamicImports: DynamicImport[];
  /** Scanned modules that failed to load, and local imports that did not
   * resolve to a file. Any entry fails the lane. */
  errors: string[];
}

function isLocalSpecifier(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

/**
 * Turns `deno info --json` output into repo-relative edges between scanned
 * modules. Edges to files outside `modules` (tests, JSON, other packages) are
 * dropped.
 */
export function graphFromDenoInfo(
  info: DenoInfoOutput,
  root: string,
  modules: ReadonlySet<string>,
): ModuleGraph {
  const relative = (url: string | undefined): string | undefined => {
    if (url === undefined || !url.startsWith("file:")) return undefined;
    const path = fileURLToPath(url);
    return path.startsWith(`${root}/`)
      ? path.slice(root.length + 1)
      : undefined;
  };
  const failed = new Set(
    info.modules.filter((m) => m.error !== undefined).map((m) => m.specifier),
  );
  const edges: Edge[] = [];
  const errors: string[] = [];
  for (const module of info.modules) {
    const from = relative(module.specifier);
    if (from === undefined || !modules.has(from)) continue;
    if (module.error !== undefined) {
      // A module that does not parse has no dependencies to report.
      errors.push(`module failed to load: ${from}`);
      continue;
    }
    for (const dep of module.dependencies ?? []) {
      const resolved = dep.code ?? dep.type;
      const line = (resolved?.span?.start.line ?? -1) + 1;
      const target = dep.code?.specifier ?? dep.type?.specifier;
      if (
        isLocalSpecifier(dep.specifier) &&
        (target === undefined || resolved?.error !== undefined ||
          failed.has(target))
      ) {
        errors.push(
          `unresolved local import "${dep.specifier}" at ${from}:${line}`,
        );
        continue;
      }
      const to = relative(target);
      if (to === undefined || !modules.has(to)) continue;
      edges.push({
        from,
        to,
        kind: dep.isDynamic === true ? "dynamic" : "static",
        typeOnly: dep.code === undefined,
        line,
      });
    }
  }
  const byKey = (e: Edge) => `${e.from} -> ${e.to} ${e.kind}`;
  edges.sort((a, b) => byKey(a).localeCompare(byKey(b)));
  return { edges, dynamicImports: [], errors: errors.sort() };
}

export interface DenoLintOutput {
  diagnostics: {
    filename: string;
    code: string;
    message: string;
    range: { start: { line: number } };
  }[];
  errors: { file_path?: string; message?: string }[];
}

const DYNAMIC_IMPORT_RULE = "arch-imports/dynamic-import";

/** Turns the plugin's `deno lint --json` diagnostics into dynamic imports. */
export function dynamicImportsFromLint(
  lint: DenoLintOutput,
  root: string,
  modules: ReadonlySet<string>,
): { dynamicImports: DynamicImport[]; errors: string[] } {
  const dynamicImports: DynamicImport[] = [];
  const relative = (name: string) => {
    const file = name.startsWith("file:") ? fileURLToPath(name) : name;
    return file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file;
  };
  // Same wording as the graph pass, so one broken module is one error.
  const errors = lint.errors.map((e) =>
    `module failed to load: ${relative(e.file_path ?? "?")}`
  );
  for (const d of lint.diagnostics) {
    if (d.code !== DYNAMIC_IMPORT_RULE) continue;
    // Deno reports the file as a `file:` URL.
    const from = relative(d.filename);
    const file = `${root}/${from}`;
    if (!modules.has(from)) continue;
    const line = d.range.start.line;
    if (d.message === "non-literal") {
      dynamicImports.push({ from, to: null, line });
      continue;
    }
    const specifier = d.message.slice("literal:".length);
    if (!isLocalSpecifier(specifier)) continue;
    const target = fileURLToPath(new URL(specifier, pathToFileURL(file)));
    const to = target.startsWith(`${root}/`)
      ? target.slice(root.length + 1)
      : undefined;
    if (to !== undefined && modules.has(to)) {
      dynamicImports.push({ from, to, line });
    }
  }
  const key = (d: DynamicImport) => `${d.from}:${d.line}`;
  dynamicImports.sort((a, b) => key(a).localeCompare(key(b)));
  return { dynamicImports, errors };
}

/** The `data:` root module that side-effect-imports every scanned module. */
export function rootModuleUrl(root: string, modules: Iterable<string>): string {
  const lines = [...modules].sort().map((path) =>
    `import ${JSON.stringify(pathToFileURL(`${root}/${path}`).href)};`
  );
  return `data:application/typescript,${encodeURIComponent(lines.join("\n"))}`;
}

async function runDeno(
  denoExecutable: string,
  args: string[],
  cwd: string,
  okCodes: number[],
): Promise<unknown> {
  const output = await new Deno.Command(denoExecutable, {
    args,
    cwd,
    stdout: "piped",
    stderr: "null",
  }).output();
  if (!okCodes.includes(output.code)) {
    throw new Error(`deno ${args[0]} exited with code ${output.code}`);
  }
  return JSON.parse(new TextDecoder().decode(output.stdout));
}

/**
 * Builds the graph with `deno info` and collects dynamic imports with
 * `deno lint` and the plugin configured in `lintConfig`.
 */
export async function loadModuleGraph(
  root: string,
  modules: ReadonlySet<string>,
  denoExecutable: string,
  lintConfig: string,
): Promise<ModuleGraph> {
  const [info, lint] = await Promise.all([
    runDeno(
      denoExecutable,
      [
        "info",
        "--json",
        "--quiet",
        "--no-config",
        "--no-lock",
        "--no-remote",
        "--no-npm",
        rootModuleUrl(root, modules),
      ],
      root,
      [0],
    ),
    // `deno lint` exits 1 when it reports diagnostics, which it always does
    // for a tree with dynamic imports.
    runDeno(
      denoExecutable,
      [
        "lint",
        "--json",
        "--quiet",
        `--config=${lintConfig}`,
        ...[...modules].sort().map((path) => `${root}/${path}`),
      ],
      root,
      [0, 1],
    ),
  ]);
  const graph = graphFromDenoInfo(info as DenoInfoOutput, root, modules);
  const dynamic = dynamicImportsFromLint(lint as DenoLintOutput, root, modules);
  return {
    edges: graph.edges,
    dynamicImports: dynamic.dynamicImports,
    errors: [...new Set([...graph.errors, ...dynamic.errors])].sort(),
  };
}
