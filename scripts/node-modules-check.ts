/**
 * npm install precondition: the repository root's `node_modules` must match
 * the root `package-lock.json`.
 *
 * npm is the only resolver of npm packages, and the test lanes run against
 * the node_modules npm installed (`nodeModulesDir: "manual"`). A missing or
 * out-of-date install would test a tree other than the locked one, so the
 * gate fails closed and names the remedy. The gate never installs: it holds
 * no run or network grant for npm.
 *
 * npm records what it installed in `node_modules/.package-lock.json`, in the
 * lockfile's own `packages` shape. The install is current when both name the
 * same packages at the same versions, and every package both name still has
 * its `package.json` on disk, so a directory deleted after the install is
 * caught. A locked optional package may be absent, because npm skips
 * optional packages built for another platform. The root is an npm
 * workspace, so the lockfile also names each member (`prototype`) and the
 * link npm installs for it (`node_modules/dyfj-prototype`). A member must
 * have its `package.json` on disk. A link is current only when npm recorded
 * the same target the lockfile names, that target is a plain relative path
 * inside the package directory, and the link on disk is a symlink resolving
 * to exactly that directory, so a link into another directory, inside the
 * repository or out of it, is caught.
 */

import { existsSync, lstatSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { sanitizeForLog } from "./scan-lib.ts";

export const NODE_MODULES_REMEDY = "run `npm ci` at the repository root";

const MAX_NAMED = 10;

export type NodeModulesState =
  | { state: "current" }
  | { state: "missing" }
  | { state: "stale"; differing?: string[] }
  | { state: "invalid" };

type PackageEntries = Record<string, Record<string, unknown>>;

function packageEntries(text: string): PackageEntries | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const packages = (parsed as Record<string, unknown>).packages;
  if (
    typeof packages !== "object" || packages === null ||
    Array.isArray(packages)
  ) {
    return undefined;
  }
  return packages as PackageEntries;
}

// A link target npm can record for a workspace member: relative, inside the
// package directory, with no empty, `.` or `..` segment and no backslash.
function isContainedTarget(target: unknown): target is string {
  return typeof target === "string" && target !== "" &&
    !target.startsWith("/") && !target.includes("\\") &&
    target.split("/").every((segment) =>
      segment !== "" && segment !== "." && segment !== ".."
    );
}

/**
 * Compares the lockfile with npm's record of the install. `hidden` is the
 * text of `node_modules/.package-lock.json`, undefined when it is absent.
 * `hasPackage` says whether a package path (`node_modules/...`) still holds
 * its `package.json`. `linksTo` says whether a link path is a symlink that
 * resolves to exactly the given target directory.
 */
export function nodeModulesState(
  lock: string,
  hidden: string | undefined,
  hasPackage: (path: string) => boolean,
  linksTo: (path: string, target: string) => boolean,
): NodeModulesState {
  const locked = packageEntries(lock);
  if (locked === undefined) return { state: "invalid" };
  if (hidden === undefined) return { state: "missing" };
  const installed = packageEntries(hidden);
  if (installed === undefined) return { state: "stale" };
  const differing = new Set<string>();
  for (const [path, entry] of Object.entries(locked)) {
    // The empty key is the root package itself, never installed.
    if (path === "") continue;
    const present = installed[path];
    if (present === undefined) {
      if (entry.optional !== true) differing.add(path);
      continue;
    }
    if (entry.link === true) {
      if (
        present.link !== true || present.resolved !== entry.resolved ||
        !isContainedTarget(entry.resolved) ||
        !linksTo(path, entry.resolved)
      ) {
        differing.add(path);
      }
      continue;
    }
    if (present.version !== entry.version || !hasPackage(path)) {
      differing.add(path);
    }
  }
  for (const path of Object.keys(installed)) {
    if (path !== "" && locked[path] === undefined) differing.add(path);
  }
  if (differing.size === 0) return { state: "current" };
  return { state: "stale", differing: [...differing].sort() };
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Checks the package directory `dir`; returns the process exit code. */
export async function runNodeModulesCheck(
  dir: string,
  out: Pick<Console, "log" | "error"> = console,
): Promise<number> {
  const lock = await readOptional(join(dir, "package-lock.json"));
  if (lock === undefined) {
    out.error("node_modules: package-lock.json is missing");
    return 1;
  }
  const hidden = await readOptional(
    join(dir, "node_modules", ".package-lock.json"),
  );
  const result = nodeModulesState(
    lock,
    hidden,
    (path) => existsSync(join(dir, path, "package.json")),
    (path, target) => {
      try {
        return lstatSync(join(dir, path)).isSymbolicLink() &&
          realpathSync(join(dir, path)) === realpathSync(join(dir, target));
      } catch {
        return false;
      }
    },
  );
  switch (result.state) {
    case "current":
      out.log("node_modules: matches package-lock.json");
      return 0;
    case "invalid":
      out.error("node_modules: package-lock.json is not readable");
      return 1;
    case "missing":
      out.error(
        `node_modules: node_modules is missing; ${NODE_MODULES_REMEDY}`,
      );
      return 1;
    case "stale": {
      const differing = result.differing ?? [];
      out.error(
        "node_modules: node_modules is out of date with " +
          `package-lock.json; ${NODE_MODULES_REMEDY}`,
      );
      for (const path of differing.slice(0, MAX_NAMED)) {
        out.error(`  - ${sanitizeForLog(path, 200)}`);
      }
      if (differing.length > MAX_NAMED) {
        out.error(`  … and ${differing.length - MAX_NAMED} more`);
      }
      return 1;
    }
  }
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (dir === undefined) {
    console.error("usage: node-modules-check.ts <package directory>");
    process.exitCode = 64;
  } else {
    try {
      process.exitCode = await runNodeModulesCheck(dir);
    } catch (error) {
      console.error(
        `node_modules: check failed (${
          (error as { code?: unknown }).code ?? (error as Error).name
        }); ${NODE_MODULES_REMEDY}`,
      );
      process.exitCode = 1;
    }
  }
}
