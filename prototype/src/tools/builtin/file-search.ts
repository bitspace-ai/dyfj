/**
 * `grep_files` and `glob_files` executors: auto-approved, read-only search
 * over the workspace, with the traversal and ceilings that bound it.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  BoundedMatcher,
  RegexBudgetExceeded,
  RegexUnavailable,
} from "../../kernel/mod.ts";
import type { WorkspaceRoot } from "./root-anchors.ts";
import {
  containedRealPath,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_ENTRIES,
  excludedSegment,
  HARD_MAX_FILE_BYTES,
  isWithinRoot,
  readContainedFile,
  resolveWorkspacePath,
  rootStillAnchored,
  safeErrorReason,
  sanitizeOutputPathField,
  sanitizeOutputText,
  SKIP_DIRS,
} from "./file-access.ts";
import {
  type GlobBudget,
  globBudgetExhausted,
  globPatternError,
  matchesGlobPath,
  newGlobBudget,
} from "./file-glob.ts";

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
//     (kernel/bounded-regex.ts). Matching line by line does NOT bound backtracking —
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
  workspace: WorkspaceRoot,
  sub: string,
): Promise<
  { rootReal: string; startReal: string; startSegments: string[] } | string
> {
  const root = workspace.path;
  // Checked before resolveWorkspacePath so the catch below — which echoes
  // `sub` for ordinary failures — never gets the chance to echo an absolute
  // path into the result and transcript.
  if (isAbsolute(sub)) {
    return "error: path must be relative to the workspace root";
  }
  try {
    const abs = resolveWorkspacePath(root, sub);
    const rootReal = await workspace.verify();
    const contained = await containedRealPath(workspace, abs);
    if (contained === null) {
      return `error: path escapes the workspace root: ${
        sanitizeOutputText(sub)
      }`;
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
    return `error: cannot search ${sanitizeOutputText(sub)}: ${
      safeErrorReason(err)
    }`;
  }
}

// ── Executors ────────────────────────────────────────────────────────────────

const encoder = new TextEncoder();

/** What one grep call declined or cut short; see `grepNotes`. */
interface GrepTally {
  truncated: boolean;
  byteCapped: boolean;
  budgetExhausted: boolean;
  readBudgetExhausted: boolean;
  skippedLarge: number;
  skippedUnreadable: number;
  skippedBinary: number;
  changedDuringRead: number;
  excludedRaced: number;
  skippedLongLines: number;
  lineCappedFiles: number;
}

function newGrepTally(): GrepTally {
  return {
    truncated: false,
    byteCapped: false,
    budgetExhausted: false,
    readBudgetExhausted: false,
    skippedLarge: 0,
    skippedUnreadable: 0,
    skippedBinary: 0,
    changedDuringRead: 0,
    excludedRaced: 0,
    skippedLongLines: 0,
    lineCappedFiles: 0,
  };
}

/**
 * Completeness notes for one grep call. Every ceiling and skip is reported
 * even when nothing matched: a bare "(no matches)" has to mean the requested
 * scope was fully examined, or the model will read an incomplete search as a
 * definitive answer.
 */
function grepNotes(
  t: GrepTally,
  walk: WalkBudget,
  globBudget: GlobBudget,
  limits: { maxMatches: number; maxTotalReadBytes: number },
): string[] {
  const notes: string[] = [];
  if (t.truncated) notes.push(`match limit ${limits.maxMatches} reached`);
  if (t.byteCapped) notes.push(`result size limit reached`);
  if (t.budgetExhausted) notes.push(`pattern matching budget exhausted`);
  notes.push(...walkNotes(walk));
  if (t.skippedLarge > 0) {
    notes.push(`${t.skippedLarge} file(s) over the size cap`);
  }
  if (t.skippedUnreadable > 0) {
    notes.push(
      `${t.skippedUnreadable} file(s) unreadable or changed mid-search`,
    );
  }
  if (t.skippedBinary > 0) {
    notes.push(`${t.skippedBinary} binary file(s) skipped`);
  }
  if (t.changedDuringRead > 0) {
    notes.push(`${t.changedDuringRead} file(s) changed while being read`);
  }
  if (t.readBudgetExhausted) {
    notes.push(`total read budget ${limits.maxTotalReadBytes} bytes reached`);
  }
  if (globBudgetExhausted(globBudget)) {
    notes.push(`include-glob matching budget exhausted`);
  }
  if (t.excludedRaced > 0) {
    notes.push(
      `${t.excludedRaced} path(s) resolved into an excluded directory`,
    );
  }
  if (t.skippedLongLines > 0) {
    notes.push(`${t.skippedLongLines} line(s) over ${MAX_LINE_LENGTH} chars`);
  }
  if (t.lineCappedFiles > 0) {
    notes.push(
      `${t.lineCappedFiles} file(s) truncated at ${HARD_MAX_LINES_PER_FILE} lines`,
    );
  }
  return notes;
}

/**
 * Search file contents for `pattern` (a JavaScript regular expression), scoped
 * to the workspace root. Returns `path:line:text` rows.
 */
export async function executeGrepFiles(
  workspace: WorkspaceRoot,
  pattern: string,
  options: {
    path?: string;
    include?: string;
    maxMatches?: number;
    maxFiles?: number;
    maxBytes?: number;
    budgetMs?: number;
    maxTotalReadBytes?: number;
    // Test-only seams. `defineGrepFiles` sets none of these, so nothing
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
  // The total-read ceiling is not model-reachable: defineGrepFiles never
  // maps it, so the option exists only so tests can exercise the cutoff
  // without writing 64 MiB of fixtures.
  const maxTotalReadBytes = clampLimit(
    options.maxTotalReadBytes,
    HARD_MAX_TOTAL_READ_BYTES,
    HARD_MAX_TOTAL_READ_BYTES,
  );
  const sub = options.path === undefined ? "." : options.path;

  const start = await searchRoot(workspace, sub);
  if (typeof start === "string") {
    matcher.close();
    return start;
  }
  const { rootReal, startReal, startSegments } = start;

  const rows: string[] = [];
  const budget = newWalkBudget(maxEntries);
  const globBudget = newGlobBudget();
  let resultBytes = 0;
  const skips = newGrepTally();
  let totalReadBytes = 0;
  let matcherError: string | null = null;

  try {
    walk:
    for await (
      const entry of walkFiles(rootReal, startReal, budget, 0, startSegments)
    ) {
      const { abs, rel } = entry;
      if (globBudgetExhausted(globBudget)) break;
      if (totalReadBytes >= maxTotalReadBytes) {
        skips.readBudgetExhausted = true;
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
        if (read.oversized === true) skips.skippedLarge++;
        else if (read.excluded === true) skips.excludedRaced++;
        else if (read.changed === true) skips.changedDuringRead++;
        else skips.skippedUnreadable++;
        continue;
      }
      totalReadBytes += read.bytes.byteLength;
      if (looksBinary(read.bytes)) {
        skips.skippedBinary++;
        continue;
      }
      const text = new TextDecoder("utf-8", { fatal: false }).decode(
        read.bytes,
      );

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
          skips.skippedLongLines += tally.longLines;
          if (tally.lineCapped) skips.lineCappedFiles++;
          if (err instanceof RegexBudgetExceeded) {
            skips.budgetExhausted = true;
            break walk;
          }
          // Break to the single exit funnel rather than returning here, so
          // the root re-verification governs this path like every other one.
          matcherError = err instanceof RegexUnavailable
            ? `error: ${(err as Error).message}`
            : `error: cannot match pattern: ${safeErrorReason(err)}`;
          break walk;
        }
        for (const hit of hits) {
          if (rows.length >= maxMatches) {
            skips.truncated = true;
            skips.skippedLongLines += tally.longLines;
            if (tally.lineCapped) skips.lineCappedFiles++;
            break walk;
          }
          const row = `${sanitizeOutputPathField(rel)}:${chunk.numbers[hit]}:${
            sanitizeOutputText(chunk.lines[hit].trimEnd())
          }`;
          const rowBytes = encoder.encode(row).byteLength + 1;
          if (resultBytes + rowBytes > HARD_MAX_RESULT_BYTES) {
            skips.byteCapped = true;
            skips.skippedLongLines += tally.longLines;
            if (tally.lineCapped) skips.lineCappedFiles++;
            break walk;
          }
          resultBytes += rowBytes;
          rows.push(row);
        }
      }
      skips.skippedLongLines += tally.longLines;
      if (tally.lineCapped) skips.lineCappedFiles++;
    }
  } finally {
    matcher.close();
  }

  const rootLost = await rootStillAnchored(workspace);
  if (rootLost !== null) return rootLost;
  if (matcherError !== null) return matcherError;
  if (rows.length === 0 && skips.budgetExhausted) {
    return `error: pattern is too expensive to run (matching budget exhausted); simplify it`;
  }
  const notes = grepNotes(skips, budget, globBudget, {
    maxMatches,
    maxTotalReadBytes,
  });
  const body = rows.length === 0 ? "(no matches)" : rows.join("\n");
  return notes.length === 0 ? body : `${body}\n[${notes.join("; ")}]`;
}

/** Find workspace-relative file paths matching a glob pattern. */
export async function executeGlobFiles(
  workspace: WorkspaceRoot,
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

  const start = await searchRoot(workspace, sub);
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
  const rootLost = await rootStillAnchored(workspace);
  if (rootLost !== null) return rootLost;
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
