/**
 * `write_file` and `edit_file` executors. Both are mutating, so the command
 * policy routes them through operator approval and they never run unapproved.
 * Containment is still enforced here: approval covers intent, not a path that
 * resolves somewhere the operator did not see.
 */

import { dirname } from "node:path";
import type { WorkspaceRoot } from "./root-anchors.ts";
import {
  containedRealPath,
  isWithinRoot,
  resolveWorkspacePath,
  safeErrorReason,
  sanitizeOutputText,
} from "./file-access.ts";

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
  workspace: WorkspaceRoot,
  p: string,
  content: string,
  // Injectable for tests: the scoped test sandbox forbids creating real symlinks
  // (Deno.symlink needs unscoped read+write), so the no-follow guard is exercised
  // with a fake lstat. The real OS symlink-follow escape is Codex-PoC-verified.
  lstat: (path: string) => Promise<{ isSymlink: boolean }> = Deno.lstat,
): Promise<string> {
  const root = workspace.path;
  let abs: string;
  try {
    abs = resolveWorkspacePath(root, p);
  } catch (err) {
    // resolveWorkspacePath's message carries only the caller-supplied path.
    return `error: ${(err as Error).message}`;
  }
  try {
    const rootReal = await workspace.verify();
    const parentReal = await Deno.realPath(dirname(abs));
    if (!isWithinRoot(rootReal, parentReal)) {
      return `error: path escapes the workspace root: ${sanitizeOutputText(p)}`;
    }
    // Refuse to write through a symlink at the target path: write_file never
    // follows symlinks. lstat (no-follow) detects a symlink even when it dangles
    // — realPath(abs) fails on a dangling link, so the old "target missing"
    // branch would have let writeTextFile follow it outside the root (CWE-59).
    try {
      const targetInfo = await lstat(abs);
      if (targetInfo.isSymlink) {
        return `error: refusing to write through a symlink: ${
          sanitizeOutputText(p)
        }`;
      }
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) {
        return `error: cannot write ${sanitizeOutputText(p)}: ${
          safeErrorReason(err)
        }`;
      }
      // NotFound — the target does not exist yet; the parent containment governs.
    }
    await Deno.writeTextFile(abs, content);
    // Non-content-derived result: no exact length, which would otherwise persist
    // a payload-size signal into the event log + session replay (CWE-532).
    return `wrote ${sanitizeOutputText(p)}`;
  } catch (err) {
    return `error: cannot write ${sanitizeOutputText(p)}: ${
      safeErrorReason(err)
    }`;
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
  workspace: WorkspaceRoot,
  p: string,
  oldString: string,
  newString: string,
  lstat: (path: string) => Promise<{ isSymlink: boolean }> = Deno.lstat,
): Promise<string> {
  const root = workspace.path;
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
    // resolveWorkspacePath's message carries only the caller-supplied path.
    return `error: ${(err as Error).message}`;
  }
  let text: string;
  try {
    const target = await containedRealPath(workspace, abs);
    if (target === null) {
      return `error: path escapes the workspace root: ${sanitizeOutputText(p)}`;
    }
    const info = await Deno.stat(target);
    if (info.isDirectory) {
      return `error: ${sanitizeOutputText(p)} is a directory`;
    }
    text = await Deno.readTextFile(target);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      return `error: cannot edit ${sanitizeOutputText(p)}: file not found`;
    }
    return `error: cannot read ${sanitizeOutputText(p)}: ${
      safeErrorReason(err)
    }`;
  }
  const first = text.indexOf(oldString);
  if (first === -1) {
    return `error: oldString not found in ${sanitizeOutputText(p)}`;
  }
  if (text.indexOf(oldString, first + oldString.length) !== -1) {
    return `error: oldString is not unique in ${
      sanitizeOutputText(p)
    }; add more surrounding context`;
  }
  const updated = text.slice(0, first) + newString +
    text.slice(first + oldString.length);
  const writeResult = await executeWriteFile(workspace, p, updated, lstat);
  // executeWriteFile returns "wrote <p>" on success or "error: …" on failure.
  return writeResult.startsWith("error:")
    ? writeResult
    : `edited ${sanitizeOutputText(p)}`;
}
