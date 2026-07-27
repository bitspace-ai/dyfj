/**
 * Workspace file tools for the agent loop, scoped to a workspace root.
 *
 * `read_file`, `list_files`, `grep_files` and `glob_files` are read-only and
 * side-effect-free (the policy auto-allows them). `write_file` is mutating —
 * the command policy routes it through operator approval, so its executor never
 * runs unapproved. Every path is resolved within the root and traversal/symlink
 * escape is rejected, so the model can only touch the project it's working in.
 * `edit_file` applies a single exact-string replacement (also mutating); `bash`
 * is a later slice.
 *
 * Auto-approval means no operator sits between the model and these executors,
 * so their resource ceilings are a security boundary rather than a courtesy.
 * The search tools carry the heaviest ones; see the section comment below for
 * what is enforced and what is deliberately left open.
 *
 * Executors never throw on operator/model error (bad path, missing file,
 * traversal attempt): they return an `error: …` string so the model sees the
 * failure as a tool result and can recover, rather than crashing the turn.
 */

import { dirname, relative, resolve, sep } from "node:path";
import {
  BoundedMatcher,
  RegexBudgetExceeded,
  RegexUnavailable,
} from "./bounded-regex.ts";

const DEFAULT_MAX_BYTES = 64 * 1024;
const DEFAULT_MAX_ENTRIES = 500;

/**
 * Largest file any read tool will pull into memory. Read tools are
 * auto-approved, so this ceiling is checked with `stat` BEFORE the read — a
 * post-read length check is not a memory bound, it is a report on memory
 * already spent.
 */
const HARD_MAX_FILE_BYTES = 4 * 1024 * 1024;

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
 * Resolve `p` within `root` and return the absolute path, or throw if it
 * escapes the root. Pure (no I/O) so it's directly testable.
 */
export function resolveWorkspacePath(root: string, p: string): string {
  const rootAbs = resolve(root);
  const abs = resolve(rootAbs, p);
  const rel = relative(rootAbs, abs);
  if (rel.startsWith("..") || rel.startsWith("/")) {
    throw new Error(`path escapes the workspace root: ${sanitizeOutputText(p)}`);
  }
  return abs;
}

/**
 * Read a file's text content, scoped to the workspace root.
 *
 * `range` selects a 1-based inclusive line window, so a large file can be read
 * in pieces without shelling out to sed/head/tail — each of which would route
 * through operator approval. The byte cap still applies to the selected window.
 *
 * `maxBytes` caps the text handed back to the model, in encoded UTF-8 bytes —
 * `.length` would count UTF-16 code units and let a multibyte file return up to
 * three times the named ceiling. It does NOT cap the read itself: the whole
 * file is decoded before a window is sliced out of it. The memory bound is the
 * separate size check against HARD_MAX_FILE_BYTES, which the model cannot
 * raise.
 */
export async function executeReadFile(
  root: string,
  p: string,
  maxBytes = DEFAULT_MAX_BYTES,
  range: { offset?: number; limit?: number } = {},
): Promise<string> {
  const hasRange = range.offset !== undefined || range.limit !== undefined;
  const offset = range.offset ?? 1;
  if (hasRange && (!Number.isInteger(offset) || offset < 1)) {
    return `error: offset must be an integer >= 1`;
  }
  if (
    range.limit !== undefined &&
    (!Number.isInteger(range.limit) || range.limit < 1)
  ) {
    return `error: limit must be an integer >= 1`;
  }
  let abs: string;
  try {
    abs = resolveWorkspacePath(root, p);
  } catch (err) {
    // resolveWorkspacePath's message carries only the caller-supplied path.
    return `error: ${(err as Error).message}`;
  }
  try {
    const target = await containedRealPath(root, abs);
    if (target === null) {
      return `error: path escapes the workspace root: ${sanitizeOutputText(p)}`;
    }
    const info = await Deno.stat(target);
    if (info.isDirectory) {
      return `error: ${sanitizeOutputText(p)} is a directory; use list_files`;
    }
    const rootReal = await Deno.realPath(resolve(root));
    const read = await readContainedFile(target, HARD_MAX_FILE_BYTES, rootReal);
    if (!read.ok) {
      return `error: cannot read ${sanitizeOutputText(p)}: ${read.reason}`;
    }
    const full = new TextDecoder("utf-8", { fatal: false }).decode(read.bytes);
    let text = full;
    if (hasRange) {
      const window = lineWindow(full, offset, range.limit);
      if (window === null) {
        return `error: offset ${offset} is past end of ${sanitizeOutputText(p)} (${
          countLines(full)
        } lines)`;
      }
      text = window.text;
      const more = window.totalLines - window.endLine;
      if (more > 0) {
        text =
          `${text}\n\n[lines ${offset}-${window.endLine} of ${window.totalLines}; ${more} more]`;
      }
    }
    const clipped = clipToUtf8Bytes(text, maxBytes);
    if (clipped !== null) {
      return `${clipped}\n\n[truncated at ${maxBytes} bytes]`;
    }
    return text;
  } catch (err) {
    return `error: cannot read ${sanitizeOutputText(p)}: ${safeErrorReason(err)}`;
  }
}

/** Total lines, counted the way `split("\n")` would, without allocating them. */
function countLines(text: string): number {
  let lines = 1;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
    lines++;
  }
  return lines;
}

/**
 * The 1-based inclusive line window `[offset, offset + limit)` as ONE slice of
 * the original string, plus the totals the caller reports. Null when `offset`
 * is past the end.
 *
 * Deliberately not `split("\n").slice(...)`: a 4 MiB file of newlines splits
 * into four million strings, and doing that to hand back twenty lines is a
 * large transient allocation on a tool nothing prompts for. One pass over the
 * text finds the window's bounds and counts the rest, so cost tracks file size
 * rather than line count.
 */
function lineWindow(
  text: string,
  offset: number,
  limit: number | undefined,
): { text: string; totalLines: number; endLine: number } | null {
  const lastWanted = limit === undefined
    ? Number.POSITIVE_INFINITY
    : offset + limit - 1;
  let totalLines = 0;
  let startIndex = -1;
  let endIndex = -1;
  let endLine = 0;
  let pos = 0;
  while (pos <= text.length) {
    totalLines++;
    if (totalLines === offset) startIndex = pos;
    const nl = text.indexOf("\n", pos);
    const lineEnd = nl === -1 ? text.length : nl;
    if (totalLines === lastWanted) {
      endIndex = lineEnd;
      endLine = totalLines;
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (startIndex === -1) return null; // offset past end
  if (endIndex === -1) {
    endIndex = text.length;
    endLine = totalLines;
  }
  return { text: text.slice(startIndex, endIndex), totalLines, endLine };
}

/**
 * `text` cut to at most `maxBytes` encoded UTF-8 bytes, or null when it already
 * fits. The cut walks back off UTF-8 continuation bytes (top bits `10`) so it
 * lands on a character boundary: a naive slice can swap a clipped tail for a
 * differently-sized replacement character and end up past the ceiling it was
 * enforcing.
 */
export function clipToUtf8Bytes(text: string, maxBytes: number): string | null {
  const encoded = new TextEncoder().encode(text);
  if (encoded.byteLength <= maxBytes) return null;
  let end = Math.min(maxBytes, encoded.byteLength);
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end--;
  return new TextDecoder().decode(encoded.subarray(0, end));
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
async function readContainedFile(
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
    return { ok: false, reason: "cannot verify file identity on this platform" };
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
async function containedRealPath(
  root: string,
  abs: string,
): Promise<string | null> {
  const rootReal = await Deno.realPath(resolve(root));
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
  return !(rel.startsWith("..") || rel.startsWith("/"));
}

/** List directory entries (one per line; directories suffixed with /). */
export async function executeListFiles(
  root: string,
  p = ".",
  maxEntries = DEFAULT_MAX_ENTRIES,
): Promise<string> {
  let abs: string;
  try {
    abs = resolveWorkspacePath(root, p);
  } catch (err) {
    // resolveWorkspacePath's message carries only the caller-supplied path.
    return `error: ${(err as Error).message}`;
  }
  try {
    const target = await containedRealPath(root, abs);
    if (target === null) {
      return `error: path escapes the workspace root: ${sanitizeOutputText(p)}`;
    }
    const entries: string[] = [];
    for await (const entry of Deno.readDir(target)) {
      entries.push(entry.isDirectory ? `${entry.name}/` : entry.name);
    }
    if (entries.length === 0) return "(empty directory)";
    entries.sort();
    if (entries.length > maxEntries) {
      const shown = entries.slice(0, maxEntries);
      return `${shown.join("\n")}\n[${
        entries.length - maxEntries
      } more entries omitted]`;
    }
    return entries.join("\n");
  } catch (err) {
    return `error: cannot list ${sanitizeOutputText(p)}: ${safeErrorReason(err)}`;
  }
}

/**
 * Write UTF-8 text to a file scoped to the workspace root, creating or
 * overwriting it. Containment is checked against the REAL parent directory
 * (defeating a symlinked parent), and write_file refuses to write through a
 * symlink at the target path — a dangling in-root symlink could point outside
 * the root and `writeTextFile` would follow it (CWE-59). The parent directory
 * must already exist. This is a mutating tool; the command policy routes it
 * through operator approval, so the executor itself never runs unapproved.
 */
export async function executeWriteFile(
  root: string,
  p: string,
  content: string,
  // Injectable for tests: the scoped test sandbox forbids creating real symlinks
  // (Deno.symlink needs unscoped read+write), so the no-follow guard is exercised
  // with a fake lstat. The real OS symlink-follow escape is Codex-PoC-verified.
  lstat: (path: string) => Promise<{ isSymlink: boolean }> = Deno.lstat,
): Promise<string> {
  let abs: string;
  try {
    abs = resolveWorkspacePath(root, p);
  } catch (err) {
    // resolveWorkspacePath's message carries only the caller-supplied path.
    return `error: ${(err as Error).message}`;
  }
  try {
    const rootReal = await Deno.realPath(resolve(root));
    const parentReal = await Deno.realPath(dirname(abs));
    if (!isWithinRoot(rootReal, parentReal)) {
      return `error: path escapes the workspace root: ${sanitizeOutputText(p)}`;
    }
    // Refuse to write through a symlink at the target path: write_file never
    // follows symlinks. lstat (no-follow) detects a symlink even when it dangles
    // — realPath(abs) fails on a dangling link, so the old "target missing"
    // branch would have let writeTextFile follow it outside the root (CWE-59).
    try {
      const targetInfo = await lstat(abs);
      if (targetInfo.isSymlink) {
        return `error: refusing to write through a symlink: ${sanitizeOutputText(p)}`;
      }
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) {
        return `error: cannot write ${sanitizeOutputText(p)}: ${safeErrorReason(err)}`;
      }
      // NotFound — the target does not exist yet; the parent containment governs.
    }
    await Deno.writeTextFile(abs, content);
    // Non-content-derived result: no exact length, which would otherwise persist
    // a payload-size signal into the event log + session replay (CWE-532).
    return `wrote ${sanitizeOutputText(p)}`;
  } catch (err) {
    return `error: cannot write ${sanitizeOutputText(p)}: ${safeErrorReason(err)}`;
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
  root: string,
  p: string,
  oldString: string,
  newString: string,
  lstat: (path: string) => Promise<{ isSymlink: boolean }> = Deno.lstat,
): Promise<string> {
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
    const target = await containedRealPath(root, abs);
    if (target === null) {
      return `error: path escapes the workspace root: ${sanitizeOutputText(p)}`;
    }
    const info = await Deno.stat(target);
    if (info.isDirectory) {
      return `error: ${sanitizeOutputText(p)} is a directory`;
    }
    text = await Deno.readTextFile(target);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      return `error: cannot edit ${sanitizeOutputText(p)}: file not found`;
    }
    return `error: cannot read ${sanitizeOutputText(p)}: ${safeErrorReason(err)}`;
  }
  const first = text.indexOf(oldString);
  if (first === -1) {
    return `error: oldString not found in ${sanitizeOutputText(p)}`;
  }
  if (text.indexOf(oldString, first + oldString.length) !== -1) {
    return `error: oldString is not unique in ${sanitizeOutputText(p)}; add more surrounding context`;
  }
  const updated = text.slice(0, first) + newString +
    text.slice(first + oldString.length);
  const writeResult = await executeWriteFile(root, p, updated, lstat);
  // executeWriteFile returns "wrote <p>" on success or "error: …" on failure.
  return writeResult.startsWith("error:") ? writeResult : `edited ${sanitizeOutputText(p)}`;
}

// ── Search affordances ───────────────────────────────────────────────────────
//
// `grep_files` and `glob_files` exist so the model does not have to reach for
// `bash` to answer read-only questions. Every bash call routes to operator
// approval (the no-exec invariant), so without a native search tool a purely
// read-only turn spends approvals on grep, sed and cat — prompts that carry no
// decision, and that train the operator to approve without reading.
//
// Both tools are AUTO-APPROVED, so every limit here has to hold against
// arguments the model chose — including a model steered by workspace file
// content it just read. What is actually enforced, and what is not:
//
//   - The walk refuses symlinks on sight and re-checks each directory with a
//     no-follow stat before descending. That is NOT race-safe descent: Deno
//     exposes no openat-style API, so recursion is ultimately by pathname and a
//     directory replaced between the check and the descent can still redirect
//     the traversal. The guarantee is therefore enforced where it can be — at
//     the point of use. Every emitted path is canonicalized and rejected if it
//     resolves outside the root or into an excluded directory, so a raced alias
//     changes which files get walked, not which ones come back.
//   - .git/.jj/node_modules are skipped by name and by canonical path, whether
//     they are met as a child or named as the search root: large, uninteresting,
//     and .git holds remotes, reflogs and identities that would otherwise reach
//     the durable transcript with no approval in front of them.
//   - The traversal budget counts EVERY directory entry visited, not only the
//     files that survive filtering, and recursion stops at HARD_MAX_DEPTH. A
//     directory-only or deeply nested tree therefore exhausts the budget the
//     same way a wide one does. (It did not, before: counting files alone let
//     an all-directories tree walk for free.)
//   - Every model-supplied limit goes through `clampLimit` against a ceiling
//     this module owns. `maxMatches: 1e9` yields HARD_MAX_MATCHES.
//   - Files are `stat`ed before they are read, so an oversized file is skipped
//     without being loaded. Checking length after `readFile` — the previous
//     shape — reports the memory it already spent. Reads also draw on one
//     total-byte budget for the whole call: the per-file and entry caps each
//     held while their product did not.
//   - Rows stop accumulating at HARD_MAX_RESULT_BYTES independently of the row
//     count, so one file of very long matching lines cannot produce an
//     unbounded tool result.
//   - Regex matching runs in a terminateable worker under a wall-clock budget
//     (bounded-regex.ts). Matching line by line does NOT bound backtracking —
//     one long line is enough for a catastrophic pattern — so lines over
//     MAX_LINE_LENGTH are skipped outright and the budget, not the pattern,
//     is what bounds the cost. If the worker cannot start, the search fails
//     closed rather than matching on the main thread. Compilation runs on the
//     main thread ahead of the worker and is bounded by a pattern-length cap
//     instead of by the clock.
//   - Glob matching does not go through RegExp at all: `matchesGlobPath` is a
//     segment-wise wildcard matcher using the standard star-backtrack trick.
//     It is worst-case quadratic, and length caps bound each match but not the
//     product of a bad pattern and a large tree — so every comparison is
//     counted against one budget shared by the whole call, and the call stops
//     and says so when that budget runs out.
//   - Content is read through `readContainedFile`, which verifies the opened
//     descriptor's identity, so a file swapped for a symlink between the walk
//     and the read is refused rather than followed.
//   - "Scope" is defined, not implied: the excluded directories above are
//     outside it by contract and are not reported as omissions — otherwise
//     every search of every repository would carry a .git note and the note
//     would stop meaning anything. Everything the search DOES observe and then
//     decline is counted: binary files, over-long lines, oversized files,
//     unreadable directories, symlinks, non-regular files, raced paths, files
//     that changed while being read, and every ceiling. A trailing note is
//     therefore reliable in one direction only, and that limit is the honest
//     part: a note means something was left out; the absence of one means the
//     search skipped nothing IT SAW. It is not proof the tree held still.
//     Deno has no snapshotting or descriptor-relative directory read, so
//     traversal walks a live filesystem by pathname — a directory replaced
//     between the check and the descent moves content out of view without ever
//     being observed, and nothing can count what was never enumerated. Content
//     that is reached is still verified at the point of use, so a raced path
//     cannot be RETURNED; it can only be missed. Same shape one level down: a
//     file mutated mid-read is caught by re-stating the descriptor, best effort
//     on size and mtime, so an in-place edit of identical length inside the
//     filesystem's mtime granularity goes unseen.

const DEFAULT_MAX_ENTRIES_VISITED = 5_000;
const DEFAULT_MAX_MATCHES = 200;

// Ceilings this module owns. No argument, model- or caller-supplied, raises
// them; `clampLimit` is the only way in.
const HARD_MAX_ENTRIES_VISITED = 50_000;
const HARD_MAX_MATCHES = 1_000;
const HARD_MAX_GLOB_RESULTS = 2_000;
const HARD_MAX_DEPTH = 32;
const HARD_MAX_RESULT_BYTES = 128 * 1024;
/** Lines longer than this are never handed to the matcher. */
const MAX_LINE_LENGTH = 4_096;
/** Lines one file may spend, however small each of them is. */
const HARD_MAX_LINES_PER_FILE = 200_000;
/**
 * Total bytes one grep call may read across every file. The per-file cap and
 * the entry cap each held individually while their PRODUCT did not: 5,000
 * entries at 64 KiB apiece is ~312 MiB of auto-approved reads in one call, and
 * binary or long-line-only files spend none of the regex budget on the way.
 * One shared ceiling bounds the product directly. Enforced before each read,
 * so a call can overshoot by at most one file's own size cap.
 */
const HARD_MAX_TOTAL_READ_BYTES = 64 * 1024 * 1024;
/** Lines per worker round trip: bounds the structured clone and the accumulator. */
const MATCH_CHUNK_LINES = 2_000;
/** Glob patterns longer than this are refused rather than matched. */
const MAX_GLOB_LENGTH = 512;
/**
 * Aggregate comparison budget for glob matching across one whole call.
 *
 * Length and entry ceilings bound the inputs but not their product: a
 * near-worst-case 512-char pattern against a long path is ~2e6 comparisons, and
 * 50,000 entries of that would occupy the event loop for minutes — on a tool
 * nothing prompts for. Unlike the regex path there is no worker to terminate,
 * because the matcher is ours and can simply count. Ordinary searches land
 * three orders of magnitude below this.
 */
const HARD_MAX_GLOB_STEPS = 20_000_000;

const SKIP_DIRS = new Set(["node_modules", ".git", ".jj", ".hg", ".svn"]);

/**
 * Fold a caller-supplied limit into `[1, hardMax]`, falling back to `fallback`
 * for anything that is not a usable number. Exported because "the model cannot
 * inflate a limit" is a claim worth testing directly.
 */
export function clampLimit(
  value: number | undefined,
  fallback: number,
  hardMax: number,
): number {
  if (value === undefined || !Number.isFinite(value)) {
    return Math.min(fallback, hardMax);
  }
  const n = Math.floor(value);
  if (n < 1) return 1;
  return Math.min(n, hardMax);
}

// ── Glob matching (no RegExp) ────────────────────────────────────────────────

/**
 * Does `ch` fall in a `[...]` class body (leading `!` or `^` negates)?
 *
 * The caller charges `body.length` before calling: this scan is proportional to
 * the class body, so leaving it uncharged would let `*[bbbb…c]` do ~500
 * comparisons per counted step and slip the aggregate budget by that factor.
 */
function matchClass(body: string, ch: string): boolean {
  let negate = false;
  let i = 0;
  if (body[0] === "!" || body[0] === "^") {
    negate = true;
    i = 1;
  }
  let hit = false;
  for (; i < body.length; i++) {
    if (body[i + 1] === "-" && i + 2 < body.length) {
      if (ch >= body[i] && ch <= body[i + 2]) hit = true;
      i += 2;
    } else if (body[i] === ch) {
      hit = true;
    }
  }
  return negate ? !hit : hit;
}

/**
 * The pattern token starting at `p`: how many chars it spans, and its test.
 *
 * Both the delimiter search and the class test are charged to the budget, so
 * every character the matcher actually examines is counted — not just the outer
 * loop iterations, which is what an aggregate bound has to mean.
 */
function tokenAt(
  pat: string,
  p: number,
  budget: GlobBudget,
): { len: number; test: (ch: string) => boolean } {
  const c = pat[p];
  if (c === "?") return { len: 1, test: () => true };
  if (c === "[") {
    const end = pat.indexOf("]", p + 1);
    budget.steps += end === -1 ? pat.length - p : end - p;
    if (end !== -1) {
      const body = pat.slice(p + 1, end);
      return {
        len: end - p + 1,
        test: (ch) => {
          budget.steps += body.length;
          return matchClass(body, ch);
        },
      };
    }
    return { len: 1, test: (ch) => ch === "[" }; // unterminated: literal
  }
  return { len: 1, test: (ch) => ch === c };
}

/**
 * Match one path segment against one glob segment (`*`, `?`, `[...]`).
 *
 * The classic wildcard algorithm: advance greedily, and on a mismatch rewind to
 * one character past the last `*`. Worst case is O(name × pattern) with no
 * recursion and no backtracking blowup — which is the whole reason globs are
 * not translated into a RegExp and run against model-supplied input.
 */
function matchSegment(name: string, pat: string, budget: GlobBudget): boolean {
  let n = 0;
  let p = 0;
  let starN = -1;
  let starP = -1;
  while (n < name.length) {
    if (++budget.steps > budget.cap) return false;
    if (p < pat.length && pat[p] === "*") {
      starP = p;
      starN = n;
      p++;
      continue;
    }
    if (p < pat.length) {
      // Checked around the token too, not just at the top of the loop: a class
      // token charges its own scan, so a long final class could cross the cap
      // and still return a match.
      const tok = tokenAt(pat, p, budget);
      if (budget.steps > budget.cap) return false;
      const matched = tok.test(name[n]);
      if (budget.steps > budget.cap) return false;
      if (matched) {
        n++;
        p += tok.len;
        continue;
      }
    }
    if (starP !== -1) {
      starN++;
      n = starN;
      p = starP + 1;
      continue;
    }
    return false;
  }
  while (p < pat.length && pat[p] === "*") p++;
  return p === pat.length;
}

/** Same algorithm one level up, with `**` standing for zero or more segments. */
function matchSegments(
  path: string[],
  glob: string[],
  budget: GlobBudget,
): boolean {
  let n = 0;
  let g = 0;
  let starN = -1;
  let starG = -1;
  while (n < path.length) {
    if (++budget.steps > budget.cap) return false;
    if (g < glob.length && glob[g] === "**") {
      starG = g;
      starN = n;
      g++;
      continue;
    }
    if (
      g < glob.length && glob[g] !== "**" &&
      matchSegment(path[n], glob[g], budget)
    ) {
      n++;
      g++;
      continue;
    }
    if (starG !== -1) {
      starN++;
      n = starN;
      g = starG + 1;
      continue;
    }
    return false;
  }
  while (g < glob.length && glob[g] === "**") g++;
  return g === glob.length;
}

/**
 * True when a workspace-relative path matches the glob. `**` crosses `/`; `*`,
 * `?` and `[...]` do not. Over-long patterns match nothing rather than being
 * matched — the length cap is what keeps the quadratic worst case small.
 */
export function matchesGlobPath(
  path: string,
  glob: string,
  budget: GlobBudget = newGlobBudget(),
): boolean {
  if (globPatternError(glob) !== null) return false;
  return matchSegments(path.split("/"), glob.split("/"), budget);
}

/**
 * Comparison budget shared by every glob match in one call. `exhausted` is what
 * the executors report: once the budget runs out every further match returns
 * false, which without a note would look exactly like "no more matches".
 */
export interface GlobBudget {
  steps: number;
  cap: number;
}

export function newGlobBudget(cap = HARD_MAX_GLOB_STEPS): GlobBudget {
  return { steps: 0, cap };
}

export function globBudgetExhausted(budget: GlobBudget): boolean {
  return budget.steps > budget.cap;
}

/**
 * Why a glob is unusable, or null when it is fine. Callers reject explicitly
 * rather than leaning on `matchesGlobPath` returning false for everything: a
 * silently unmatchable pattern reads as "nothing here" when it means "I did not
 * look".
 */
export function globPatternError(glob: string): string | null {
  if (glob.length === 0) return "pattern must be non-empty";
  if (glob.length > MAX_GLOB_LENGTH) {
    return `pattern is longer than ${MAX_GLOB_LENGTH} characters`;
  }
  return null;
}

// ── Traversal ────────────────────────────────────────────────────────────────

/**
 * Yield bounded chunks of matchable lines, walking the text rather than
 * splitting it. `split("\\n")` on a multi-megabyte file of short lines
 * materialises every line at once, which is unbounded work in service of a
 * bounded answer; `indexOf` walks it a chunk at a time and the caller can stop
 * as soon as its row limits are met. `tally` carries out what was omitted so
 * the completeness note stays honest.
 */
function* chunkLines(
  text: string,
  tally: { longLines: number; lineCapped: boolean },
): Generator<{ lines: string[]; numbers: number[] }> {
  let lines: string[] = [];
  let numbers: number[] = [];
  let start = 0;
  let lineNumber = 1;
  let scanned = 0;
  while (start <= text.length) {
    if (scanned >= HARD_MAX_LINES_PER_FILE) {
      tally.lineCapped = true;
      break;
    }
    const nl = text.indexOf("\n", start);
    const line = text.slice(start, nl === -1 ? text.length : nl);
    scanned++;
    if (line.length > MAX_LINE_LENGTH) {
      tally.longLines++;
    } else {
      lines.push(line);
      numbers.push(lineNumber);
      if (lines.length >= MATCH_CHUNK_LINES) {
        yield { lines, numbers };
        lines = [];
        numbers = [];
      }
    }
    lineNumber++;
    if (nl === -1) break;
    start = nl + 1;
  }
  if (lines.length > 0) yield { lines, numbers };
}

/** True when the buffer looks binary (NUL byte in the first 8KB). */
function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8192);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

/**
 * Traversal budget and the completeness state that goes with it. Every way the
 * walk can come up short travels here, because an executor that cannot see the
 * omission will report a partial search as an empty one.
 */
export interface WalkBudget {
  visited: number;
  cap: number;
  depthClipped: boolean;
  unreadableDirs: number;
  /** Symlinks refused on sight — a safety skip the caller cannot predict. */
  skippedSymlinks: number;
  /** Sockets, devices, fifos: neither file nor directory, silently unsearchable. */
  skippedNonRegular: number;
  /** Entries whose type changed between enumeration and descent. */
  skippedRaced: number;
}

export function newWalkBudget(cap: number): WalkBudget {
  return {
    visited: 0,
    cap,
    depthClipped: false,
    unreadableDirs: 0,
    skippedSymlinks: 0,
    skippedNonRegular: 0,
    skippedRaced: 0,
  };
}

/** Notes describing every way a completed walk fell short of its scope. */
export function walkNotes(budget: WalkBudget): string[] {
  const notes: string[] = [];
  if (budget.visited >= budget.cap) {
    notes.push(`entry limit ${budget.cap} reached`);
  }
  if (budget.depthClipped) {
    notes.push(`directory depth limit ${HARD_MAX_DEPTH} reached`);
  }
  if (budget.unreadableDirs > 0) {
    notes.push(`${budget.unreadableDirs} unreadable director(ies) skipped`);
  }
  if (budget.skippedSymlinks > 0) {
    notes.push(`${budget.skippedSymlinks} symlink(s) skipped`);
  }
  if (budget.skippedNonRegular > 0) {
    notes.push(`${budget.skippedNonRegular} non-regular file(s) skipped`);
  }
  if (budget.skippedRaced > 0) {
    notes.push(`${budget.skippedRaced} entr(ies) changed type mid-search`);
  }
  return notes;
}

/** One walked file: the absolute path to OPEN, and the display path to SHOW. */
interface WalkEntry {
  abs: string;
  rel: string;
}

/**
 * Yield walked files under `start`, depth-first and sorted for deterministic
 * output. Symlinks are never followed. `budget.visited` counts every entry
 * seen — directories included — so the cap bounds the walk itself and not
 * merely the files it yields.
 */
async function* walkFiles(
  rootReal: string,
  start: string,
  budget: WalkBudget,
  depth = 0,
  relSegments: string[] = [],
): AsyncGenerator<WalkEntry> {
  if (depth > HARD_MAX_DEPTH) {
    budget.depthClipped = true;
    return;
  }
  const room = budget.cap - budget.visited;
  if (room <= 0) return;
  // Stop consuming readDir at the remaining budget rather than buffering the
  // directory and checking afterwards: one enormous flat directory would
  // otherwise allocate and sort without limit before the cap ever applied,
  // which is precisely what the cap exists to prevent. The consequence is that
  // an overflowing directory keeps readDir order instead of sorted order —
  // output stops being deterministic exactly when it also stops being complete.
  const entries: Deno.DirEntry[] = [];
  try {
    for await (const e of Deno.readDir(start)) {
      entries.push(e);
      if (entries.length >= room) break;
    }
  } catch {
    // Skipping an unreadable directory beats failing the whole search, but it
    // is still a hole in the answer, so it is counted and reported.
    budget.unreadableDirs++;
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (budget.visited >= budget.cap) return;
    budget.visited++;
    const abs = resolve(start, entry.name);
    if (entry.isSymlink) {
      // Never follow: escape and cycle defense. Counted, because refusing to
      // look somewhere is an omission the caller has no way to anticipate.
      budget.skippedSymlinks++;
      continue;
    }
    if (entry.isDirectory) {
      if (SKIP_DIRS.has(entry.name)) continue;
      // DirEntry is a snapshot taken by readDir; re-check with a no-follow
      // stat, because the name may already point somewhere else by now. This
      // narrows the window before descending — it does not close it, which is
      // why emitted results are checked again at the point of use.
      let current: Deno.FileInfo;
      try {
        current = await Deno.lstat(abs);
      } catch {
        budget.unreadableDirs++;
        continue;
      }
      if (current.isSymlink || !current.isDirectory) {
        // It was a directory when readDir looked and is not one now: a raced
        // change, and an omission the caller cannot see unless it is counted.
        budget.skippedRaced++;
        continue;
      }
      yield* walkFiles(rootReal, abs, budget, depth + 1, [
        ...relSegments,
        entry.name,
      ]);
      continue;
    }
    if (!entry.isFile) {
      budget.skippedNonRegular++;
      continue;
    }
    if (!isWithinRoot(rootReal, abs)) continue;
    // `rel` is built by joining ENTRY NAMES with "/", never by splitting a
    // platform path back apart. The distinction is load-bearing on POSIX,
    // where backslash is a legal filename character: normalizing a derived
    // relative path turned a file literally named `..\private\secret.txt`
    // into the traversal `../private/secret.txt`, and reopening from that
    // display string redirected the read to a different file. A separator can
    // never appear inside an entry name on either platform, so the join is
    // unambiguous — and `abs` stays the one true filesystem identity; the
    // display path is never resolved back into a path to open.
    yield { abs, rel: [...relSegments, entry.name].join("/") };
  }
}

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
 * Resolve the search start, or return an `error: …` string.
 *
 * SKIP_DIRS is enforced here as well as in the walk. The walk only ever sees a
 * skipped directory as a *child*, so naming one as the starting point — `path:
 * ".git"` — used to begin inside it and traverse freely, handing back exactly
 * the repository metadata the exclusion exists to withhold. The check runs on
 * the canonicalized start, so an in-root symlink pointing at `.git` is caught
 * with it.
 */
async function searchRoot(
  root: string,
  sub: string,
): Promise<
  { rootReal: string; startReal: string; startSegments: string[] } | string
> {
  try {
    const abs = resolveWorkspacePath(root, sub);
    const rootReal = await Deno.realPath(resolve(root));
    const contained = await containedRealPath(root, abs);
    if (contained === null) {
      return `error: path escapes the workspace root: ${sanitizeOutputText(sub)}`;
    }
    const excluded = excludedSegment(rootReal, contained);
    if (excluded !== null) {
      return `error: ${excluded} is excluded from search`;
    }
    // Split on the PLATFORM separator: on Windows that divides the real
    // directory names; on POSIX it is "/", so a start directory whose name
    // contains a literal backslash keeps it inside one segment rather than
    // being misread as nesting. Display-only — opening always uses startReal.
    const startRel = relative(rootReal, contained);
    const startSegments = startRel === "" ? [] : startRel.split(sep);
    return { rootReal, startReal: contained, startSegments };
  } catch (err) {
    return `error: cannot search ${sanitizeOutputText(sub)}: ${safeErrorReason(err)}`;
  }
}

// ── Executors ────────────────────────────────────────────────────────────────

const encoder = new TextEncoder();

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
  return p.replace(
    /[\\:\x00-\x1f\x7f-\x9f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
    (c) => {
      if (c === "\\") return "\\\\";
      if (c === ":") return "\\x3a";
      return escapeChar(c);
    },
  );
}

/**
 * Search file contents for `pattern` (a JavaScript regular expression), scoped
 * to the workspace root. Returns `path:line:text` rows.
 */
export async function executeGrepFiles(
  root: string,
  pattern: string,
  options: {
    path?: string;
    include?: string;
    maxMatches?: number;
    maxFiles?: number;
    maxBytes?: number;
    budgetMs?: number;
    maxTotalReadBytes?: number;
    // Test-only seams. `buildGrepFilesCommand` sets none of these, so nothing
    // the model sends can reach them — and that must stay true: an overridden
    // worker runs with the host's inherited permissions, and an overridden
    // canonicalizer is what decides containment.
    workerSpecifier?: string;
    realPath?: (p: string) => Promise<string>;
  } = {},
): Promise<string> {
  if (pattern === "") return "error: pattern must be non-empty";
  if (options.include !== undefined) {
    const globError = globPatternError(options.include);
    if (globError !== null) return `error: include ${globError}`;
  }

  let matcher: BoundedMatcher;
  try {
    matcher = new BoundedMatcher(pattern, {
      budgetMs: options.budgetMs,
      specifier: options.workerSpecifier,
    });
  } catch (err) {
    // The engine's message embeds the pattern itself, which is model-supplied
    // text like any other and gets the same structural escaping.
    return `error: invalid pattern: ${
      sanitizeOutputText((err as Error).message)
    }`;
  }

  const maxMatches = clampLimit(
    options.maxMatches,
    DEFAULT_MAX_MATCHES,
    HARD_MAX_MATCHES,
  );
  const maxEntries = clampLimit(
    options.maxFiles,
    DEFAULT_MAX_ENTRIES_VISITED,
    HARD_MAX_ENTRIES_VISITED,
  );
  const maxBytes = clampLimit(
    options.maxBytes,
    DEFAULT_MAX_BYTES,
    HARD_MAX_FILE_BYTES,
  );
  // The total-read ceiling is not model-reachable: buildGrepFilesCommand never
  // maps it, so the option exists only so tests can exercise the cutoff
  // without writing 64 MiB of fixtures.
  const maxTotalReadBytes = clampLimit(
    options.maxTotalReadBytes,
    HARD_MAX_TOTAL_READ_BYTES,
    HARD_MAX_TOTAL_READ_BYTES,
  );
  const sub = options.path === undefined ? "." : options.path;

  const start = await searchRoot(root, sub);
  if (typeof start === "string") {
    matcher.close();
    return start;
  }
  const { rootReal, startReal, startSegments } = start;

  const rows: string[] = [];
  const budget = newWalkBudget(maxEntries);
  const globBudget = newGlobBudget();
  let resultBytes = 0;
  let truncated = false;
  let byteCapped = false;
  let budgetExhausted = false;
  let skippedLarge = 0;
  let skippedUnreadable = 0;
  let skippedBinary = 0;
  let excludedRaced = 0;
  let skippedLongLines = 0;
  let lineCappedFiles = 0;
  let changedDuringRead = 0;
  let totalReadBytes = 0;
  let readBudgetExhausted = false;

  try {
    walk:
    for await (
      const entry of walkFiles(rootReal, startReal, budget, 0, startSegments)
    ) {
      const { abs, rel } = entry;
      if (globBudgetExhausted(globBudget)) break;
      if (totalReadBytes >= maxTotalReadBytes) {
        readBudgetExhausted = true;
        break;
      }
      if (
        options.include !== undefined &&
        !matchesGlobPath(rel, options.include, globBudget)
      ) {
        continue;
      }
      // Identity-verified read of the ENUMERATED absolute path — never a path
      // rebuilt from the display string, which a backslash-bearing filename
      // could turn into a traversal. The size is checked before any content is
      // loaded, and a pathname repointed since the walk saw it is refused.
      const read = await readContainedFile(abs, maxBytes, rootReal, {
        realPath: options.realPath,
        enforceExclusions: true,
      });
      if (!read.ok) {
        if (read.oversized === true) skippedLarge++;
        else if (read.excluded === true) excludedRaced++;
        else if (read.changed === true) changedDuringRead++;
        else skippedUnreadable++;
        continue;
      }
      totalReadBytes += read.bytes.byteLength;
      if (looksBinary(read.bytes)) {
        skippedBinary++;
        continue;
      }
      const text = new TextDecoder("utf-8", { fatal: false }).decode(read.bytes);

      // Lines are walked and matched in chunks rather than split up front. A
      // 4 MiB file of newlines splits into four million strings — built, held,
      // and structured-cloned into the worker — before the 1,000-row limit gets
      // a chance to apply, so the row ceilings were bounding the answer while
      // nothing bounded the work. Chunking keeps the worker message small, caps
      // the lines any one file can spend, and stops the moment the row limits
      // are met instead of after the whole file.
      const tally = { longLines: 0, lineCapped: false };
      for (const chunk of chunkLines(text, tally)) {
        let hits: number[];
        try {
          hits = await matcher.matchLines(chunk.lines);
        } catch (err) {
          skippedLongLines += tally.longLines;
          if (tally.lineCapped) lineCappedFiles++;
          if (err instanceof RegexBudgetExceeded) {
            budgetExhausted = true;
            break walk;
          }
          if (err instanceof RegexUnavailable) {
            return `error: ${(err as Error).message}`;
          }
          return `error: cannot match pattern: ${safeErrorReason(err)}`;
        }
        for (const hit of hits) {
          if (rows.length >= maxMatches) {
            truncated = true;
            skippedLongLines += tally.longLines;
            if (tally.lineCapped) lineCappedFiles++;
            break walk;
          }
          const row = `${sanitizeOutputPathField(rel)}:${chunk.numbers[hit]}:${
            sanitizeOutputText(chunk.lines[hit].trimEnd())
          }`;
          const rowBytes = encoder.encode(row).byteLength + 1;
          if (resultBytes + rowBytes > HARD_MAX_RESULT_BYTES) {
            byteCapped = true;
            skippedLongLines += tally.longLines;
            if (tally.lineCapped) lineCappedFiles++;
            break walk;
          }
          resultBytes += rowBytes;
          rows.push(row);
        }
      }
      skippedLongLines += tally.longLines;
      if (tally.lineCapped) lineCappedFiles++;
    }
  } finally {
    matcher.close();
  }

  if (rows.length === 0 && budgetExhausted) {
    return `error: pattern is too expensive to run (matching budget exhausted); simplify it`;
  }
  // Every ceiling and skip is reported even when nothing matched: a bare
  // "(no matches)" has to mean the requested scope was fully examined, or the
  // model will read an incomplete search as a definitive answer.
  const notes: string[] = [];
  if (truncated) notes.push(`match limit ${maxMatches} reached`);
  if (byteCapped) notes.push(`result size limit reached`);
  if (budgetExhausted) notes.push(`pattern matching budget exhausted`);
  notes.push(...walkNotes(budget));
  if (skippedLarge > 0) notes.push(`${skippedLarge} file(s) over the size cap`);
  if (skippedUnreadable > 0) {
    notes.push(`${skippedUnreadable} file(s) unreadable or changed mid-search`);
  }
  if (skippedBinary > 0) notes.push(`${skippedBinary} binary file(s) skipped`);
  if (changedDuringRead > 0) {
    notes.push(`${changedDuringRead} file(s) changed while being read`);
  }
  if (readBudgetExhausted) {
    notes.push(`total read budget ${maxTotalReadBytes} bytes reached`);
  }
  if (globBudgetExhausted(globBudget)) {
    notes.push(`include-glob matching budget exhausted`);
  }
  if (excludedRaced > 0) {
    notes.push(`${excludedRaced} path(s) resolved into an excluded directory`);
  }
  if (skippedLongLines > 0) {
    notes.push(`${skippedLongLines} line(s) over ${MAX_LINE_LENGTH} chars`);
  }
  if (lineCappedFiles > 0) {
    notes.push(
      `${lineCappedFiles} file(s) truncated at ${HARD_MAX_LINES_PER_FILE} lines`,
    );
  }
  const body = rows.length === 0 ? "(no matches)" : rows.join("\n");
  return notes.length === 0 ? body : `${body}\n[${notes.join("; ")}]`;
}

/** Find workspace-relative file paths matching a glob pattern. */
export async function executeGlobFiles(
  root: string,
  pattern: string,
  options: {
    path?: string;
    maxResults?: number;
    maxFiles?: number;
    // Test-only seam; see executeGrepFiles.
    realPath?: (p: string) => Promise<string>;
  } = {},
): Promise<string> {
  const patternError = globPatternError(pattern);
  if (patternError !== null) return `error: ${patternError}`;
  const maxResults = clampLimit(
    options.maxResults,
    DEFAULT_MAX_ENTRIES,
    HARD_MAX_GLOB_RESULTS,
  );
  const maxEntries = clampLimit(
    options.maxFiles,
    DEFAULT_MAX_ENTRIES_VISITED,
    HARD_MAX_ENTRIES_VISITED,
  );
  const sub = options.path === undefined ? "." : options.path;

  const start = await searchRoot(root, sub);
  if (typeof start === "string") return start;
  const { rootReal, startReal, startSegments } = start;

  const hits: string[] = [];
  const budget = newWalkBudget(maxEntries);
  const globBudget = newGlobBudget();
  let resultBytes = 0;
  let truncated = false;
  let byteCapped = false;
  let escaped = 0;
  let excludedRaced = 0;
  const realPath = options.realPath ?? Deno.realPath;
  for await (
    const entry of walkFiles(rootReal, startReal, budget, 0, startSegments)
  ) {
    const { abs, rel } = entry;
    if (globBudgetExhausted(globBudget)) break;
    if (!matchesGlobPath(rel, pattern, globBudget)) continue;
    // glob_files returns names without opening anything, so it gets the same
    // ancestor-replacement check by canonicalizing before it emits: a path
    // that resolves outside the root is a name the model should never see.
    // Canonicalized from the enumerated absolute path, not one rebuilt from
    // the display string.
    try {
      const canonical = await realPath(abs);
      if (!isWithinRoot(rootReal, canonical)) {
        escaped++;
        continue;
      }
      if (excludedSegment(rootReal, canonical) !== null) {
        excludedRaced++;
        continue;
      }
    } catch {
      escaped++;
      continue;
    }
    if (hits.length >= maxResults) {
      truncated = true;
      break;
    }
    // Measure what is actually emitted: escaping can lengthen the string, so
    // charging the raw path would let the byte ceiling be quietly overshot.
    const emitted = sanitizeOutputPathField(rel);
    const relBytes = encoder.encode(emitted).byteLength + 1;
    if (resultBytes + relBytes > HARD_MAX_RESULT_BYTES) {
      byteCapped = true;
      break;
    }
    resultBytes += relBytes;
    hits.push(emitted);
  }
  const notes: string[] = [];
  if (truncated) notes.push(`result limit ${maxResults} reached`);
  if (byteCapped) notes.push(`result size limit reached`);
  notes.push(...walkNotes(budget));
  if (escaped > 0) {
    notes.push(`${escaped} path(s) resolved outside the workspace root`);
  }
  if (excludedRaced > 0) {
    notes.push(`${excludedRaced} path(s) resolved into an excluded directory`);
  }
  if (globBudgetExhausted(globBudget)) {
    notes.push(`glob matching budget exhausted`);
  }
  const body = hits.length === 0 ? "(no matches)" : hits.join("\n");
  return notes.length === 0 ? body : `${body}\n[${notes.join("; ")}]`;
}
