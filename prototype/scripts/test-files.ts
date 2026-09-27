// One source of truth for which prototype files are typechecked and which
// test files each test lane runs. Every list is derived by walking the tree,
// never hand-maintained, so a new module or test is covered on arrival.
//
// During the Vitest-to-`Deno.test` transition both frameworks share the
// `*.test.ts` naming, so a test file's framework is read from its imports: a
// file that statically imports `vitest` belongs to the Vitest lane, anything
// else is a `Deno.test` file. The imports come from `deno info --json` (the
// deno_graph parser Deno itself uses), not from scanning the source text, so
// import-shaped text in strings, template literals or comments never counts.
// Integration files (`*.integration.test.ts`) and the golden suite
// (`testing/golden/`) have their own lanes and are never unit tests.

import { pathToFileURL } from "node:url";
import { selectedDenoExecutable } from "./deno-executable.ts";

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

export function isVitestSpecifier(specifier: string): boolean {
  return vitestSpecifierPattern.test(specifier);
}

/** The subset of `deno info --json` output that classification reads. */
export interface DenoInfoOutput {
  modules: {
    specifier: string;
    error?: string;
    dependencies?: { specifier: string; isDynamic?: boolean }[];
  }[];
}

/**
 * The module URLs among `urls` that statically import `vitest` (value or
 * type import, bare or `npm:` specifier). A dynamic `import()` does not
 * count. Fails closed: a module missing from the graph, or one that did not
 * parse, cannot be classified and throws.
 */
export function vitestModulesFromDenoInfo(
  info: DenoInfoOutput,
  urls: readonly string[],
): Set<string> {
  const byUrl = new Map(
    info.modules.map((module) => [module.specifier, module]),
  );
  const vitest = new Set<string>();
  for (const url of urls) {
    const module = byUrl.get(url);
    if (module === undefined) {
      throw new Error(`cannot classify test file (not in graph): ${url}`);
    }
    if (module.error !== undefined) {
      throw new Error(`cannot classify test file: ${module.error}`);
    }
    const importsVitest = (module.dependencies ?? []).some((dependency) =>
      dependency.isDynamic !== true && isVitestSpecifier(dependency.specifier)
    );
    if (importsVitest) vitest.add(url);
  }
  return vitest;
}

/**
 * A `data:` module that side-effect-imports each URL, so one `deno info` call
 * covers every file.
 */
export function rootModule(urls: readonly string[]): string {
  const source = urls.map((url) => `import ${JSON.stringify(url)};\n`).join("");
  return `data:application/typescript,${encodeURIComponent(source)}`;
}

/**
 * Runs `deno info --json` over the given module URLs. Offline and
 * config-free: packages are not resolved, and a bare or `npm:` specifier is
 * still reported by name, which is all classification needs.
 */
export function denoInfo(
  urls: readonly string[],
  deno: string = selectedDenoExecutable(),
): DenoInfoOutput {
  const output = new Deno.Command(deno, {
    args: [
      "info",
      "--json",
      "--no-remote",
      "--no-npm",
      "--no-config",
      "--no-lock",
      rootModule(urls),
    ],
    stdout: "piped",
    stderr: "piped",
  }).outputSync();
  if (!output.success) {
    throw new Error(
      `deno info failed: ${new TextDecoder().decode(output.stderr).trim()}`,
    );
  }
  return JSON.parse(new TextDecoder().decode(output.stdout));
}

/** The repository-relative test files among `files` that import `vitest`. */
export function vitestTestFiles(
  root: string,
  files: readonly string[],
): Set<string> {
  if (files.length === 0) return new Set();
  const absoluteRoot = root.startsWith("/") ? root : `${Deno.cwd()}/${root}`;
  const urlOf = new Map(
    files.map((file) => [pathToFileURL(`${absoluteRoot}/${file}`).href, file]),
  );
  const urls = [...urlOf.keys()];
  const vitest = vitestModulesFromDenoInfo(denoInfo(urls), urls);
  return new Set([...vitest].map((url) => urlOf.get(url)!));
}

export function testSourcesFromPaths(paths: readonly string[]): string[] {
  return paths.filter(isTestSource).sort();
}

function isGoldenPath(path: string): boolean {
  return path.startsWith(goldenDirectory) ||
    path.includes(`/${goldenDirectory}`);
}

/** A `Deno.test` file that belongs in the `test.unit` lane. */
export function isUnitTest(path: string, importsVitest: boolean): boolean {
  return isTestSource(path) && !isIntegrationTest(path) &&
    !isGoldenPath(path) && !importsVitest;
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
  const tests = discoverTestSources(root);
  const vitest = vitestTestFiles(root, tests);
  return tests.filter((path) => isUnitTest(path, vitest.has(path)));
}

/**
 * Non-integration `Deno.test` files outside the golden suite are the unit
 * lane's; Vitest must not collect them. Golden files are excluded from Vitest
 * too, so this is every `*.test.ts` that does not import `vitest`.
 */
export function discoverDenoTestSources(root: string): string[] {
  const tests = discoverTestSources(root);
  const vitest = vitestTestFiles(root, tests);
  return tests.filter((path) => !vitest.has(path));
}
