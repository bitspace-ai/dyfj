/**
 * Shared helpers for repository scan lanes.
 *
 * Every scan that reads repository files — tracked, or untracked and not
 * ignored — treats them as untrusted
 * pre-publication input: a matching line can carry a credential, private
 * text, terminal-control bytes, or an arbitrarily large payload, and none of
 * that belongs in terminal or CI output. These helpers keep that posture in
 * one place — sanitized bounded paths, capped collection and reporting, and
 * code-authored error messages that never relay a platform exception or git
 * stderr.
 */

import { fileURLToPath } from "node:url";

export function posixPath(path: string): string {
  return path.replaceAll("\\", "/");
}

export function repoRootFromMeta(): string {
  return fileURLToPath(new URL("..", import.meta.url));
}

// Strip characters that can manipulate terminal or CI output — C0 and C1
// controls (both escape introducers), DEL, and the Unicode direction
// controls that can visually reorder a rendered line — then bound length so
// the log cannot flood. Filters by code point rather than a literal
// containing control characters.
function isLogUnsafe(code: number): boolean {
  if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  if (code === 0x061c || code === 0x200e || code === 0x200f) return true;
  if (code >= 0x202a && code <= 0x202e) return true;
  if (code >= 0x2066 && code <= 0x2069) return true;
  return false;
}

export function sanitizeForLog(raw: string, maxChars: number): string {
  let out = "";
  for (const ch of raw) {
    if (isLogUnsafe(ch.codePointAt(0) ?? 0)) continue;
    out += ch;
    if (out.length >= maxChars) return `${out}…`;
  }
  return out;
}

// Runs git with piped output and code-authored failure handling. A spawn
// failure (git missing, not executable, not permitted) never relays the raw
// platform exception. Callers that tolerate nonzero exits (for example
// `git diff --check`, which exits 2 on findings) inspect the returned output;
// stderr is captured so it can never reach the terminal, and it is never
// relayed into a diagnostic. `gitCommand` exists so tests can prove the
// unavailable-tool path without uninstalling git.
export async function gitOutput(
  root: string,
  args: readonly string[],
  scanLabel: string,
  gitCommand = "git",
): Promise<Deno.CommandOutput> {
  try {
    return await new Deno.Command(gitCommand, {
      args: ["-C", root, ...args],
      stdout: "piped",
      stderr: "piped",
    }).output();
  } catch {
    throw new Error(
      `${scanLabel}: cannot run git (is it installed and executable?)`,
    );
  }
}

// Like `gitOutput`, but a nonzero exit is itself a failure. The diagnostic
// carries the git subcommand name and exit code only: git stderr is not
// relayed at all, so a failure message that happens to carry sensitive
// content never reaches the log. Re-run the command by hand to see why it
// failed.
export async function gitStdout(
  root: string,
  args: readonly string[],
  scanLabel: string,
  gitCommand = "git",
): Promise<Uint8Array> {
  const result = await gitOutput(root, args, scanLabel, gitCommand);
  if (!result.success) {
    throw new Error(
      `${scanLabel}: git ${args[0] ?? ""} failed (exit ${result.code})`,
    );
  }
  return result.stdout;
}

export async function trackedFiles(
  root: string,
  scanLabel: string,
): Promise<string[]> {
  const stdout = await gitStdout(root, ["ls-files", "-z"], scanLabel);
  return new TextDecoder().decode(stdout).split("\0").filter(Boolean);
}

// A local working tree carries files git has not recorded yet. Those are
// invisible to `ls-files` and to `git diff`, so a secret-shaped value sitting
// in a new, not-yet-added file passes every range and tree lane silently.
// Local feedback therefore enumerates them separately; CI never does, because
// there the subject is an immutable commit and `subject.resolve` already fails
// closed on any working-tree modification (see `subject-check.ts`).
//
// `--exclude-standard` keeps ignored files out: an ignored path is
// deliberately outside the publication surface and must stay excluded.
export const MAX_UNTRACKED_FILES = 2000;

// Untracked trees hold build output and other large artifacts that no
// tracked-file bound has ever had to cover, so each file is read up to a
// fixed prefix. A credential shape sits in a file's leading text in every
// realistic case, and the bound keeps a single huge artifact from exhausting
// memory during local feedback.
export const MAX_UNTRACKED_FILE_BYTES = 1_000_000;

export interface UntrackedInventory {
  paths: string[];
  // True when the tree held more untracked files than the bound admits, so
  // the caller can say the inventory was capped rather than imply coverage.
  truncated: boolean;
}

// Bounded local scanning is fail-closed by construction.
//
// The two bounds above keep a hostile or merely large working tree from
// exhausting memory, but a bound that actually bites leaves repository content
// unread. Reporting a clean pass then would assert something the scan never
// checked — the classic fail-open. So every bound that bites records a gap
// here, and every caller turns any recorded gap into a failing verdict rather
// than a warning printed beside a clean exit.
//
// Gaps are only ever produced by local untracked scanning. CI scans the
// tracked subject, which carries no such bound: there the inventory is
// `ls-files` exactly, files are read whole, and coverage is complete.
export interface CoverageGaps {
  // The untracked inventory stopped at `MAX_UNTRACKED_FILES`, so an unknown
  // number of untracked files were never opened.
  inventoryBound: boolean;
  // Repo-relative paths read only as far as `MAX_UNTRACKED_FILE_BYTES`. The
  // list is itself bounded so a tree full of large artifacts cannot flood the
  // log or the ledger.
  truncatedPaths: string[];
  // Oversized files beyond the ones the list names.
  unlistedTruncated: number;
}

export const MAX_REPORTED_COVERAGE_GAPS = 20;

export function emptyCoverage(): CoverageGaps {
  return { inventoryBound: false, truncatedPaths: [], unlistedTruncated: 0 };
}

export function recordTruncatedRead(gaps: CoverageGaps, path: string): void {
  if (gaps.truncatedPaths.length >= MAX_REPORTED_COVERAGE_GAPS) {
    gaps.unlistedTruncated++;
    return;
  }
  gaps.truncatedPaths.push(posixPath(path));
}

export function coverageIsComplete(gaps: CoverageGaps): boolean {
  return !gaps.inventoryBound && gaps.truncatedPaths.length === 0 &&
    gaps.unlistedTruncated === 0;
}

// Value-free like every other diagnostic here: a gap line names the bound that
// bit and, for a per-file bound, the sanitized bounded repo-relative path —
// never a byte of the content that went unread. The inventory line stays
// count-free and path-free because the enumeration stopped before those
// entries were ever collected.
export function formatCoverageGaps(gaps: CoverageGaps): string {
  const lines: string[] = [];
  if (gaps.inventoryBound) {
    lines.push(
      "untracked inventory reached its file-count bound; some untracked " +
        "files were never scanned",
    );
  }
  for (const path of gaps.truncatedPaths) {
    lines.push(
      `${sanitizeForLog(path, 300)}: read only its leading bytes; the rest ` +
        "of this untracked file was never scanned",
    );
  }
  if (gaps.unlistedTruncated > 0) {
    lines.push(
      `… and ${gaps.unlistedTruncated} more partially read untracked files ` +
        "not shown",
    );
  }
  return lines.join("\n");
}

export async function untrackedFiles(
  root: string,
  scanLabel: string,
  gitCommand = "git",
): Promise<UntrackedInventory> {
  const stdout = await gitStdout(
    root,
    ["ls-files", "-z", "--others", "--exclude-standard"],
    scanLabel,
    gitCommand,
  );
  const paths: string[] = [];
  let truncated = false;
  for (const raw of new TextDecoder().decode(stdout).split("\0")) {
    if (!raw) continue;
    // A trailing slash is git's way of naming a directory it will not walk
    // into — a nested repository. Its contents belong to that repository's
    // own scans, and the entry is not a readable file here.
    if (raw.endsWith("/")) continue;
    // Defence in depth: an inventory entry must stay inside the tree. git
    // does not emit absolute or parent-escaping paths from the repository
    // root, and a scan must not read one if it ever did.
    if (raw.startsWith("/") || posixPath(raw).split("/").includes("..")) {
      continue;
    }
    if (paths.length >= MAX_UNTRACKED_FILES) {
      truncated = true;
      break;
    }
    paths.push(raw);
  }
  return { paths, truncated };
}

export interface UntrackedRead {
  bytes: Uint8Array;
  // True when the file carried more bytes than `MAX_UNTRACKED_FILE_BYTES`
  // admits, so `bytes` is a prefix and the remainder was never scanned. The
  // caller must record this as a coverage gap, never discard it.
  truncated: boolean;
}

// The untracked counterpart of `readTrackedFile`, with the same posture: a
// symlink is never followed — the link-target text is scanned instead, so a
// link cannot pull content from outside the repository into a scan — and an
// unreadable path fails closed with a code-authored, value-free message
// carrying only the sanitized repo-relative path. Anything that is neither a
// regular file nor a symlink (a directory, a socket, a device) has no scannable
// content and yields no bytes. Reads stop at `MAX_UNTRACKED_FILE_BYTES`, and
// stopping there is reported rather than silently returned as if it were the
// whole file.
export async function readUntrackedFile(
  root: string,
  path: string,
  scanLabel: string,
): Promise<UntrackedRead> {
  const absolute = `${root}/${path}`;
  try {
    const info = await Deno.lstat(absolute);
    if (info.isSymlink) {
      return {
        bytes: new TextEncoder().encode(await Deno.readLink(absolute)),
        truncated: false,
      };
    }
    if (!info.isFile) return { bytes: new Uint8Array(), truncated: false };
    const cap = Math.min(info.size, MAX_UNTRACKED_FILE_BYTES);
    const buffer = new Uint8Array(cap);
    const file = await Deno.open(absolute, { read: true });
    try {
      let offset = 0;
      while (offset < buffer.length) {
        const read = await file.read(buffer.subarray(offset));
        if (read === null) break;
        offset += read;
      }
      // Whether content remains past the prefix is decided by the file, not by
      // the size the earlier lstat happened to observe: a file that grew in
      // between must still be reported as partially read.
      let truncated = false;
      if (offset === MAX_UNTRACKED_FILE_BYTES) {
        truncated = (await file.read(new Uint8Array(1)) ?? 0) > 0;
      }
      return { bytes: buffer.subarray(0, offset), truncated };
    } finally {
      file.close();
    }
  } catch {
    throw new Error(
      `${scanLabel}: cannot read untracked file ${
        sanitizeForLog(posixPath(path), 300)
      }`,
    );
  }
}

// Collection stops here, not just at formatting: one hit already fails a
// scan, so a pathological tree cannot make a scanner materialize an
// unbounded hit list before the report is capped.
export const MAX_COLLECTED_HITS = 1000;

export const MAX_REPORTED_HITS = 50;

// Fail-closed and value-free: an unreadable tracked path (permissions,
// concurrent removal) fails the scan with a code-authored message carrying
// only the sanitized repo-relative path. The raw exception is never relayed
// — its message embeds the unsanitized filesystem path. A symlink is never
// followed: git tracks a symlink as a blob whose content is the link-target
// text, so those are the exact bytes a scan must see, and following the
// link could read outside the repository.
export async function readTrackedFile(
  root: string,
  path: string,
  scanLabel: string,
): Promise<Uint8Array> {
  const absolute = `${root}/${path}`;
  try {
    const info = await Deno.lstat(absolute);
    if (info.isSymlink) {
      return new TextEncoder().encode(await Deno.readLink(absolute));
    }
    return await Deno.readFile(absolute);
  } catch {
    throw new Error(
      `${scanLabel}: cannot read tracked file ${
        sanitizeForLog(posixPath(path), 300)
      }`,
    );
  }
}
