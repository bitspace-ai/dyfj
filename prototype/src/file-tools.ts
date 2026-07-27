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
 * `maxBytes` caps the text handed back to the model. It does NOT cap the read
 * itself: the whole file is decoded before a window is sliced out of it. The
 * memory bound is the separate `stat` check against HARD_MAX_FILE_BYTES below,
 * which the model cannot raise.
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
    if (info.size > HARD_MAX_FILE_BYTES) {
      return `error: ${p} is ${info.size} bytes, over the ${HARD_MAX_FILE_BYTES}-byte read limit`;
    }
    const full = await Deno.readTextFile(target);
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
    if (text.length > maxBytes) {
      return `${
        text.slice(0, maxBytes)
      }\n\n[truncated at ${maxBytes} characters]`;
    }
    return text;
  } catch (err) {
    return `error: cannot read ${p}: ${(err as Error).message}`;
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
// approval (the no-exec invariant), so a missing search tool showed up as
// approval fatigue rather than as a missing feature: read-heavy turns were
// running ~8 approvals, overwhelmingly read-only sed/grep/cat.
//
// Both tools are AUTO-APPROVED, so every limit here has to hold against
// arguments the model chose — including a model steered by workspace file
// content it just read. What is actually enforced, and what is not:
//
//   - The walk never follows symlinks, so it cannot leave the root and cannot
//     cycle. .git/.jj/node_modules are skipped by name: large, uninteresting,
//     and .git holds packed objects that read as binary.
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
//     closed rather than matching on the main thread.
//   - Glob matching does not go through RegExp at all: `matchesGlobPath` is a
//     segment-wise wildcard matcher using the standard star-backtrack trick,
//     worst-case quadratic over inputs that are themselves length-capped.
//
// Not defended here: a regular file swapped for a symlink between enumeration
// and read. The walk rejects symlinks as it sees them, but the later read
// reopens by pathname, so a concurrent replacement wins the race. Single
// operator, single trust domain — recorded rather than fixed.

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
function matchSegment(name: string, pat: string): boolean {
  let n = 0;
  let p = 0;
  let starN = -1;
  let starP = -1;
  while (n < name.length) {
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
function matchSegments(path: string[], glob: string[]): boolean {
  let n = 0;
  let g = 0;
  let starN = -1;
  let starG = -1;
  while (n < path.length) {
    if (g < glob.length && glob[g] === "**") {
      starG = g;
      starN = n;
      g++;
      continue;
    }
    if (g < glob.length && glob[g] !== "**" && matchSegment(path[n], glob[g])) {
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
export function matchesGlobPath(path: string, glob: string): boolean {
  if (glob.length === 0 || glob.length > MAX_GLOB_LENGTH) return false;
  return matchSegments(path.split("/"), glob.split("/"));
}

// ── Traversal ────────────────────────────────────────────────────────────────

/** True when the buffer looks binary (NUL byte in the first 8KB). */
function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8192);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
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
  budget: { visited: number; cap: number },
  depth = 0,
): AsyncGenerator<string> {
  if (depth > HARD_MAX_DEPTH) return;
  let entries: Deno.DirEntry[];
  try {
    entries = [];
    for await (const e of Deno.readDir(start)) entries.push(e);
  } catch {
    return; // unreadable directory: skip rather than fail the whole search
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (budget.visited >= budget.cap) return;
    budget.visited++;
    const abs = resolve(start, entry.name);
    if (entry.isSymlink) continue; // never follow: escape and cycle defense
    if (entry.isDirectory) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walkFiles(rootReal, abs, budget, depth + 1);
      continue;
    }
    if (!entry.isFile) continue;
    if (!isWithinRoot(rootReal, abs)) continue;
    yield relative(rootReal, abs);
  }
}

/** Resolve the search start, or return an `error: …` string. */
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
    workerSpecifier?: string;
  } = {},
): Promise<string> {
  if (pattern === "") return "error: pattern must be non-empty";

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
  const budget = { visited: 0, cap: maxEntries };
  let resultBytes = 0;
  let truncated = false;
  let byteCapped = false;
  let budgetExhausted = false;
  let skippedLarge = 0;
  let skippedLongLines = 0;

  try {
    walk:
    for await (const rel of walkFiles(rootReal, startReal, budget)) {
      if (
        options.include !== undefined &&
        !matchesGlobPath(rel, options.include)
      ) {
        continue;
      }
      const abs = resolve(rootReal, rel);
      // stat before read: this is the memory bound, not the length check that
      // used to sit after readFile.
      let info: Deno.FileInfo;
      try {
        info = await Deno.stat(abs);
      } catch {
        continue;
      }
      if (!info.isFile) continue;
      if (info.size > maxBytes) {
        skippedLarge++;
        continue;
      }
      let bytes: Uint8Array;
      try {
        bytes = await Deno.readFile(abs);
      } catch {
        continue;
      }
      if (looksBinary(bytes)) continue;
      const lines = new TextDecoder("utf-8", { fatal: false })
        .decode(bytes)
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

  if (rows.length === 0) {
    if (budgetExhausted) {
      return `error: pattern is too expensive to run (matching budget exhausted); simplify it`;
    }
    return "(no matches)";
  }
  const notes: string[] = [];
  if (truncated) notes.push(`match limit ${maxMatches} reached`);
  if (byteCapped) notes.push(`result size limit reached`);
  if (budgetExhausted) notes.push(`pattern matching budget exhausted`);
  if (budget.visited >= budget.cap) {
    notes.push(`entry limit ${budget.cap} reached`);
  }
  if (skippedLarge > 0) notes.push(`${skippedLarge} file(s) over the size cap`);
  if (skippedLongLines > 0) {
    notes.push(`${skippedLongLines} line(s) over ${MAX_LINE_LENGTH} chars`);
  }
  return notes.length === 0
    ? rows.join("\n")
    : `${rows.join("\n")}\n[${notes.join("; ")}]`;
}

/** Find workspace-relative file paths matching a glob pattern. */
export async function executeGlobFiles(
  root: string,
  pattern: string,
  options: { path?: string; maxResults?: number; maxFiles?: number } = {},
): Promise<string> {
  if (pattern === "") return "error: pattern must be non-empty";
  if (pattern.length > MAX_GLOB_LENGTH) {
    return `error: pattern is longer than ${MAX_GLOB_LENGTH} characters`;
  }
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
  const budget = { visited: 0, cap: maxEntries };
  let resultBytes = 0;
  let truncated = false;
  let byteCapped = false;
  for await (const rel of walkFiles(rootReal, startReal, budget)) {
    if (!matchesGlobPath(rel, pattern)) continue;
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
  if (hits.length === 0) return "(no matches)";
  const notes: string[] = [];
  if (truncated) notes.push(`result limit ${maxResults} reached`);
  if (byteCapped) notes.push(`result size limit reached`);
  if (budget.visited >= budget.cap) {
    notes.push(`entry limit ${budget.cap} reached`);
  }
  return notes.length === 0
    ? hits.join("\n")
    : `${hits.join("\n")}\n[${notes.join("; ")}]`;
}
