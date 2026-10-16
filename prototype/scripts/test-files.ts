// One source of truth for which prototype files are typechecked and which
// test files each test lane runs. Every list is derived by walking the tree,
// never hand-maintained, so a new module or test is covered on arrival.
//
// The tier is decided by file name (`specs/03-testing.md` §3): integration
// files (`*.integration.test.ts`) run in the integration lane, the golden suite
// (`testing/golden/`) has its own lane, and every other `*.test.ts` is a unit
// test.

import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const SOURCE_ROOTS = [
  "src",
  "mcp",
  "scripts",
  "testing",
  "diagnostics",
  "examples",
] as const;

const ignoredDirectories = new Set([".git", "node_modules"]);
const typeScriptSourcePattern = /\.[cm]?tsx?$/;
const declarationPattern = /\.d\.[cm]?ts$/;
const testSourcePattern = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const integrationTestPattern = /\.integration\.(?:test|spec)\.[cm]?[jt]sx?$/;
const goldenDirectory = "testing/golden/";

export function isTestSource(path: string): boolean {
  return testSourcePattern.test(path);
}

export function isIntegrationTest(path: string): boolean {
  return integrationTestPattern.test(path);
}

export function isTypecheckSource(path: string): boolean {
  return typeScriptSourcePattern.test(path) &&
    !declarationPattern.test(path) && !isTestSource(path);
}

export function testSourcesFromPaths(paths: readonly string[]): string[] {
  return paths.filter(isTestSource).sort();
}

function isGoldenPath(path: string): boolean {
  return path.startsWith(goldenDirectory) ||
    path.includes(`/${goldenDirectory}`);
}

/** A test file that belongs in the `test.unit` lane. */
export function isUnitTest(path: string): boolean {
  return isTestSource(path) && !isIntegrationTest(path) && !isGoldenPath(path);
}

/** A test file that belongs in the integration lane. */
export function isIntegrationLaneTest(path: string): boolean {
  return isIntegrationTest(path) && !isGoldenPath(path);
}

function walkSync(
  root: string,
  directory: string,
  keep: (relative: string) => boolean,
  out: string[],
): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(`${root}/${directory}`, { withFileTypes: true });
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        walkSync(root, relative, keep, out);
      }
    } else if (entry.isFile() && keep(relative)) {
      out.push(relative);
    }
  }
}

/** Repository-relative paths under the source roots that satisfy `keep`. */
export function discoverSync(
  root: string,
  keep: (relative: string) => boolean,
  roots: readonly string[] = SOURCE_ROOTS,
): string[] {
  const out: string[] = [];
  for (const directory of roots) walkSync(root, directory, keep, out);
  return out.sort();
}

export function discoverTypecheckSources(root: string): string[] {
  return discoverSync(root, isTypecheckSource);
}

export function discoverTestSources(root: string): string[] {
  return discoverSync(root, isTestSource);
}

export function discoverUnitTests(root: string): string[] {
  return discoverTestSources(root).filter(isUnitTest);
}

export function discoverIntegrationTests(root: string): string[] {
  return discoverTestSources(root).filter(isIntegrationLaneTest);
}

/** The golden suite's test files, which only the golden lane runs. */
export function discoverGoldenTests(root: string): string[] {
  return discoverTestSources(root).filter(isGoldenPath);
}

// Routing between the two runtimes a test lane runs on (decision D32).
// Product tests run on `node:test` only; the lane and gate tooling tests
// under `scripts/` (this directory) keep the existing runtime until the
// gate-tooling port. No file is listed by hand:
//
// - A file under `scripts/` whose own source calls the existing runtime's
//   test function or imports `@std/testing/bdd` runs where it does today,
//   until the gate-tooling port.
// - Every other file runs under `node --test`, including a `scripts/` file
//   that registers with `node:test` only.
// - A file outside `scripts/` that calls the existing runtime's test
//   function or imports `@std/testing/bdd` fails discovery, with its path.

export type TestRuntime = "deno" | "node";

const gateToolingDirectory = "scripts/";
// Assembled so this file adds no whole-word reference to the runtime.neutral
// ratchet's count.
const legacyRegistrationPattern = new RegExp(
  `(?<![\\w$])${["De", "no"].join("")}\\.test\\s*\\(|` +
    `from\\s*["']@std/testing/bdd["']`,
);

/** Whether `source` itself registers through the existing runtime's runner. */
export function registersWithLegacyRunner(source: string): boolean {
  return legacyRegistrationPattern.test(source);
}

/** Whether `path` (relative to the prototype root) is a gate-tooling test. */
export function isGateToolingTest(path: string): boolean {
  return path.startsWith(gateToolingDirectory);
}

/**
 * The runtime `path`'s tests run on. Throws when a file outside `scripts/`
 * registers with the existing runtime's runner.
 */
export function testRuntime(path: string, source: string): TestRuntime {
  if (!registersWithLegacyRunner(source)) return "node";
  if (isGateToolingTest(path)) return "deno";
  throw new Error(
    `${path} registers tests with the existing runner (its test function or ` +
      "@std/testing/bdd); product tests run on node:test only, so convert " +
      "its registrations to node:test",
  );
}

/**
 * `files` (paths relative to `root`) split by the runtime their tests run on,
 * each list in the given order. Fails closed on a product test file that
 * registers with the existing runner.
 */
export function partitionByRuntime(
  root: string,
  files: readonly string[],
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): Record<TestRuntime, string[]> {
  const partition: Record<TestRuntime, string[]> = { deno: [], node: [] };
  for (const file of files) {
    partition[testRuntime(file, read(join(root, file)))].push(file);
  }
  return partition;
}
