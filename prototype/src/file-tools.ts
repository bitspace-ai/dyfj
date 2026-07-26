/**
 * Workspace file tools for the agent loop, scoped to a workspace root.
 *
 * `read_file` and `list_files` are read-only and side-effect-free (the policy
 * auto-allows them). `write_file` is mutating — the command policy routes it
 * through operator approval, so its executor never runs unapproved.
 * Every path is resolved within the root and traversal/symlink escape is
 * rejected, so the model can only touch the project it's working in. `edit_file`
 * applies a single exact-string replacement (also mutating); `bash` is a later slice.
 *
 * Executors never throw on operator/model error (bad path, missing file,
 * traversal attempt): they return an `error: …` string so the model sees the
 * failure as a tool result and can recover, rather than crashing the turn.
 */

import { dirname, relative, resolve } from "node:path";

const DEFAULT_MAX_BYTES = 64 * 1024;
const DEFAULT_MAX_ENTRIES = 500;

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
// Safety properties, all deliberate:
//   - The walk NEVER follows symlinked directories, so it cannot leave the root
//     and cannot cycle. Regular files are still containment-checked.
//   - Dot-directories (.git, .jj) and node_modules are skipped by default: they
//     are large, uninteresting, and .git holds packed objects that look binary.
//   - Every traversal is bounded — files visited, matches returned, bytes read
//     per file — so a broad pattern degrades to a truncated answer, not a hang.
//   - grep matches LINE BY LINE. Besides being the useful output shape, it
//     bounds regex backtracking to line length: a model-supplied pattern cannot
//     turn a large file into a catastrophic-backtracking hang.


/**
 * Convert a glob to an anchored RegExp. Supports `**` (crosses `/`), `*` and
 * `?` (do not cross `/`), and `[...]` classes.
 *
 * Hand-rolled on purpose: `node:path`'s `matchesGlob` pulls in minimatch, which
 * reads `process.env.__MINIMATCH_TESTING_PLATFORM__` and therefore needs
 * `--allow-env`. The runtime profiles (`serve-unix`, `workbench`) grant env by
 * explicit allowlist, so that dependency would throw NotCapable on first real
 * use — while passing tests, because the `test` profile grants `env=true`.
 * Exported so the matching itself is directly testable without any permission.
 */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` should also match zero directories, so `**/*.ts` finds root files.
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (c === "?") { out += "[^/]"; continue; }
    if (c === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end !== -1) { out += glob.slice(i, end + 1); i = end; continue; }
      out += "\\["; continue;
    }
    out += c.replace(/[\\^$.+()|{}]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/** True when a workspace-relative path matches the glob. */
export function matchesGlobPath(path: string, glob: string): boolean {
  try {
    return globToRegExp(glob).test(path);
  } catch {
    return false;
  }
}

const DEFAULT_MAX_FILES_SCANNED = 2000;
const DEFAULT_MAX_MATCHES = 200;
const SKIP_DIRS = new Set(["node_modules", ".git", ".jj", ".hg", ".svn"]);

/** True when the buffer looks binary (NUL byte in the first 8KB). */
function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8192);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

/**
 * Yield workspace-relative file paths under `start`, depth-first and sorted for
 * deterministic output. Symlinked directories are not traversed; symlinked
 * files are yielded only when their real target stays inside the root.
 */
async function* walkFiles(
  rootReal: string,
  start: string,
  budget: { visited: number; cap: number },
): AsyncGenerator<string> {
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
    const abs = resolve(start, entry.name);
    if (entry.isSymlink) continue; // never follow: escape and cycle defense
    if (entry.isDirectory) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walkFiles(rootReal, abs, budget);
      continue;
    }
    if (!entry.isFile) continue;
    if (!isWithinRoot(rootReal, abs)) continue;
    budget.visited++;
    yield relative(rootReal, abs);
  }
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
  } = {},
): Promise<string> {
  if (pattern === "") return "error: pattern must be non-empty";
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch (err) {
    return `error: invalid pattern: ${(err as Error).message}`;
  }

  const maxMatches = options.maxMatches ?? DEFAULT_MAX_MATCHES;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES_SCANNED;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const sub = options.path === undefined ? "." : options.path;

  let rootReal: string;
  let startReal: string;
  try {
    const abs = resolveWorkspacePath(root, sub);
    rootReal = await Deno.realPath(resolve(root));
    const contained = await containedRealPath(root, abs);
    if (contained === null) {
      return `error: path escapes the workspace root: ${sub}`;
    }
    startReal = contained;
  } catch (err) {
    return `error: cannot search ${sub}: ${(err as Error).message}`;
  }

  const rows: string[] = [];
  const budget = { visited: 0, cap: maxFiles };
  let truncated = false;
  for await (const rel of walkFiles(rootReal, startReal, budget)) {
    if (options.include !== undefined && !matchesGlobPath(rel, options.include)) {
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = await Deno.readFile(resolve(rootReal, rel));
    } catch {
      continue;
    }
    if (bytes.length > maxBytes || looksBinary(bytes)) continue;
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      // Per-line match: bounds regex backtracking to one line's length.
      if (!re.test(lines[i])) continue;
      if (rows.length >= maxMatches) {
        truncated = true;
        break;
      }
      rows.push(`${rel}:${i + 1}:${lines[i].trimEnd()}`);
    }
    if (truncated) break;
  }

  if (rows.length === 0) return "(no matches)";
  const notes: string[] = [];
  if (truncated) notes.push(`match limit ${maxMatches} reached`);
  if (budget.visited >= budget.cap) notes.push(`file limit ${budget.cap} reached`);
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
  const maxResults = options.maxResults ?? DEFAULT_MAX_ENTRIES;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES_SCANNED;
  const sub = options.path === undefined ? "." : options.path;

  let rootReal: string;
  let startReal: string;
  try {
    const abs = resolveWorkspacePath(root, sub);
    rootReal = await Deno.realPath(resolve(root));
    const contained = await containedRealPath(root, abs);
    if (contained === null) {
      return `error: path escapes the workspace root: ${sub}`;
    }
    startReal = contained;
  } catch (err) {
    return `error: cannot search ${sub}: ${(err as Error).message}`;
  }

  const hits: string[] = [];
  const budget = { visited: 0, cap: maxFiles };
  let truncated = false;
  for await (const rel of walkFiles(rootReal, startReal, budget)) {
    if (!matchesGlobPath(rel, pattern)) continue;
    if (hits.length >= maxResults) {
      truncated = true;
      break;
    }
    hits.push(rel);
  }
  if (hits.length === 0) return "(no matches)";
  return truncated ? `${hits.join("\n")}\n[result limit ${maxResults} reached]` : hits.join("\n");
}
