/**
 * CI workflow hygiene tests.
 *
 * The remote gate must call the repository-owned commands instead of
 * restating lanes in YAML, hold least-privilege permissions, keep untrusted
 * pull-request code away from secrets, pin third-party actions by digest,
 * verify every downloaded executable archive against a repository-committed
 * SHA-256 before unpacking or executing it, bound its runtime, and expose a
 * stable required-check name for branch protection. These tests assert those
 * properties on the workflow text so a drift fails the aggregate gate itself.
 */

import { fileURLToPath } from "node:url";

const WORKFLOW_URL = new URL("../.github/workflows/gate.yml", import.meta.url);

function workflowText(): Promise<string> {
  return Deno.readTextFile(fileURLToPath(WORKFLOW_URL));
}

function assertIncludes(text: string, expected: string): void {
  if (!text.includes(expected)) {
    throw new Error(`workflow is missing ${JSON.stringify(expected)}`);
  }
}

function assertExcludes(text: string, banned: string): void {
  if (text.includes(banned)) {
    throw new Error(`workflow must not contain ${JSON.stringify(banned)}`);
  }
}

Deno.test("gate workflow runs the repository-owned aggregate command", async () => {
  const text = await workflowText();
  const runs = text.match(/^\s+run: deno task test$/gm) ?? [];
  if (runs.length !== 2) {
    throw new Error("Linux and macOS must each run the repository-owned gate");
  }
});

Deno.test("gate workflow does not restate lane definitions in YAML", async () => {
  const text = await workflowText();
  // Lane vocabulary lives in scripts/ and deno.json; its presence here would
  // mean a second copy of the gate's ontology.
  for (
    const banned of [
      "aggregate-test-gate",
      "retired-surface",
      "public-safety-scan",
      "run-vitest",
      "cargo test",
      "validate-schema",
      "check:tests",
    ]
  ) {
    assertExcludes(text, banned);
  }
});

Deno.test("gate workflow holds least-privilege permissions", async () => {
  const text = await workflowText();
  assertIncludes(text, "permissions:\n  contents: read");
  if (/^\s*[a-z-]+:\s*write\s*$/m.test(text)) {
    throw new Error("workflow grants a write-scoped permission");
  }
});

Deno.test("gate workflow keeps untrusted pull-request code away from secrets", async () => {
  const text = await workflowText();
  assertExcludes(text, "pull_request_target");
  assertExcludes(text, "workflow_run");
  assertExcludes(text, "secrets.");
  assertIncludes(text, "pull_request:");
});

Deno.test("gate workflow pins every action to a full commit digest", async () => {
  const text = await workflowText();
  const uses = [...text.matchAll(/^\s*(?:- )?uses:\s*(\S+)/gm)].map(
    (match) => match[1] ?? "",
  );
  if (uses.length === 0) {
    throw new Error("workflow checkout step is missing");
  }
  for (const reference of uses) {
    if (!/^[^@]+@[0-9a-f]{40}$/.test(reference)) {
      throw new Error(`action reference is not digest-pinned: ${reference}`);
    }
  }
});

Deno.test("gate workflow triggers on pull requests and main-branch pushes", async () => {
  const text = await workflowText();
  assertIncludes(text, "pull_request:");
  assertIncludes(text, "push:\n    branches: [main]");
});

Deno.test("gate workflow bounds runtime and separates cancellation from failure", async () => {
  const text = await workflowText();
  assertIncludes(text, "timeout-minutes:");
  assertIncludes(text, "concurrency:");
  assertIncludes(text, "cancel-in-progress:");
});

Deno.test("gate workflow exposes the stable required-check job name", async () => {
  const text = await workflowText();
  assertIncludes(text, "\n  full-gate:\n");
});

Deno.test("gate workflow names explicit Linux and macOS runner versions", async () => {
  const text = await workflowText();
  assertIncludes(text, "runs-on: ubuntu-24.04");
  assertIncludes(text, "\n  macos-portability:\n");
  assertIncludes(text, "runs-on: macos-15");
  assertIncludes(text, "deno-aarch64-apple-darwin.zip");
  assertIncludes(text, "dolt-darwin-arm64.tar.gz");
  assertExcludes(text, "runs-on: ubuntu-latest");
  assertExcludes(text, "runs-on: macos-latest");
});

Deno.test("gate workflow binds the exact subject and release range", async () => {
  const text = await workflowText();
  assertIncludes(text, "DYFJ_GATE_SUBJECT: ${{ github.sha }}");
  assertIncludes(
    text,
    "DYFJ_GATE_RANGE_BASE: " +
      "${{ github.event.pull_request.base.sha || github.event.before }}",
  );
  // The bound range base must be resolvable from the checkout.
  assertIncludes(text, "fetch-depth: 0");
});

Deno.test("gate workflow drops the checkout credential", async () => {
  const text = await workflowText();
  assertIncludes(text, "persist-credentials: false");
});

Deno.test("gate workflow uses no mutable installer shapes", async () => {
  const text = await workflowText();
  assertExcludes(text, "releases/latest");
  assertExcludes(text, "latest/download");
  assertExcludes(text, "raw.githubusercontent.com");
  if (/\b(curl|wget)\b[^|\n]*\|/.test(text)) {
    throw new Error("workflow pipes a download instead of saving it");
  }
});

Deno.test("gate workflow verifies exact pinned tool versions", async () => {
  const text = await workflowText();
  assertIncludes(text, "releases/download/v2.9.6/");
  assertIncludes(text, 'grep -F "deno 2.9.6"');
  assertIncludes(text, "releases/download/v2.3.1/");
  assertIncludes(text, 'grep -F "2.3.1"');
  assertIncludes(text, 'grep -F "rustc 1.98.0"');
});

// A downloaded archive is arbitrary bytes until something proves what it is.
// The proof must land between the download and the first use of those bytes,
// so these helpers work on line order rather than on step prose.
const DOWNLOAD_LINE = /\bcurl\b[^\n]*\s-o\s+(\S+)/;
const UNPACK_COMMAND = /\b(unzip|tar|7z|gunzip|bsdtar|install)\b/;
const DIGEST_CHECK = /\b(?:sha256sum\s+-c|shasum\s+-a\s+256\s+-c)\b/;

interface ArchiveUse {
  path: string;
  downloadedAt: number;
  verifiedAt: number | undefined;
  unpackedAt: number | undefined;
}

function archiveUses(text: string): ArchiveUse[] {
  const lines = text.split("\n");
  const uses: ArchiveUse[] = [];
  for (let index = 0; index < lines.length; index++) {
    const download = DOWNLOAD_LINE.exec(lines[index] ?? "");
    if (!download) continue;
    const path = download[1] ?? "";
    const after = (
      predicate: (line: string) => boolean,
    ): number | undefined => {
      for (let scan = index + 1; scan < lines.length; scan++) {
        if (predicate(lines[scan] ?? "")) return scan;
      }
      return undefined;
    };
    uses.push({
      path,
      downloadedAt: index,
      verifiedAt: after(
        (line) => line.includes(path) && DIGEST_CHECK.test(line),
      ),
      unpackedAt: after(
        (line) => line.includes(path) && UNPACK_COMMAND.test(line),
      ),
    });
  }
  return uses;
}

Deno.test("gate workflow verifies a pinned digest before unpacking any archive", async () => {
  const text = await workflowText();
  const uses = archiveUses(text);
  if (uses.length < 2) {
    throw new Error(
      "expected the Deno and Dolt archive downloads; a removed download " +
        "must not silently drop its integrity check",
    );
  }
  for (const use of uses) {
    if (use.unpackedAt === undefined) {
      // A downloaded archive that is never unpacked is still executable
      // input; it may not exist without a verification step either.
      if (use.verifiedAt === undefined) {
        throw new Error(`downloaded archive is never verified: ${use.path}`);
      }
      continue;
    }
    if (use.verifiedAt === undefined) {
      throw new Error(
        `archive is unpacked without a pinned digest check: ${use.path}`,
      );
    }
    if (use.verifiedAt > use.unpackedAt) {
      throw new Error(
        `archive is unpacked before its digest check: ${use.path}`,
      );
    }
  }
});

Deno.test("gate workflow pins archive digests in-repository, never at run time", async () => {
  const text = await workflowText();
  const checks = text.split("\n").filter((line) => DIGEST_CHECK.test(line));
  if (checks.length === 0) {
    throw new Error("workflow declares no archive digest check");
  }
  for (const line of checks) {
    // The expected digest must be a literal committed here: a workflow
    // expression, a variable, or a downloaded checksum file would make the
    // pin mutable by whoever controls that source.
    if (!/\b[0-9a-f]{64}\b/.test(line)) {
      throw new Error(
        "digest check carries no committed 64-hex SHA-256 literal",
      );
    }
    if (line.includes("${{") || line.includes("$(")) {
      throw new Error("digest check resolves its expected value dynamically");
    }
  }
  // Fetching checksums, signatures, or trust roots at run time from the same
  // origin as the archive adds no integrity the origin cannot forge.
  for (
    const banned of [
      "checksums.txt",
      "SHASUMS",
      ".sha256",
      ".sig",
      ".asc",
      "cosign",
      "keyserver",
      "--recv-keys",
    ]
  ) {
    assertExcludes(text, banned);
  }
});

// A step name is an evidence claim a reader takes at face value. The Deno and
// Dolt archives are checked against a digest committed here; the Rust
// toolchain is not downloaded by this workflow at all, and its visible
// evidence is the repository's exact pin plus a reported-version check. A
// step may not claim more than its own body does.
Deno.test("gate workflow claims digest verification only where a digest is checked", async () => {
  const text = await workflowText();
  assertIncludes(
    text,
    "name: Install the pinned Rust toolchain (exact pin, reported-version check)",
  );
  const lines = text.split("\n");
  const stepName = /^\s*-\s+name:\s*(.+)$/;
  for (let index = 0; index < lines.length; index++) {
    const name = stepName.exec(lines[index] ?? "")?.[1];
    if (name === undefined) continue;
    let end = index + 1;
    while (end < lines.length && !stepName.test(lines[end] ?? "")) end++;
    const body = lines.slice(index, end).join("\n");
    if (/digest-verified/.test(name) !== DIGEST_CHECK.test(body)) {
      throw new Error(`step evidence claim does not match its body: ${name}`);
    }
  }
});

Deno.test("gate workflow run blocks fail closed on pipeline errors", async () => {
  const text = await workflowText();
  const multiline = text.match(/run: \|/g) ?? [];
  const strict = text.match(/set -euo pipefail/g) ?? [];
  if (multiline.length === 0) {
    throw new Error("expected multiline setup steps");
  }
  if (strict.length !== multiline.length) {
    throw new Error(
      "every multiline run block must set -euo pipefail so a failed " +
        "download or version check fails the job",
    );
  }
});
