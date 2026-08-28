/**
 * Retired-surface scan.
 *
 * Fails if a deny-list name of a demolished Workbench surface appears in a
 * tracked file outside explicitly historical text. Current-state claims fail
 * (docs, comments, code, tests — any tracked type). Retirement announcements
 * pass.
 *
 * Allow rules:
 * - Dated README-style lines matching `/^- 20\d\d-\d\d-\d\d/`.
 * - CHANGELOG dated sections: every line after `## [YYYY-MM-DD]` until the
 *   next `## [` heading. `[Unreleased]` is not dated history.
 * - CHANGELOG `[Unreleased]` lines that announce retirement (`retired`,
 *   `is gone`, or `are gone`) — including Removed bullets that name the
 *   retired files. Live capability claims in Unreleased still fail.
 * - `notes/workbench-runtime-veneers.md` (superseded inventory).
 * - This file, so the deny-list can be defined here.
 * - Files containing a NUL byte are skipped as binary; their bytes are not
 *   scanned as text.
 *
 * Goal: "X is a live HTTP/shell/bearer-key surface" fails; "X retired / is gone"
 * changelog lines pass. Do not gut the scan to silence a current-state hit.
 *
 * Diagnostics are value-free: a report names path, line number, and needle —
 * never the matched line's content. Tracked files are untrusted
 * pre-publication input; a matching line can carry a credential, private
 * text, terminal-control bytes, or an arbitrarily large payload, and none of
 * that belongs in terminal or CI output. Paths are control-stripped and
 * bounded, hit collection and reporting are both capped, and a git failure
 * reports its exit code only — stderr is never relayed.
 */

import { fileURLToPath } from "node:url";

const WORKBENCH_BEARER_ENV = ["DYFJ", "WORKBENCH", "API", "KEY"].join("_");

export const DENY_LIST: readonly string[] = [
  "runWorkbenchShell",
  "workbench-http",
  WORKBENCH_BEARER_ENV,
  "DYFJ_WORKBENCH_HTTP_",
  "DYFJ_WORKBENCH_ALLOWED_HOSTS",
  "/api/turn",
  "CLI/shell",
  "standalone HTTP",
  "session-coordination",
  "mcp-client",
  // Retired turn-seam transport wording. `serverUrl` was the removed HTTP
  // client's operator-configurable endpoint; "SSE frame" is the retired HTTP
  // streaming transport's framing. Provider adapters still legitimately speak
  // SSE to model APIs, so the seam's own vocabulary is denied rather than
  // "SSE" broadly. Like every needle here these are context-free substrings:
  // a legitimate future use gets rephrased or allowlisted, never silently
  // passed.
  "serverUrl",
  "SSE frame",
];

const DATED_LINE = /^- 20\d\d-\d\d-\d\d/;
const CHANGELOG_HEADING = /^## \[([^\]]+)\]\s*$/;
const DATED_HEADING_VALUE = /^20\d\d-\d\d-\d\d$/;
const RETIREMENT_ANNOUNCEMENT = /\bretired\b|\bis gone\b|\bare gone\b/i;

// Deliberately carries no matched-line content: nothing downstream can echo
// what it never held.
export interface RetiredSurfaceHit {
  path: string;
  line: number;
  needle: string;
}

function posixPath(path: string): string {
  return path.replaceAll("\\", "/");
}

export function isAllowlistedPath(path: string): boolean {
  const normalized = posixPath(path);
  return normalized === "notes/workbench-runtime-veneers.md" ||
    normalized === "scripts/retired-surface-scan.ts";
}

function isChangelogPath(path: string): boolean {
  const normalized = posixPath(path);
  return normalized === "CHANGELOG.md" || normalized.endsWith("/CHANGELOG.md");
}

type ChangelogSection = "unreleased" | "dated" | null;

function headingSection(value: string): ChangelogSection {
  if (value === "Unreleased") return "unreleased";
  if (DATED_HEADING_VALUE.test(value)) return "dated";
  return null;
}

export function lineIsAllowed(
  path: string,
  line: string,
  changelogSection: ChangelogSection,
): boolean {
  if (DATED_LINE.test(line)) return true;
  if (!isChangelogPath(path)) return false;
  if (changelogSection === "dated") return true;
  if (
    changelogSection === "unreleased" && RETIREMENT_ANNOUNCEMENT.test(line)
  ) {
    return true;
  }
  return false;
}

export function scanText(
  path: string,
  content: string,
  limit: number = Number.POSITIVE_INFINITY,
): RetiredSurfaceHit[] {
  if (limit <= 0) return [];
  if (isAllowlistedPath(path)) return [];
  if (content.includes("\0")) return [];
  const hits: RetiredSurfaceHit[] = [];
  let changelogSection: ChangelogSection = null;
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line === undefined) continue;
    if (isChangelogPath(path)) {
      const heading = CHANGELOG_HEADING.exec(line);
      if (heading) {
        changelogSection = headingSection(heading[1] ?? "");
      }
    }
    if (lineIsAllowed(path, line, changelogSection)) continue;
    for (const needle of DENY_LIST) {
      if (line.includes(needle)) {
        hits.push({
          path: posixPath(path),
          line: index + 1,
          needle,
        });
        if (hits.length >= limit) return hits;
      }
    }
  }
  return hits;
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

export async function trackedFiles(root: string): Promise<string[]> {
  const result = await new Deno.Command("git", {
    args: ["-C", root, "ls-files", "-z"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    // Exit code only: git stderr is not relayed at all, so a failure message
    // that happens to carry sensitive content never reaches the diagnostic.
    // Re-run `git ls-files` by hand to see why it failed.
    throw new Error(
      `retired-surface scan: git ls-files failed (exit ${result.code})`,
    );
  }
  return new TextDecoder().decode(result.stdout).split("\0").filter(Boolean);
}

// Collection stops here, not just at formatting: one hit already fails the
// scan, so a pathological tree cannot make the scanner materialize an
// unbounded hit list before the report is capped.
export const MAX_COLLECTED_HITS = 1000;

export async function scanRepo(root: string): Promise<RetiredSurfaceHit[]> {
  const files = await trackedFiles(root);
  const hits: RetiredSurfaceHit[] = [];
  for (const path of files) {
    const remaining = MAX_COLLECTED_HITS - hits.length;
    if (remaining <= 0) break;
    const bytes = await Deno.readFile(`${root}/${path}`);
    if (bytes.includes(0)) continue;
    const content = new TextDecoder().decode(bytes);
    for (const hit of scanText(path, content, remaining)) {
      hits.push(hit);
    }
  }
  return hits;
}

export const MAX_REPORTED_HITS = 50;

// Value-free by construction: path (sanitized and bounded), line number, and
// needle locate a failure for ordinary repository paths (an exotic path —
// literal backslashes, or long enough to truncate — may render ambiguously);
// the matched content never appears. Reporting is capped so a pathological
// tree cannot flood the log.
export function formatHits(hits: RetiredSurfaceHit[]): string {
  const shown = hits.slice(0, MAX_REPORTED_HITS).map((hit) =>
    `${sanitizeForLog(hit.path, 300)}:${hit.line}: ${
      sanitizeForLog(hit.needle, 100)
    }`
  );
  if (hits.length > MAX_REPORTED_HITS) {
    shown.push(`… and ${hits.length - MAX_REPORTED_HITS} more hits not shown`);
  }
  return shown.join("\n");
}

if (import.meta.main) {
  const root = repoRootFromMeta();
  const hits = await scanRepo(root);
  if (hits.length > 0) {
    console.error(
      "retired-surface scan: current-state claims of retired surfaces:",
    );
    console.error(formatHits(hits));
    Deno.exit(1);
  }
  console.log("retired-surface scan: clean");
}

function assertEquals<T>(actual: T, expected: T): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}


Deno.test("dated README-style lines are historical", () => {
  const line =
    "- 2026-06-04 - Workbench runtime split with CLI/shell and local HTTP veneers.";
  assertEquals(
    scanText("README.md", `${line}\n`),
    [],
  );
});

Deno.test("CHANGELOG dated sections are historical", () => {
  const content = [
    "## [2026-06-12]",
    "",
    "### Added",
    "",
    `- Bearer-key authentication via ${WORKBENCH_BEARER_ENV} and DYFJ_WORKBENCH_ALLOWED_HOSTS.`,
    "- Multi-interface bind: DYFJ_WORKBENCH_HTTP_HOST.",
    "",
    "## [Unreleased]",
    "",
    "- Live claim: the CLI/shell is the operator surface.",
  ].join("\n");
  const hits = scanText("CHANGELOG.md", content);
  assertEquals(hits.length, 1);
  assertEquals(hits[0]?.needle, "CLI/shell");
  assertEquals(hits[0]?.line, 10);
});

Deno.test("Unreleased retirement announcements pass", () => {
  const content = [
    "## [Unreleased]",
    "",
    "### Removed",
    "",
    "- **Workbench shell retired**: `runWorkbenchShell` is gone.",
    "- **Session coordination retired**: `session-coordination.ts` is gone.",
    "- **Legacy stdio MCP client retired**: `mcp-client.ts` is gone.",
    "- HTTP peer server retired: workbench-http is gone.",
  ].join("\n");
  assertEquals(scanText("CHANGELOG.md", content), []);
});

Deno.test("Unreleased live claims fail", () => {
  const content = [
    "## [Unreleased]",
    "",
    "### Added",
    "",
    "- Added session-coordination claims for delegated work.",
    "- The standalone HTTP server serves POST /api/turn.",
  ].join("\n");
  const hits = scanText("CHANGELOG.md", content);
  const needles = hits.map((hit) => hit.needle).sort();
  assertEquals(needles, ["/api/turn", "session-coordination", "standalone HTTP"]);
});

Deno.test("current-state comments in TypeScript fail", () => {
  const hits = scanText(
    "prototype/src/workbench.ts",
    "   * The direct CLI/shell path injects console output.\n",
  );
  assertEquals(hits.length, 1);
  assertEquals(hits[0]?.needle, "CLI/shell");
});

Deno.test("the superseded veneers note is historical", () => {
  assertEquals(
    scanText(
      "notes/workbench-runtime-veneers.md",
      "runWorkbenchShell and POST /api/turn\n",
    ),
    [],
  );
});

Deno.test("this scanner file is allowlisted", () => {
  assertEquals(
    scanText(
      "scripts/retired-surface-scan.ts",
      `${WORKBENCH_BEARER_ENV} CLI/shell mcp-client\n`,
    ),
    [],
  );
});

Deno.test("retired serverUrl and SSE-frame wording fails as current-state", () => {
  const content = [
    "// config.serverUrl is operator-configurable",
    "// SSE frame protocol, negotiated via Accept",
  ].join("\n");
  const hits = scanText("prototype/src/example.ts", content);
  assertEquals(hits.map((hit) => hit.needle).sort(), ["SSE frame", "serverUrl"]);
});

Deno.test("retirement announcements for the transport wording pass", () => {
  const content = [
    "## [Unreleased]",
    "",
    "### Removed",
    "",
    "- Stale SSE frame and serverUrl transport comments are gone.",
  ].join("\n");
  assertEquals(scanText("CHANGELOG.md", content), []);
});

Deno.test("formatted output is value-free: matched content never appears", () => {
  // Assembled at runtime so no secret-shaped literal sits in tracked source.
  const secret = ["sk-live", "EXAMPLE", "abcdef0123456789"].join("-");
  const hits = scanText(
    "docs/example.md",
    `The standalone HTTP server uses key ${secret}.\n`,
  );
  assertEquals(hits.length, 1);
  const formatted = formatHits(hits);
  if (formatted.includes(secret)) {
    throw new Error("secret-like content reached formatted output");
  }
  assertEquals(formatted, "docs/example.md:1: standalone HTTP");
});

Deno.test("oversized matched lines never inflate formatted output", () => {
  const hits = scanText(
    "docs/example.md",
    `${"x".repeat(100_000)} standalone HTTP ${"y".repeat(100_000)}\n`,
  );
  const formatted = formatHits(hits);
  if (formatted.length > 500) {
    throw new Error(`formatted output too large: ${formatted.length} chars`);
  }
});

Deno.test("control bytes in paths are stripped from formatted output", () => {
  const hits = scanText(
    "docs/\x1b[2Jevil\rname.md",
    "the standalone HTTP server\n",
  );
  const formatted = formatHits(hits);
  for (const ch of formatted) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      throw new Error("control byte reached formatted output");
    }
  }
  assertEquals(formatted, "docs/[2Jevilname.md:1: standalone HTTP");
});

Deno.test("hit reporting is capped", () => {
  const lines = Array.from(
    { length: MAX_REPORTED_HITS + 10 },
    () => "the standalone HTTP server",
  ).join("\n");
  const hits = scanText("docs/example.md", lines);
  assertEquals(hits.length, MAX_REPORTED_HITS + 10);
  const formatted = formatHits(hits).split("\n");
  assertEquals(formatted.length, MAX_REPORTED_HITS + 1);
  assertEquals(formatted.at(-1), "… and 10 more hits not shown");
});

Deno.test("sanitizeForLog strips control bytes and bounds length", () => {
  assertEquals(
    sanitizeForLog("fatal:\x1b[31m boom\r\n", 256),
    "fatal:[31m boom",
  );
  assertEquals(sanitizeForLog("a".repeat(300), 256), `${"a".repeat(256)}…`);
});

Deno.test("sanitizeForLog strips C1 and direction controls too", () => {
  // U+009B is the single-byte CSI; U+202E is right-to-left override.
  assertEquals(sanitizeForLog("a\u{009b}2Jb\u{202e}c\u{2066}d\u{200e}", 256), "a2Jbcd");
});

Deno.test("scanText stops collecting at the given limit", () => {
  const lines = Array.from(
    { length: 40 },
    () => "the standalone HTTP server",
  ).join("\n");
  assertEquals(scanText("docs/example.md", lines, 7).length, 7);
  assertEquals(scanText("docs/example.md", lines, 0), []);
});

Deno.test("tracked tree has no current-state retired-surface claims", async () => {
  const hits = await scanRepo(repoRootFromMeta());
  if (hits.length > 0) {
    throw new Error(
      `retired-surface scan: current-state claims of retired surfaces:\n${
        formatHits(hits)
      }`,
    );
  }
});
