/**
 * What a saved file means for `dyfj dev`: restart the runtime, rebuild and
 * re-exec the REPL, both, or nothing.
 *
 * The TypeScript side comes from the arch.imports module graph
 * (`scripts/arch-imports-graph.ts`), not from directory lists, so it cannot
 * drift from the code:
 * - a module reachable from the server entry over value edges is runtime
 *   code (a type-only edge loads nothing at run time);
 * - `contract/` and `transport/` are the wire protocol, so a change there
 *   restarts both, the runtime first;
 * - test and fixture files (the rules' `exclude`) reload nothing, and neither
 *   does a module only the TypeScript client reaches: the client runs from
 *   source on every call;
 * - any other file under `prototype/src` (a prompt, a data file) restarts the
 *   runtime, since the graph cannot say who reads it.
 *
 * The Rust side comes from the Cargo workspace (`cargo metadata`): a file
 * belongs to the member whose directory is its longest prefix, and the REPL is
 * `dyfj-repl` plus every workspace crate it depends on by path. The lock
 * file, the root manifest (it holds `[workspace]`) and the toolchain file
 * change every member's build. Without metadata every `core/` change counts
 * as the REPL's.
 */

import { readFileSync } from "node:fs";
import {
  loadModuleGraph,
  type ModuleGraph,
} from "../../scripts/arch-imports-graph.ts";
import {
  collectSources,
  existsIn,
  type LayerRules,
  unitFor,
} from "../../scripts/arch-imports.ts";

export const SERVER_ENTRY = "prototype/src/server/main.ts";
export const REPL_CRATE = "dyfj-repl";

const SOURCE_ROOT = "prototype/src";
const CORE_ROOT = "core";
const WIRE_UNITS = new Set(["contract", "transport"]);
const WORKSPACE_FILES = new Set([
  "core/Cargo.lock",
  "core/Cargo.toml",
  "core/rust-toolchain.toml",
]);

export type PathClass = "none" | "runtime" | "repl" | "both";

/** A Cargo workspace member, with repo-relative directories. */
export interface CrateMember {
  name: string;
  dir: string;
  pathDeps: string[];
}

export interface ClassifyContext {
  rules: LayerRules;
  /** Repo-relative modules the server entry reaches. */
  serverReachable: ReadonlySet<string>;
  /** Workspace members, or null when `cargo metadata` was unavailable. */
  crates: readonly CrateMember[] | null;
  /** Directories of the REPL crate and the workspace crates it depends on. */
  replCrates: ReadonlySet<string>;
}

export interface BatchClass {
  runtime: boolean;
  repl: boolean;
  files: number;
}

/** Modules reachable from `entry` over value edges, `entry` included. */
export function serverReachableFrom(
  graph: ModuleGraph,
  entry: string,
): Set<string> {
  const next = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.typeOnly) continue;
    const list = next.get(edge.from) ?? [];
    list.push(edge.to);
    next.set(edge.from, list);
  }
  const seen = new Set([entry]);
  const stack = [entry];
  while (stack.length > 0) {
    for (const to of next.get(stack.pop()!) ?? []) {
      if (!seen.has(to)) {
        seen.add(to);
        stack.push(to);
      }
    }
  }
  return seen;
}

export function readLayerRules(root: string): LayerRules {
  return JSON.parse(
    readFileSync(`${root}/scripts/arch-layers.json`, "utf8"),
  ) as LayerRules;
}

/** The server's reachable set for the tree at `root`, as arch.imports sees it. */
export function loadServerReachable(
  root: string,
  rules: LayerRules = readLayerRules(root),
): Set<string> {
  const sources = collectSources(root, rules);
  const graph = loadModuleGraph(root, sources, existsIn(root));
  return serverReachableFrom(graph, SERVER_ENTRY);
}

interface CargoMetadata {
  packages: {
    name: string;
    manifest_path: string;
    dependencies: { name: string; path?: string }[];
  }[];
}

function repoRelative(root: string, path: string): string {
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

function dirOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/** Workspace members from `cargo metadata --no-deps --format-version 1`. */
export function crateMembersFromMetadata(
  metadata: unknown,
  root: string,
): CrateMember[] {
  return (metadata as CargoMetadata).packages.map((pkg) => ({
    name: pkg.name,
    dir: repoRelative(root, dirOf(pkg.manifest_path)),
    pathDeps: pkg.dependencies
      .flatMap((dep) => dep.path === undefined ? [] : [dep.path])
      .map((path) => repoRelative(root, path)),
  }));
}

/** The directories of `name` and every member it reaches by path. */
export function replCrateDirs(
  crates: readonly CrateMember[],
  name: string,
): string[] {
  const start = crates.find((crate) => crate.name === name);
  if (start === undefined) return [];
  const byDir = new Map(crates.map((crate) => [crate.dir, crate]));
  const seen = new Set([start.dir]);
  const stack = [start];
  while (stack.length > 0) {
    for (const dir of stack.pop()!.pathDeps) {
      const member = byDir.get(dir);
      if (member !== undefined && !seen.has(dir)) {
        seen.add(dir);
        stack.push(member);
      }
    }
  }
  return [...seen];
}

function within(path: string, dir: string): boolean {
  return dir === "" || path === dir || path.startsWith(`${dir}/`);
}

function classifyCore(path: string, ctx: ClassifyContext): PathClass {
  if (within(path, `${CORE_ROOT}/target`)) return "none";
  if (ctx.crates === null || WORKSPACE_FILES.has(path)) return "repl";
  let owner: CrateMember | undefined;
  for (const crate of ctx.crates) {
    if (
      within(path, crate.dir) &&
      (owner === undefined || crate.dir.length > owner.dir.length)
    ) {
      owner = crate;
    }
  }
  return owner !== undefined && ctx.replCrates.has(owner.dir) ? "repl" : "none";
}

function classifySource(path: string, ctx: ClassifyContext): PathClass {
  if (ctx.rules.exclude.some((suffix) => path.endsWith(suffix))) return "none";
  if (!path.endsWith(".ts")) return "runtime";
  const unit = unitFor(ctx.rules, path);
  if (unit !== undefined && WIRE_UNITS.has(unit.name)) return "both";
  return ctx.serverReachable.has(path) ? "runtime" : "none";
}

/** Classify one repo-relative path. */
export function classifyPath(path: string, ctx: ClassifyContext): PathClass {
  if (within(path, CORE_ROOT)) return classifyCore(path, ctx);
  if (within(path, SOURCE_ROOT)) return classifySource(path, ctx);
  return "none";
}

/** What one debounced batch of saved paths asks for. */
export function classifyBatch(
  paths: readonly string[],
  ctx: ClassifyContext,
): BatchClass {
  let runtime = false;
  let repl = false;
  for (const path of paths) {
    const kind = classifyPath(path, ctx);
    runtime ||= kind === "runtime" || kind === "both";
    repl ||= kind === "repl" || kind === "both";
  }
  return { runtime, repl, files: paths.length };
}
