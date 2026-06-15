/**
 * Read-only workspace file tools for the agent loop (Slice A).
 *
 * Two capabilities — `read_file` and `list_files` — scoped to a workspace root.
 * Every path is resolved within the root and traversal/escape is rejected, so
 * the model can read the project it's working in but nothing outside it. These
 * are read-only and side-effect-free, so they need no approval flow (the policy
 * auto-allows read-only filesystem access). Write/bash + the approval flow are
 * later slices.
 *
 * Executors never throw on operator/model error (bad path, missing file,
 * traversal attempt): they return an `error: …` string so the model sees the
 * failure as a tool result and can recover, rather than crashing the turn.
 */

import { relative, resolve } from "node:path";

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
      return `${text.slice(0, maxBytes)}\n\n[truncated at ${maxBytes} characters]`;
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
      return `${shown.join("\n")}\n[${entries.length - maxEntries} more entries omitted]`;
    }
    return entries.join("\n");
  } catch (err) {
    return `error: cannot list ${p}: ${(err as Error).message}`;
  }
}
