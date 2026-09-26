// One source of truth for which prototype files are typechecked and which
// test files each test lane runs. Every list is derived by walking the tree,
// never hand-maintained, so a new module or test is covered on arrival.
//
// During the Vitest-to-`Deno.test` transition both frameworks share the
// `*.test.ts` naming, so a test file's framework is read from its source: a
// file that imports `vitest` belongs to the Vitest lane, anything else is a
// `Deno.test` file. Integration files (`*.integration.test.ts`) and the golden
// suite (`testing/golden/`) have their own lanes and are never unit tests.

export const SOURCE_ROOTS = ["src", "mcp", "scripts", "testing"] as const;

const ignoredDirectories = new Set([".git", ".vitest-tmp", "node_modules"]);
const typeScriptSourcePattern = /\.[cm]?tsx?$/;
const declarationPattern = /\.d\.[cm]?ts$/;
const testSourcePattern = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const integrationTestPattern = /\.integration\.(?:test|spec)\.[cm]?[jt]sx?$/;
// Anchored to a statement at the start of a line, so import text quoted inside
// a string (a fixture, a diagnostic) never reclassifies a file. Covers
// `import … from`, the closing `} from` line of a multi-line import, a
// re-export, and a bare side-effect import.
const vitestImportPattern =
  /^\s*(?:(?:import|export)\b[^\n'"`]*?\bfrom|\}\s*from|import)\s*["'](?:npm:)?vitest(?:@[^"'/]*)?(?:\/[^"']*)?["']/m;
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

export function importsVitest(source: string): boolean {
  return vitestImportPattern.test(source);
}

export function testSourcesFromPaths(paths: readonly string[]): string[] {
  return paths.filter(isTestSource).sort();
}

function isGoldenPath(path: string): boolean {
  return path.startsWith(goldenDirectory) ||
    path.includes(`/${goldenDirectory}`);
}

/** A `Deno.test` file that belongs in the `test.unit` lane. */
export function isUnitTest(path: string, source: string): boolean {
  return isTestSource(path) && !isIntegrationTest(path) &&
    !isGoldenPath(path) && !importsVitest(source);
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
  return discoverSync(
    root,
    (path) =>
      isTestSource(path) &&
      isUnitTest(path, Deno.readTextFileSync(`${root}/${path}`)),
  );
}

/**
 * Non-integration `Deno.test` files outside the golden suite are the unit
 * lane's; Vitest must not collect them. Golden files are excluded from Vitest
 * too, so this is every `*.test.ts` that does not import `vitest`.
 */
export function discoverDenoTestSources(root: string): string[] {
  return discoverSync(
    root,
    (path) =>
      isTestSource(path) &&
      !importsVitest(Deno.readTextFileSync(`${root}/${path}`)),
  );
}
