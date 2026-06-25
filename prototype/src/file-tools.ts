/**
 * Workspace file tools for the agent loop, scoped to a workspace root.
 *
 * `read_file` and `list_files` are read-only and side-effect-free (the policy
 * auto-allows them). `write_file` is mutating — the command policy routes it
 * through operator approval, so its executor never runs unapproved.
 * Every path is resolved within the root and traversal/symlink escape is
 * rejected, so the model can only touch the project it's working in. `edit_file`
 * applies a single exact-string replacement (also mutating); `bash` is a later slice.
 *
 * Executors never throw on operator/model error (bad path, missing file,
 * traversal attempt): they return an `error: …` string so the model sees the
 * failure as a tool result and can recover, rather than crashing the turn.
 */

import { dirname, relative, resolve } from "node:path";

const DEFAULT_MAX_BYTES = 64 * 1024;
const DEFAULT_MAX_ENTRIES = 500;

/**
 * Resolve `p` within `root` and return the absolute path, or throw if it
 * escapes the root. Pure (no I/O) so it's directly testable.
 */
export function resolveWorkspacePath(root: string, p: string): string {
  const rootAbs = resolve(root);
  const abs = resolve(rootAbs, p);
  const rel = relative(rootAbs, abs);
  if (rel.startsWith("..") || rel.startsWith("/")) {
    throw new Error(`path escapes the workspace root: ${p}`);
  }
  return abs;
}

/** Read a file's text content, scoped to the workspace root. */
export async function executeReadFile(
  root: string,
  p: string,
  maxBytes = DEFAULT_MAX_BYTES,
): Promise<string> {
  let abs: string;
  try {
    abs = resolveWorkspacePath(root, p);
  } catch (err) {
    return `error: ${(err as Error).message}`;
  }
  try {
    const target = await containedRealPath(root, abs);
    if (target === null) {
      return `error: path escapes the workspace root: ${p}`;
    }
    const info = await Deno.stat(target);
    if (info.isDirectory) {
      return `error: ${p} is a directory; use list_files`;
    }
    const text = await Deno.readTextFile(target);
    if (text.length > maxBytes) {
      return `${
        text.slice(0, maxBytes)
      }\n\n[truncated at ${maxBytes} characters]`;
    }
    return text;
  } catch (err) {
    return `error: cannot read ${p}: ${(err as Error).message}`;
  }
}

/**
 * Canonicalize the lexically-resolved path and confirm its REAL target is still
 * within the real workspace root — defeats symlink escapes (an in-root path
 * that is a symlink to an outside file). Returns the real path, or null if the
 * canonical target escapes the root. Throws (caught by callers) if the path
 * does not exist.
 */
async function containedRealPath(
  root: string,
  abs: string,
): Promise<string | null> {
  const rootReal = await Deno.realPath(resolve(root));
  const targetReal = await Deno.realPath(abs);
  return isWithinRoot(rootReal, targetReal) ? targetReal : null;
}

/**
 * True when `targetReal` is the root itself or nested under it. Both arguments
 * must already be canonical (post-realPath) absolute paths. Pure, so the
 * containment decision behind the symlink defense is directly testable.
 */
export function isWithinRoot(rootReal: string, targetReal: string): boolean {
  const rel = relative(rootReal, targetReal);
  return !(rel.startsWith("..") || rel.startsWith("/"));
}

/** List directory entries (one per line; directories suffixed with /). */
export async function executeListFiles(
  root: string,
  p = ".",
  maxEntries = DEFAULT_MAX_ENTRIES,
): Promise<string> {
  let abs: string;
  try {
    abs = resolveWorkspacePath(root, p);
  } catch (err) {
    return `error: ${(err as Error).message}`;
  }
  try {
    const target = await containedRealPath(root, abs);
    if (target === null) {
      return `error: path escapes the workspace root: ${p}`;
    }
    const entries: string[] = [];
    for await (const entry of Deno.readDir(target)) {
      entries.push(entry.isDirectory ? `${entry.name}/` : entry.name);
    }
    if (entries.length === 0) return "(empty directory)";
    entries.sort();
    if (entries.length > maxEntries) {
      const shown = entries.slice(0, maxEntries);
      return `${shown.join("\n")}\n[${
        entries.length - maxEntries
      } more entries omitted]`;
    }
    return entries.join("\n");
  } catch (err) {
    return `error: cannot list ${p}: ${(err as Error).message}`;
  }
}

/**
 * Write UTF-8 text to a file scoped to the workspace root, creating or
 * overwriting it. Containment is checked against the REAL parent directory
 * (defeating a symlinked parent), and write_file refuses to write through a
 * symlink at the target path — a dangling in-root symlink could point outside
 * the root and `writeTextFile` would follow it (CWE-59). The parent directory
 * must already exist. This is a mutating tool; the command policy routes it
 * through operator approval, so the executor itself never runs unapproved.
 */
export async function executeWriteFile(
  root: string,
  p: string,
  content: string,
  // Injectable for tests: the scoped test sandbox forbids creating real symlinks
  // (Deno.symlink needs unscoped read+write), so the no-follow guard is exercised
  // with a fake lstat. The real OS symlink-follow escape is Codex-PoC-verified.
  lstat: (path: string) => Promise<{ isSymlink: boolean }> = Deno.lstat,
): Promise<string> {
  let abs: string;
  try {
    abs = resolveWorkspacePath(root, p);
  } catch (err) {
    return `error: ${(err as Error).message}`;
  }
  try {
    const rootReal = await Deno.realPath(resolve(root));
    const parentReal = await Deno.realPath(dirname(abs));
    if (!isWithinRoot(rootReal, parentReal)) {
      return `error: path escapes the workspace root: ${p}`;
    }
    // Refuse to write through a symlink at the target path: write_file never
    // follows symlinks. lstat (no-follow) detects a symlink even when it dangles
    // — realPath(abs) fails on a dangling link, so the old "target missing"
    // branch would have let writeTextFile follow it outside the root (CWE-59).
    try {
      const targetInfo = await lstat(abs);
      if (targetInfo.isSymlink) {
        return `error: refusing to write through a symlink: ${p}`;
      }
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) {
        return `error: cannot write ${p}: ${(err as Error).message}`;
      }
      // NotFound — the target does not exist yet; the parent containment governs.
    }
    await Deno.writeTextFile(abs, content);
    // Non-content-derived result: no exact length, which would otherwise persist
    // a payload-size signal into the event log + session replay (CWE-532).
    return `wrote ${p}`;
  } catch (err) {
    return `error: cannot write ${p}: ${(err as Error).message}`;
  }
}

/**
 * Apply a single exact-string replacement to an existing file within the
 * workspace root: replace `oldString` with `newString`. The match must be
 * unique — zero or multiple occurrences error rather than guess (the model adds
 * surrounding context to disambiguate). The write-back goes through
 * executeWriteFile, inheriting its parent-containment + symlink no-follow
 * (CWE-59) guarantees. Mutating; the command policy routes it through operator
 * approval, so the executor never runs unapproved.
 */
export async function executeEditFile(
  root: string,
  p: string,
  oldString: string,
  newString: string,
  lstat: (path: string) => Promise<{ isSymlink: boolean }> = Deno.lstat,
): Promise<string> {
  if (oldString === "") {
    return `error: oldString must be non-empty`;
  }
  if (oldString === newString) {
    return `error: oldString and newString are identical; no edit to apply`;
  }
  let abs: string;
  try {
    abs = resolveWorkspacePath(root, p);
  } catch (err) {
    return `error: ${(err as Error).message}`;
  }
  let text: string;
  try {
    const target = await containedRealPath(root, abs);
    if (target === null) {
      return `error: path escapes the workspace root: ${p}`;
    }
    const info = await Deno.stat(target);
    if (info.isDirectory) {
      return `error: ${p} is a directory`;
    }
    text = await Deno.readTextFile(target);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      return `error: cannot edit ${p}: file not found`;
    }
    return `error: cannot read ${p}: ${(err as Error).message}`;
  }
  const first = text.indexOf(oldString);
  if (first === -1) {
    return `error: oldString not found in ${p}`;
  }
  if (text.indexOf(oldString, first + oldString.length) !== -1) {
    return `error: oldString is not unique in ${p}; add more surrounding context`;
  }
  const updated = text.slice(0, first) + newString +
    text.slice(first + oldString.length);
  const writeResult = await executeWriteFile(root, p, updated, lstat);
  // executeWriteFile returns "wrote <p>" on success or "error: …" on failure.
  return writeResult.startsWith("error:") ? writeResult : `edited ${p}`;
}
