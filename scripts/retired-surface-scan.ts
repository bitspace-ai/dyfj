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
 *
 * Goal: "X is a live HTTP/shell/bearer-key surface" fails; "X retired / is gone"
 * changelog lines pass. Do not gut the scan to silence a current-state hit.
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
];

const DATED_LINE = /^- 20\d\d-\d\d-\d\d/;
const CHANGELOG_HEADING = /^## \[([^\]]+)\]\s*$/;
const DATED_HEADING_VALUE = /^20\d\d-\d\d-\d\d$/;
const RETIREMENT_ANNOUNCEMENT = /\bretired\b|\bis gone\b|\bare gone\b/i;

export interface RetiredSurfaceHit {
  path: string;
  line: number;
  needle: string;
  text: string;
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

export function scanText(path: string, content: string): RetiredSurfaceHit[] {
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
          text: line,
        });
      }
    }
  }
  return hits;
}

export function repoRootFromMeta(): string {
  return fileURLToPath(new URL("..", import.meta.url));
}

export async function trackedFiles(root: string): Promise<string[]> {
  const result = await new Deno.Command("git", {
    args: ["-C", root, "ls-files", "-z"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(
      `retired-surface scan: git ls-files failed (${result.code}): ${
        new TextDecoder().decode(result.stderr)
      }`,
    );
  }
  return new TextDecoder().decode(result.stdout).split("\0").filter(Boolean);
}

export async function scanRepo(root: string): Promise<RetiredSurfaceHit[]> {
  const files = await trackedFiles(root);
  const hits: RetiredSurfaceHit[] = [];
  for (const path of files) {
    const bytes = await Deno.readFile(`${root}/${path}`);
    if (bytes.includes(0)) continue;
    const content = new TextDecoder().decode(bytes);
    hits.push(...scanText(path, content));
  }
  return hits;
}

export function formatHits(hits: RetiredSurfaceHit[]): string {
  return hits.map((hit) =>
    `${hit.path}:${hit.line}: ${hit.needle}: ${hit.text.trim()}`
  ).join("\n");
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
