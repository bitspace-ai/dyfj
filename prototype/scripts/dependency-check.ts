/**
 * The launcher's dependency preflight: is every package `prototype/package.json`
 * depends on installed, at the version it pins? A missing or stale
 * `node_modules` otherwise surfaces as Node's own `ERR_MODULE_NOT_FOUND` stack
 * trace from whichever import fails first, which names neither the cause nor
 * the fix.
 *
 * Imports only `node:` modules, so it runs on the very tree it checks. Exits
 * 0 when the tree is usable, else prints one `dyfj:` line to stderr and
 * exits 1.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** An exact `x.y.z` pin; a range is not compared. */
const EXACT_PIN = /^\d+\.\d+\.\d+$/;

/** The installed version of `name` seen from `from`, or undefined. */
function installedVersion(from: string, name: string): string | undefined {
  for (let dir = from;; dir = dirname(dir)) {
    const manifest = join(dir, "node_modules", name, "package.json");
    if (existsSync(manifest)) {
      const { version } = JSON.parse(readFileSync(manifest, "utf8")) as {
        version?: unknown;
      };
      return typeof version === "string" ? version : "";
    }
    if (dirname(dir) === dir) return undefined;
  }
}

/**
 * Why the dependencies of the package at `prototypeDir` are not usable, or
 * undefined when they are. Names the first missing or mismatched package and
 * the command that installs the pinned set.
 */
export function dependencyProblem(prototypeDir: string): string | undefined {
  const { dependencies = {} } = JSON.parse(
    readFileSync(join(prototypeDir, "package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  const fix = `run \`npm ci\` in ${dirname(prototypeDir)}, then retry`;
  for (const [name, pin] of Object.entries(dependencies)) {
    const installed = installedVersion(prototypeDir, name);
    if (installed === undefined) {
      return `dyfj: the dependency ${name} is not installed, so the client ` +
        `and runtime cannot load; ${fix}`;
    }
    if (EXACT_PIN.test(pin) && installed !== pin) {
      return `dyfj: ${name} ${installed} is installed, but ` +
        `prototype/package.json pins ${pin}: the installed dependencies are ` +
        `out of date; ${fix}`;
    }
  }
  return undefined;
}

if (import.meta.main) {
  const prototypeDir = dirname(dirname(fileURLToPath(import.meta.url)));
  const problem = dependencyProblem(prototypeDir);
  if (problem !== undefined) {
    process.stderr.write(`${problem}\n`);
    process.exitCode = 1;
  }
}
