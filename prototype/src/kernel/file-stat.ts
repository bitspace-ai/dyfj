/**
 * The one stat shape the workspace readers share: the kind of entry, its size
 * and modification time, and the (device, inode) pair that identifies it.
 * Pure: it maps a `Stats` the caller already holds and performs no I/O.
 */

import type { Stats } from "node:fs";

/**
 * What the workspace readers read from a stat, in one shape: the kind of
 * entry, its size and modification time, and the (device, inode) pair that
 * identifies it.
 */
export interface FileStat {
  isFile: boolean;
  isDirectory: boolean;
  isSymlink: boolean;
  size: number;
  mtimeMs: number;
  dev: number;
  ino: number;
}

/** The shared stat shape of a `node:fs` `Stats`. */
export function fileStat(stats: Stats): FileStat {
  return {
    isFile: stats.isFile(),
    isDirectory: stats.isDirectory(),
    isSymlink: stats.isSymbolicLink(),
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    dev: stats.dev,
    ino: stats.ino,
  };
}

/**
 * Whether a stat's (device, inode) pair can be compared at all. A platform
 * that reports no identity reports zero, and a zero pair would compare equal
 * across different files, so it counts as unverifiable and the read is
 * refused rather than trusted.
 */
export function hasVerifiableIdentity(
  info: Pick<FileStat, "dev" | "ino">,
): boolean {
  return info.dev !== 0 && info.ino !== 0;
}
