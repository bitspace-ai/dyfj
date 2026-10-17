/**
 * The file watcher `dyfj dev` uses: one recursive `fs.watch` per tree,
 * reporting each saved path relative to the repository.
 *
 * Node's recursive watch works on macOS and Linux (the integration test runs
 * it on whichever the gate runs on). Editor scratch files and Cargo's build
 * output are dropped here, so a build never triggers a build and a swap file
 * never restarts the runtime. `core/target` is not watched at all: on Linux a
 * recursive watch holds one inotify watch per directory, and the build output
 * has hundreds (`coreTrees`).
 */

import { readdirSync, watch } from "node:fs";

export interface WatchedTree {
  /** Absolute directory to watch. */
  dir: string;
  /** Its repo-relative path, prefixed to every reported file. */
  prefix: string;
  /** Watch subdirectories too; true unless false. */
  recursive?: boolean;
}

export type WatchFn = (
  dir: string,
  options: { recursive: boolean },
  listener: (event: string, name: string | null) => void,
) => { close(): void };

const nodeWatch: WatchFn = (dir, options, listener) =>
  watch(dir, options, (event, name) => listener(event, name === null ? null : String(name)));

/** A path no build or runtime reads: an editor's scratch file, or build output. */
export function isEditorNoise(path: string): boolean {
  if (path === "core/target" || path.startsWith("core/target/")) return true;
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base.startsWith(".") ||
    base.endsWith("~") ||
    /\.sw[a-px]$/.test(base) ||
    /^\d+$/.test(base) ||
    /\.tmp(\.|$)/.test(base);
}

export function watchTrees(
  trees: readonly WatchedTree[],
  onChange: (path: string) => void,
  watchFn: WatchFn = nodeWatch,
): { close(): void } {
  const watchers = trees.map((tree) =>
    watchFn(tree.dir, { recursive: tree.recursive !== false }, (_event, name) => {
      if (name === null || name === "") return;
      const path = `${tree.prefix}/${name.replaceAll("\\", "/")}`;
      if (!isEditorNoise(path)) onChange(path);
    })
  );
  return {
    close() {
      for (const watcher of watchers) watcher.close();
    },
  };
}

/**
 * The trees that cover the Cargo workspace at `dir` without its `target/`:
 * the top level on its own (the manifests, the lock file, the toolchain file),
 * and each other directory recursively. Dot directories are skipped, as their
 * files are. A directory created later is not watched until `dyfj dev`
 * restarts.
 */
export function coreTrees(dir: string, prefix: string): WatchedTree[] {
  const subdirectories = readdirSync(dir, { withFileTypes: true })
    .filter((entry) =>
      entry.isDirectory() && entry.name !== "target" && !entry.name.startsWith(".")
    )
    .map((entry) => entry.name)
    .sort();
  return [
    { dir, prefix, recursive: false },
    ...subdirectories.map((name) => ({ dir: `${dir}/${name}`, prefix: `${prefix}/${name}` })),
  ];
}
