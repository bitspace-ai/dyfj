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

import { dirname, relative, resolve } from "node:path";
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
 * Resolve `p` within `root` and return the absolute path, or throw if it
 * escapes the root. Pure (no I/O) so it's directly testable.
 */
export function resolveWorkspacePath(root: string, p: string): string {
  const rootAbs = resolve(root);
  const abs = resolve(rootAbs, p);
  const rel = relative(rootAbs, abs);
  if (rel.startsWith("..") || rel.startsWith("/")) {
    throw new Error(`path escapes the workspace root: ${p}`);
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
    return `error: ${(err as Error).message}`;
  }
  try {
    const target = await containedRealPath(root, abs);
    if (target === null) {
      return `error: path escapes the workspace root: ${p}`;
    }
    const info = await Deno.stat(target);
    if (info.isDirectory) {
      return `error: ${p} is a directory; use list_files`;
    }
    const rootReal = await Deno.realPath(resolve(root));
    const read = await readContainedFile(target, HARD_MAX_FILE_BYTES, rootReal);
    if (!read.ok) {
      return `error: cannot read ${p}: ${read.reason}`;
    }
    const full = new TextDecoder("utf-8", { fatal: false }).decode(read.bytes);
    let text = full;
    if (hasRange) {
      const lines = full.split("\n");
      if (offset > lines.length) {
        return `error: offset ${offset} is past end of ${p} (${lines.length} lines)`;
      }
      const end = range.limit === undefined
        ? lines.length
        : Math.min(lines.length, offset - 1 + range.limit);
      text = lines.slice(offset - 1, end).join("\n");
      const more = lines.length - end;
      if (more > 0) {
        text = `${text}\n\n[lines ${offset}-${end} of ${lines.length}; ${more} more]`;
      }
    }
    const clipped = clipToUtf8Bytes(text, maxBytes);
    if (clipped !== null) {
      return `${clipped}\n\n[truncated at ${maxBytes} bytes]`;
    }
    return text;
  } catch (err) {
    return `error: cannot read ${p}: ${(err as Error).message}`;
  }
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
  | { ok: false; reason: string; oversized?: boolean; excluded?: boolean }
> {
  const realPath = options.realPath ?? Deno.realPath;
  let before: Deno.FileInfo;
  try {
    before = await Deno.lstat(abs);
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
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
    return { ok: false, reason: (err as Error).message };
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
    return {
      ok: true,
      canonical,
      bytes: read === bytes.length ? bytes : bytes.subarray(0, read),
    };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
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
    return `error: ${(err as Error).message}`;
  }
  try {
    const target = await containedRealPath(root, abs);
    if (target === null) {
      return `error: path escapes the workspace root: ${p}`;
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
    return `error: cannot list ${p}: ${(err as Error).message}`;
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
    return `error: ${(err as Error).message}`;
  }
  try {
    const rootReal = await Deno.realPath(resolve(root));
    const parentReal = await Deno.realPath(dirname(abs));
    if (!isWithinRoot(rootReal, parentReal)) {
      return `error: path escapes the workspace root: ${p}`;
    }
    // Refuse to write through a symlink at the target path: write_file never
    // follows symlinks. lstat (no-follow) detects a symlink even when it dangles
    // — realPath(abs) fails on a dangling link, so the old "target missing"
    // branch would have let writeTextFile follow it outside the root (CWE-59).
    try {
      const targetInfo = await lstat(abs);
      if (targetInfo.isSymlink) {
        return `error: refusing to write through a symlink: ${p}`;
      }
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) {
        return `error: cannot write ${p}: ${(err as Error).message}`;
      }
      // NotFound — the target does not exist yet; the parent containment governs.
    }
    await Deno.writeTextFile(abs, content);
    // Non-content-derived result: no exact length, which would otherwise persist
    // a payload-size signal into the event log + session replay (CWE-532).
    return `wrote ${p}`;
  } catch (err) {
    return `error: cannot write ${p}: ${(err as Error).message}`;
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
    return `error: ${(err as Error).message}`;
  }
  let text: string;
  try {
    const target = await containedRealPath(root, abs);
    if (target === null) {
      return `error: path escapes the workspace root: ${p}`;
    }
    const info = await Deno.stat(target);
    if (info.isDirectory) {
      return `error: ${p} is a directory`;
    }
    text = await Deno.readTextFile(target);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      return `error: cannot edit ${p}: file not found`;
    }
    return `error: cannot read ${p}: ${(err as Error).message}`;
  }
  const first = text.indexOf(oldString);
  if (first === -1) {
    return `error: oldString not found in ${p}`;
  }
  if (text.indexOf(oldString, first + oldString.length) !== -1) {
    return `error: oldString is not unique in ${p}; add more surrounding context`;
  }
  const updated = text.slice(0, first) + newString +
    text.slice(first + oldString.length);
  const writeResult = await executeWriteFile(root, p, updated, lstat);
  // executeWriteFile returns "wrote <p>" on success or "error: …" on failure.
  return writeResult.startsWith("error:") ? writeResult : `edited ${p}`;
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
//     shape — reports the memory it already spent.
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
//   - A search that hit a ceiling or skipped anything says so, including when
//     it found nothing: "(no matches)" on its own means the whole requested
//     scope was actually examined. Binary files, over-long lines, oversized
//     files, unreadable directories and raced paths are all omissions, and all
//     of them are counted and reported rather than quietly dropped — an
//     incomplete search read as proof of absence is a worse failure than a
//     truncated one.

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

/** Does `ch` fall in a `[...]` class body (leading `!` or `^` negates)? */
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

/** The pattern token starting at `p`: how many chars it spans, and its test. */
function tokenAt(
  pat: string,
  p: number,
): { len: number; test: (ch: string) => boolean } {
  const c = pat[p];
  if (c === "?") return { len: 1, test: () => true };
  if (c === "[") {
    const end = pat.indexOf("]", p + 1);
    if (end !== -1) {
      const body = pat.slice(p + 1, end);
      return { len: end - p + 1, test: (ch) => matchClass(body, ch) };
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
      const tok = tokenAt(pat, p);
      if (tok.test(name[n])) {
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
interface WalkBudget {
  visited: number;
  cap: number;
  depthClipped: boolean;
  unreadableDirs: number;
}

function newWalkBudget(cap: number): WalkBudget {
  return { visited: 0, cap, depthClipped: false, unreadableDirs: 0 };
}

/** Notes describing every way a completed walk fell short of its scope. */
function walkNotes(budget: WalkBudget): string[] {
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
  return notes;
}

/**
 * Yield workspace-relative file paths under `start`, depth-first and sorted for
 * deterministic output. Symlinks are never followed. `budget.visited` counts
 * every entry seen — directories included — so the cap bounds the walk itself
 * and not merely the files it yields.
 */
async function* walkFiles(
  rootReal: string,
  start: string,
  budget: WalkBudget,
  depth = 0,
): AsyncGenerator<string> {
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
    if (entry.isSymlink) continue; // never follow: escape and cycle defense
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
      if (current.isSymlink || !current.isDirectory) continue;
      yield* walkFiles(rootReal, abs, budget, depth + 1);
      continue;
    }
    if (!entry.isFile) continue;
    if (!isWithinRoot(rootReal, abs)) continue;
    yield relative(rootReal, abs);
  }
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
function excludedSegment(rootReal: string, canonical: string): string | null {
  return relative(rootReal, canonical)
    .split("/")
    .find((segment) => SKIP_DIRS.has(segment)) ?? null;
}

async function searchRoot(
  root: string,
  sub: string,
): Promise<{ rootReal: string; startReal: string } | string> {
  try {
    const abs = resolveWorkspacePath(root, sub);
    const rootReal = await Deno.realPath(resolve(root));
    const contained = await containedRealPath(root, abs);
    if (contained === null) {
      return `error: path escapes the workspace root: ${sub}`;
    }
    const excluded = excludedSegment(rootReal, contained);
    if (excluded !== null) {
      return `error: ${excluded} is excluded from search`;
    }
    return { rootReal, startReal: contained };
  } catch (err) {
    return `error: cannot search ${sub}: ${(err as Error).message}`;
  }
}

// ── Executors ────────────────────────────────────────────────────────────────

const encoder = new TextEncoder();

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
    // Test-only seams. `buildGrepFilesCommand` sets neither, so nothing the
    // model sends can reach them — and that must stay true: an overridden
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
    return `error: invalid pattern: ${(err as Error).message}`;
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
  const sub = options.path === undefined ? "." : options.path;

  const start = await searchRoot(root, sub);
  if (typeof start === "string") {
    matcher.close();
    return start;
  }
  const { rootReal, startReal } = start;

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

  try {
    walk:
    for await (const rel of walkFiles(rootReal, startReal, budget)) {
      if (globBudgetExhausted(globBudget)) break;
      if (
        options.include !== undefined &&
        !matchesGlobPath(rel, options.include, globBudget)
      ) {
        continue;
      }
      const abs = resolve(rootReal, rel);
      // Identity-verified read: the size is checked before any content is
      // loaded, and a pathname repointed since the walk saw it is refused.
      const read = await readContainedFile(abs, maxBytes, rootReal, {
        realPath: options.realPath,
        enforceExclusions: true,
      });
      if (!read.ok) {
        if (read.oversized === true) skippedLarge++;
        else if (read.excluded === true) excludedRaced++;
        else skippedUnreadable++;
        continue;
      }
      if (looksBinary(read.bytes)) {
        skippedBinary++;
        continue;
      }
      const lines = new TextDecoder("utf-8", { fatal: false })
        .decode(read.bytes)
        .split("\n");

      // Over-long lines never reach the matcher: line-by-line matching narrows
      // the input but does not bound backtracking on any one line.
      const candidates: string[] = [];
      const sourceIndex: number[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].length > MAX_LINE_LENGTH) {
          skippedLongLines++;
          continue;
        }
        candidates.push(lines[i]);
        sourceIndex.push(i);
      }

      let hits: number[];
      try {
        hits = await matcher.matchLines(candidates);
      } catch (err) {
        if (err instanceof RegexBudgetExceeded) {
          budgetExhausted = true;
          break;
        }
        if (err instanceof RegexUnavailable) {
          return `error: ${(err as Error).message}`;
        }
        return `error: cannot match pattern: ${(err as Error).message}`;
      }

      for (const hit of hits) {
        if (rows.length >= maxMatches) {
          truncated = true;
          break walk;
        }
        const i = sourceIndex[hit];
        const row = `${rel}:${i + 1}:${lines[i].trimEnd()}`;
        const rowBytes = encoder.encode(row).byteLength + 1;
        if (resultBytes + rowBytes > HARD_MAX_RESULT_BYTES) {
          byteCapped = true;
          break walk;
        }
        resultBytes += rowBytes;
        rows.push(row);
      }
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
  if (globBudgetExhausted(globBudget)) {
    notes.push(`include-glob matching budget exhausted`);
  }
  if (excludedRaced > 0) {
    notes.push(`${excludedRaced} path(s) resolved into an excluded directory`);
  }
  if (skippedLongLines > 0) {
    notes.push(`${skippedLongLines} line(s) over ${MAX_LINE_LENGTH} chars`);
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
  const { rootReal, startReal } = start;

  const hits: string[] = [];
  const budget = newWalkBudget(maxEntries);
  const globBudget = newGlobBudget();
  let resultBytes = 0;
  let truncated = false;
  let byteCapped = false;
  let escaped = 0;
  let excludedRaced = 0;
  const realPath = options.realPath ?? Deno.realPath;
  for await (const rel of walkFiles(rootReal, startReal, budget)) {
    if (globBudgetExhausted(globBudget)) break;
    if (!matchesGlobPath(rel, pattern, globBudget)) continue;
    // glob_files returns names without opening anything, so it gets the same
    // ancestor-replacement check by canonicalizing before it emits: a path
    // that resolves outside the root is a name the model should never see.
    try {
      const canonical = await realPath(resolve(rootReal, rel));
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
    const relBytes = encoder.encode(rel).byteLength + 1;
    if (resultBytes + relBytes > HARD_MAX_RESULT_BYTES) {
      byteCapped = true;
      break;
    }
    resultBytes += relBytes;
    hits.push(rel);
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
