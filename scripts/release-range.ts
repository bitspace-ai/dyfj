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
        authoritative,
        description: `bound range ${base}...HEAD (authoritative CI binding)`,
      };
    }
    return {
      diffArgs: [base],
      authoritative,
      description: `working tree vs ${base} (non-authoritative local feedback)`,
    };
  }
  const mergeBase = await localMergeBase(root, gitCommand);
  if (mergeBase !== undefined) {
    return {
      diffArgs: [mergeBase],
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

// Parses `git diff --unified=0` output for one file into its added lines
// with new-file line numbers. Binary changes produce no hunks and therefore
// no added lines.
export function parseAddedLines(diffText: string): AddedLine[] {
  const added: AddedLine[] = [];
  let next = 0;
  for (const raw of diffText.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      next = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith("+++")) continue;
    if (raw.startsWith("+")) {
      added.push({ line: next, text: raw.slice(1) });
      next++;
    }
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
