/**
 * Module-graph loader for the arch.imports lane, built on `deno info --json`
 * (the deno_graph parser Deno itself uses) instead of a hand-written lexer.
 *
 * Every scanned module becomes a root of one `deno info` call, through a
 * generated `data:` module that side-effect-imports each file, so modules no
 * entry point reaches are still covered. The call is offline (`--no-remote`,
 * `--no-npm`) and config-free; only local `file:` edges are kept, and package
 * specifiers that do not resolve offline are ignored. `--unstable-sloppy-imports`
 * resolves extensionless local specifiers.
 *
 * What deno_graph reports, and how it maps onto edges:
 * - A dependency with a `code` entry is a value edge; one with only a `type`
 *   entry (`import type`, `export type`, `typeof import(...)`) is type-only. An
 *   import whose named bindings all carry an inline `type` modifier still loads
 *   the module under `verbatimModuleSyntax`, so deno_graph reports a value edge.
 * - `isDynamic` is set only when every value import of that specifier is a
 *   dynamic `import()`. A dynamic import of a module that the same file also
 *   imports statically adds no edge, so it is not reported as dynamic.
 * - A dynamic `import()` whose argument is not a string literal has no
 *   resolvable target and does not appear in the graph.
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

export interface ModuleGraph {
  edges: Edge[];
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
  return { edges, errors: errors.sort() };
}

/** The `data:` root module that side-effect-imports every scanned module. */
export function rootModuleUrl(root: string, modules: Iterable<string>): string {
  const lines = [...modules].sort().map((path) =>
    `import ${JSON.stringify(pathToFileURL(`${root}/${path}`).href)};`
  );
  return `data:application/typescript,${encodeURIComponent(lines.join("\n"))}`;
}

export async function loadModuleGraph(
  root: string,
  modules: ReadonlySet<string>,
  denoExecutable: string,
): Promise<ModuleGraph> {
  const output = await new Deno.Command(denoExecutable, {
    args: [
      "info",
      "--json",
      "--quiet",
      "--no-config",
      "--no-lock",
      "--no-remote",
      "--no-npm",
      "--unstable-sloppy-imports",
      rootModuleUrl(root, modules),
    ],
    cwd: root,
    stdout: "piped",
    stderr: "null",
  }).output();
  if (!output.success) {
    throw new Error(`deno info exited with code ${output.code}`);
  }
  const info = JSON.parse(new TextDecoder().decode(output.stdout));
  return graphFromDenoInfo(info as DenoInfoOutput, root, modules);
}
