import { randomUUID } from "node:crypto";
import { chmod, open, rename, rm } from "node:fs/promises";
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
