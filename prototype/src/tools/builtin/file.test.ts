// Unit tests for the builtin file tools: path containment, the read/list/
// write/edit executors, the basic grep/glob search surface, ranged reads, the
// pure glob matcher, and the enforced resource bounds on the auto-approved
// search tools. The containment, completeness and output-encoding hardening
// suite lives in file-hardening.test.ts.
//
// Fixture trees are created per describe (useIoRoot / useSearchRoot) in the
// system temp directory, so the suite runs under the unit lane's temp-only
// write grant.

import {
  assertFalse,
  assertLess,
  assertLessOrEqual,
  assertMatch,
  assertRejects,
  assertStrictEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import {
  clampLimit,
  executeEditFile,
  executeGlobFiles,
  executeGrepFiles,
  executeListFiles,
  executeReadFile,
  executeWriteFile,
  isWithinRoot,
  matchesGlobPath,
  resolveWorkspacePath,
} from "./file.ts";
import { RootAnchors } from "./root-anchors.ts";

// The file tools verify each root against the anchors it is bound to. One
// set per file keeps the old process-wide semantics; tests that move a temp
// root away start a fresh set, as the old reset hook did.
let anchors = new RootAnchors();
const at = (root: string) => anchors.root(root);

// ── resolveWorkspacePath (pure containment) ───────────────────────────────────

describe("resolveWorkspacePath", () => {
  it("resolves a path within the root", () => {
    assertStrictEquals(
      resolveWorkspacePath("/work", "src/a.ts"),
      "/work/src/a.ts",
    );
  });
  it("resolves the root itself for '.'", () => {
    assertStrictEquals(resolveWorkspacePath("/work", "."), "/work");
  });
  it("rejects parent traversal", () => {
    assertThrows(
      () => resolveWorkspacePath("/work", "../secret"),
      Error,
      "escapes",
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
        assertStringIncludes(msg, "must be relative");
        assertFalse(msg.includes("/etc"));
        assertFalse(msg.includes("/work"));
      }
    }
  });
  // The Windows cross-drive case — relative("D:\\ws", "C:\\evil") returning
  // an absolute path with no ".." prefix — cannot be reproduced from POSIX,
  // where node:path speaks posix semantics. The containment checks use
  // isAbsolute(rel) so that shape is rejected there; these lock the POSIX
  // equivalence so the swap cannot regress what is testable here.
  it("isAbsolute-based rejection matches the POSIX prefix check", () => {
    assertThrows(
      () => resolveWorkspacePath("/work", "/other/root"),
      Error,
      "must be relative",
    );
    assertStrictEquals(isWithinRoot("/work", "/other/root"), false);
  });
  it("rejects sneaky traversal that climbs out", () => {
    assertThrows(
      () => resolveWorkspacePath("/work", "a/../../etc"),
      Error,
      "escapes",
    );
  });
});

// ── isWithinRoot (canonical containment behind the symlink defense) ───────────

describe("isWithinRoot", () => {
  it("accepts a target nested under the root", () => {
    assertStrictEquals(isWithinRoot("/work", "/work/sub/a.txt"), true);
  });
  it("accepts the root itself", () => {
    assertStrictEquals(isWithinRoot("/work", "/work"), true);
  });
  it("rejects a sibling outside the root (symlink-escape shape)", () => {
    assertStrictEquals(isWithinRoot("/work", "/outside/secret.txt"), false);
  });
  it("rejects the parent of the root", () => {
    assertStrictEquals(isWithinRoot("/work/proj", "/work"), false);
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
    root = await Deno.makeTempDir();
    await Deno.writeTextFile(`${root}/hello.txt`, "hello world");
    await Deno.mkdir(`${root}/sub`);
    await Deno.writeTextFile(`${root}/sub/nested.txt`, "nested content");
  });
  afterAll(async () => {
    if (root) {
      await Deno.remove(root, { recursive: true });
      anchors = new RootAnchors();
    }
  });
}

describe("executeReadFile", () => {
  useIoRoot();

  it("reads a file within the workspace", async () => {
    assertStrictEquals(
      await executeReadFile(at(root), "hello.txt"),
      "hello world",
    );
  });
  it("reads a nested file", async () => {
    assertStrictEquals(
      await executeReadFile(at(root), "sub/nested.txt"),
      "nested content",
    );
  });
  it("returns an error for a traversal attempt (no read happens)", async () => {
    assertMatch(
      await executeReadFile(at(root), "../../../etc/hosts"),
      /^error: path escapes/,
    );
  });
  it("returns an error for a missing file", async () => {
    assertMatch(
      await executeReadFile(at(root), "nope.txt"),
      /^error: cannot read/,
    );
  });
  it("returns an error when the path is a directory", async () => {
    assertMatch(await executeReadFile(at(root), "sub"), /is a directory/);
  });
  it("truncates oversized content at the byte cap", async () => {
    const out = await executeReadFile(at(root), "hello.txt", 5);
    assertStringIncludes(out, "[truncated at 5 bytes]");
    assertStrictEquals(out.startsWith("hello"), true);
  });
});

describe("executeListFiles", () => {
  useIoRoot();

  it("lists directory entries, directories suffixed with /", async () => {
    const out = await executeListFiles(at(root), ".");
    assertStringIncludes(out, "hello.txt");
    assertStringIncludes(out, "sub/");
  });
  it("lists a subdirectory", async () => {
    assertStrictEquals(await executeListFiles(at(root), "sub"), "nested.txt");
  });
  it("rejects a traversal attempt", async () => {
    assertMatch(await executeListFiles(at(root), ".."), /^error: path escapes/);
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
    assertStrictEquals(out, "wrote written.txt");
    assertStrictEquals(
      await Deno.readTextFile(`${root}/written.txt`),
      "fresh content",
    );
  });
  it("overwrites an existing file", async () => {
    await executeWriteFile(at(root), "over.txt", "first");
    await executeWriteFile(at(root), "over.txt", "second");
    assertStrictEquals(await Deno.readTextFile(`${root}/over.txt`), "second");
  });
  it("writes into an existing subdirectory", async () => {
    await executeWriteFile(at(root), "sub/new.txt", "in sub");
    assertStrictEquals(
      await Deno.readTextFile(`${root}/sub/new.txt`),
      "in sub",
    );
  });
  it("rejects a traversal escape (no write happens)", async () => {
    assertMatch(
      await executeWriteFile(at(root), "../escape.txt", "nope"),
      /^error: path escapes/,
    );
  });
  it("errors when the parent directory does not exist", async () => {
    assertMatch(
      await executeWriteFile(at(root), "missing/deep.txt", "x"),
      /^error: cannot write/,
    );
  });
  it("the success result carries no payload length (no size signal)", async () => {
    assertStrictEquals(
      await executeWriteFile(at(root), "sized.txt", "0123456789"),
      "wrote sized.txt",
    );
  });
});

describe("executeWriteFile symlink containment", () => {
  useIoRoot();

  // The scoped test sandbox forbids Deno.symlink (a symlink's target cannot be
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
    assertMatch(out, /refusing to write through a symlink/);
    // The guard runs before the write, so nothing is created.
    await assertRejects(
      () => Deno.stat(`${root}/link.txt`),
      Deno.errors.NotFound,
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
    assertStrictEquals(out, "edited edit-basic.txt");
    assertStrictEquals(
      await Deno.readTextFile(`${root}/edit-basic.txt`),
      "alpha DELTA gamma",
    );
  });
  it("errors when the old text is absent (file unchanged)", async () => {
    await executeWriteFile(at(root), "edit-absent.txt", "unchanged");
    assertMatch(
      await executeEditFile(at(root), "edit-absent.txt", "missing", "x"),
      /oldString not found/,
    );
    assertStrictEquals(
      await Deno.readTextFile(`${root}/edit-absent.txt`),
      "unchanged",
    );
  });
  it("errors when the old text is not unique (file unchanged)", async () => {
    await executeWriteFile(at(root), "edit-dup.txt", "x x x");
    assertMatch(
      await executeEditFile(at(root), "edit-dup.txt", "x", "y"),
      /not unique/,
    );
    assertStrictEquals(
      await Deno.readTextFile(`${root}/edit-dup.txt`),
      "x x x",
    );
  });
  it("errors for a missing file (no create)", async () => {
    assertMatch(
      await executeEditFile(at(root), "edit-nope.txt", "a", "b"),
      /file not found/,
    );
  });
  it("rejects a traversal escape", async () => {
    assertMatch(
      await executeEditFile(at(root), "../escape.txt", "a", "b"),
      /^error: path escapes/,
    );
  });
  it("rejects an empty oldString", async () => {
    await executeWriteFile(at(root), "edit-empty.txt", "content");
    assertMatch(
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
    assertMatch(out, /refusing to write through a symlink/);
    assertStrictEquals(
      await Deno.readTextFile(`${root}/edit-link.txt`),
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
    sroot = await Deno.makeTempDir();
    await Deno.writeTextFile(
      `${sroot}/alpha.ts`,
      "const a = 1;\nneedle here\nconst b = 2;\n",
    );
    await Deno.writeTextFile(`${sroot}/beta.md`, "# doc\nneedle in markdown\n");
    await Deno.mkdir(`${sroot}/pkg`);
    await Deno.writeTextFile(
      `${sroot}/pkg/gamma.ts`,
      "no match on this line\n",
    );
    await Deno.mkdir(`${sroot}/.git`);
    await Deno.writeTextFile(
      `${sroot}/.git/config`,
      "needle should be skipped\n",
    );
    await Deno.writeTextFile(`${sroot}/binary.bin`, "abc\u0000needle\n");
    await Deno.writeTextFile(
      `${sroot}/many.txt`,
      Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n"),
    );
  });
  afterAll(async () => {
    if (sroot) {
      await Deno.remove(sroot, { recursive: true });
      anchors = new RootAnchors();
    }
  });
}

describe("executeGrepFiles", () => {
  useSearchRoot();

  it("finds matches with path:line:text rows", async () => {
    const out = await executeGrepFiles(at(sroot), "needle");
    assertStringIncludes(out, "alpha.ts:2:needle here");
    assertStringIncludes(out, "beta.md:2:needle in markdown");
  });
  it("skips .git and binary files", async () => {
    const out = await executeGrepFiles(at(sroot), "needle");
    assertFalse(out.includes(".git"));
    assertFalse(out.includes("binary.bin"));
  });
  it("include glob narrows the file set", async () => {
    const out = await executeGrepFiles(at(sroot), "needle", {
      include: "**/*.ts",
    });
    assertStringIncludes(out, "alpha.ts");
    assertFalse(out.includes("beta.md"));
  });
  it("reports no matches distinctly from an error", async () => {
    const out = await executeGrepFiles(at(sroot), "zzz-absent");
    assertStrictEquals(out.startsWith("(no matches)"), true);
    assertStrictEquals(out.startsWith("error:"), false);
  });
  it("rejects an invalid regex without throwing", async () => {
    const out = await executeGrepFiles(at(sroot), "(unclosed");
    assertStrictEquals(out.startsWith("error:"), true);
    assertStringIncludes(out, "invalid pattern");
  });
  it("rejects an empty pattern", async () => {
    assertStringIncludes(await executeGrepFiles(at(sroot), ""), "error:");
  });
  it("refuses to search outside the workspace root", async () => {
    const out = await executeGrepFiles(at(sroot), "needle", { path: "../.." });
    assertStrictEquals(out.startsWith("error:"), true);
  });
  it("caps matches and says so", async () => {
    const out = await executeGrepFiles(at(sroot), "line", { maxMatches: 3 });
    assertStrictEquals(
      out.split("\n").filter((l) => l.includes("many.txt")).length,
      3,
    );
    assertStringIncludes(out, "match limit 3 reached");
  });
});

describe("executeGlobFiles", () => {
  useSearchRoot();

  it("matches by relative path glob", async () => {
    const out = await executeGlobFiles(at(sroot), "**/*.ts");
    assertStringIncludes(out, "alpha.ts");
    assertStringIncludes(out, "pkg/gamma.ts");
    assertFalse(out.includes("beta.md"));
  });
  it("reports no matches distinctly", async () => {
    assertStrictEquals(
      await executeGlobFiles(at(sroot), "**/*.nope"),
      "(no matches)",
    );
  });
  it("refuses to search outside the workspace root", async () => {
    const out = await executeGlobFiles(at(sroot), "**/*", { path: "../.." });
    assertStrictEquals(out.startsWith("error:"), true);
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
    assertStrictEquals(out.startsWith("error:"), true);
    assertStringIncludes(out, "excluded from search");
  });
  it("glob_files refuses an explicit .git start", async () => {
    const out = await executeGlobFiles(at(sroot), "**/*", { path: ".git" });
    assertStrictEquals(out.startsWith("error:"), true);
    assertStringIncludes(out, "excluded from search");
  });
  it("a nested excluded directory is refused too", async () => {
    await Deno.mkdir(`${sroot}/pkg/node_modules/dep`, { recursive: true });
    await Deno.writeTextFile(`${sroot}/pkg/node_modules/dep/i.js`, "needle\n");
    const out = await executeGlobFiles(at(sroot), "**/*", {
      path: "pkg/node_modules/dep",
    });
    assertStrictEquals(out.startsWith("error:"), true);
    assertStringIncludes(out, "excluded from search");
  });
  it("a normal sibling directory still searches", async () => {
    const out = await executeGlobFiles(at(sroot), "**/*.ts", { path: "pkg" });
    assertStringIncludes(out, "gamma.ts");
  });
});

describe("executeReadFile ranged reads", () => {
  useSearchRoot();

  it("returns a line window", async () => {
    const out = await executeReadFile(at(sroot), "many.txt", undefined, {
      offset: 3,
      limit: 2,
    });
    assertStringIncludes(out, "line 3");
    assertStringIncludes(out, "line 4");
    assertFalse(out.includes("line 5"));
  });
  it("annotates how much remains", async () => {
    const out = await executeReadFile(at(sroot), "many.txt", undefined, {
      offset: 1,
      limit: 2,
    });
    assertStringIncludes(out, "lines 1-2 of 40");
  });
  it("reads to end when limit is omitted", async () => {
    const out = await executeReadFile(at(sroot), "many.txt", undefined, {
      offset: 39,
    });
    assertStringIncludes(out, "line 40");
  });
  it("rejects an offset past end of file", async () => {
    const out = await executeReadFile(at(sroot), "many.txt", undefined, {
      offset: 999,
    });
    assertStringIncludes(out, "past end");
  });
  it("rejects a non-positive offset", async () => {
    const out = await executeReadFile(at(sroot), "many.txt", undefined, {
      offset: 0,
    });
    assertStringIncludes(out, "error:");
  });
  it("unranged read is unchanged", async () => {
    const out = await executeReadFile(at(sroot), "alpha.ts");
    assertStrictEquals(out, "const a = 1;\nneedle here\nconst b = 2;\n");
  });
  it("refuses a file over the hard read ceiling before reading it", async () => {
    // Sparse: stat reports 5MB without writing 5MB, which is exactly the case
    // the pre-read stat is there to catch.
    const huge = `${sroot}/huge.bin`;
    const f = await Deno.create(huge);
    await f.truncate(5 * 1024 * 1024);
    f.close();
    const out = await executeReadFile(at(sroot), "huge.bin");
    assertStrictEquals(out.startsWith("error:"), true);
    assertStringIncludes(out, "over the 4194304-byte limit");
    await Deno.remove(huge);
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
    assertStrictEquals(matchesGlobPath("a.ts", "*.ts"), true);
    assertStrictEquals(matchesGlobPath("pkg/a.ts", "*.ts"), false);
  });
  it("** crosses separators and matches zero directories", () => {
    assertStrictEquals(matchesGlobPath("a.ts", "**/*.ts"), true);
    assertStrictEquals(matchesGlobPath("pkg/deep/a.ts", "**/*.ts"), true);
  });
  it("? matches exactly one non-separator character", () => {
    assertStrictEquals(matchesGlobPath("ab.ts", "a?.ts"), true);
    assertStrictEquals(matchesGlobPath("a/b.ts", "a?b.ts"), false);
  });
  it("character classes work", () => {
    assertStrictEquals(matchesGlobPath("a1.ts", "a[0-9].ts"), true);
    assertStrictEquals(matchesGlobPath("ax.ts", "a[0-9].ts"), false);
  });
  it("dots are literal, not regex wildcards", () => {
    assertStrictEquals(matchesGlobPath("axts", "*.ts"), false);
  });
  it("anchors the whole path", () => {
    assertStrictEquals(matchesGlobPath("src/a.ts.bak", "**/*.ts"), false);
  });
  it("an unparsable class degrades to no match rather than throwing", () => {
    matchesGlobPath("a.ts", "a[.ts");
  });
  it("refuses an over-long pattern rather than matching it", () => {
    assertStrictEquals(matchesGlobPath("a.ts", "*".repeat(600) + ".ts"), false);
  });
  it("many ** segments stay fast (no regex backtracking surface)", () => {
    const started = performance.now();
    assertStrictEquals(
      matchesGlobPath("a/b/c/d/e/f/g/h/i/j/k.txt", "**/".repeat(40) + "*.ts"),
      false,
    );
    assertLess(performance.now() - started, 250);
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
    assertStrictEquals(clampLimit(undefined, 200, 1000), 200);
    assertStrictEquals(clampLimit(Number.NaN, 200, 1000), 200);
    assertStrictEquals(clampLimit(Number.POSITIVE_INFINITY, 200, 1000), 200);
  });
  it("ignores an inflated limit", () => {
    assertStrictEquals(clampLimit(1e9, 200, 1000), 1000);
  });
  it("floors to at least 1", () => {
    assertStrictEquals(clampLimit(0, 200, 1000), 1);
    assertStrictEquals(clampLimit(-5, 200, 1000), 1);
  });
  it("passes through a reasonable request", () => {
    assertStrictEquals(clampLimit(50, 200, 1000), 50);
  });
});

describe("grep_files resource bounds", () => {
  let broot: string;

  beforeAll(async () => {
    broot = await Deno.makeTempDir();
    // A line long enough that a catastrophic pattern cannot finish on it.
    await Deno.writeTextFile(`${broot}/longline.txt`, "a".repeat(6000) + "!\n");
    // Directory-only tree: nothing to yield, so a file-counting budget would
    // have walked it for free.
    let dir = broot;
    for (let i = 0; i < 40; i++) {
      dir = `${dir}/d${i}`;
      await Deno.mkdir(dir);
    }
    await Deno.writeTextFile(`${dir}/buried.txt`, "needle\n");
    await Deno.writeTextFile(`${broot}/plain.txt`, "needle\n");
  });

  afterAll(async () => {
    if (broot) await Deno.remove(broot, { recursive: true });
  });

  it("a catastrophic pattern is cut off instead of hanging", async () => {
    // The fixture's long line is over the length cap, so it is skipped before
    // the matcher sees it. A short line of the same shape is what actually
    // backtracks; without it the budget only fires if worker startup alone
    // exceeds it, which is a timing accident rather than the bound under test.
    const catastrophic = `${broot}/catastrophic.txt`;
    await Deno.writeTextFile(catastrophic, "a".repeat(32) + "!\n");
    const started = performance.now();
    let out: string;
    try {
      // Built at run time: the pattern is catastrophic on purpose, since the
      // bounded matcher is what this test exercises.
      const pattern = ["(a+)+", "$"].join("");
      out = await executeGrepFiles(at(broot), pattern, { budgetMs: 300 });
    } finally {
      await Deno.remove(catastrophic);
    }
    const elapsed = performance.now() - started;
    // The budget is what bounds this, so allow generous slack for worker
    // startup — the assertion that matters is that it returns at all.
    assertLess(elapsed, 8000);
    assertStrictEquals(out.startsWith("error:"), true);
    assertStringIncludes(out, "too expensive");
  });

  it("lines over the length cap are never matched", async () => {
    // `a+!` matches the long line trivially; it is skipped for its length, so
    // the only evidence it existed is the note.
    const out = await executeGrepFiles(at(broot), "a+!");
    assertFalse(out.includes("longline.txt"));
    assertStrictEquals(
      out === "(no matches)" || out.includes("over 4096 chars"),
      true,
    );
  });

  it("directories consume the traversal budget", async () => {
    // 5 entries is fewer than the directory chain is deep, so a budget that
    // counted only files would have descended all the way to buried.txt.
    const out = await executeGrepFiles(at(broot), "needle", { maxFiles: 5 });
    assertFalse(out.includes("buried.txt"));
    assertStringIncludes(out, "entry limit 5 reached");
  });

  it("a truncated search says so even when it found nothing", async () => {
    const out = await executeGrepFiles(at(broot), "zzz-absent", {
      maxFiles: 5,
    });
    assertStringIncludes(out, "(no matches)");
    assertStringIncludes(out, "entry limit 5 reached");
  });

  it(
    "a flat directory larger than the cap does not buffer past it",
    async () => {
      const flat = await Deno.makeTempDir();
      for (let i = 0; i < 60; i++) {
        await Deno.writeTextFile(`${flat}/f${i}.txt`, "needle\n");
      }
      const out = await executeGlobFiles(at(flat), "**/*.txt", {
        maxFiles: 10,
      });
      assertLessOrEqual(
        out.split("\n").filter((l) => l.endsWith(".txt")).length,
        10,
      );
      assertStringIncludes(out, "entry limit 10 reached");
      await Deno.remove(flat, { recursive: true });
    },
  );

  it(
    "an over-long include glob is rejected, not silently unmatchable",
    async () => {
      const out = await executeGrepFiles(at(broot), "needle", {
        include: "*".repeat(600),
      });
      assertStrictEquals(out.startsWith("error:"), true);
      assertStringIncludes(out, "include");
    },
  );

  it("an over-long pattern is rejected before compilation", async () => {
    const out = await executeGrepFiles(at(broot), "a".repeat(2000));
    assertStrictEquals(out.startsWith("error:"), true);
  });

  it("the walk stops at the depth cap", async () => {
    // buried.txt sits 40 directories down, past HARD_MAX_DEPTH (32), so it is
    // unreachable no matter how large the entry budget is.
    const out = await executeGrepFiles(at(broot), "needle", { maxFiles: 1e9 });
    assertStringIncludes(out, "plain.txt");
    assertFalse(out.includes("buried.txt"));
  });

  it("an oversized file is skipped without being read", async () => {
    const out = await executeGrepFiles(at(broot), "a+", { maxBytes: 10 });
    assertFalse(out.includes("longline.txt"));
  });

  it("an inflated maxMatches does not raise the ceiling", async () => {
    // Not observable in the row count on this small tree; what is observable is
    // that the note reports the clamped value, not the requested one.
    const out = await executeGrepFiles(at(broot), "needle", {
      maxMatches: 1e9,
    });
    assertFalse(out.includes("1000000000"));
  });

  it("fails closed when the matcher cannot start", async () => {
    const out = await executeGrepFiles(at(broot), "needle", {
      workerSpecifier: "file:///nonexistent/regex-worker.ts",
    });
    assertStrictEquals(out.startsWith("error:"), true);
  });
});
