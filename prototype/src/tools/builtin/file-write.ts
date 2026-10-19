/**
 * `write_file` and `edit_file` executors. Both are mutating, so the command
 * policy routes them through operator approval and they never run unapproved.
 * Containment is still enforced here: approval covers intent, not a path that
 * resolves somewhere the operator did not see.
 */

import { readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import type { WorkspaceRoot } from "./root-anchors.ts";
import {
  containedRealPath,
  errorCode,
  isWithinRoot,
  lstatFile,
  resolveWorkspacePath,
  toPosixPath,
  safeErrorReason,
  sanitizeOutputText,
  statFile,
} from "./file-access.ts";

/**
 * True when a workspace-relative path names `.git` or anything inside one.
 * Repository config and attributes there can make read-only git commands run
 * programs (core.fsmonitor, diff drivers), and the bash allowlist lets those
 * commands run without a prompt, so the write tools never touch them
 * (BIT-707). Case-insensitive, because the default macOS filesystem is.
 */
function insideGitDir(relativePath: string): boolean {
  return toPosixPath(relativePath).split("/").some((segment) =>
    segment.toLowerCase() === ".git"
  );
}

const refuseGitDir = (p: string): string =>
  `error: refusing to write inside .git: ${sanitizeOutputText(p)}`;

/**
 * Write UTF-8 text to a file scoped to the workspace root, creating or
 * overwriting it. Containment is checked against the REAL parent directory
 * (defeating a symlinked parent), and write_file refuses to write through a
 * symlink at the target path — a dangling in-root symlink could point outside
 * the root and a plain write would follow it (CWE-59). The parent directory
 * must already exist. This is a mutating tool; the command policy routes it
 * through operator approval, so the executor itself never runs unapproved.
 */
export async function executeWriteFile(
  workspace: WorkspaceRoot,
  p: string,
  content: string,
  // Injectable for tests: the scoped test sandbox forbids creating real symlinks
  // (making one needs unscoped read+write), so the no-follow guard is exercised
  // with a fake lstat. The real OS symlink-follow escape is Codex-PoC-verified.
  lstat: (path: string) => Promise<{ isSymlink: boolean }> = lstatFile,
): Promise<string> {
  const root = workspace.path;
  let abs: string;
  try {
    abs = resolveWorkspacePath(root, p);
  } catch (err) {
    // resolveWorkspacePath's message carries only the caller-supplied path.
    return `error: ${(err as Error).message}`;
  }
  if (insideGitDir(relative(workspace.path, abs))) return refuseGitDir(p);
  try {
    const rootReal = await workspace.verify();
    const parentReal = await realpath(dirname(abs));
    if (!isWithinRoot(rootReal, parentReal)) {
      return `error: path escapes the workspace root: ${sanitizeOutputText(p)}`;
    }
    // Again on the real parent, so a symlink to .git is refused too.
    if (insideGitDir(relative(rootReal, join(parentReal, basename(abs))))) {
      return refuseGitDir(p);
    }
    // Refuse to write through a symlink at the target path: write_file never
    // follows symlinks. lstat (no-follow) detects a symlink even when it dangles
    // — realPath(abs) fails on a dangling link, so the old "target missing"
    // branch would have let the write follow it outside the root (CWE-59).
    try {
      const targetInfo = await lstat(abs);
      if (targetInfo.isSymlink) {
        return `error: refusing to write through a symlink: ${
          sanitizeOutputText(p)
        }`;
      }
    } catch (err) {
      if (errorCode(err) !== "ENOENT") {
        return `error: cannot write ${sanitizeOutputText(p)}: ${
          safeErrorReason(err)
        }`;
      }
      // NotFound — the target does not exist yet; the parent containment governs.
    }
    await writeFile(abs, content, "utf8");
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
  lstat: (path: string) => Promise<{ isSymlink: boolean }> = lstatFile,
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
    const info = await statFile(target);
    if (info.isDirectory) {
      return `error: ${sanitizeOutputText(p)} is a directory`;
    }
    text = await readFile(target, "utf8");
  } catch (err) {
    if (errorCode(err) === "ENOENT") {
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
