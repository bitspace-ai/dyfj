import { lstat, open, readFile, readlink, realpath, rmdir, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { hasDotPathComponent } from "../../kernel/mod.ts";
import { DomainError } from "../../contract/mod.ts";
import { ensurePrivateDirectory, writePrivateFile } from "../../private-file.ts";

function ownedWithoutSharedWrite(info: { uid: number; mode: number }): boolean {
  return info.uid === process.getuid?.() && (info.mode & 0o022) === 0;
}

async function optionalLstat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function projectOperatorContext(
  operatorHome: string,
  isolatedHome: string,
  codexHome: string,
  enabled: boolean,
): Promise<Array<"instructions" | "skills">> {
  let instructions: Buffer | undefined;
  let skills: string | undefined;
  if (enabled) {
    try {
      const parent = await lstat(join(operatorHome, ".codex"));
      if (!parent.isDirectory() || !ownedWithoutSharedWrite(parent)) throw new Error("unavailable instructions directory");
      const source = await realpath(join(operatorHome, ".codex", "AGENTS.md"));
      const info = await lstat(source);
      if (info.isFile() && ownedWithoutSharedWrite(info) && info.size <= 65_536) {
        const file = await open(source, "r");
        try {
          const opened = await file.stat();
          if (opened.isFile() && ownedWithoutSharedWrite(opened) &&
              opened.size <= 65_536 && opened.dev === info.dev && opened.ino === info.ino) {
            const bytes = Buffer.alloc(65_537);
            let length = 0;
            while (length < bytes.length) {
              const { bytesRead } = await file.read(bytes.subarray(length));
              if (bytesRead === 0) break;
              length += bytesRead;
            }
            if (length <= 65_536) instructions = bytes.subarray(0, length);
          }
        } finally {
          await file.close();
        }
      }
    } catch {
      // Unavailable operator sources are absent context, not turn failures.
    }
    try {
      const canonical = await realpath(join(operatorHome, ".agents", "skills"));
      skills = await operatorAuthorizedToolchainDirectory(canonical);
    } catch {
      // The directory validator supplies the same ownership and mode checks.
    }
  }
  const projected: Array<"instructions" | "skills"> = [];
  const diagnostic = "Codex ACP operator context is unavailable";
  try {
    const destination = join(codexHome, "AGENTS.md");
    const existing = await optionalLstat(destination);
    if (instructions === undefined) {
      if (existing !== undefined) await unlink(destination);
    } else {
      if (!existing?.isFile() || (existing.mode & 0o777) !== 0o600 ||
          !instructions.equals(await readFile(destination))) {
        await writePrivateFile(destination, instructions, 0o600, diagnostic);
      }
      projected.push("instructions");
    }
    const parent = join(isolatedHome, ".agents");
    const parentInfo = await optionalLstat(parent);
    // Never traverse an existing link out of the private home.
    if (parentInfo !== undefined) await ensurePrivateDirectory(parent);
    if (parentInfo !== undefined || skills !== undefined) {
      if (parentInfo === undefined) await ensurePrivateDirectory(parent);
      const destination = join(parent, "skills");
      const existing = await optionalLstat(destination);
      if (existing === undefined || existing.isSymbolicLink()) {
        const target = existing === undefined ? undefined : await readlink(destination);
        if (target !== skills) {
          if (existing !== undefined) await unlink(destination);
          if (skills !== undefined) await symlink(skills, destination);
        }
        if (skills !== undefined) projected.push("skills");
      }
      if (skills === undefined) {
        try {
          await rmdir(parent);
        } catch (error) {
          if ((error as { code?: string }).code !== "ENOTEMPTY") throw error;
        }
      }
    }
  } catch {
    throw new DomainError(diagnostic);
  }
  return projected;
}

export async function operatorAuthorizedToolchainDirectory(
  pathValue: string | undefined,
): Promise<string | undefined> {
  if (pathValue === undefined || pathValue === "") return undefined;
  if (
    !pathValue.startsWith("/") || pathValue.includes(",") ||
    pathValue.includes(":")
  ) {
    throw new DomainError(
      "Codex ACP requires an absolute, delimiter-safe toolchain directory",
    );
  }
  if (hasDotPathComponent(pathValue)) {
    throw new DomainError(
      "Codex ACP toolchain path must not contain dot components",
    );
  }
  if (/^\/+$/u.test(pathValue)) {
    throw new DomainError("Codex ACP toolchain directory is unavailable");
  }
  try {
    const noFollowPath = pathValue.replace(/\/+$/, "");
    const info = await lstat(noFollowPath);
    if (info.isDirectory() && !info.isSymbolicLink()) {
      const canonical = await realpath(noFollowPath);
      if (canonical.includes(",") || canonical.includes(":")) {
        throw new Error("canonical path contains an unsupported delimiter");
      }
      const canonicalInfo = await lstat(canonical);
      if (
        !canonicalInfo.isDirectory() || canonicalInfo.isSymbolicLink() ||
        (process.platform !== "win32" &&
          (!ownedWithoutSharedWrite(canonicalInfo) ||
            (canonicalInfo.mode & 0o100) === 0)) ||
        canonicalInfo.dev !== info.dev || canonicalInfo.ino !== info.ino
      ) {
        throw new Error("canonical directory authority changed");
      }
      return canonical;
    }
  } catch {
    // Use the fixed diagnostic below instead of disclosing the supplied path.
  }
  throw new DomainError("Codex ACP toolchain directory is unavailable");
}
