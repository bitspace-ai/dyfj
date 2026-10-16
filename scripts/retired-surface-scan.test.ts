// Tests for the retired-surface scan. They register with node:test and
// take assertions from node:assert, like the scan, which is written to node:
// builtins only. The lane itself runs the scan over the tracked tree
// (`node scripts/retired-surface-scan.ts`); these tests pin its rules.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { test } from "node:test";
import {
  formatHits,
  MAX_REPORTED_HITS,
  readTrackedFile,
  sanitizeForLog,
  scanRepo,
  scanText,
  WORKBENCH_BEARER_ENV,
} from "./retired-surface-scan.ts";

test("dated README-style lines are historical", () => {
  const line =
    "- 2026-06-04 - Workbench runtime split with CLI/shell and local HTTP veneers.";
  assert.deepEqual(
    scanText("README.md", `${line}\n`),
    [],
  );
});

test("wrapped dated README-style lines remain historical", () => {
  const content = [
    "- 2026-06-04 - Workbench runtime split into a shared boundary with",
    "  CLI/shell and local HTTP veneers.",
    "Current mcp-client capability.",
  ].join("\n");
  const hits = scanText("README.md", content);
  if (hits.length !== 1 || hits[0]?.needle !== "mcp-client") {
    throw new Error("dated bullet continuation was not bounded correctly");
  }
});

test("CHANGELOG dated sections are historical", () => {
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
  assert.deepEqual(hits.length, 1);
  assert.deepEqual(hits[0]?.needle, "CLI/shell");
  assert.deepEqual(hits[0]?.line, 10);
});

test("Unreleased retirement announcements pass", () => {
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
  assert.deepEqual(scanText("CHANGELOG.md", content), []);
});

test("Unreleased live claims fail", () => {
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
  assert.deepEqual(needles, [
    "/api/turn",
    "session-coordination",
    "standalone HTTP",
  ]);
});

test("current-state comments in TypeScript fail", () => {
  const hits = scanText(
    "prototype/src/workbench.ts",
    "   * The direct CLI/shell path injects console output.\n",
  );
  assert.deepEqual(hits.length, 1);
  assert.deepEqual(hits[0]?.needle, "CLI/shell");
});

test("the superseded veneers note is historical", () => {
  assert.deepEqual(
    scanText(
      "notes/workbench-runtime-veneers.md",
      "runWorkbenchShell and POST /api/turn\n",
    ),
    [],
  );
});

test("this scanner file is allowlisted", () => {
  assert.deepEqual(
    scanText(
      "scripts/retired-surface-scan.ts",
      `${WORKBENCH_BEARER_ENV} CLI/shell mcp-client\n`,
    ),
    [],
  );
});

test("retired serverUrl and SSE-frame wording fails as current-state", () => {
  const content = [
    "// config.serverUrl is operator-configurable",
    "// SSE frame protocol, negotiated via Accept",
  ].join("\n");
  const hits = scanText("prototype/src/example.ts", content);
  assert.deepEqual(hits.map((hit) => hit.needle).sort(), [
    "SSE frame",
    "serverUrl",
  ]);
});

test("retirement announcements for the transport wording pass", () => {
  const content = [
    "## [Unreleased]",
    "",
    "### Removed",
    "",
    "- Stale SSE frame and serverUrl transport comments are gone.",
  ].join("\n");
  assert.deepEqual(scanText("CHANGELOG.md", content), []);
});

test("formatted output is value-free: matched content never appears", () => {
  // Assembled at runtime so no secret-shaped literal sits in tracked source.
  const secret = ["sk-live", "EXAMPLE", "abcdef0123456789"].join("-");
  const hits = scanText(
    "docs/example.md",
    `The standalone HTTP server uses key ${secret}.\n`,
  );
  assert.deepEqual(hits.length, 1);
  const formatted = formatHits(hits);
  if (formatted.includes(secret)) {
    throw new Error("secret-like content reached formatted output");
  }
  assert.deepEqual(formatted, "docs/example.md:1: standalone HTTP");
});

test("oversized matched lines never inflate formatted output", () => {
  const hits = scanText(
    "docs/example.md",
    `${"x".repeat(100_000)} standalone HTTP ${"y".repeat(100_000)}\n`,
  );
  assert.deepEqual(hits.length, 1);
  const formatted = formatHits(hits);
  if (formatted.length > 500) {
    throw new Error(`formatted output too large: ${formatted.length} chars`);
  }
});

test("control bytes in paths are stripped from formatted output", () => {
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
  assert.deepEqual(formatted, "docs/[2Jevilname.md:1: standalone HTTP");
});

test("hit reporting is capped", () => {
  const lines = Array.from(
    { length: MAX_REPORTED_HITS + 10 },
    () => "the standalone HTTP server",
  ).join("\n");
  const hits = scanText("docs/example.md", lines);
  assert.deepEqual(hits.length, MAX_REPORTED_HITS + 10);
  const formatted = formatHits(hits).split("\n");
  assert.deepEqual(formatted.length, MAX_REPORTED_HITS + 1);
  assert.deepEqual(formatted.at(-1), "… and 10 more hits not shown");
});

test("a failed tracked-file read is value-free and fail-closed", async () => {
  let message = "";
  try {
    await readTrackedFile(
      "/nonexistent-root-for-this-test",
      `docs/\x1b[2Jevil${"x".repeat(400)}.md`,
    );
    throw new Error("expected readTrackedFile to throw");
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  // Exact equality with the code-authored message: no platform error text of
  // ANY flavor, no filesystem root, no control bytes can be present, because
  // nothing beyond this exact string is.
  const expectedPath = sanitizeForLog(
    `docs/\x1b[2Jevil${"x".repeat(400)}.md`,
    300,
  );
  assert.deepEqual(
    message,
    `retired-surface scan: cannot read tracked file ${expectedPath}`,
  );
});

test("sanitizeForLog strips control bytes and bounds length", () => {
  assert.deepEqual(
    sanitizeForLog("fatal:\x1b[31m boom\r\n", 256),
    "fatal:[31m boom",
  );
  assert.deepEqual(sanitizeForLog("a".repeat(300), 256), `${"a".repeat(256)}…`);
});

test("sanitizeForLog strips C1 and direction controls too", () => {
  // U+009B is the single-byte CSI; U+202E is right-to-left override.
  assert.deepEqual(
    sanitizeForLog("a\u{009b}2Jb\u{202e}c\u{2066}d\u{200e}", 256),
    "a2Jbcd",
  );
});

test("scanText stops collecting at the given limit", () => {
  const lines = Array.from(
    { length: 40 },
    () => "the standalone HTTP server",
  ).join("\n");
  assert.deepEqual(scanText("docs/example.md", lines, 7).length, 7);
  assert.deepEqual(scanText("docs/example.md", lines, 0), []);
});

test("this test file is allowlisted, as the scanner file is", () => {
  assert.deepEqual(
    scanText(
      "scripts/retired-surface-scan.test.ts",
      `${WORKBENCH_BEARER_ENV} CLI/shell mcp-client\n`,
    ),
    [],
  );
});

test("scanRepo reports a tracked file's hits by path, line and needle", async () => {
  const dir = mkdtempSync(join(tmpdir(), "retired-surface-"));
  try {
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", dir, ...args], {
        env: {
          PATH: process.env.PATH ?? "",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
        stdio: "ignore",
      });
    git("init", "-q");
    writeFileSync(join(dir, "clean.md"), "nothing retired here\n");
    writeFileSync(join(dir, "live.md"), "intro\nthe standalone HTTP server\n");
    writeFileSync(join(dir, "untracked.md"), "the standalone HTTP server\n");
    git("add", "clean.md", "live.md");
    assert.deepEqual(await scanRepo(dir), [
      { path: "live.md", line: 2, needle: "standalone HTTP" },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
