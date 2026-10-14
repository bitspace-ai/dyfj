// The `erasable.syntax` gate lane: no git-tracked TypeScript file may hold a
// constructor parameter property (a constructor parameter with an
// accessibility, `readonly` or `override` modifier).
//
// Node runs `.ts` by stripping types without transforming them (decision
// D32), and a parameter property is the one construct in this repository that
// stripping cannot erase: a module that holds one fails to load under Node. The
// lane keeps the syntax from coming back until `tsc --erasableSyntaxOnly`
// takes the check over.
//
// The scan uses the runtime's own parser, not a pattern: it runs `deno lint`
// with the repository-owned plugin in `erasable-syntax-lint-plugin.ts`, which
// reports every parameter-property node, across line breaks and whatever the
// modifiers. A file the linter cannot parse fails the lane too.
//
// Written to `node:` builtins only, so it adds no reference to the runtime
// global that `runtime.neutral` counts.
//
// Usage (from the repository root; `--deno=<path>` selects the binary that
// runs `deno lint`, default `deno` on PATH):
//   deno run --allow-read=. --allow-run=git,deno scripts/erasable-syntax.ts
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import process from "node:process";

export const LABEL = "erasable.syntax";
export const LINT_CONFIG_PATH = "scripts/erasable-syntax-lint.json";
const RULE = "erasable-syntax/parameter-property";

/** The part of `deno lint --json` output the lane reads. */
export interface LintOutput {
  diagnostics: {
    filename: string;
    code: string;
    message: string;
    range: { start: { line: number } };
  }[];
  errors: { file_path?: string; message?: string }[];
}

function relativeTo(root: string, name: string): string {
  const file = name.startsWith("file:") ? fileURLToPath(name) : name;
  return file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file;
}

/** One error line per parameter property and per file that failed to parse. */
export function erasableSyntaxViolations(
  lint: LintOutput,
  root: string,
): string[] {
  const errors = lint.errors.map((error) =>
    `${relativeTo(root, error.file_path ?? "?")}: could not be parsed: ` +
    `${error.message ?? "unknown error"}`
  );
  const found = lint.diagnostics
    .filter((diagnostic) => diagnostic.code === RULE)
    .map((diagnostic) => ({
      path: relativeTo(root, diagnostic.filename),
      line: diagnostic.range.start.line,
      name: diagnostic.message,
    }))
    .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  for (const { path, line, name } of found) {
    errors.push(
      `${path}:${line}: constructor parameter property \`${name}\`; declare ` +
        "the field in the class body and assign it in the constructor",
    );
  }
  return errors;
}

/** Runs the plugin over `files` (absolute paths) and parses its JSON report. */
export function lintParameterProperties(
  denoExecutable: string,
  root: string,
  files: readonly string[],
): LintOutput {
  if (files.length === 0) return { diagnostics: [], errors: [] };
  const result = spawnSync(
    denoExecutable,
    [
      "lint",
      "--json",
      "--quiet",
      `--config=${join(root, LINT_CONFIG_PATH)}`,
      ...files,
    ],
    {
      cwd: root,
      // Explicit, so the spawn reads no environment: the lane holds no env
      // grant beyond the one the runtime's spawn shim reads.
      env: {},
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  // `deno lint` exits 1 when it reports a diagnostic.
  if (
    result.error !== undefined || (result.status !== 0 && result.status !== 1)
  ) {
    throw new Error(
      `deno lint failed (${
        result.error?.message ?? `exit ${result.status}`
      }): ` +
        `${(result.stderr ?? "").trim()}`,
    );
  }
  return JSON.parse(result.stdout) as LintOutput;
}

function trackedTypeScript(root: string): string[] {
  const listing = execFileSync("git", ["ls-files", "-z", "--", "*.ts"], {
    cwd: root,
    env: {},
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 64 * 1024 * 1024,
  });
  return listing.split("\0").filter((path) => path !== "").sort();
}

export interface ErasableSyntaxResult {
  report: string;
  errors: string[];
}

export function checkErasableSyntax(
  root: string,
  denoExecutable: string,
): ErasableSyntaxResult {
  const files = trackedTypeScript(root);
  const lint = lintParameterProperties(
    denoExecutable,
    root,
    files.map((path) => join(root, path)),
  );
  const errors = erasableSyntaxViolations(lint, root);
  return {
    report: `${LABEL}: ${files.length} tracked .ts files scanned, ` +
      `${errors.length} violations`,
    errors,
  };
}

function main(args: readonly string[], root: string): number {
  const denoArg = args.find((arg) => arg.startsWith("--deno="));
  if (args.some((arg) => arg !== denoArg)) {
    console.error(`${LABEL}: usage: [--deno=<path>]`);
    return 64;
  }
  const { report, errors } = checkErasableSyntax(
    root,
    denoArg?.slice("--deno=".length) ?? "deno",
  );
  console.log(report);
  for (const error of errors) console.error(`${LABEL}: ${error}`);
  return errors.length > 0 ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2), process.cwd());
}
