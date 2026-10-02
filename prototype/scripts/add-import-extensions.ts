import { dirname, join, relative } from "node:path";

// Rewrites extensionless relative module specifiers to name the file they
// resolve to, so every local import resolves without extension guessing. Covers
// static and dynamic imports, re-exports and `typeof import(...)`.
// Specifiers that already carry an extension are left alone, and a file
// containing the IGNORE_MARKER line is skipped (this script's own test
// fixtures are import-shaped strings).
//
// Usage: deno run --allow-read=. --allow-write=. \
//          scripts/add-import-extensions.ts [dir ...]
// Defaults to src, mcp, scripts, examples, testing. Exits 1 when a specifier resolves
// to no file, after rewriting everything else.

export const IGNORE_MARKER = "// add-import-extensions: ignore-file";

const KNOWN_EXTENSION = /\.(?:[cm]?[jt]sx?|json)$/;

const SPECIFIER_PATTERNS = [
  /(\b(?:from|import)\s*\(?\s*)(["'])(\.{1,2}\/[^"'\n]*)\2/g,
];

export type ResolveCandidate = (path: string) => boolean;

export interface RewriteResult {
  source: string;
  unresolved: string[];
}

export function addImportExtensions(
  source: string,
  fileDir: string,
  exists: ResolveCandidate,
): RewriteResult {
  const unresolved: string[] = [];
  if (source.includes(IGNORE_MARKER)) return { source, unresolved };
  let output = source;
  for (const pattern of SPECIFIER_PATTERNS) {
    output = output.replace(
      pattern,
      (match, prefix: string, quote: string, specifier: string) => {
        if (KNOWN_EXTENSION.test(specifier)) return match;
        const target = join(fileDir, specifier);
        const suffix = [".ts", ".tsx", "/index.ts"].find((candidate) =>
          exists(target + candidate)
        );
        if (suffix === undefined) {
          unresolved.push(specifier);
          return match;
        }
        return `${prefix}${quote}${specifier}${suffix}${quote}`;
      },
    );
  }
  return { source: output, unresolved };
}

function isFile(path: string): boolean {
  try {
    return Deno.statSync(path).isFile;
  } catch {
    return false;
  }
}

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of Deno.readDirSync(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory && entry.name !== "node_modules") {
      yield* sourceFiles(path);
    } else if (entry.isFile && /\.[cm]?[jt]sx?$/.test(entry.name)) {
      yield path;
    }
  }
}

if (import.meta.main) {
  const roots = Deno.args.length > 0
    ? Deno.args
    : ["src", "mcp", "scripts", "examples", "testing", "diagnostics"];
  let failed = false;
  for (const root of roots) {
    for (const file of sourceFiles(root)) {
      const before = Deno.readTextFileSync(file);
      const { source, unresolved } = addImportExtensions(
        before,
        dirname(file),
        isFile,
      );
      if (source !== before) {
        Deno.writeTextFileSync(file, source);
        console.log(`rewrote ${relative(".", file)}`);
      }
      for (const specifier of unresolved) {
        failed = true;
        console.error(`unresolved ${relative(".", file)}: ${specifier}`);
      }
    }
  }
  if (failed) Deno.exit(1);
}
