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
const vitestSpecifierPattern = /^(?:npm:)?vitest(?:@[^/]*)?(?:\/.*)?$/;
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

/**
 * The module specifiers of a file's leading import block: the static
 * `import … from "x"`, `import "x"` and `export … from "x"` statements before
 * the first other statement, with comments and whitespace skipped. Scanning
 * stops at the first statement that is not one of those, so import-shaped text
 * later in the file (a string, a template literal, a comment in the body) is
 * never read as an import.
 */
export function leadingImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  let i = source.startsWith("#!") ? lineEnd(source, 0) : 0;
  for (;;) {
    i = skipTrivia(source, i);
    const keyword = readWord(source, i);
    if (keyword !== "import" && keyword !== "export") return specifiers;
    const next = source[skipTrivia(source, i + keyword.length)];
    // `import(…)`, `import.meta` and `export const …` end the import block.
    if (keyword === "import" && (next === "(" || next === ".")) {
      return specifiers;
    }
    if (keyword === "export" && next !== "*" && next !== "{") {
      const word = readWord(source, skipTrivia(source, i + keyword.length));
      if (word !== "type") return specifiers;
    }
    i += keyword.length;
    // A bare `import "x"` or the first string after `from` is the specifier;
    // strings in a trailing `with { … }` attribute clause are not.
    let bare = keyword === "import";
    let afterFrom = false;
    let specifier: string | undefined;
    for (;;) {
      i = skipTrivia(source, i);
      const char = source[i];
      if (char === undefined) break;
      if (char === ";") {
        i++;
        break;
      }
      if (char === '"' || char === "'") {
        const [value, end] = readString(source, i);
        i = end;
        if (specifier === undefined && (bare || afterFrom)) {
          specifier = value;
          // Without a semicolon the statement ends here, unless an
          // attribute clause follows (possibly on the next line).
          const next = skipTrivia(source, i);
          const word = readWord(source, next);
          if (source[next] !== ";" && word !== "with" && word !== "assert") {
            break;
          }
        }
        bare = false;
        continue;
      }
      const word = readWord(source, i);
      if (specifier !== undefined && (word === "with" || word === "assert")) {
        // The attribute clause ends the declaration, with or without a
        // semicolon after it.
        i = skipTrivia(source, i + word.length);
        if (source[i] === "{") i = skipBraces(source, i);
        const next = skipTrivia(source, i);
        if (source[next] === ";") i = next + 1;
        break;
      }
      if (word !== undefined) {
        if (word === "from") afterFrom = true;
        bare = false;
        i += word.length;
        continue;
      }
      bare = false;
      i++;
    }
    if (specifier === undefined) return specifiers;
    specifiers.push(specifier);
  }
}

function lineEnd(source: string, from: number): number {
  const end = source.indexOf("\n", from);
  return end < 0 ? source.length : end + 1;
}

function skipTrivia(source: string, from: number): number {
  let i = from;
  for (;;) {
    while (i < source.length && /\s/.test(source[i]!)) i++;
    if (source.startsWith("//", i)) {
      i = lineEnd(source, i);
    } else if (source.startsWith("/*", i)) {
      const end = source.indexOf("*/", i + 2);
      i = end < 0 ? source.length : end + 2;
    } else {
      return i;
    }
  }
}

function readWord(source: string, from: number): string | undefined {
  return /^[A-Za-z_$][\w$]*/.exec(source.slice(from, from + 64))?.[0];
}

/** The index just past the `}` that closes the `{` at `from`. */
function skipBraces(source: string, from: number): number {
  let depth = 0;
  let i = from;
  while (i < source.length) {
    const char = source[i];
    if (char === '"' || char === "'") {
      i = readString(source, i)[1];
      continue;
    }
    if (source.startsWith("//", i) || source.startsWith("/*", i)) {
      i = skipTrivia(source, i);
      continue;
    }
    if (char === "{") depth++;
    if (char === "}" && --depth === 0) return i + 1;
    i++;
  }
  return i;
}

function readString(source: string, from: number): [string, number] {
  const quote = source[from];
  let value = "";
  let i = from + 1;
  while (i < source.length && source[i] !== quote) {
    if (source[i] === "\\") i++;
    value += source[i] ?? "";
    i++;
  }
  return [value, i + 1];
}

export function importsVitest(source: string): boolean {
  return leadingImportSpecifiers(source).some((specifier) =>
    vitestSpecifierPattern.test(specifier)
  );
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
