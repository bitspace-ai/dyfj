/**
 * Release-range checks: `secret.diff`, `diff.whitespace`, `markdown.links`,
 * and `shell.parse`.
 *
 * Each check runs over the resolved release range (see `release-range.ts`):
 * authoritative in CI where the workflow binds the exact base commit,
 * explicitly non-authoritative working-tree feedback locally.
 *
 * - `secret.diff` scans the range's added lines with the public-safe secret
 *   rules from `public-safety-scan.ts`, reported under `secret.diff/*`. It
 *   is separate from the tree scan so a secret introduced by the change is
 *   caught even when later removal within the range would hide it from the
 *   tree scan. No path is skipped — the scanner's own source included. In a
 *   local (non-authoritative) run it additionally scans untracked non-ignored
 *   files, which no `git diff` can see; ignored files stay excluded and
 *   symlinks are never followed. CI keeps the exact bound range instead,
 *   because `subject.resolve` already fails a subject tree carrying
 *   uncommitted or untracked files. That local sweep is bounded, and its
 *   bounds fail closed: an inventory or per-file read that stops at its bound
 *   left content unread, and the check reports that as a failure rather than
 *   a warning printed beside a clean pass.
 * - `diff.whitespace` is `git diff --check` for the exact range, attributed
 *   per changed file. Only git's fixed finding vocabulary and line numbers
 *   are reported — never the offending line.
 * - `markdown.links` validates changed Markdown: repository-relative link
 *   targets must exist and code fences must be balanced. External-link
 *   reachability is deliberately not checked.
 * - `shell.parse` parses every changed shell file (`*.sh`, `*.bash`, or a
 *   shell shebang) with `bash -n`. A changed shell-named symlink fails
 *   closed with a fixed class instead: handing its filesystem path to the
 *   parser would follow the link, possibly outside the repository. Parser
 *   output is discarded; only the file, an optional line number, and a
 *   fixed class are reported. No further static shell advisories are
 *   configured in this toolchain.
 *
 * All failures are fail-closed: an unavailable tool, an unreadable file, an
 * unresolvable range, or coverage a bound cut short is a check failure, never
 * a silent pass. All diagnostics are value-free and bounded (see
 * `scan-lib.ts`).
 */

import {
  type CoverageGaps,
  coverageIsComplete,
  emptyCoverage,
  formatCoverageGaps,
  gitOutput,
  MAX_COLLECTED_HITS,
  posixPath,
  readTrackedFile,
  readUntrackedFile,
  recordTruncatedRead,
  repoRootFromMeta,
  sanitizeForLog,
  untrackedFiles,
} from "./scan-lib.ts";
import {
  addedLinesFor,
  changedFiles,
  type ReleaseRange,
  resolveReleaseRange,
} from "./release-range.ts";
import {
  formatHits,
  type PublicSafetyHit,
  rulesForFamily,
  scanText,
} from "./public-safety-scan.ts";

const LABEL = "range check";

export const RANGE_CHECKS = [
  "secret.diff",
  "diff.whitespace",
  "markdown.links",
  "shell.parse",
] as const;
export type RangeCheck = (typeof RANGE_CHECKS)[number];

export async function secretDiffHits(
  root: string,
  range: ReleaseRange,
  gitCommand = "git",
): Promise<PublicSafetyHit[]> {
  const rules = rulesForFamily("secret.tree");
  const hits: PublicSafetyHit[] = [];
  for (const path of await changedFiles(root, range, gitCommand)) {
    if (hits.length >= MAX_COLLECTED_HITS) break;
    for (const added of await addedLinesFor(root, range, path, gitCommand)) {
      for (const rule of rules) {
        if (rule.matches(added.text)) {
          hits.push({
            path: posixPath(path),
            line: added.line,
            rule: asDiffRuleId(rule.id),
          });
          if (hits.length >= MAX_COLLECTED_HITS) return hits;
        }
      }
    }
  }
  return hits;
}

function asDiffRuleId(ruleId: string): string {
  return ruleId.replace(/^secret\.tree\//, "secret.diff/");
}

export interface UntrackedSecretResult {
  hits: PublicSafetyHit[];
  // What the local bounds left unread (see `scan-lib.ts`). Any gap makes the
  // check fail: partial coverage is never reported as a clean sweep.
  coverage: CoverageGaps;
}

// `git diff` only sees paths git already tracks, so a secret-shaped value in a
// file that has never been added is invisible to every range lane. Every line
// of such a file is content the range would introduce, so the whole file is
// scanned with the same secret rules and reported under the same
// `secret.diff/*` ids.
//
// This is local feedback only — see `runRangeCheck`. It never widens an
// authoritative CI range: there the bound base…HEAD range is the subject, and
// `subject.resolve` fails closed on a working tree carrying untracked files at
// all. Ignored files stay excluded, symlinks are read as their link-target
// text rather than followed, and diagnostics carry only path, line, and rule.
export async function untrackedSecretHits(
  root: string,
  gitCommand = "git",
): Promise<UntrackedSecretResult> {
  const rules = rulesForFamily("secret.tree");
  const coverage = emptyCoverage();
  const { paths, truncated } = await untrackedFiles(root, LABEL, gitCommand);
  coverage.inventoryBound = truncated;
  const hits: PublicSafetyHit[] = [];
  for (const path of paths) {
    const remaining = MAX_COLLECTED_HITS - hits.length;
    if (remaining <= 0) break;
    const read = await readUntrackedFile(root, path, LABEL);
    if (read.truncated) recordTruncatedRead(coverage, path);
    const content = new TextDecoder().decode(read.bytes);
    for (const hit of scanText(path, content, remaining, rules)) {
      hits.push({ ...hit, rule: asDiffRuleId(hit.rule) });
    }
  }
  return { hits, coverage };
}

// git's own `--check` finding vocabulary; nothing outside it is reported.
const WHITESPACE_CLASSES = [
  "trailing whitespace",
  "space before tab in indent",
  "new blank line at EOF",
  "leftover conflict marker",
] as const;

export async function whitespaceHits(
  root: string,
  range: ReleaseRange,
  gitCommand = "git",
): Promise<PublicSafetyHit[]> {
  const hits: PublicSafetyHit[] = [];
  for (const path of await changedFiles(root, range, gitCommand)) {
    if (hits.length >= MAX_COLLECTED_HITS) break;
    const result = await gitOutput(
      root,
      ["diff", "--check", ...range.diffArgs, "--", path],
      LABEL,
      gitCommand,
    );
    if (result.code === 0) continue;
    if (result.code !== 2) {
      throw new Error(
        `${LABEL}: git diff --check failed (exit ${result.code})`,
      );
    }
    // Only line numbers and git's fixed classes leave the captured output;
    // offending content lines (prefixed `+`) are never inspected or echoed.
    const before = hits.length;
    for (const raw of new TextDecoder().decode(result.stdout).split("\n")) {
      if (raw.startsWith("+")) continue;
      const match = /:(\d+): ([a-z A-Z]+)\.?$/.exec(raw);
      if (!match) continue;
      const cls = match[2] ?? "";
      if (!(WHITESPACE_CLASSES as readonly string[]).includes(cls)) continue;
      hits.push({
        path: posixPath(path),
        line: Number(match[1]),
        rule: `diff.whitespace/${cls.replaceAll(" ", "-")}`,
      });
      if (hits.length >= MAX_COLLECTED_HITS) break;
    }
    if (hits.length === before) {
      // Fail closed: git reported problems even if none were parseable.
      hits.push({
        path: posixPath(path),
        line: 0,
        rule: "diff.whitespace/whitespace-error",
      });
    }
  }
  return hits;
}

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

// Resolves a repository-relative link target against the linking file.
// Returns undefined when the target escapes the repository.
export function resolveLinkTarget(
  fromPath: string,
  target: string,
): string | undefined {
  let raw = target;
  try {
    raw = decodeURIComponent(raw);
  } catch {
    // Keep the raw form; an undecodable target is checked literally.
  }
  const withoutFragment = raw.split("#")[0] ?? "";
  if (withoutFragment === "") return "";
  const start = withoutFragment.startsWith("/")
    ? []
    : posixPath(fromPath).split("/").slice(0, -1);
  const segments = [...start];
  for (const segment of withoutFragment.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return undefined;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

interface LineLink {
  line: number;
  target: string;
}

export function markdownLinkTargets(content: string): {
  links: LineLink[];
  unclosedFenceLine?: number;
} {
  const links: LineLink[] = [];
  let fenceOpenLine: number | undefined;
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (/^\s*(```|~~~)/.test(line)) {
      fenceOpenLine = fenceOpenLine === undefined ? index + 1 : undefined;
      continue;
    }
    if (fenceOpenLine !== undefined) continue;
    // Inline code spans are not link syntax.
    const stripped = line.replaceAll(/`[^`]*`/g, "");
    const inline = stripped.matchAll(
      /\]\(\s*<?([^)<>\s]+)>?(?:\s+"[^"]*")?\s*\)/g,
    );
    for (const match of inline) {
      links.push({ line: index + 1, target: match[1] ?? "" });
    }
    const reference = /^\s*\[[^\]]+\]:\s+(\S+)/.exec(stripped);
    if (reference) {
      links.push({ line: index + 1, target: reference[1] ?? "" });
    }
  }
  return { links, unclosedFenceLine: fenceOpenLine };
}

async function pathExists(root: string, relative: string): Promise<boolean> {
  try {
    await Deno.stat(`${root}/${relative}`);
    return true;
  } catch {
    return false;
  }
}

export async function markdownLinkHits(
  root: string,
  range: ReleaseRange,
  gitCommand = "git",
): Promise<PublicSafetyHit[]> {
  const hits: PublicSafetyHit[] = [];
  for (const path of await changedFiles(root, range, gitCommand)) {
    if (!/\.(md|markdown)$/i.test(path)) continue;
    if (hits.length >= MAX_COLLECTED_HITS) break;
    const bytes = await readTrackedFile(root, path, LABEL);
    const { links, unclosedFenceLine } = markdownLinkTargets(
      new TextDecoder().decode(bytes),
    );
    if (unclosedFenceLine !== undefined) {
      hits.push({
        path: posixPath(path),
        line: unclosedFenceLine,
        rule: "markdown.links/unclosed-fence",
      });
    }
    for (const link of links) {
      if (hits.length >= MAX_COLLECTED_HITS) break;
      const target = link.target;
      if (SCHEME.test(target) || target.startsWith("#")) continue;
      if (target.startsWith("//")) continue;
      const resolved = resolveLinkTarget(path, target);
      if (resolved === undefined) {
        hits.push({
          path: posixPath(path),
          line: link.line,
          rule: "markdown.links/escapes-repository",
        });
        continue;
      }
      if (resolved === "") continue;
      if (!(await pathExists(root, resolved))) {
        hits.push({
          path: posixPath(path),
          line: link.line,
          rule: "markdown.links/broken-relative-link",
        });
      }
    }
  }
  return hits;
}

export function looksLikeShell(path: string, firstLine: string): boolean {
  if (/\.(sh|bash)$/.test(path)) return true;
  return /^#!\S*\b(?:env\s+)?(sh|bash|dash|ksh|zsh)\b/.test(firstLine);
}

export async function shellParseHits(
  root: string,
  range: ReleaseRange,
  gitCommand = "git",
  shellCommand = "/bin/bash",
): Promise<PublicSafetyHit[]> {
  const hits: PublicSafetyHit[] = [];
  for (const path of await changedFiles(root, range, gitCommand)) {
    if (hits.length >= MAX_COLLECTED_HITS) break;
    const bytes = await readTrackedFile(root, path, LABEL);
    const firstLine = new TextDecoder()
      .decode(bytes.slice(0, 256)).split("\n")[0] ?? "";
    if (!looksLikeShell(posixPath(path), firstLine)) continue;
    // The checked bytes above are the tracked link-target text for a
    // symlink; the filesystem path would make `bash -n` follow the link,
    // possibly outside the repository. Fail closed with a fixed class and
    // never invoke the parser on it.
    let isLink: boolean;
    try {
      isLink = (await Deno.lstat(`${root}/${path}`)).isSymlink;
    } catch {
      throw new Error(
        `${LABEL}: cannot read tracked file ${
          sanitizeForLog(posixPath(path), 300)
        }`,
      );
    }
    if (isLink) {
      hits.push({
        path: posixPath(path),
        line: 0,
        rule: "shell.parse/symlink-not-parsed",
      });
      continue;
    }
    let result: Deno.CommandOutput;
    try {
      result = await new Deno.Command(shellCommand, {
        args: ["-n", `${root}/${path}`],
        stdout: "piped",
        stderr: "piped",
      }).output();
    } catch {
      // An unavailable parser must fail the check, never skip it. The raw
      // platform exception is not relayed.
      throw new Error(
        `${LABEL}: cannot run the shell parser; failing closed`,
      );
    }
    if (!result.success) {
      // Parser output is discarded except a line number; syntax messages
      // can embed arbitrary file content.
      const lineMatch = /line (\d+):/.exec(
        new TextDecoder().decode(result.stderr),
      );
      hits.push({
        path: posixPath(path),
        line: lineMatch ? Number(lineMatch[1]) : 0,
        rule: "shell.parse/parse-error",
      });
    }
  }
  return hits;
}

export async function runRangeCheck(
  check: RangeCheck,
  root: string,
  env: (name: string) => string | undefined,
  out: Pick<Console, "log" | "error"> = console,
): Promise<number> {
  const range = await resolveReleaseRange(root, env);
  let hits: PublicSafetyHit[];
  // Only local untracked scanning is bounded, so only it can leave a gap; an
  // authoritative CI range reads the exact diff it is bound to.
  let coverage = emptyCoverage();
  switch (check) {
    case "secret.diff": {
      hits = await secretDiffHits(root, range);
      // Local feedback only: an authoritative CI range is exactly what the
      // bound subject introduces, and nothing outside it is in scope there.
      if (!range.authoritative) {
        const untracked = await untrackedSecretHits(root);
        coverage = untracked.coverage;
        for (const hit of untracked.hits) {
          if (hits.length >= MAX_COLLECTED_HITS) break;
          hits.push(hit);
        }
      }
      break;
    }
    case "diff.whitespace":
      hits = await whitespaceHits(root, range);
      break;
    case "markdown.links":
      hits = await markdownLinkHits(root, range);
      break;
    case "shell.parse":
      hits = await shellParseHits(root, range);
      break;
  }
  const scope = sanitizeForLog(range.description, 160);
  const complete = coverageIsComplete(coverage);
  if (hits.length > 0) {
    out.error(`${check}: findings in ${scope}:`);
    out.error(formatHits(hits));
  }
  if (!complete) {
    // A bound that bit left part of the local subject unread. That is a check
    // failure, not a note beside a pass.
    out.error(`${check}: incomplete coverage in ${scope}; failing closed:`);
    out.error(formatCoverageGaps(coverage));
  }
  if (hits.length > 0 || !complete) return 1;
  out.log(`${check}: clean (${scope})`);
  return 0;
}

if (import.meta.main) {
  const [flag, check] = Deno.args;
  if (
    Deno.args.length !== 2 || flag !== "--check" ||
    !(RANGE_CHECKS as readonly string[]).includes(check ?? "")
  ) {
    console.error(
      `${LABEL}: usage: --check <${RANGE_CHECKS.join("|")}>`,
    );
    Deno.exit(64);
  }
  let code: number;
  try {
    code = await runRangeCheck(
      check as RangeCheck,
      repoRootFromMeta(),
      (name) => Deno.env.get(name),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    code = 1;
  }
  Deno.exit(code);
}
