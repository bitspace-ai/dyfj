/**
 * Shared workspace-access primitives for the file tools: path containment,
 * identity-verified reads, the search exclusion contract, and the escaping
 * every executor applies to workspace-sourced text before it reaches the model
 * and the durable transcript.
 *
 * The resource ceilings here are shared by more than one tool. Tool-specific
 * ceilings live with the tool that enforces them.
 */

import { isAbsolute, relative, resolve } from "node:path";
import {
  type WorkspaceRoot,
  WorkspaceRootChangedError,
} from "./root-anchors.ts";

export const DEFAULT_MAX_BYTES = 64 * 1024;
export const DEFAULT_MAX_ENTRIES = 500;

/**
 * Largest file any read tool will pull into memory. Read tools are
 * auto-approved, so this ceiling is checked with `stat` BEFORE the read — a
 * post-read length check is not a memory bound, it is a report on memory
 * already spent.
 */
export const HARD_MAX_FILE_BYTES = 4 * 1024 * 1024;

/**
 * A stable, path-free description of a filesystem failure.
 *
 * Deno's exception messages embed the absolute path they failed on — home
 * directory, username, workspace layout. These executors hand their result to
 * the model AND to the durable event transcript, so passing the raw message
 * through publishes private paths on every missing file. The caller already
 * knows which workspace-relative path it asked about; the class of failure is
 * the only part worth adding.
 */
export function safeErrorReason(err: unknown): string {
  if (err instanceof WorkspaceRootChangedError) {
    return "workspace root identity changed";
  }
  if (err instanceof Deno.errors.NotFound) return "not found";
  if (err instanceof Deno.errors.PermissionDenied) return "permission denied";
  if (err instanceof Deno.errors.NotADirectory) return "not a directory";
  if (err instanceof Deno.errors.IsADirectory) return "is a directory";
  if (err instanceof Deno.errors.NotCapable) {
    return "not permitted by the runtime sandbox";
  }
  if (err instanceof Deno.errors.FilesystemLoop) return "symlink loop";
  return "unavailable";
}

/**
 * Re-verify the root anchor after a call's filesystem work, before its results
 * are returned. The entry check rejects a replacement already in place when
 * the call starts; this exit check rejects one that arrived mid-call. What
 * survives both is a replace-AND-restore landing entirely between the two
 * verifications — the unavoidable pathname race, retained and stated rather
 * than claimed away. Returns an `error: …` string, or null when the root held.
 */
export async function rootStillAnchored(
  root: WorkspaceRoot,
): Promise<string | null> {
  try {
    await root.verify();
    return null;
  } catch (err) {
    return `error: ${safeErrorReason(err)}`;
  }
}

/**
 * Resolve `p` within `root` and return the absolute path, or throw if `p` is
 * not a workspace-relative path that stays inside the root. Pure (no I/O) so
 * it's directly testable.
 *
 * Absolute inputs are rejected outright — even ones that resolve inside the
 * workspace. The schemas document paths as workspace-relative, and every
 * executor echoes the caller's path into its result and the durable event
 * transcript; accepting an in-root absolute path would put the operator's
 * username and workspace layout into both. The rejection message deliberately
 * does not echo the value, for the same reason.
 */
export function resolveWorkspacePath(root: string, p: string): string {
  if (isAbsolute(p)) {
    throw new Error("path must be relative to the workspace root");
  }
  const rootAbs = resolve(root);
  const abs = resolve(rootAbs, p);
  const rel = relative(rootAbs, abs);
  // isAbsolute, not startsWith("/"): on Windows, `relative` between different
  // drives (or a UNC share) returns the ABSOLUTE target — `C:\evil` — which
  // starts with neither ".." nor "/", so a prefix check reads an out-of-root
  // path as contained. On POSIX the two checks are equivalent. Reachable even
  // with absolute inputs rejected above: `..` traversal resolves wherever it
  // resolves.
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      `path escapes the workspace root: ${sanitizeOutputText(p)}`,
    );
  }
  return abs;
}

/**
 * Best-effort check that a descriptor still holds the same file contents it did
 * before the read: same size, same mtime.
 *
 * Best-effort is the honest word. An in-place edit that preserves byte length
 * and lands inside the filesystem's mtime granularity — or one that restores
 * the old mtime deliberately — passes this check. It catches the ordinary case
 * (a file growing, shrinking, or being rewritten during a search) and does not
 * pretend to be a version counter. Exported so the rule behind the omission
 * note is directly testable rather than only reachable through a real race.
 */
export function sameFileVersion(
  before: Deno.FileInfo,
  after: Deno.FileInfo,
): boolean {
  return before.size === after.size &&
    before.mtime?.getTime() === after.mtime?.getTime();
}

/**
 * Read a file through a descriptor whose identity has been verified.
 *
 * `lstat` → `open` → `fstat`, comparing (dev, ino): if the pathname was swapped
 * — for a symlink, or anything else — between the check and the open, the
 * opened object is not the one that was approved and the read is refused. That
 * race is the reason a pathname check is not sufficient on its own: containment
 * is decided against a name, and a name can be repointed before the content is
 * read. Every read tool here is auto-approved, so the name it was handed is the
 * only thing standing between the model and the rest of the filesystem.
 *
 * Leaf identity alone is not containment, though: it proves we opened the
 * object we checked, not that the object sits inside the workspace. An ANCESTOR
 * directory swapped for a symlink mid-walk leaves a pathname that is lexically
 * in-root and canonically outside it, with a perfectly stable file at the end
 * of it. So the canonical path is resolved after opening, checked against the
 * root, and correlated back to the open descriptor — the traversal is not
 * prevented from wandering, but nothing that wandered is returned.
 *
 * Limits worth stating plainly: inode reuse could in principle defeat the
 * comparison, and platforms that report a null `ino`/`dev` (Windows) cannot be
 * verified at all — those are refused rather than read on trust.
 */
export async function readContainedFile(
  abs: string,
  maxBytes: number,
  rootReal: string,
  options: {
    // Test seam: the sandbox cannot create real symlinks, so the ancestor-swap
    // rejection is exercised with a canonicalizer that reports another path.
    realPath?: (p: string) => Promise<string>;
    // Search enforces SKIP_DIRS against the canonical path; read_file does not,
    // because naming .git/config explicitly is a legitimate request there.
    enforceExclusions?: boolean;
  } = {},
): Promise<
  | { ok: true; bytes: Uint8Array; canonical: string }
  | {
    ok: false;
    reason: string;
    oversized?: boolean;
    excluded?: boolean;
    changed?: boolean;
  }
> {
  const realPath = options.realPath ?? Deno.realPath;
  let before: Deno.FileInfo;
  try {
    before = await Deno.lstat(abs);
  } catch (err) {
    return { ok: false, reason: safeErrorReason(err) };
  }
  if (before.isSymlink) return { ok: false, reason: "path is a symlink" };
  if (!before.isFile) return { ok: false, reason: "not a regular file" };
  if (before.ino === null || before.dev === null) {
    return {
      ok: false,
      reason: "cannot verify file identity on this platform",
    };
  }
  if (before.size > maxBytes) {
    return {
      ok: false,
      reason: `${before.size} bytes is over the ${maxBytes}-byte limit`,
      oversized: true,
    };
  }
  let file: Deno.FsFile;
  try {
    file = await Deno.open(abs, { read: true });
  } catch (err) {
    return { ok: false, reason: safeErrorReason(err) };
  }
  try {
    const after = await file.stat();
    if (
      !after.isFile || after.ino !== before.ino || after.dev !== before.dev
    ) {
      return { ok: false, reason: "file identity changed while opening it" };
    }
    if (after.size > maxBytes) {
      return {
        ok: false,
        reason: `${after.size} bytes is over the ${maxBytes}-byte limit`,
        oversized: true,
      };
    }
    const canonical = await realPath(abs);
    if (!isWithinRoot(rootReal, canonical)) {
      return { ok: false, reason: "resolves outside the workspace root" };
    }
    if (options.enforceExclusions === true) {
      const excluded = excludedSegment(rootReal, canonical);
      if (excluded !== null) {
        return {
          ok: false,
          reason: `resolves into ${excluded}, which is excluded from search`,
          excluded: true,
        };
      }
    }
    const canonicalInfo = await Deno.lstat(canonical);
    if (
      canonicalInfo.ino !== after.ino || canonicalInfo.dev !== after.dev
    ) {
      return { ok: false, reason: "file identity changed while opening it" };
    }
    const bytes = new Uint8Array(after.size);
    let read = 0;
    while (read < bytes.length) {
      const n = await file.read(bytes.subarray(read));
      if (n === null) break;
      read += n;
    }
    const settled = await file.stat();
    if (!sameFileVersion(after, settled)) {
      return { ok: false, reason: "changed while being read", changed: true };
    }
    return {
      ok: true,
      canonical,
      bytes: read === bytes.length ? bytes : bytes.subarray(0, read),
    };
  } catch (err) {
    return { ok: false, reason: safeErrorReason(err) };
  } finally {
    file.close();
  }
}

/**
 * Canonicalize the lexically-resolved path and confirm its REAL target is still
 * within the real workspace root — defeats symlink escapes (an in-root path
 * that is a symlink to an outside file). Returns the real path, or null if the
 * canonical target escapes the root. Throws (caught by callers) if the path
 * does not exist.
 */
export async function containedRealPath(
  workspace: WorkspaceRoot,
  abs: string,
): Promise<string | null> {
  const rootReal = await workspace.verify();
  const targetReal = await Deno.realPath(abs);
  return isWithinRoot(rootReal, targetReal) ? targetReal : null;
}

/**
 * True when `targetReal` is the root itself or nested under it. Both arguments
 * must already be canonical (post-realPath) absolute paths. Pure, so the
 * containment decision behind the symlink defense is directly testable.
 */
export function isWithinRoot(rootReal: string, targetReal: string): boolean {
  const rel = relative(rootReal, targetReal);
  // isAbsolute for the same reason as resolveWorkspacePath: a cross-drive
  // `relative` on Windows returns an absolute path, not a "../" prefix.
  return !(rel.startsWith("..") || isAbsolute(rel));
}

/** Directory names outside search scope by contract; see file-search.ts. */
export const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".jj",
  ".hg",
  ".svn",
]);

/**
 * Backslashes rewritten to `/`. Used ONLY inside excludedSegment, whose input
 * comes from `node:path`'s platform-sensitive `relative` — on Windows that
 * returns `pkg\\.git\\config`, which splits on "/" into one segment and made
 * the exclusion contract a no-op there. On POSIX the rewrite can only ADD
 * segment boundaries, so its error direction is over-exclusion, which fails
 * closed.
 *
 * Never use this on a path that will be opened, matched, or displayed: on
 * POSIX a backslash is an ordinary filename character, and normalizing one
 * into a separator turns a filename like `..\\private\\secret.txt` into a
 * traversal. Traversal builds its paths from entry names instead.
 */
export function toPosixPath(p: string): string {
  return p.replaceAll("\\", "/");
}

/**
 * On POSIX a filename may itself contain backslashes, and normalizing them
 * here can only ADD "/" boundaries — so the error direction is over-exclusion,
 * which fails closed. Filesystem access never goes through this string.
 */
export function excludedSegment(
  rootReal: string,
  canonical: string,
): string | null {
  return toPosixPath(relative(rootReal, canonical))
    .split("/")
    .find((segment) => SKIP_DIRS.has(segment)) ?? null;
}

/**
 * Escape characters that could restructure a result row.
 *
 * Results are newline-separated `path:line:text` rows, and both the filename
 * and the matched line come from the workspace: a file named
 * `a\nb.ts:1:fake` would print as two rows, one of them fabricated, and a name
 * carrying the note delimiters could forge a completeness note. Matched text
 * cannot contain a newline — that is what the lines were split on — but a
 * carriage return, an escape sequence, or a bidi override still rewrites what
 * the reader sees, so both fields go through the same escaping.
 *
 * Covered: C0 and DEL, C1, the Unicode line/paragraph separators (U+2028,
 * U+2029, U+0085) which several renderers treat as line breaks, and the bidi
 * overrides that can visually reorder a row. This is about structural and
 * display integrity, not about producing a canonical encoding.
 */
export function sanitizeOutputText(p: string): string {
  // deno-lint-ignore no-control-regex
  return p.replace(
    /[\x00-\x1f\x7f-\x9f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
    escapeChar,
  );
}

function escapeChar(c: string): string {
  const code = c.charCodeAt(0);
  return code <= 0xff
    ? `\\x${code.toString(16).padStart(2, "0")}`
    : `\\u${code.toString(16).padStart(4, "0")}`;
}

/**
 * Injective encoding for the PATH field of a `path:line:text` row.
 *
 * The path field sits ahead of two delimiters, so it needs more than display
 * safety: a POSIX filename may contain `:` (mimicking the field separator) or
 * `\` (mimicking this function's own escapes). Both are escaped along with
 * everything sanitizeOutputText covers, in one pass — backslash first in the
 * class, so an escape in the output can only have come from this function.
 * That makes the encoding decodable: `\\` is a literal backslash, `\x3a` a
 * literal colon, and a bare `:` is really the delimiter. Matched line text
 * keeps the lighter escaping — it is the final field, so delimiters inside it
 * are unambiguous, and mangling every backslash in source code would cost more
 * readability than it buys.
 */
export function sanitizeOutputPathField(p: string): string {
  // deno-lint-ignore no-control-regex
  const out = p.replace(
    /[\\:\x00-\x1f\x7f-\x9f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
    (c) => {
      if (c === "\\") return "\\\\";
      if (c === ":") return "\\x3a";
      return escapeChar(c);
    },
  );
  // Two whole-line forms are reserved for the tool itself: "(no matches)" and
  // "[<notes>]". A file literally named either would impersonate a control
  // record, so a path's LEADING "(" or "[" is escaped — position 0 only, which
  // leaves file(1).txt untouched. Injective as before: a literal backslash was
  // already escaped above, so an escape at the front can only mean this.
  if (out.startsWith("(")) return `\\x28${out.slice(1)}`;
  if (out.startsWith("[")) return `\\x5b${out.slice(1)}`;
  return out;
}
