/**
 * The code fingerprint: which code a runtime loaded, so a client can tell
 * when the runtime is behind the working tree it runs from.
 *
 * The runtime records it once, at boot: the git HEAD of its checkout and a
 * content hash of the files under its `prototype/src`. A client hashes its
 * own checkout's `prototype/src` the same way and compares the two hashes;
 * HEAD is for the operator to read, not for the comparison. Neither half
 * runs git: the runtime's spawn policy does not allow it, and the client
 * runs without child processes. HEAD is read from the `.git` files.
 *
 * The content hash must match the Rust REPL's (`core/dyfj-repl/src/posture.rs`)
 * byte for byte; `testing/fixtures/code-fingerprint` pins both to one test
 * vector. Every regular file under the root, skipping any entry whose name
 * starts with `.`; sorted by relative path (`/`-separated, compared as UTF-8
 * bytes); SHA-256 over, for each file, its path, a NUL, its length in
 * decimal, a NUL, and its content; written as `sha256:<hex>`. Symlinks are
 * skipped, neither followed nor hashed: following one could leave the tree,
 * and the runtime loads none from there. Any read error makes the whole
 * hash `unknown`, never a partial one.
 */

import { createHash } from "node:crypto";
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** A fingerprint field that could not be read. Never compared. */
export const FINGERPRINT_UNKNOWN = "unknown";

export interface CodeFingerprint {
  /** The checkout's HEAD commit, or `unknown`. */
  head: string;
  /** `sha256:<hex>` over the files under `prototype/src`, or `unknown`. */
  contentHash: string;
}

/** This checkout's `prototype/src`, from this module's own location. */
export function prototypeSourceDir(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

/** Every regular file under `root` (see the module comment), sorted. */
async function sourceFiles(root: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await sourceFiles(root, relative));
    else if (entry.isFile()) files.push(relative);
    // Symlinks and every other kind of entry are skipped.
  }
  return files;
}

/** The content hash of the tree at `root`, or `unknown`. */
export async function sourceTreeHash(root: string): Promise<string> {
  try {
    const files = await sourceFiles(root);
    files.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    const hash = createHash("sha256");
    for (const relative of files) {
      const content = await readFile(join(root, relative));
      hash.update(`${relative}\0${content.byteLength}\0`);
      hash.update(content);
    }
    return `sha256:${hash.digest("hex")}`;
  } catch {
    return FINGERPRINT_UNKNOWN;
  }
}

const OBJECT_ID = /^[0-9a-f]{40}$/;
// A branch, tag or remote ref under refs/: no leading or doubled slash, and
// (checked in resolveRef) no `.` or `..` segment.
const REF_NAME = /^refs\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/;

async function readTrimmed(path: string): Promise<string | null> {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch {
    return null;
  }
}

/**
 * The git directory of the checkout holding `start`: the nearest `.git`
 * above it, either the directory itself or, in a worktree, the `.git` file's
 * `gitdir:` target.
 */
async function findGitDir(start: string): Promise<string | null> {
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, ".git");
    try {
      const entry = await lstat(candidate);
      if (entry.isDirectory()) return candidate;
      if (entry.isFile()) {
        const text = await readTrimmed(candidate);
        const target = text?.match(/^gitdir: (.+)$/)?.[1];
        if (target === undefined) return null;
        return isAbsolute(target) ? target : resolve(dir, target);
      }
      return null;
    } catch {
      // No .git here; keep climbing.
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Where shared refs live: a worktree's `commondir`, else the git dir. */
async function commonDir(gitDir: string): Promise<string> {
  const pointer = await readTrimmed(join(gitDir, "commondir"));
  if (pointer === null || pointer === "") return gitDir;
  return isAbsolute(pointer) ? pointer : resolve(gitDir, pointer);
}

async function resolveRef(gitDir: string, ref: string): Promise<string | null> {
  if (
    !REF_NAME.test(ref) ||
    ref.split("/").some((part) => part === "." || part === "..")
  ) {
    return null;
  }
  const common = await commonDir(gitDir);
  for (const dir of new Set([gitDir, common])) {
    const loose = await readTrimmed(join(dir, ...ref.split("/")));
    if (loose !== null && OBJECT_ID.test(loose)) return loose;
  }
  const packed = await readTrimmed(join(common, "packed-refs"));
  for (const line of packed?.split("\n") ?? []) {
    const [id, name] = line.split(" ");
    if (name === ref && OBJECT_ID.test(id)) return id;
  }
  return null;
}

/** The HEAD commit of the checkout holding `start`, or `unknown`. */
export async function gitHead(start: string): Promise<string> {
  try {
    const gitDir = await findGitDir(start);
    if (gitDir === null || !(await stat(gitDir)).isDirectory()) {
      return FINGERPRINT_UNKNOWN;
    }
    const head = await readTrimmed(join(gitDir, "HEAD"));
    if (head === null) return FINGERPRINT_UNKNOWN;
    if (OBJECT_ID.test(head)) return head;
    const ref = head.match(/^ref: (.+)$/)?.[1];
    if (ref === undefined) return FINGERPRINT_UNKNOWN;
    return await resolveRef(gitDir, ref) ?? FINGERPRINT_UNKNOWN;
  } catch {
    return FINGERPRINT_UNKNOWN;
  }
}

/** The fingerprint of the code under `sourceDir` (a `prototype/src`). */
export async function codeFingerprint(
  sourceDir: string,
): Promise<CodeFingerprint> {
  const [head, contentHash] = await Promise.all([
    gitHead(sourceDir),
    sourceTreeHash(sourceDir),
  ]);
  return { head, contentHash };
}

/**
 * Whether a runtime runs the code in this checkout: `current` when the
 * hashes match, `behind` when they differ, `unknown` when either side is
 * unknown or not a well-formed hash, or the runtime reported no fingerprint
 * (an older runtime). Only `behind` warrants a warning or a restart.
 */
export type Freshness = "current" | "behind" | "unknown";

// A content hash as `sourceTreeHash` writes it. The runtime's comes from
// unvalidated JSON, and `behind` can stop a runtime, so any other shape on
// either side means no comparison.
const CONTENT_HASH = /^sha256:[0-9a-f]{64}$/;

export function compareFreshness(
  runtimeFingerprint: unknown,
  localHash: string,
): Freshness {
  if (typeof runtimeFingerprint !== "object" || runtimeFingerprint === null) {
    return "unknown";
  }
  const runtimeHash = (runtimeFingerprint as { contentHash?: unknown })
    .contentHash;
  if (
    typeof runtimeHash !== "string" ||
    !CONTENT_HASH.test(runtimeHash) ||
    !CONTENT_HASH.test(localHash)
  ) {
    return "unknown";
  }
  return runtimeHash === localHash ? "current" : "behind";
}
