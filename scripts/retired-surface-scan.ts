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
 * - This file, so the deny-list can be defined here, and its test file,
 *   which quotes the deny-list to test it.
 * - Files containing a NUL byte are skipped as binary; their bytes are not
 *   scanned as text.
 *
 * Tracked paths are read from the worktree; a tracked symlink is never
 * followed — the shared `readTrackedFile` scans the exact link-target bytes
 * git tracks for that path, so the scan sees what the repository publishes
 * without reading outside it.
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
 * reports its exit code only — stderr is never relayed. The shared posture
 * (sanitizing, caps, code-authored messages) lives in `scan-lib.ts`.
 */

import process from "node:process";
import {
  MAX_COLLECTED_HITS,
  MAX_REPORTED_HITS,
  posixPath,
  readTrackedFile as readTrackedFileWith,
  repoRootFromMeta,
  sanitizeForLog,
  trackedFiles as trackedFilesWith,
} from "./scan-lib.ts";

export {
  MAX_COLLECTED_HITS,
  MAX_REPORTED_HITS,
  repoRootFromMeta,
  sanitizeForLog,
};

const SCAN_LABEL = "retired-surface scan";

export const WORKBENCH_BEARER_ENV = ["DYFJ", "WORKBENCH", "API", "KEY"].join(
  "_",
);

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

export function isAllowlistedPath(path: string): boolean {
  const normalized = posixPath(path);
  return normalized === "notes/workbench-runtime-veneers.md" ||
    normalized === "scripts/retired-surface-scan.ts" ||
    normalized === "scripts/retired-surface-scan.test.ts";
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
  let datedBulletContinuation = false;
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line === undefined) continue;
    if (DATED_LINE.test(line)) {
      datedBulletContinuation = true;
    } else if (datedBulletContinuation) {
      if (/^\s+\S/.test(line)) continue;
      datedBulletContinuation = false;
    }
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

export function trackedFiles(root: string): Promise<string[]> {
  return trackedFilesWith(root, SCAN_LABEL);
}

export function readTrackedFile(
  root: string,
  path: string,
): Promise<Uint8Array> {
  return readTrackedFileWith(root, path, SCAN_LABEL);
}

export async function scanRepo(root: string): Promise<RetiredSurfaceHit[]> {
  const files = await trackedFiles(root);
  const hits: RetiredSurfaceHit[] = [];
  for (const path of files) {
    const remaining = MAX_COLLECTED_HITS - hits.length;
    if (remaining <= 0) break;
    const bytes = await readTrackedFile(root, path);
    if (bytes.includes(0)) continue;
    const content = new TextDecoder().decode(bytes);
    for (const hit of scanText(path, content, remaining)) {
      hits.push(hit);
    }
  }
  return hits;
}

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
  try {
    const hits = await scanRepo(repoRootFromMeta());
    if (hits.length > 0) {
      console.error(
        "retired-surface scan: current-state claims of retired surfaces:",
      );
      console.error(formatHits(hits));
      process.exitCode = 1;
    } else {
      console.log("retired-surface scan: clean");
    }
  } catch (error) {
    // The scan's own errors are code-authored and value-free (`scan-lib.ts`).
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
