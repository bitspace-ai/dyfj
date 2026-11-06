/**
 * The Codex runner's private bin.
 *
 * The selected Node executable is shimmed here, and so are `npm` and `npx`
 * when a sibling passes the mode-bit and delimiter checks. Selecting that
 * Node does not add its directory to `PATH`. `/usr/bin` and `/bin` stay on
 * `PATH`, and an operator-selected toolchain directory is still added when
 * one is configured.
 */

import { dirname, join } from "node:path";
import { realpath, stat, unlink } from "node:fs/promises";
import process from "node:process";
import { DomainError } from "./contract/mod.ts";
import { writePrivateFile } from "./private-file.ts";

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** Exec the sibling pathname. The shim does not choose that file's interpreter. */
function execShim(executable: string): string {
  return `#!/bin/sh\nexec ${shellSingleQuote(executable)} "$@"\n`;
}

/**
 * Ordinary owner, group, and other execute bits for this account. Root may
 * execute when any execute bit is set. Access-control lists are not consulted.
 */
function accountCanExecute(info: {
  uid: number;
  gid: number;
  mode: number;
}): boolean {
  if (process.platform === "win32") return true;
  const uid = process.getuid?.();
  if (uid === 0) return (info.mode & 0o111) !== 0;
  if (uid !== undefined && info.uid === uid) return (info.mode & 0o100) !== 0;
  const gid = process.getgid?.();
  const groups = new Set<number>([
    ...(gid === undefined ? [] : [gid]),
    ...(process.getgroups?.() ?? []),
  ]);
  if (groups.has(info.gid)) return (info.mode & 0o010) !== 0;
  return (info.mode & 0o001) !== 0;
}

/**
 * The executable `name` beside `nodePath`, when it is a delimiter-safe file
 * whose mode bits let this account execute it. Absent when there is no such
 * sibling.
 */
async function matchingSibling(
  nodePath: string,
  name: "npm" | "npx",
): Promise<string | undefined> {
  const candidate = join(dirname(nodePath), name);
  if (
    !candidate.startsWith("/") || candidate.includes(",") ||
    candidate.includes(":")
  ) return undefined;
  try {
    const info = await stat(candidate);
    if (!info.isFile() || !accountCanExecute(info)) return undefined;
    const canonical = await realpath(candidate);
    if (canonical.includes(",") || canonical.includes(":")) return undefined;
    return candidate;
  } catch {
    return undefined;
  }
}

/**
 * Write the private bin and return the child `PATH`: this directory, the
 * optional toolchain directory, `/usr/bin`, and `/bin`.
 */
export async function writeCodexRunnerBin(input: {
  runnerBin: string;
  nodePath: string;
  toolchainPath?: string;
}): Promise<string> {
  await writePrivateFile(
    join(input.runnerBin, "node"),
    execShim(input.nodePath),
    0o700,
    "Codex ACP private Node shim is unavailable",
  );
  for (const name of ["npm", "npx"] as const) {
    const shim = join(input.runnerBin, name);
    const executable = await matchingSibling(input.nodePath, name);
    if (executable === undefined) {
      await removePrivateShim(
        shim,
        `Codex ACP private ${name} shim is unavailable`,
      );
      continue;
    }
    await writePrivateFile(
      shim,
      execShim(executable),
      0o700,
      `Codex ACP private ${name} shim is unavailable`,
    );
  }
  return [
    input.runnerBin,
    ...(input.toolchainPath === undefined ? [] : [input.toolchainPath]),
    "/usr/bin",
    "/bin",
  ].join(":");
}

/** Drop a shim this bin already has. A missing shim is the state we want. */
async function removePrivateShim(
  path: string,
  diagnostic: string,
): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ENOENT") return;
    throw new DomainError(diagnostic);
  }
}
