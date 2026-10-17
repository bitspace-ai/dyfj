/**
 * The `dyfj dev` last-good snapshot: a copy of `prototype/src` taken after a
 * runtime booted on it, which `dyfj dev` runs when the working tree's
 * runtime fails to start.
 *
 * - It lives at `prototype/.dyfj-dev-last-good/`, beside `src` rather than
 *   inside another directory, and holds the files of `src` directly. The
 *   runtime finds some files from its own location (`import.meta.url`): the
 *   Codex ACP package from the directory above its source, and the code
 *   fingerprint from its source directory. From beside `src`, the first
 *   resolves as it does from `src`, and the second hashes the snapshot.
 * - Only `src` is copied. Dependencies are not: a snapshot records the hash
 *   of the repository's `package-lock.json`, and a snapshot whose lock no
 *   longer matches is refused, so old code never runs on new dependencies.
 * - A promotion copies into a staging directory beside the snapshot, checks
 *   that the copy is the code the runtime booted (the content hash it
 *   reported), writes the record, and swaps it in: the current snapshot
 *   moves to a retired directory, staging moves into place, and the retired
 *   copy is removed. `rename(2)` cannot replace a directory that has files,
 *   hence two renames. A crash between them leaves no snapshot, never a
 *   partial one, and every use re-hashes the snapshot against its record.
 * - Staging and retired directories are named for the promoting process.
 *   A `dyfj dev` never promotes and falls back at the same time. Two on one
 *   checkout (a test lane beside the operator's, say) do not share a copy:
 *   the slower one's final rename fails, and it reports that it did not
 *   update the snapshot.
 *
 * Every one of these directories is gitignored (`prototype/.dyfj-dev-*`) and
 * sits outside every root the gate's lanes, the type check and the dev
 * watcher read.
 */

import { createHash } from "node:crypto";
import { cp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { FINGERPRINT_UNKNOWN, sourceTreeHash } from "../src/config/mod.ts";

export const SNAPSHOT_DIR = ".dyfj-dev-last-good";

/** Where a promotion by process `pid` stages its copy. */
export const stagingDir = (snapshot: string, pid = process.pid) => `${snapshot}.staging-${pid}`;
/** Where a promotion by process `pid` moves the snapshot it replaces. */
export const retiredDir = (snapshot: string, pid = process.pid) => `${snapshot}.retired-${pid}`;
/** The record, a dot file so the content hash skips it. */
const RECORD = ".dyfj-dev-snapshot.json";

export interface SnapshotPaths {
  /** `<repo>/prototype`, the runtime's cwd. */
  prototype: string;
  /** `<repo>/prototype/src`. */
  source: string;
  /** `<repo>/prototype/.dyfj-dev-last-good`. */
  snapshot: string;
  /** The workspace's lock file, `<repo>/package-lock.json`. */
  lock: string;
  /** The snapshot's server entry, relative to `prototype`. */
  entry: string;
  /** Copy a tree; a test can make it fail. */
  copy?: (from: string, to: string) => Promise<void>;
}

export function snapshotPaths(repo: string): SnapshotPaths {
  const prototype = join(repo, "prototype");
  return {
    prototype,
    source: join(prototype, "src"),
    snapshot: join(prototype, SNAPSHOT_DIR),
    lock: join(repo, "package-lock.json"),
    entry: join(SNAPSHOT_DIR, "server", "main.ts"),
  };
}

export interface SnapshotRecord {
  /** The content hash of the snapshot's files, as the runtime reported it. */
  contentHash: string;
  /** When it was taken, as an ISO timestamp. */
  takenAt: string;
  /** sha256 of `package-lock.json` when it was taken. */
  lockHash: string;
}

export type SnapshotCheck =
  | { ok: true; meta: SnapshotRecord }
  | { ok: false; reason: "none" | "corrupt" | "lock" };

async function lockHash(path: string): Promise<string> {
  try {
    return `sha256:${createHash("sha256").update(await readFile(path)).digest("hex")}`;
  } catch {
    return "missing";
  }
}

const defaultCopy = (from: string, to: string) =>
  cp(from, to, { recursive: true, verbatimSymlinks: true, errorOnExist: true });

/**
 * Copy `src` and swap it in as the snapshot, if the copy is the code that
 * booted (`booted`, the runtime's reported content hash). Anything else, a
 * save that landed after the boot included, leaves the current snapshot.
 */
export async function promoteSnapshot(
  paths: SnapshotPaths,
  booted: string,
  now: Date,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const staging = stagingDir(paths.snapshot);
  const retired = retiredDir(paths.snapshot);
  try {
    await rm(staging, { recursive: true, force: true });
    await (paths.copy ?? defaultCopy)(paths.source, staging);
    const copied = await sourceTreeHash(staging);
    if (copied === FINGERPRINT_UNKNOWN || copied !== booted) {
      await rm(staging, { recursive: true, force: true });
      return { ok: false, error: "the source changed after the runtime booted" };
    }
    const record: SnapshotRecord = {
      contentHash: copied,
      takenAt: now.toISOString(),
      lockHash: await lockHash(paths.lock),
    };
    await writeFile(join(staging, RECORD), `${JSON.stringify(record)}\n`);
    await rm(retired, { recursive: true, force: true });
    try {
      await rename(paths.snapshot, retired);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rename(staging, paths.snapshot);
    await rm(retired, { recursive: true, force: true });
    return { ok: true };
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function parseRecord(text: string): SnapshotRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const record = value as Partial<SnapshotRecord> | null;
  return typeof record?.contentHash === "string" &&
      typeof record.takenAt === "string" &&
      typeof record.lockHash === "string"
    ? { contentHash: record.contentHash, takenAt: record.takenAt, lockHash: record.lockHash }
    : null;
}

/** Whether the snapshot may run now: whole, and on the current lock file. */
export async function checkSnapshot(paths: SnapshotPaths): Promise<SnapshotCheck> {
  let text: string;
  try {
    text = await readFile(join(paths.snapshot, RECORD), "utf8");
  } catch {
    return { ok: false, reason: "none" };
  }
  const meta = parseRecord(text);
  if (meta === null) return { ok: false, reason: "corrupt" };
  const hash = await sourceTreeHash(paths.snapshot);
  if (hash === FINGERPRINT_UNKNOWN || hash !== meta.contentHash) {
    return { ok: false, reason: "corrupt" };
  }
  if ((await lockHash(paths.lock)) !== meta.lockHash) return { ok: false, reason: "lock" };
  return { ok: true, meta };
}
