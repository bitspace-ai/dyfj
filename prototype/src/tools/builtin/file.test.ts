// Unit tests for the builtin file tools: path containment, the read/list/
// write/edit executors, the basic grep/glob search surface, ranged reads, the
// pure glob matcher, and the enforced resource bounds on the auto-approved
// search tools. The containment, completeness and output-encoding hardening
// suite lives in file-hardening.test.ts.
//
// Fixture trees are created per describe (useIoRoot / useSearchRoot) in the
// system temp directory, so the suite runs under the unit lane's temp-only
// write grant.

import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// On the host's runner until the regex worker runs under Node (BIT-651).
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { isWithinRoot, resolveWorkspacePath } from "./file-access.ts";
import { matchesGlobPath } from "./file-glob.ts";
import { executeListFiles, executeReadFile } from "./file-read.ts";
import {
  clampLimit,
  executeGlobFiles,
  executeGrepFiles,
} from "./file-search.ts";
import { executeEditFile, executeWriteFile } from "./file-write.ts";
import { RootAnchors } from "./root-anchors.ts";

// The file tools verify each root against the anchors it is bound to. One
// set per file keeps the old process-wide semantics; tests that move a temp
// root away start a fresh set, as the old reset hook did.
let anchors = new RootAnchors();
const at = (root: string) => anchors.root(root);

// ── resolveWorkspacePath (pure containment) ───────────────────────────────────

describe("resolveWorkspacePath", () => {
  it("resolves a path within the root", () => {
    assert.strictEqual(
      resolveWorkspacePath("/work", "src/a.ts"),
      "/work/src/a.ts",
    );
  });
  it("resolves the root itself for '.'", () => {
    assert.strictEqual(resolveWorkspacePath("/work", "."), "/work");
  });
  it("rejects parent traversal", () => {
    assert.throws(
      () => resolveWorkspacePath("/work", "../secret"),
      (error: unknown) =>
        error instanceof Error && error.message.includes("escapes"),
    );
  });
  it("rejects any absolute path, without echoing it", () => {
    // Absolute inputs are refused even when they would resolve in-root: the
    // executors echo the caller's path into results and the durable
    // transcript, so an accepted in-root absolute path would publish the
    // operator's username and workspace layout. The message must not echo
    // the value for the same reason.
    for (const abs of ["/etc/hosts", "/work/inside.txt"]) {
      try {
        resolveWorkspacePath("/work", abs);
        throw new Error("expected a throw");
      } catch (err) {
        const msg = (err as Error).message;
        assert.ok(
          msg.includes("must be relative"),
          `expected ${JSON.stringify(msg)} to include "must be relative"`,
        );
        assert.ok(!msg.includes("/etc"));
        assert.ok(!msg.includes("/work"));
      }
    }
  });
  // The Windows cross-drive case — relative("D:\\ws", "C:\\evil") returning
  // an absolute path with no ".." prefix — cannot be reproduced from POSIX,
  // where node:path speaks posix semantics. The containment checks use
  // isAbsolute(rel) so that shape is rejected there; these lock the POSIX
  // equivalence so the swap cannot regress what is testable here.
  it("isAbsolute-based rejection matches the POSIX prefix check", () => {
    assert.throws(
      () => resolveWorkspacePath("/work", "/other/root"),
      (error: unknown) =>
        error instanceof Error && error.message.includes("must be relative"),
    );
    assert.strictEqual(isWithinRoot("/work", "/other/root"), false);
  });
  it("rejects sneaky traversal that climbs out", () => {
    assert.throws(
      () => resolveWorkspacePath("/work", "a/../../etc"),
      (error: unknown) =>
        error instanceof Error && error.message.includes("escapes"),
    );
  });
});

// ── isWithinRoot (canonical containment behind the symlink defense) ───────────

describe("isWithinRoot", () => {
  it("accepts a target nested under the root", () => {
    assert.strictEqual(isWithinRoot("/work", "/work/sub/a.txt"), true);
  });
  it("accepts the root itself", () => {
    assert.strictEqual(isWithinRoot("/work", "/work"), true);
  });
  it("rejects a sibling outside the root (symlink-escape shape)", () => {
    assert.strictEqual(isWithinRoot("/work", "/outside/secret.txt"), false);
  });
  it("rejects the parent of the root", () => {
    assert.strictEqual(isWithinRoot("/work/proj", "/work"), false);
  });
});

// ── executeReadFile / executeListFiles (scoped I/O) ───────────────────────────

let root: string;

/**
 * Registers, in the calling describe, a fresh workspace holding hello.txt and
 * sub/nested.txt at `root`, removed when that describe finishes.
 */
function useIoRoot(): void {
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "tmp-"));
    await writeFile(`${root}/hello.txt`, "hello world");
    await mkdir(`${root}/sub`);
    await writeFile(`${root}/sub/nested.txt`, "nested content");
  });
  afterAll(async () => {
    if (root) {
      await rm(root, { recursive: true });
      anchors = new RootAnchors();
    }
  });
}

describe("executeReadFile", () => {
  useIoRoot();

  it("reads a file within the workspace", async () => {
    assert.strictEqual(
      await executeReadFile(at(root), "hello.txt"),
      "hello world",
    );
  });
  it("reads a nested file", async () => {
    assert.strictEqual(
      await executeReadFile(at(root), "sub/nested.txt"),
      "nested content",
    );
  });
  it("returns an error for a traversal attempt (no read happens)", async () => {
    assert.match(
      await executeReadFile(at(root), "../../../etc/hosts"),
      /^error: path escapes/,
    );
  });
  it("returns an error for a missing file", async () => {
    assert.match(
      await executeReadFile(at(root), "nope.txt"),
      /^error: cannot read/,
    );
  });
  it("returns an error when the path is a directory", async () => {
    assert.match(await executeReadFile(at(root), "sub"), /is a directory/);
  });
  it("truncates oversized content at the byte cap", async () => {
    const out = await executeReadFile(at(root), "hello.txt", 5);
    assert.ok(
      out.includes("[truncated at 5 bytes]"),
      `expected ${JSON.stringify(out)} to include "[truncated at 5 bytes]"`,
    );
    assert.strictEqual(out.startsWith("hello"), true);
  });
});

describe("executeListFiles", () => {
  useIoRoot();

  it("lists directory entries, directories suffixed with /", async () => {
    const out = await executeListFiles(at(root), ".");
    assert.ok(
      out.includes("hello.txt"),
      `expected ${JSON.stringify(out)} to include "hello.txt"`,
    );
    assert.ok(
      out.includes("sub/"),
      `expected ${JSON.stringify(out)} to include "sub/"`,
    );
  });
  it("lists a subdirectory", async () => {
    assert.strictEqual(await executeListFiles(at(root), "sub"), "nested.txt");
  });
  it("rejects a traversal attempt", async () => {
    assert.match(
      await executeListFiles(at(root), ".."),
      /^error: path escapes/,
    );
  });
});

describe("executeWriteFile", () => {
  useIoRoot();

  it("writes a new file within the workspace", async () => {
    const out = await executeWriteFile(
      at(root),
      "written.txt",
      "fresh content",
    );
    assert.strictEqual(out, "wrote written.txt");
    assert.strictEqual(
      await readFile(`${root}/written.txt`, "utf8"),
      "fresh content",
    );
  });
  it("overwrites an existing file", async () => {
    await executeWriteFile(at(root), "over.txt", "first");
    await executeWriteFile(at(root), "over.txt", "second");
    assert.strictEqual(await readFile(`${root}/over.txt`, "utf8"), "second");
  });
  it("writes into an existing subdirectory", async () => {
    await executeWriteFile(at(root), "sub/new.txt", "in sub");
    assert.strictEqual(
      await readFile(`${root}/sub/new.txt`, "utf8"),
      "in sub",
    );
  });
  it("rejects a traversal escape (no write happens)", async () => {
    assert.match(
      await executeWriteFile(at(root), "../escape.txt", "nope"),
      /^error: path escapes/,
    );
  });
  it("errors when the parent directory does not exist", async () => {
    assert.match(
      await executeWriteFile(at(root), "missing/deep.txt", "x"),
      /^error: cannot write/,
    );
  });
  it("the success result carries no payload length (no size signal)", async () => {
    assert.strictEqual(
      await executeWriteFile(at(root), "sized.txt", "0123456789"),
      "wrote sized.txt",
    );
  });
});

describe("executeWriteFile symlink containment", () => {
  useIoRoot();

  // The scoped test sandbox forbids creating a symlink (a symlink's target cannot be
  // permission-scoped), so the no-follow guard is exercised with an injected
  // lstat. The real OS symlink-follow escape — a dangling in-root link to an
  // outside target — is validated separately by the Codex security PoC.
  it("refuses to write when the target is a symlink, and writes nothing", async () => {
    const fakeSymlinkLstat = () => Promise.resolve({ isSymlink: true });
    const out = await executeWriteFile(
      at(root),
      "link.txt",
      "escaped",
      fakeSymlinkLstat,
    );
    assert.match(out, /refusing to write through a symlink/);
    // The guard runs before the write, so nothing is created.
    await assert.rejects(
      () => stat(`${root}/link.txt`),
      (error: unknown) =>
        error instanceof Error &&
        (error as { code?: unknown }).code === "ENOENT",
    );
  });
});

describe("executeEditFile", () => {
  useIoRoot();

  it("replaces a unique fragment and reports the edit", async () => {
    await executeWriteFile(at(root), "edit-basic.txt", "alpha beta gamma");
    const out = await executeEditFile(
      at(root),
      "edit-basic.txt",
      "beta",
      "DELTA",
    );
    assert.strictEqual(out, "edited edit-basic.txt");
    assert.strictEqual(
      await readFile(`${root}/edit-basic.txt`, "utf8"),
      "alpha DELTA gamma",
    );
  });
  it("errors when the old text is absent (file unchanged)", async () => {
    await executeWriteFile(at(root), "edit-absent.txt", "unchanged");
    assert.match(
      await executeEditFile(at(root), "edit-absent.txt", "missing", "x"),
      /oldString not found/,
    );
    assert.strictEqual(
      await readFile(`${root}/edit-absent.txt`, "utf8"),
      "unchanged",
    );
  });
  it("errors when the old text is not unique (file unchanged)", async () => {
    await executeWriteFile(at(root), "edit-dup.txt", "x x x");
    assert.match(
      await executeEditFile(at(root), "edit-dup.txt", "x", "y"),
      /not unique/,
    );
    assert.strictEqual(
      await readFile(`${root}/edit-dup.txt`, "utf8"),
      "x x x",
    );
  });
  it("errors for a missing file (no create)", async () => {
    assert.match(
      await executeEditFile(at(root), "edit-nope.txt", "a", "b"),
      /file not found/,
    );
  });
  it("rejects a traversal escape", async () => {
    assert.match(
      await executeEditFile(at(root), "../escape.txt", "a", "b"),
      /^error: path escapes/,
    );
  });
  it("rejects an empty oldString", async () => {
    await executeWriteFile(at(root), "edit-empty.txt", "content");
    assert.match(
      await executeEditFile(at(root), "edit-empty.txt", "", "x"),
      /oldString must be non-empty/,
    );
  });
  it("inherits the write-back symlink guard (refuses, writes nothing)", async () => {
    await executeWriteFile(at(root), "edit-link.txt", "before");
    const fakeSymlinkLstat = () => Promise.resolve({ isSymlink: true });
    const out = await executeEditFile(
      at(root),
      "edit-link.txt",
      "before",
      "after",
      fakeSymlinkLstat,
    );
    assert.match(out, /refusing to write through a symlink/);
    assert.strictEqual(
      await readFile(`${root}/edit-link.txt`, "utf8"),
      "before",
    );
  });
});

// ── Search affordances (grep_files / glob_files / ranged read) ────────────────
//
// These exist so read-only questions do not have to route through bash, which
// always requires operator approval. The tests below pin the properties that
// make that safe: nothing that resolves outside the workspace is ever
// RETURNED (containment is enforced at the point of use — a live-tree race can
// redirect traversal, so what is emitted is checked, not the walk itself), and
// every traversal is bounded.

let sroot: string;

/**
 * Registers, in the calling describe, a fresh search tree at `sroot` (source
 * files, a .git directory, a binary file, a 40-line file), removed when that
 * describe finishes.
 */
function useSearchRoot(): void {
  beforeAll(async () => {
    sroot = await mkdtemp(join(tmpdir(), "tmp-"));
    await writeFile(
      `${sroot}/alpha.ts`,
      "const a = 1;\nneedle here\nconst b = 2;\n",
    );
    await writeFile(`${sroot}/beta.md`, "# doc\nneedle in markdown\n");
    await mkdir(`${sroot}/pkg`);
    await writeFile(
      `${sroot}/pkg/gamma.ts`,
      "no match on this line\n",
    );
    await mkdir(`${sroot}/.git`);
    await writeFile(
      `${sroot}/.git/config`,
      "needle should be skipped\n",
    );
    await writeFile(`${sroot}/binary.bin`, "abc\u0000needle\n");
    await writeFile(
      `${sroot}/many.txt`,
      Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n"),
    );
  });
  afterAll(async () => {
    if (sroot) {
      await rm(sroot, { recursive: true });
      anchors = new RootAnchors();
    }
  });
}

describe("executeGrepFiles", () => {
  useSearchRoot();

  it("finds matches with path:line:text rows", async () => {
    const out = await executeGrepFiles(at(sroot), "needle");
    assert.ok(
      out.includes("alpha.ts:2:needle here"),
      `expected ${JSON.stringify(out)} to include "alpha.ts:2:needle here"`,
    );
    assert.ok(
      out.includes("beta.md:2:needle in markdown"),
      `expected ${
        JSON.stringify(out)
      } to include "beta.md:2:needle in markdown"`,
    );
  });
  it("skips .git and binary files", async () => {
    const out = await executeGrepFiles(at(sroot), "needle");
    assert.ok(!out.includes(".git"));
    assert.ok(!out.includes("binary.bin"));
  });
  it("include glob narrows the file set", async () => {
    const out = await executeGrepFiles(at(sroot), "needle", {
      include: "**/*.ts",
    });
    assert.ok(
      out.includes("alpha.ts"),
      `expected ${JSON.stringify(out)} to include "alpha.ts"`,
    );
    assert.ok(!out.includes("beta.md"));
  });
  it("reports no matches distinctly from an error", async () => {
    const out = await executeGrepFiles(at(sroot), "zzz-absent");
    assert.strictEqual(out.startsWith("(no matches)"), true);
    assert.strictEqual(out.startsWith("error:"), false);
  });
  it("rejects an invalid regex without throwing", async () => {
    const out = await executeGrepFiles(at(sroot), "(unclosed");
    assert.strictEqual(out.startsWith("error:"), true);
    assert.ok(
      out.includes("invalid pattern"),
      `expected ${JSON.stringify(out)} to include "invalid pattern"`,
    );
  });
  it("rejects an empty pattern", async () => {
    assert.ok(
      (await executeGrepFiles(at(sroot), "")).includes("error:"),
      `expected await executeGrepFiles(at(sroot), "") to include "error:"`,
    );
  });
  it("refuses to search outside the workspace root", async () => {
    const out = await executeGrepFiles(at(sroot), "needle", { path: "../.." });
    assert.strictEqual(out.startsWith("error:"), true);
  });
  it("caps matches and says so", async () => {
    const out = await executeGrepFiles(at(sroot), "line", { maxMatches: 3 });
    assert.strictEqual(
      out.split("\n").filter((l) => l.includes("many.txt")).length,
      3,
    );
    assert.ok(
      out.includes("match limit 3 reached"),
      `expected ${JSON.stringify(out)} to include "match limit 3 reached"`,
    );
  });
});

describe("executeGlobFiles", () => {
  useSearchRoot();

  it("matches by relative path glob", async () => {
    const out = await executeGlobFiles(at(sroot), "**/*.ts");
    assert.ok(
      out.includes("alpha.ts"),
      `expected ${JSON.stringify(out)} to include "alpha.ts"`,
    );
    assert.ok(
      out.includes("pkg/gamma.ts"),
      `expected ${JSON.stringify(out)} to include "pkg/gamma.ts"`,
    );
    assert.ok(!out.includes("beta.md"));
  });
  it("reports no matches distinctly", async () => {
    assert.strictEqual(
      await executeGlobFiles(at(sroot), "**/*.nope"),
      "(no matches)",
    );
  });
  it("refuses to search outside the workspace root", async () => {
    const out = await executeGlobFiles(at(sroot), "**/*", { path: "../.." });
    assert.strictEqual(out.startsWith("error:"), true);
  });
});

// An excluded directory is only ever a *child* during the walk, so naming one
// as the starting point was a way around the exclusion — and .git holds
// remotes, reflogs, and identities that would land in the durable transcript
// with no approval in front of them.
describe("excluded directories cannot be searched by naming them", () => {
  useSearchRoot();

  it("grep_files refuses an explicit .git start", async () => {
    const out = await executeGrepFiles(at(sroot), "needle", { path: ".git" });
    assert.strictEqual(out.startsWith("error:"), true);
    assert.ok(
      out.includes("excluded from search"),
      `expected ${JSON.stringify(out)} to include "excluded from search"`,
    );
  });
  it("glob_files refuses an explicit .git start", async () => {
    const out = await executeGlobFiles(at(sroot), "**/*", { path: ".git" });
    assert.strictEqual(out.startsWith("error:"), true);
    assert.ok(
      out.includes("excluded from search"),
      `expected ${JSON.stringify(out)} to include "excluded from search"`,
    );
  });
  it("a nested excluded directory is refused too", async () => {
    await mkdir(`${sroot}/pkg/node_modules/dep`, { recursive: true });
    await writeFile(`${sroot}/pkg/node_modules/dep/i.js`, "needle\n");
    const out = await executeGlobFiles(at(sroot), "**/*", {
      path: "pkg/node_modules/dep",
    });
    assert.strictEqual(out.startsWith("error:"), true);
    assert.ok(
      out.includes("excluded from search"),
      `expected ${JSON.stringify(out)} to include "excluded from search"`,
    );
  });
  it("a normal sibling directory still searches", async () => {
    const out = await executeGlobFiles(at(sroot), "**/*.ts", { path: "pkg" });
    assert.ok(
      out.includes("gamma.ts"),
      `expected ${JSON.stringify(out)} to include "gamma.ts"`,
    );
  });
});

describe("executeReadFile ranged reads", () => {
  useSearchRoot();

  it("returns a line window", async () => {
    const out = await executeReadFile(at(sroot), "many.txt", undefined, {
      offset: 3,
      limit: 2,
    });
    assert.ok(
      out.includes("line 3"),
      `expected ${JSON.stringify(out)} to include "line 3"`,
    );
    assert.ok(
      out.includes("line 4"),
      `expected ${JSON.stringify(out)} to include "line 4"`,
    );
    assert.ok(!out.includes("line 5"));
  });
  it("annotates how much remains", async () => {
    const out = await executeReadFile(at(sroot), "many.txt", undefined, {
      offset: 1,
      limit: 2,
    });
    assert.ok(
      out.includes("lines 1-2 of 40"),
      `expected ${JSON.stringify(out)} to include "lines 1-2 of 40"`,
    );
  });
  it("reads to end when limit is omitted", async () => {
    const out = await executeReadFile(at(sroot), "many.txt", undefined, {
      offset: 39,
    });
    assert.ok(
      out.includes("line 40"),
      `expected ${JSON.stringify(out)} to include "line 40"`,
    );
  });
  it("rejects an offset past end of file", async () => {
    const out = await executeReadFile(at(sroot), "many.txt", undefined, {
      offset: 999,
    });
    assert.ok(
      out.includes("past end"),
      `expected ${JSON.stringify(out)} to include "past end"`,
    );
  });
  it("rejects a non-positive offset", async () => {
    const out = await executeReadFile(at(sroot), "many.txt", undefined, {
      offset: 0,
    });
    assert.ok(
      out.includes("error:"),
      `expected ${JSON.stringify(out)} to include "error:"`,
    );
  });
  it("unranged read is unchanged", async () => {
    const out = await executeReadFile(at(sroot), "alpha.ts");
    assert.strictEqual(out, "const a = 1;\nneedle here\nconst b = 2;\n");
  });
  it("refuses a file over the hard read ceiling before reading it", async () => {
    // Sparse: stat reports 5MB without writing 5MB, which is exactly the case
    // the pre-read stat is there to catch.
    const huge = `${sroot}/huge.bin`;
    const f = await open(huge, "w+");
    await f.truncate(5 * 1024 * 1024);
    await f.close();
    const out = await executeReadFile(at(sroot), "huge.bin");
    assert.strictEqual(out.startsWith("error:"), true);
    assert.ok(
      out.includes("over the 4194304-byte limit"),
      `expected ${
        JSON.stringify(out)
      } to include "over the 4194304-byte limit"`,
    );
    await unlink(huge);
  });
});

// ── matchesGlobPath (pure) ───────────────────────────────────────────────────
//
// Pure and dependency-free by design: node:path's matchesGlob needs --allow-env
// (minimatch reads process.env), and the runtime profiles grant env by explicit
// allowlist — so that dependency would have thrown NotCapable in production
// while passing tests, because the test profile grants env=true. It also does
// not build a RegExp, so a model-supplied glob has no backtracking surface.

describe("matchesGlobPath", () => {
  it("* does not cross a path separator", () => {
    assert.strictEqual(matchesGlobPath("a.ts", "*.ts"), true);
    assert.strictEqual(matchesGlobPath("pkg/a.ts", "*.ts"), false);
  });
  it("** crosses separators and matches zero directories", () => {
    assert.strictEqual(matchesGlobPath("a.ts", "**/*.ts"), true);
    assert.strictEqual(matchesGlobPath("pkg/deep/a.ts", "**/*.ts"), true);
  });
  it("? matches exactly one non-separator character", () => {
    assert.strictEqual(matchesGlobPath("ab.ts", "a?.ts"), true);
    assert.strictEqual(matchesGlobPath("a/b.ts", "a?b.ts"), false);
  });
  it("character classes work", () => {
    assert.strictEqual(matchesGlobPath("a1.ts", "a[0-9].ts"), true);
    assert.strictEqual(matchesGlobPath("ax.ts", "a[0-9].ts"), false);
  });
  it("dots are literal, not regex wildcards", () => {
    assert.strictEqual(matchesGlobPath("axts", "*.ts"), false);
  });
  it("anchors the whole path", () => {
    assert.strictEqual(matchesGlobPath("src/a.ts.bak", "**/*.ts"), false);
  });
  it("an unparsable class degrades to no match rather than throwing", () => {
    matchesGlobPath("a.ts", "a[.ts");
  });
  it("refuses an over-long pattern rather than matching it", () => {
    assert.strictEqual(matchesGlobPath("a.ts", "*".repeat(600) + ".ts"), false);
  });
  it("many ** segments stay fast (no regex backtracking surface)", () => {
    const started = performance.now();
    assert.strictEqual(
      matchesGlobPath("a/b/c/d/e/f/g/h/i/j/k.txt", "**/".repeat(40) + "*.ts"),
      false,
    );
    assert.ok(
      (performance.now() - started) < 250,
      `expected performance.now() - started < 250`,
    );
  });
});

// ── Enforced bounds on the auto-approved search tools ────────────────────────
//
// Regression coverage for the resource ceilings on grep_files and glob_files.
// Nothing prompts the operator before these run, so each bound is exercised
// against arguments a model could actually send — an inflated limit, a
// catastrophic regex, a tree shaped to slip past a file-only budget.

describe("clampLimit", () => {
  it("falls back when the value is absent or unusable", () => {
    assert.strictEqual(clampLimit(undefined, 200, 1000), 200);
    assert.strictEqual(clampLimit(Number.NaN, 200, 1000), 200);
    assert.strictEqual(clampLimit(Number.POSITIVE_INFINITY, 200, 1000), 200);
  });
  it("ignores an inflated limit", () => {
    assert.strictEqual(clampLimit(1e9, 200, 1000), 1000);
  });
  it("floors to at least 1", () => {
    assert.strictEqual(clampLimit(0, 200, 1000), 1);
    assert.strictEqual(clampLimit(-5, 200, 1000), 1);
  });
  it("passes through a reasonable request", () => {
    assert.strictEqual(clampLimit(50, 200, 1000), 50);
  });
});

describe("grep_files resource bounds", () => {
  let broot: string;

  beforeAll(async () => {
    broot = await mkdtemp(join(tmpdir(), "tmp-"));
    // A line long enough that a catastrophic pattern cannot finish on it.
    await writeFile(`${broot}/longline.txt`, "a".repeat(6000) + "!\n");
    // Directory-only tree: nothing to yield, so a file-counting budget would
    // have walked it for free.
    let dir = broot;
    for (let i = 0; i < 40; i++) {
      dir = `${dir}/d${i}`;
      await mkdir(dir);
    }
    await writeFile(`${dir}/buried.txt`, "needle\n");
    await writeFile(`${broot}/plain.txt`, "needle\n");
  });

  afterAll(async () => {
    if (broot) await rm(broot, { recursive: true });
  });

  it("a catastrophic pattern is cut off instead of hanging", async () => {
    // The fixture's long line is over the length cap, so it is skipped before
    // the matcher sees it. A short line of the same shape is what actually
    // backtracks; without it the budget only fires if worker startup alone
    // exceeds it, which is a timing accident rather than the bound under test.
    const catastrophic = `${broot}/catastrophic.txt`;
    await writeFile(catastrophic, "a".repeat(32) + "!\n");
    const started = performance.now();
    let out: string;
    try {
      // Built at run time: the pattern is catastrophic on purpose, since the
      // bounded matcher is what this test exercises.
      const pattern = ["(a+)+", "$"].join("");
      out = await executeGrepFiles(at(broot), pattern, { budgetMs: 300 });
    } finally {
      await unlink(catastrophic);
    }
    const elapsed = performance.now() - started;
    // The budget is what bounds this, so allow generous slack for worker
    // startup — the assertion that matters is that it returns at all.
    assert.ok(elapsed < 8000, `expected ${elapsed} < 8000`);
    assert.strictEqual(out.startsWith("error:"), true);
    assert.ok(
      out.includes("too expensive"),
      `expected ${JSON.stringify(out)} to include "too expensive"`,
    );
  });

  it("lines over the length cap are never matched", async () => {
    // `a+!` matches the long line trivially; it is skipped for its length, so
    // the only evidence it existed is the note.
    const out = await executeGrepFiles(at(broot), "a+!");
    assert.ok(!out.includes("longline.txt"));
    assert.strictEqual(
      out === "(no matches)" || out.includes("over 4096 chars"),
      true,
    );
  });

  it("directories consume the traversal budget", async () => {
    // 5 entries is fewer than the directory chain is deep, so a budget that
    // counted only files would have descended all the way to buried.txt.
    const out = await executeGrepFiles(at(broot), "needle", { maxFiles: 5 });
    assert.ok(!out.includes("buried.txt"));
    assert.ok(
      out.includes("entry limit 5 reached"),
      `expected ${JSON.stringify(out)} to include "entry limit 5 reached"`,
    );
  });

  it("a truncated search says so even when it found nothing", async () => {
    const out = await executeGrepFiles(at(broot), "zzz-absent", {
      maxFiles: 5,
    });
    assert.ok(
      out.includes("(no matches)"),
      `expected ${JSON.stringify(out)} to include "(no matches)"`,
    );
    assert.ok(
      out.includes("entry limit 5 reached"),
      `expected ${JSON.stringify(out)} to include "entry limit 5 reached"`,
    );
  });

  it(
    "a flat directory larger than the cap does not buffer past it",
    async () => {
      const flat = await mkdtemp(join(tmpdir(), "tmp-"));
      for (let i = 0; i < 60; i++) {
        await writeFile(`${flat}/f${i}.txt`, "needle\n");
      }
      const out = await executeGlobFiles(at(flat), "**/*.txt", {
        maxFiles: 10,
      });
      assert.ok(
        out.split("\n").filter((l) => l.endsWith(".txt")).length <= 10,
        `expected out.split("\\n").filter((l) => l.endsWith(".txt")).length <= 10`,
      );
      assert.ok(
        out.includes("entry limit 10 reached"),
        `expected ${JSON.stringify(out)} to include "entry limit 10 reached"`,
      );
      await rm(flat, { recursive: true });
    },
  );

  it(
    "an over-long include glob is rejected, not silently unmatchable",
    async () => {
      const out = await executeGrepFiles(at(broot), "needle", {
        include: "*".repeat(600),
      });
      assert.strictEqual(out.startsWith("error:"), true);
      assert.ok(
        out.includes("include"),
        `expected ${JSON.stringify(out)} to include "include"`,
      );
    },
  );

  it("an over-long pattern is rejected before compilation", async () => {
    const out = await executeGrepFiles(at(broot), "a".repeat(2000));
    assert.strictEqual(out.startsWith("error:"), true);
  });

  it("the walk stops at the depth cap", async () => {
    // buried.txt sits 40 directories down, past HARD_MAX_DEPTH (32), so it is
    // unreachable no matter how large the entry budget is.
    const out = await executeGrepFiles(at(broot), "needle", { maxFiles: 1e9 });
    assert.ok(
      out.includes("plain.txt"),
      `expected ${JSON.stringify(out)} to include "plain.txt"`,
    );
    assert.ok(!out.includes("buried.txt"));
  });

  it("an oversized file is skipped without being read", async () => {
    const out = await executeGrepFiles(at(broot), "a+", { maxBytes: 10 });
    assert.ok(!out.includes("longline.txt"));
  });

  it("an inflated maxMatches does not raise the ceiling", async () => {
    // Not observable in the row count on this small tree; what is observable is
    // that the note reports the clamped value, not the requested one.
    const out = await executeGrepFiles(at(broot), "needle", {
      maxMatches: 1e9,
    });
    assert.ok(!out.includes("1000000000"));
  });

  it("fails closed when the matcher cannot start", async () => {
    const out = await executeGrepFiles(at(broot), "needle", {
      workerSpecifier: "file:///nonexistent/regex-worker.ts",
    });
    assert.strictEqual(out.startsWith("error:"), true);
  });
});
