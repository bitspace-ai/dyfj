// The `runtime.neutral` gate lane: a ratchet on references to the Deno host
// API in tracked TypeScript, so the port to Node (decision D32) shows its
// progress and nothing new takes a dependency on the runtime being replaced.
//
// It counts the literal text of a Deno API reference (comments included, to
// match `rg`) in every git-tracked `.ts` file and compares each file's count
// to the committed `scripts/runtime-neutral-exceptions.json`. The ratchet is
// exact: a count above its entry fails, and so does one below it, so a port
// leaf lowers the entry in the same change and its diff shows the drop. Once
// no file has a reference the list is `[]` and any new reference has no entry.
//
// Written to `node:` builtins only, so it adds no reference of its own and
// runs unchanged on either runtime.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const LABEL = "runtime.neutral";
export const EXCEPTIONS_PATH = "scripts/runtime-neutral-exceptions.json";

// Assembled so this file does not contain the text it counts.
const RUNTIME = "Deno";
const REFERENCE = new RegExp(`${RUNTIME}\\.`, "g");

/** One entry of `scripts/runtime-neutral-exceptions.json`. */
export interface RuntimeNeutralException {
  path: string;
  /** The file's reference count, which it may neither exceed nor undercut. */
  count: number;
  reason: string;
}

export function countReferences(source: string): number {
  return source.match(REFERENCE)?.length ?? 0;
}

function isWellFormed(raw: unknown): raw is RuntimeNeutralException {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return false;
  }
  const entry = raw as Partial<RuntimeNeutralException>;
  return typeof entry.path === "string" && entry.path !== "" &&
    Number.isSafeInteger(entry.count) && (entry.count as number) > 0 &&
    typeof entry.reason === "string" && entry.reason.trim() !== "";
}

/**
 * Violations of the exact ratchet. `counts` maps each tracked `.ts` path to
 * its reference count (zero included); `exceptions` is the parsed list.
 */
export function runtimeNeutralViolations(
  counts: ReadonlyMap<string, number>,
  exceptions: unknown,
): string[] {
  const errors: string[] = [];
  const byPath = new Map<string, RuntimeNeutralException>();
  if (!Array.isArray(exceptions)) {
    errors.push(`${EXCEPTIONS_PATH} must be a JSON array`);
    exceptions = [];
  }
  for (const [index, raw] of (exceptions as unknown[]).entries()) {
    if (!isWellFormed(raw)) {
      errors.push(
        `exception #${index} is malformed: it needs a path, a positive ` +
          "integer count and a non-empty reason",
      );
    } else if (byPath.has(raw.path)) {
      errors.push(`exception is listed twice: ${raw.path}`);
    } else {
      byPath.set(raw.path, raw);
    }
  }
  for (const [path, count] of [...counts.entries()].sort()) {
    const entry = byPath.get(path);
    if (count === 0) continue;
    if (entry === undefined) {
      errors.push(
        `${path}: ${count} ${RUNTIME}. references and no entry in ` +
          `${EXCEPTIONS_PATH}; use the node: API instead`,
      );
    } else if (count > entry.count) {
      errors.push(
        `${path}: references grew (${count} > ${entry.count}); an entry ` +
          "may only shrink",
      );
    } else if (count < entry.count) {
      errors.push(
        `${path}: references dropped to ${count} (entry says ` +
          `${entry.count}); lower the entry to ${count}`,
      );
    }
  }
  for (const path of [...byPath.keys()].sort()) {
    if ((counts.get(path) ?? 0) === 0) {
      errors.push(
        `${path}: not a tracked .ts file with references; remove the entry`,
      );
    }
  }
  return errors;
}

export function formatReport(counts: ReadonlyMap<string, number>): string {
  let total = 0;
  let files = 0;
  for (const count of counts.values()) {
    total += count;
    if (count > 0) files += 1;
  }
  return `${LABEL}: ${total} ${RUNTIME}. references in ${files} files`;
}

function trackedTypeScript(root: string): string[] {
  const listing = execFileSync("git", ["ls-files", "-z", "--", "*.ts"], {
    cwd: root,
    // Explicit, so the spawn reads no environment: the lane holds no env grant.
    env: {},
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 64 * 1024 * 1024,
  });
  return listing.split("\0").filter((path) => path !== "").sort();
}

function readIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    // A tracked file deleted from the work tree has nothing to count.
    if ((error as { code?: string }).code === "ENOENT") return undefined;
    throw error;
  }
}

export interface RuntimeNeutralResult {
  report: string;
  errors: string[];
}

export function checkRuntimeNeutral(root: string): RuntimeNeutralResult {
  const counts = new Map<string, number>();
  for (const path of trackedTypeScript(root)) {
    const source = readIfPresent(join(root, path));
    if (source !== undefined) counts.set(path, countReferences(source));
  }
  let exceptions: unknown;
  try {
    exceptions = JSON.parse(readFileSync(join(root, EXCEPTIONS_PATH), "utf8"));
  } catch (error) {
    return {
      report: formatReport(counts),
      errors: [`${EXCEPTIONS_PATH} could not be read: ${String(error)}`],
    };
  }
  return {
    report: formatReport(counts),
    errors: runtimeNeutralViolations(counts, exceptions),
  };
}

function main(root: string): number {
  const { report, errors } = checkRuntimeNeutral(root);
  console.log(report);
  for (const error of errors) console.error(`${LABEL}: ${error}`);
  return errors.length > 0 ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.cwd());
}
