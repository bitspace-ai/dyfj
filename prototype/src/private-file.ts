import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import process from "node:process";
import { DomainError } from "./contract/mod.ts";

/**
 * Write a private runner file atomically. The content goes to a new file,
 * created exclusively under a random name beside the final one, so an
 * existing file is never followed or reused; it is then given its mode and
 * renamed into place. Any failure makes a best-effort removal of the
 * temporary and reports the fixed diagnostic, which does not disclose the path.
 */
export async function writePrivateFile(
  path: string,
  content: string,
  mode: number,
  diagnostic: string,
): Promise<void> {
  const temporary = `${path}-${randomUUID()}`;
  let created = false;
  try {
    const file = await open(temporary, "wx", 0o600);
    created = true;
    try {
      await file.writeFile(content);
    } finally {
      await file.close();
    }
    await chmod(temporary, mode);
    await rename(temporary, path);
  } catch {
    if (created) {
      // The rename may already have consumed the temporary path.
      await rm(temporary, { force: true }).catch(() => {});
    }
    throw new DomainError(diagnostic);
  }
}

/**
 * Create `path` owner-only, or check that an existing one is a directory and,
 * on a platform other than Windows, the account's and not group- or
 * world-writable.
 */
export async function ensurePrivateDirectory(
  path: string,
  enforceExistingMode = true,
): Promise<void> {
  let created = false;
  try {
    await mkdir(path, { mode: 0o700 });
    created = true;
  } catch (error) {
    if ((error as { code?: unknown }).code !== "EEXIST") throw error;
  }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new DomainError("Codex ACP runner home is unavailable");
  }
  if (
    !created && process.platform !== "win32" &&
    (info.uid !== process.getuid?.() ||
      (info.mode & 0o022) !== 0)
  ) {
    throw new DomainError("Codex ACP runner home is unavailable");
  }
  if (created || enforceExistingMode) await chmod(path, 0o700);
}

/**
 * Refuse unless `path` is a directory that is not a symbolic link and, on a
 * platform other than Windows, that the account owns and others cannot write.
 */
export async function requireOwnedDirectory(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (
      info.isDirectory() && !info.isSymbolicLink() &&
      (process.platform === "win32" ||
        (info.uid === process.getuid?.() && (info.mode & 0o022) === 0))
    ) return;
  } catch {
    // Use the fixed diagnostic below instead of disclosing the supplied path.
  }
  throw new DomainError("Codex ACP operator home is unavailable");
}
