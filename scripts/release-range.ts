/**
 * Release-range resolution for range-scoped checks.
 *
 * In CI (`GITHUB_ACTIONS=true`) the workflow binds the release range through
 * `DYFJ_GATE_RANGE_BASE`: the pull-request base commit or the pre-push tip.
 * A missing, zero, non-immutable, or unresolvable base fails closed — a
 * range check that cannot know its range must not pass. The bound range is
 * `<base>...HEAD`, i.e. exactly what the subject introduces relative to the
 * merge base.
 *
 * A local invocation without the binding is explicitly non-authoritative
 * working-tree feedback: it diffs the working tree against the merge base
 * with `main` when one exists, and against `HEAD` otherwise, so uncommitted
 * work is visible locally while CI remains the authoritative enforcement
 * point for the exact bound range.
 *
 * A range is two views of the same subject, and a scan that must not miss
 * content needs both:
 *
 * - `diffArgs` is the net view — one diff of the endpoint trees (plus the
 *   working tree locally). It answers "what does the range leave behind".
 * - `historyArgs` is the history view — every commit the range makes newly
 *   reachable. It answers "what does the range carry", which is the larger
 *   question: content introduced by one commit and removed by a later one
 *   never appears in the net diff, yet it is published in the ancestry all
 *   the same. The history view exists whenever a base commit is known; the
 *   `HEAD` fallback has no commits to walk.
 */

import { gitOutput, gitStdout } from "./scan-lib.ts";

const LABEL = "release range";

export type EnvReader = (name: string) => string | undefined;

const FULL_SHA = /^[0-9a-f]{40}$/;
const ZERO_SHA = /^0{40}$/;

export interface RangeBase {
  base?: string;
  authoritative: boolean;
}

export function resolveRangeBase(env: EnvReader): RangeBase {
  const ci = env("GITHUB_ACTIONS") === "true";
  const base = env("DYFJ_GATE_RANGE_BASE");
  if (base === undefined || base === "") {
    if (ci) {
      throw new Error(
        `${LABEL}: CI run without a bound range base; failing closed`,
      );
    }
    return { authoritative: false };
  }
  if (!FULL_SHA.test(base) || ZERO_SHA.test(base)) {
    // A branch name or zero id is not an immutable range base; it is also
    // never passed into git argv.
    throw new Error(
      `${LABEL}: bound range base is not a full immutable commit id; ` +
        "failing closed",
    );
  }
  return { base, authoritative: ci };
}

export interface ReleaseRange {
  // Revision arguments appended to `git diff`.
  diffArgs: string[];
  // Revision arguments naming the commits the range makes newly reachable,
  // appended to `git rev-list`. Absent when no base commit is known, in which
  // case there is no history to walk and only the net view applies.
  historyArgs?: string[];
  authoritative: boolean;
  description: string;
}

export async function resolveReleaseRange(
  root: string,
  env: EnvReader,
  gitCommand = "git",
): Promise<ReleaseRange> {
  const { base, authoritative } = resolveRangeBase(env);
  if (base !== undefined) {
    // Throws (value-free) when the base commit is absent from the checkout:
    // a range that cannot be resolved must not silently shrink to nothing.
    await gitStdout(
      root,
      ["rev-parse", "--verify", `${base}^{commit}`],
      LABEL,
      gitCommand,
    );
    if (authoritative) {
      return {
        diffArgs: [`${base}...HEAD`],
        historyArgs: [`${base}..HEAD`],
        authoritative,
        description: `bound range ${base}...HEAD (authoritative CI binding)`,
      };
    }
    return {
      diffArgs: [base],
      historyArgs: [`${base}..HEAD`],
      authoritative,
      description: `working tree vs ${base} (non-authoritative local feedback)`,
    };
  }
  const mergeBase = await localMergeBase(root, gitCommand);
  if (mergeBase !== undefined) {
    return {
      diffArgs: [mergeBase],
      historyArgs: [`${mergeBase}..HEAD`],
      authoritative: false,
      description:
        `working tree vs ${mergeBase} (non-authoritative local feedback)`,
    };
  }
  return {
    diffArgs: ["HEAD"],
    authoritative: false,
    description: "working tree vs HEAD (non-authoritative local feedback)",
  };
}

async function localMergeBase(
  root: string,
  gitCommand: string,
): Promise<string | undefined> {
  const result = await gitOutput(
    root,
    ["merge-base", "main", "HEAD"],
    LABEL,
    gitCommand,
  );
  if (!result.success) return undefined;
  const base = new TextDecoder().decode(result.stdout).trim();
  return FULL_SHA.test(base) ? base : undefined;
}

// Changed paths whose current content the caller will read: deletions are
// excluded (`--diff-filter=d`) because a deleted path has no content left to
// scan. Coverage-style callers that must see a deleted path as a mutation
// use `changedFilesIncludingDeleted` instead.
export async function changedFiles(
  root: string,
  range: ReleaseRange,
  gitCommand = "git",
): Promise<string[]> {
  const stdout = await gitStdout(
    root,
    ["diff", "-z", "--name-only", "--diff-filter=d", ...range.diffArgs],
    LABEL,
    gitCommand,
  );
  return new TextDecoder().decode(stdout).split("\0").filter(Boolean);
}

// Every changed path in the range, deletions included. Dependency-surface
// coverage must see a deleted manifest or lockfile as a mutation rather
// than letting the surface disappear from range detection.
export async function changedFilesIncludingDeleted(
  root: string,
  range: ReleaseRange,
  gitCommand = "git",
): Promise<string[]> {
  const stdout = await gitStdout(
    root,
    ["diff", "-z", "--name-only", ...range.diffArgs],
    LABEL,
    gitCommand,
  );
  return new TextDecoder().decode(stdout).split("\0").filter(Boolean);
}

export interface AddedLine {
  line: number;
  text: string;
}

// A unified hunk header (`@@ -a,b +c,d @@`) or a combined one from a merge
// diff (`@@@ -a,b -c,d +e,f @@@`, one pre-image range per parent). The run of
// `@` is one longer than the number of parents, which is exactly the width of
// the marker columns each body line carries.
const HUNK_HEADER =
  /^(@{2,}) -\d+(?:,(\d+))?(?: -\d+(?:,\d+)?)* \+(\d+)(?:,(\d+))? @{2,}/;

const MARKERS = " +-";

interface Hunk {
  // Marker columns per body line: 1 for a two-way diff, one per parent for a
  // combined one.
  width: number;
  // Line number the next post-image line will carry.
  next: number;
  // Body lines still expected. A two-way header states both counts exactly,
  // so the hunk ends where the header says it does. A combined header states
  // one pre-image range per parent and no total, so those hunks end at the
  // first line that is not a marker row instead.
  oldRemaining: number;
  newRemaining: number;
}

function startHunk(header: RegExpExecArray): Hunk {
  const width = (header[1] ?? "@@").length - 1;
  const combined = width > 1;
  return {
    width,
    next: Number(header[3]),
    oldRemaining: combined ? Infinity : Number(header[2] ?? "1"),
    newRemaining: combined ? Infinity : Number(header[4] ?? "1"),
  };
}

function isMarkerRow(markers: string): boolean {
  for (const marker of markers) {
    if (!MARKERS.includes(marker)) return false;
  }
  return true;
}

// Parses `git diff --unified=0` output into its added lines with post-image
// line numbers. Binary changes produce no hunks and therefore no added lines.
//
// Hunk state, not a line prefix, decides what a line is. A file header (`+++
// b/path`) only ever appears outside a hunk, while an added source line whose
// own content starts with `+` is indistinguishable from one by prefix alone —
// dropping every `+++` would silently drop such a line from the scan.
//
// Combined merge output (`git diff-tree -c`) is parsed too: each body line
// carries one marker column per parent, and a line is an addition only when
// every column marks it added — content the merge itself introduced rather
// than content it inherited from a parent that is walked on its own.
export function parseAddedLines(diffText: string): AddedLine[] {
  const added: AddedLine[] = [];
  let hunk: Hunk | undefined;
  for (const raw of diffText.split("\n")) {
    if (hunk !== undefined) {
      // "\ No newline at end of file" annotates the line before it and is
      // itself neither a pre-image nor a post-image line.
      if (raw.startsWith("\\")) continue;
      const markers = raw.slice(0, hunk.width);
      if (markers.length === hunk.width && isMarkerRow(markers)) {
        if (markers.includes("-")) {
          hunk.oldRemaining--;
        } else {
          if (!markers.includes(" ")) {
            added.push({ line: hunk.next, text: raw.slice(hunk.width) });
          }
          hunk.next++;
          hunk.newRemaining--;
          if (markers.includes(" ")) hunk.oldRemaining--;
        }
        if (hunk.oldRemaining <= 0 && hunk.newRemaining <= 0) hunk = undefined;
        continue;
      }
      hunk = undefined;
    }
    const header = HUNK_HEADER.exec(raw);
    if (header) hunk = startHunk(header);
  }
  return added;
}

export async function addedLinesFor(
  root: string,
  range: ReleaseRange,
  path: string,
  gitCommand = "git",
): Promise<AddedLine[]> {
  const stdout = await gitStdout(
    root,
    ["diff", "--unified=0", ...range.diffArgs, "--", path],
    LABEL,
    gitCommand,
  );
  return parseAddedLines(new TextDecoder().decode(stdout));
}

// Walking history is one git invocation per commit and per changed path, so
// an unexpectedly wide range is bounded rather than left to run unbounded.
// The bound fails closed: a range past it is not scanned partially and called
// clean. A publication range is a review's worth of commits, far under this.
export const MAX_RANGE_COMMITS = 1000;

export interface RangeCommit {
  // Full immutable commit id, re-validated before it reaches git argv.
  id: string;
  // A merge is read as a combined diff against all of its parents at once.
  // The commits it merges are walked in their own right, so the only content
  // the merge itself introduces is what no parent had — a conflict
  // resolution, or an edit made while merging.
  isMerge: boolean;
}

// The commits the range makes newly reachable, oldest first. Empty when the
// range has no history view (see `ReleaseRange.historyArgs`).
export async function rangeCommits(
  root: string,
  range: ReleaseRange,
  gitCommand = "git",
  maxCommits = MAX_RANGE_COMMITS,
): Promise<RangeCommit[]> {
  if (range.historyArgs === undefined) return [];
  const stdout = await gitStdout(
    root,
    [
      "rev-list",
      "--reverse",
      "--parents",
      "-n",
      String(maxCommits + 1),
      ...range.historyArgs,
    ],
    LABEL,
    gitCommand,
  );
  const commits: RangeCommit[] = [];
  for (const line of new TextDecoder().decode(stdout).split("\n")) {
    if (line === "") continue;
    // Each line is `<commit> <parent>…`, so a second field means a merge.
    const ids = line.split(" ");
    const id = ids[0] ?? "";
    if (!FULL_SHA.test(id)) {
      throw new Error(
        `${LABEL}: history walk read an unusable commit id; failing closed`,
      );
    }
    commits.push({ id, isMerge: ids.length > 2 });
  }
  if (commits.length > maxCommits) {
    throw new Error(
      `${LABEL}: range spans more than ${maxCommits} commits; failing closed`,
    );
  }
  return commits;
}

// `-c` reads a merge against every parent at once; `--root` lets an initial
// commit be diffed against the empty tree instead of yielding nothing.
function commitDiffArgs(commit: RangeCommit): string[] {
  return commit.isMerge ? ["-c", "--root"] : ["--root"];
}

// Paths one commit changed, deletions excluded: a deletion adds no lines.
export async function changedFilesInCommit(
  root: string,
  commit: RangeCommit,
  gitCommand = "git",
): Promise<string[]> {
  const stdout = await gitStdout(
    root,
    [
      "diff-tree",
      "-z",
      "-r",
      "--no-commit-id",
      "--name-only",
      "--diff-filter=d",
      ...commitDiffArgs(commit),
      commit.id,
    ],
    LABEL,
    gitCommand,
  );
  return new TextDecoder().decode(stdout).split("\0").filter(Boolean);
}

// The lines one commit added to one path, with that commit's line numbers.
export async function addedLinesInCommit(
  root: string,
  commit: RangeCommit,
  path: string,
  gitCommand = "git",
): Promise<AddedLine[]> {
  const stdout = await gitStdout(
    root,
    [
      "diff-tree",
      "-r",
      "-p",
      "--no-commit-id",
      "--unified=0",
      ...commitDiffArgs(commit),
      commit.id,
      "--",
      path,
    ],
    LABEL,
    gitCommand,
  );
  return parseAddedLines(new TextDecoder().decode(stdout));
}
