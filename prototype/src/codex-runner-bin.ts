/**
 * The Codex runner's private bin.
 *
 * The selected Node executable is shimmed here, and so are `npm` and `npx`
 * when a sibling passes the effective-credential mode-bit and delimiter
 * checks. Selecting that Node does not add its directory to `PATH`.
 * `/usr/bin` and `/bin` stay on `PATH`, and an operator-selected toolchain
 * directory is still added when one is configured.
 */

import { dirname, join } from "node:path";
import { realpath, stat, unlink } from "node:fs/promises";
import process from "node:process";
import { codexPathSyntax } from "./config/mod.ts";
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
 * Ordinary owner, group, and other execute bits for these credentials.
 * Effective uid 0 may execute when any execute bit is set. Access-control
 * lists are not consulted.
 */
export function modeBitsAllowExecute(
  info: { uid: number; gid: number; mode: number },
  account: { uid: number | undefined; gids: ReadonlySet<number> },
): boolean {
  if (process.platform === "win32") return true;
  if (account.uid === 0) return (info.mode & 0o111) !== 0;
  if (account.uid !== undefined && info.uid === account.uid) {
    return (info.mode & 0o100) !== 0;
  }
  if (account.gids.has(info.gid)) return (info.mode & 0o010) !== 0;
  return (info.mode & 0o001) !== 0;
}

/** Effective user and group. The real uid and gid are not read. */
function effectiveAccount(): {
  uid: number | undefined;
  gids: ReadonlySet<number>;
} {
  const gid = process.getegid?.();
  return {
    uid: process.geteuid?.(),
    gids: new Set<number>([
      ...(gid === undefined ? [] : [gid]),
      ...(process.getgroups?.() ?? []),
    ]),
  };
}

function accountCanExecute(info: {
  uid: number;
  gid: number;
  mode: number;
}): boolean {
  return modeBitsAllowExecute(info, effectiveAccount());
}

/**
 * The executable `name` beside `nodePath`, when it is a delimiter-safe file
 * whose mode bits let the effective credentials execute it. Absent when
 * there is no such
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

export interface CodexPathEvidence {
  operatorDirectories: number;
  operatorDropped: number;
  extraDirectories: number;
  extraDropped: number;
  environmentNamesAdded: number;
}

async function acceptedPathDirectory(path: string): Promise<string | undefined> {
  if (!codexPathSyntax(path)) return undefined;
  try {
    const canonical = await realpath(path);
    if (!codexPathSyntax(canonical)) return undefined;
    const info = await stat(canonical);
    if (!info.isDirectory() || (info.uid !== process.getuid?.() && info.uid !== 0) || (info.mode & 0o002) !== 0) return undefined;
    return canonical;
  } catch {
    return undefined;
  }
}

export async function composeCodexPath(input: {
  minimalPath: string;
  mode: "operator" | "minimal";
  runtimePath: string;
  extraPath: readonly string[];
}): Promise<{ path: string; evidence: CodexPathEvidence }> {
  const evidence: CodexPathEvidence = { operatorDirectories: 0, operatorDropped: 0, extraDirectories: 0, extraDropped: 0, environmentNamesAdded: 0 };
  if (input.mode === "minimal") return { path: input.minimalPath, evidence };
  const entries: string[] = [];
  const seen = new Set<string>();
  const add = async (entry: string) => {
    const canonical = await realpath(entry).catch(() => entry);
    if (seen.has(canonical)) return false;
    seen.add(canonical); entries.push(entry); return true;
  };
  const minimal = input.minimalPath.split(":");
  for (const entry of minimal.slice(0,-2)) await add(entry);
  // Reserve targets and spellings so the fixed suffix survives merged /usr.
  for (const entry of ["/usr/bin", "/bin"]) {
    seen.add(entry);
    seen.add(await realpath(entry).catch(() => entry));
  }
  for (const [source, values] of [["operator", input.runtimePath.split(":")], ["extra", input.extraPath]] as const) {
    for (const entry of values) {
      const accepted = await acceptedPathDirectory(entry);
      if (accepted === undefined) { evidence[source === "operator" ? "operatorDropped" : "extraDropped"]++; continue; }
      if (await add(accepted)) evidence[source === "operator" ? "operatorDirectories" : "extraDirectories"]++;
    }
  }
  entries.push("/usr/bin", "/bin");
  return { path: entries.join(":"), evidence };
}

/** One owner per runtime; no path or environment content enters this sink. */
export function codexExtraPathReporter(say: (line: string) => void): (count: number) => void {
  const seen = new Set<number>();
  return count => {
    if (count === 0 || seen.has(count)) return;
    seen.add(count);
    say(`Codex extra PATH directories dropped: ${count}`);
  };
}
