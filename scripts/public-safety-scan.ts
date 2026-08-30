/**
 * Public-safety scan.
 *
 * Fails when a repository text file carries content that must never land in a
 * public artifact. Two rule families, each reported under a stable check id:
 *
 * - `secret.tree/*` — secret-shaped values: private-key headers, well-known
 *   credential prefixes, and JWT-shaped tokens. Placeholders that do not
 *   match a full credential shape (an empty `KEY=` line, an `op://…` pointer,
 *   a `<your-value>` stub) pass.
 * - `public.boundary/*` — operator-identifying material that belongs in
 *   private overlays, not this repository: email addresses outside the
 *   RFC-reserved documentation domains (the `.example` / `.invalid` /
 *   `.test` / `.localhost` TLDs, and `example.com` / `example.net` /
 *   `example.org` with their subdomains), and absolute home-directory paths
 *   (`/Users/…`, `/home/…`).
 *
 * Only rules that are safe to publish live here: every pattern describes a
 * generic credential or boundary shape, never a private vocabulary entry.
 * Richer private-corpus rules stay in private tooling and do not gate this
 * repository.
 *
 * There are no path exemptions and no allowlist: tests are public artifacts
 * too, and a credential inserted into this scanner's own source must still
 * fail. Sources whose text would otherwise match a rule (including this
 * file's tests) assemble those fixtures at runtime instead. Files that look
 * binary are not skipped either — decoded bytes are scanned so an ASCII
 * secret shape inside a NUL-carrying tracked payload is still detected.
 *
 * Inventory follows the caller's environment (see `scanTree`): CI scans the
 * tracked subject exactly, while a local run also scans untracked non-ignored
 * files, so a secret-shaped value in a not-yet-added file is caught before it
 * is committed. Ignored files are excluded in both modes, and no symlink is
 * ever followed.
 *
 * Local scanning is bounded, and those bounds fail closed. When the untracked
 * inventory or a per-file read stops at its bound, part of the subject went
 * unread, and `runTreeScan` reports that as a failure — never as a warning
 * printed beside a clean pass. `clean` therefore means both "nothing found"
 * and "everything in scope was read".
 *
 * The same rule set backs two lanes of the aggregate gate: `--family
 * secret.tree` and `--family public.boundary` report separately under their
 * stable check ids, and `secret-diff-scan` reuses the secret rules for
 * release-range additions.
 *
 * Diagnostics are value-free: a report names rule id, path, and line number —
 * never the matched content. See `scan-lib.ts` for the shared posture
 * (sanitized bounded paths, capped collection and reporting, code-authored
 * failure messages).
 */

import {
  type CoverageGaps,
  coverageIsComplete,
  emptyCoverage,
  formatCoverageGaps,
  MAX_COLLECTED_HITS,
  MAX_REPORTED_HITS,
  posixPath,
  readTrackedFile,
  readUntrackedFile,
  recordTruncatedRead,
  repoRootFromMeta,
  sanitizeForLog,
  trackedFiles,
  untrackedFiles,
} from "./scan-lib.ts";

const SCAN_LABEL = "public-safety scan";

export interface ScanRule {
  id: string;
  matches: (line: string) => boolean;
}

function patternRule(id: string, pattern: RegExp): ScanRule {
  return { id, matches: (line) => pattern.test(line) };
}

// Only RFC-reserved shapes are documentation-safe: the reserved TLDs
// `.example` / `.invalid` / `.test` / `.localhost`, and the second-level
// documentation domains example.com / example.net / example.org including
// their subdomains. An interior `example` label does not reserve a real
// domain — example.evil.com is deliverable and fails.
const RESERVED_EMAIL_TLDS = ["example", "invalid", "test", "localhost"];
const RESERVED_EXAMPLE_TLDS = ["com", "net", "org"];

export function isAllowedEmailDomain(domain: string): boolean {
  const labels = domain.toLowerCase().split(".");
  const tld = labels.at(-1) ?? "";
  if (RESERVED_EMAIL_TLDS.includes(tld)) return true;
  return labels.at(-2) === "example" && RESERVED_EXAMPLE_TLDS.includes(tld);
}

// [A-Za-z0-9-]: a domain-label character.
function isLabelCode(code: number): boolean {
  return (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) || code === 0x2d;
}

// [A-Za-z]
function isAlphaCode(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

// [A-Za-z0-9._%+-]: an email local-part character.
function isLocalCode(code: number): boolean {
  return isLabelCode(code) || code === 0x2e || code === 0x5f ||
    code === 0x25 || code === 0x2b;
}

// Longest dotted domain starting at `start`, mirroring the greedy match of
// `[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![A-Za-z0-9-])`, but in
// linear time: the backtracking regex is quadratic on hostile runs, which
// made a single 200k-character line take seconds to scan. The window is
// bounded by the RFC 5321 255-octet domain limit rather than truncating the
// line, so no deliverable address is hidden by the bound.
function domainAfter(line: string, start: number): string | undefined {
  const limit = Math.min(line.length, start + 256);
  const labelEnds: number[] = [];
  let i = start;
  while (i < limit) {
    const labelStart = i;
    while (i < limit && isLabelCode(line.charCodeAt(i))) i++;
    if (i === labelStart) break;
    labelEnds.push(i);
    if (line.charCodeAt(i) !== 0x2e) break;
    if (i + 1 >= limit || !isLabelCode(line.charCodeAt(i + 1))) break;
    i++;
  }
  for (let k = labelEnds.length; k >= 2; k--) {
    const end = labelEnds[k - 1] ?? 0;
    const labelStart = (labelEnds[k - 2] ?? 0) + 1;
    if (end - labelStart < 2) continue;
    let alphabetic = true;
    for (let j = labelStart; j < end; j++) {
      if (!isAlphaCode(line.charCodeAt(j))) {
        alphabetic = false;
        break;
      }
    }
    if (alphabetic) return line.slice(start, end);
  }
  return undefined;
}

function hasDisallowedEmail(line: string): boolean {
  let at = line.indexOf("@");
  while (at !== -1) {
    if (at > 0 && isLocalCode(line.charCodeAt(at - 1))) {
      const domain = domainAfter(line, at + 1);
      if (domain !== undefined && !isAllowedEmailDomain(domain)) return true;
    }
    at = line.indexOf("@", at + 1);
  }
  return false;
}

export const RULES: readonly ScanRule[] = [
  patternRule("secret.tree/private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/),
  patternRule("secret.tree/aws-access-key-id", /\bAKIA[0-9A-Z]{16}\b/),
  patternRule("secret.tree/github-token", /\bgh[pousr]_[A-Za-z0-9]{36,}/),
  patternRule("secret.tree/google-api-key", /\bAIza[0-9A-Za-z_-]{35}/),
  patternRule("secret.tree/slack-token", /\bxox[abprs]-[0-9A-Za-z-]{10,}/),
  patternRule("secret.tree/anthropic-api-key", /\bsk-ant-[A-Za-z0-9_-]{16,}/),
  patternRule(
    "secret.tree/jwt",
    /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}/,
  ),
  { id: "public.boundary/personal-email", matches: hasDisallowedEmail },
  {
    id: "public.boundary/home-directory-path",
    matches: (line) => /\/(?:Users|home)\/[A-Za-z][A-Za-z0-9._-]*/.test(line),
  },
];

export const RULE_FAMILIES = ["secret.tree", "public.boundary"] as const;

export function rulesForFamily(family: string): readonly ScanRule[] {
  const selected = RULES.filter((rule) => rule.id.startsWith(`${family}/`));
  if (selected.length === 0) {
    throw new Error(`${SCAN_LABEL}: unknown rule family`);
  }
  return selected;
}

// Deliberately carries no matched-line content: nothing downstream can echo
// what it never held.
export interface PublicSafetyHit {
  path: string;
  line: number;
  rule: string;
}

export function scanText(
  path: string,
  content: string,
  limit: number = Number.POSITIVE_INFINITY,
  rules: readonly ScanRule[] = RULES,
): PublicSafetyHit[] {
  if (limit <= 0) return [];
  const hits: PublicSafetyHit[] = [];
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line === undefined) continue;
    for (const rule of rules) {
      if (rule.matches(line)) {
        hits.push({
          path: posixPath(path),
          line: index + 1,
          rule: rule.id,
        });
        if (hits.length >= limit) return hits;
      }
    }
  }
  return hits;
}

export async function scanRepo(
  root: string,
  rules: readonly ScanRule[] = RULES,
): Promise<PublicSafetyHit[]> {
  const files = await trackedFiles(root, SCAN_LABEL);
  const hits: PublicSafetyHit[] = [];
  for (const path of files) {
    const remaining = MAX_COLLECTED_HITS - hits.length;
    if (remaining <= 0) break;
    const bytes = await readTrackedFile(root, path, SCAN_LABEL);
    const content = new TextDecoder().decode(bytes);
    for (const hit of scanText(path, content, remaining, rules)) {
      hits.push(hit);
    }
  }
  return hits;
}

export type EnvReader = (name: string) => string | undefined;

export interface TreeScanResult {
  hits: PublicSafetyHit[];
  // Whether untracked, non-ignored files were part of this inventory. False in
  // CI, where the subject is the committed tree.
  untrackedScanned: boolean;
  // What the local bounds left unread (see `scan-lib.ts`). Any gap here makes
  // the scan fail: partial coverage is never reported as a clean pass. Always
  // empty in CI, where the tracked subject is read whole.
  coverage: CoverageGaps;
}

// The scan as a caller's environment defines it.
//
// In CI (`GITHUB_ACTIONS=true`) the subject is an immutable commit, and
// `subject.resolve` already fails closed when the checked-out tree carries any
// modification — untracked non-ignored files included. Scanning untracked
// content there would scan something the gate has, by construction, already
// rejected; the tracked inventory stays exactly the authoritative subject.
//
// Locally the tree is where work actually happens, so a secret-shaped value in
// a file that has not been `git add`ed yet is precisely the case worth
// catching before it is ever committed. Ignored files stay excluded in both
// modes.
export async function scanTree(
  root: string,
  rules: readonly ScanRule[] = RULES,
  env: EnvReader = () => undefined,
): Promise<TreeScanResult> {
  const hits = await scanRepo(root, rules);
  if (env("GITHUB_ACTIONS") === "true") {
    return { hits, untrackedScanned: false, coverage: emptyCoverage() };
  }
  const coverage = emptyCoverage();
  const { paths, truncated } = await untrackedFiles(root, SCAN_LABEL);
  coverage.inventoryBound = truncated;
  for (const path of paths) {
    const remaining = MAX_COLLECTED_HITS - hits.length;
    if (remaining <= 0) break;
    const read = await readUntrackedFile(root, path, SCAN_LABEL);
    if (read.truncated) recordTruncatedRead(coverage, path);
    const content = new TextDecoder().decode(read.bytes);
    for (const hit of scanText(path, content, remaining, rules)) {
      hits.push(hit);
    }
  }
  return { hits, untrackedScanned: true, coverage };
}

// The scan's verdict, as an exit code. Two independent reasons to fail, each
// reported on its own terms: hits found, and subject not fully read. Only a
// run that found nothing *and* read everything it claimed to cover prints
// `clean`, so no bound can turn into a silent pass.
export async function runTreeScan(
  root: string,
  rules: readonly ScanRule[] = RULES,
  env: EnvReader = () => undefined,
  out: Pick<Console, "log" | "error"> = console,
  label: string = SCAN_LABEL,
): Promise<number> {
  const result = await scanTree(root, rules, env);
  const scope = result.untrackedScanned
    ? "tracked and untracked non-ignored files"
    : "tracked files";
  const complete = coverageIsComplete(result.coverage);
  if (result.hits.length > 0) {
    out.error(`${label}: secret-shaped or boundary-crossing content:`);
    out.error(formatHits(result.hits));
  }
  if (!complete) {
    out.error(
      `${label}: incomplete coverage of ${scope}; failing closed:`,
    );
    out.error(formatCoverageGaps(result.coverage));
  }
  if (result.hits.length > 0 || !complete) return 1;
  out.log(`${label}: clean (${scope})`);
  return 0;
}

// Value-free by construction: rule id, path (sanitized and bounded), and line
// number locate a failure; the matched content never appears. Reporting is
// capped so a pathological tree cannot flood the log.
export function formatHits(hits: PublicSafetyHit[]): string {
  const shown = hits.slice(0, MAX_REPORTED_HITS).map((hit) =>
    `${sanitizeForLog(hit.path, 300)}:${hit.line}: ${
      sanitizeForLog(hit.rule, 100)
    }`
  );
  if (hits.length > MAX_REPORTED_HITS) {
    shown.push(`… and ${hits.length - MAX_REPORTED_HITS} more hits not shown`);
  }
  return shown.join("\n");
}

// Fail closed on anything unrecognized: an unknown flag must not silently
// scan a different rule selection than the caller intended.
export function parseScanArguments(
  args: readonly string[],
): { family?: string } {
  if (args.length === 0) return {};
  if (args.length === 2 && args[0] === "--family") {
    const family = args[1] ?? "";
    if ((RULE_FAMILIES as readonly string[]).includes(family)) {
      return { family };
    }
    throw new Error(`${SCAN_LABEL}: unknown rule family`);
  }
  throw new Error(
    `${SCAN_LABEL}: unknown arguments (only --family <name> is supported)`,
  );
}

// The tree-scan lane runs without an environment grant, so the CI marker is
// read only when that permission is already granted; querying never prompts.
// Without it the run is treated as local feedback, which is the safe
// direction: in CI the subject tree is clean — `subject.resolve` fails closed
// otherwise — so the untracked inventory is empty and the two modes coincide.
export function permittedEnvReader(variable: string): EnvReader {
  let granted: boolean;
  try {
    granted =
      Deno.permissions.querySync({ name: "env", variable }).state === "granted";
  } catch {
    granted = false;
  }
  return (name) =>
    granted && name === variable ? Deno.env.get(name) : undefined;
}

if (import.meta.main) {
  let rules: readonly ScanRule[] = RULES;
  let label = SCAN_LABEL;
  try {
    const { family } = parseScanArguments(Deno.args);
    if (family !== undefined) {
      rules = rulesForFamily(family);
      label = `${SCAN_LABEL} (${family})`;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(64);
  }
  const code = await runTreeScan(
    repoRootFromMeta(),
    rules,
    permittedEnvReader("GITHUB_ACTIONS"),
    console,
    label,
  );
  Deno.exit(code);
}
