/**
 * Change-scope classification for the aggregate gate: does the bound release
 * range change Markdown files only?
 *
 * The gate asks this on a pull request, so it can run only the policy lanes
 * for a documentation-only change (see `DOCS_ONLY_LANE_LABELS` in
 * `aggregate-test-gate.ts`). The answer is `markdown-only` only when the
 * range is the authoritative CI binding and every path it changes, deletions
 * included, ends in `.md`. Anything else is `other`, which keeps the full
 * gate: a local (non-authoritative) range, an empty range, or any other path.
 *
 * Rename detection is off, so a file renamed to a `.md` name still shows its
 * old path and keeps the full gate.
 *
 * Output is one code-authored word on stdout. An error exits nonzero, and the
 * gate treats that, like any other answer, as `other`.
 */

import { type EnvReader, resolveReleaseRange } from "./release-range.ts";
import { gitStdout, repoRootFromMeta } from "./scan-lib.ts";

const LABEL = "change scope";

export type ChangeScope = "markdown-only" | "other";

export function isMarkdownPath(path: string): boolean {
  return /\.md$/i.test(path);
}

export function classifyChangedPaths(paths: readonly string[]): ChangeScope {
  return paths.length > 0 && paths.every(isMarkdownPath)
    ? "markdown-only"
    : "other";
}

export async function changeScope(
  root: string,
  env: EnvReader,
  gitCommand = "git",
): Promise<ChangeScope> {
  const range = await resolveReleaseRange(root, env, gitCommand);
  if (!range.authoritative) return "other";
  const stdout = await gitStdout(
    root,
    ["diff", "-z", "--name-only", "--no-renames", ...range.diffArgs],
    LABEL,
    gitCommand,
  );
  const paths = new TextDecoder().decode(stdout).split("\0").filter(Boolean);
  return classifyChangedPaths(paths);
}

if (import.meta.main) {
  try {
    console.log(
      await changeScope(repoRootFromMeta(), (name) => Deno.env.get(name)),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
}
