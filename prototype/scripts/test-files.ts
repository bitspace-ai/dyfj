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

// Routing between the two runtimes a test lane runs on while the track moves
// test registrations onto `node:test` (decision D32). The file's content
// decides; no file is listed by hand.
//
// - A file whose own source registers with `node:test` (it imports a
//   registration or hook, or the whole module) runs under `node --test`.
// - A file whose own source calls the existing runtime's test function or
//   imports `@std/testing/bdd` runs where it does today. So does a file with
//   neither, such as a conformance-kit caller whose registrations live in the
//   kit.
// - A file with both fails discovery: its tests would be split across two
//   runtimes, so it is converted whole or not at all.
//
// Importing only `mock` (or another non-registering export) from `node:test`
// is not a registration: files on the existing runtime do that today.

export type TestRuntime = "deno" | "node";

const NODE_TEST_REGISTRATIONS = new Set([
  "test",
  "it",
  "describe",
  "suite",
  "before",
  "after",
  "beforeEach",
  "afterEach",
]);
const nodeTestImportPattern =
  /\bimport\s+(type\s+)?([^;]*?)\s*from\s*["']node:test["']/g;
// Assembled so this file adds no whole-word reference to the runtime.neutral
// ratchet's count.
const legacyRegistrationPattern = new RegExp(
  `(?<![\\w$])${["De", "no"].join("")}\\.test\\s*\\(|` +
    `from\\s*["']@std/testing/bdd["']`,
);

/** Whether `source` itself registers a test or hook with `node:test`. */
export function registersWithNodeTest(source: string): boolean {
  for (const match of source.matchAll(nodeTestImportPattern)) {
    if (match[1] !== undefined) continue;
    const clause = match[2];
    const named = /\{([^}]*)\}/.exec(clause);
    // A default or namespace import reaches every registration.
    if (clause.replace(/\{[^}]*\}/, "").replace(/,/g, "").trim() !== "") {
      return true;
    }
    for (const specifier of named?.[1].split(",") ?? []) {
      const trimmed = specifier.trim();
      if (trimmed.startsWith("type ")) continue;
      const imported = trimmed.split(/\s+as\s+/)[0];
      if (NODE_TEST_REGISTRATIONS.has(imported)) return true;
    }
  }
  return false;
}

/** Whether `source` itself registers through the existing runtime's runner. */
export function registersWithLegacyRunner(source: string): boolean {
  return legacyRegistrationPattern.test(source);
}

/** The runtime `path`'s tests run on. Throws when the file registers with both. */
export function testRuntime(path: string, source: string): TestRuntime {
  const node = registersWithNodeTest(source);
  if (node && registersWithLegacyRunner(source)) {
    throw new Error(
      `${path} registers tests with both node:test and the existing runner ` +
        "(its test function or @std/testing/bdd); a test file runs on one " +
        "runtime, so convert all of its registrations together",
    );
  }
  return node ? "node" : "deno";
}

/**
 * `files` (paths relative to `root`) split by the runtime their tests run on,
 * each list in the given order. Fails closed on a file that registers with
 * both.
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
