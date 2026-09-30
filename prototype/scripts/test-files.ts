// One source of truth for which prototype files are typechecked and which
// test files each test lane runs. Every list is derived by walking the tree,
// never hand-maintained, so a new module or test is covered on arrival.
//
// The tier is decided by file name (`specs/03-testing.md` §3): integration
// files (`*.integration.test.ts`) run in the integration lane, the golden suite
// (`testing/golden/`) has its own lane, and every other `*.test.ts` is a unit
// test.

export const SOURCE_ROOTS = ["src", "mcp", "scripts", "testing"] as const;

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
  let entries: Iterable<Deno.DirEntry>;
  try {
    entries = Deno.readDirSync(`${root}/${directory}`);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
  for (const entry of entries) {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory) {
      if (!ignoredDirectories.has(entry.name)) {
        walkSync(root, relative, keep, out);
      }
    } else if (entry.isFile && keep(relative)) {
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
