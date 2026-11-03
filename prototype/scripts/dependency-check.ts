/**
 * The launcher's dependency preflight: does each package under
 * `dependencies` in `prototype/package.json` have a readable installed
 * manifest, at the pinned version when the pin is an exact numeric `x.y.z`?
 * A missing or stale `node_modules` otherwise surfaces as Node's own
 * `ERR_MODULE_NOT_FOUND` stack trace from whichever import fails first,
 * which names neither the cause nor the fix. It reads manifests only: it
 * does not check a package's files, ranges or other pin forms, or whether
 * `node_modules` matches `package-lock.json`.
 *
 * Imports only `node:` modules, so it runs on the very tree it checks. Exits
 * 0 when every check passes, else prints one `dyfj:` line to stderr and
 * exits 1.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** An exact `x.y.z` pin; a range is not compared. */
const EXACT_PIN = /^\d+\.\d+\.\d+$/;

/** A manifest that is present but cannot be read or parsed. */
const UNREADABLE = Symbol("unreadable");

/**
 * The installed version of `name` seen from `from`: undefined when no
 * manifest is found, `UNREADABLE` when one is found but cannot be read or
 * parsed, else its `version` ("" when it has none).
 */
function installedVersion(
  from: string,
  name: string,
): string | typeof UNREADABLE | undefined {
  for (let dir = from;; dir = dirname(dir)) {
    const manifest = join(dir, "node_modules", name, "package.json");
    if (existsSync(manifest)) {
      try {
        const { version } = JSON.parse(readFileSync(manifest, "utf8")) as {
          version?: unknown;
        };
        return typeof version === "string" ? version : "";
      } catch {
        return UNREADABLE;
      }
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
    if (installed === UNREADABLE) {
      return `dyfj: the installed package.json of ${name} cannot be read, ` +
        `so the installation is incomplete; ${fix}`;
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
  let problem: string | undefined;
  try {
    problem = dependencyProblem(prototypeDir);
  } catch {
    problem = `dyfj: the dependency check cannot read ` +
      `${join(prototypeDir, "package.json")}; check the checkout, then retry`;
  }
  if (problem !== undefined) {
    process.stderr.write(`${problem}\n`);
    process.exitCode = 1;
  }
}
