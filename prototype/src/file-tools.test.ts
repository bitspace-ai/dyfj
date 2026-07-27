import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  executeEditFile,
  clampLimit,
  clipToUtf8Bytes,
  newGlobBudget,
  newWalkBudget,
  walkNotes,
  executeGlobFiles,
  matchesGlobPath,
  executeGrepFiles,
  executeListFiles,
  executeReadFile,
  executeWriteFile,
  isWithinRoot,
  resolveWorkspacePath,
} from "./file-tools";

// ── resolveWorkspacePath (pure containment) ───────────────────────────────────

describe("resolveWorkspacePath", () => {
  test("resolves a path within the root", () => {
    expect(resolveWorkspacePath("/work", "src/a.ts")).toBe("/work/src/a.ts");
  });
  test("resolves the root itself for '.'", () => {
    expect(resolveWorkspacePath("/work", ".")).toBe("/work");
  });
  test("rejects parent traversal", () => {
    expect(() => resolveWorkspacePath("/work", "../secret")).toThrow("escapes");
  });
  test("rejects an absolute path outside the root", () => {
    expect(() => resolveWorkspacePath("/work", "/etc/hosts")).toThrow(
      "escapes",
    );
  });
  test("rejects sneaky traversal that climbs out", () => {
    expect(() => resolveWorkspacePath("/work", "a/../../etc")).toThrow(
      "escapes",
    );
  });
});

// ── isWithinRoot (canonical containment behind the symlink defense) ───────────

describe("isWithinRoot", () => {
  test("accepts a target nested under the root", () => {
    expect(isWithinRoot("/work", "/work/sub/a.txt")).toBe(true);
  });
  test("accepts the root itself", () => {
    expect(isWithinRoot("/work", "/work")).toBe(true);
  });
  test("rejects a sibling outside the root (symlink-escape shape)", () => {
    expect(isWithinRoot("/work", "/outside/secret.txt")).toBe(false);
  });
  test("rejects the parent of the root", () => {
    expect(isWithinRoot("/work/proj", "/work")).toBe(false);
  });
});

// ── executeReadFile / executeListFiles (scoped I/O) ───────────────────────────

let root: string;

beforeAll(async () => {
  await Deno.mkdir(".vitest-tmp", { recursive: true });
  root = await Deno.makeTempDir({ dir: ".vitest-tmp" });
  await Deno.writeTextFile(`${root}/hello.txt`, "hello world");
  await Deno.mkdir(`${root}/sub`);
  await Deno.writeTextFile(`${root}/sub/nested.txt`, "nested content");
});

afterAll(async () => {
  if (root) await Deno.remove(root, { recursive: true });
});

describe("executeReadFile", () => {
  test("reads a file within the workspace", async () => {
    expect(await executeReadFile(root, "hello.txt")).toBe("hello world");
  });
  test("reads a nested file", async () => {
    expect(await executeReadFile(root, "sub/nested.txt")).toBe(
      "nested content",
    );
  });
  test("returns an error for a traversal attempt (no read happens)", async () => {
    expect(await executeReadFile(root, "../../../etc/hosts")).toMatch(
      /^error: path escapes/,
    );
  });
  test("returns an error for a missing file", async () => {
    expect(await executeReadFile(root, "nope.txt")).toMatch(
      /^error: cannot read/,
    );
  });
  test("returns an error when the path is a directory", async () => {
    expect(await executeReadFile(root, "sub")).toMatch(/is a directory/);
  });
  test("truncates oversized content at the byte cap", async () => {
    const out = await executeReadFile(root, "hello.txt", 5);
    expect(out).toContain("[truncated at 5 bytes]");
    expect(out.startsWith("hello")).toBe(true);
  });
});

describe("executeListFiles", () => {
  test("lists directory entries, directories suffixed with /", async () => {
    const out = await executeListFiles(root, ".");
    expect(out).toContain("hello.txt");
    expect(out).toContain("sub/");
  });
  test("lists a subdirectory", async () => {
    expect(await executeListFiles(root, "sub")).toBe("nested.txt");
  });
  test("rejects a traversal attempt", async () => {
    expect(await executeListFiles(root, "..")).toMatch(/^error: path escapes/);
  });
});

describe("executeWriteFile", () => {
  test("writes a new file within the workspace", async () => {
    const out = await executeWriteFile(root, "written.txt", "fresh content");
    expect(out).toBe("wrote written.txt");
    expect(await Deno.readTextFile(`${root}/written.txt`)).toBe(
      "fresh content",
    );
  });
  test("overwrites an existing file", async () => {
    await executeWriteFile(root, "over.txt", "first");
    await executeWriteFile(root, "over.txt", "second");
    expect(await Deno.readTextFile(`${root}/over.txt`)).toBe("second");
  });
  test("writes into an existing subdirectory", async () => {
    await executeWriteFile(root, "sub/new.txt", "in sub");
    expect(await Deno.readTextFile(`${root}/sub/new.txt`)).toBe("in sub");
  });
  test("rejects a traversal escape (no write happens)", async () => {
    expect(await executeWriteFile(root, "../escape.txt", "nope")).toMatch(
      /^error: path escapes/,
    );
  });
  test("errors when the parent directory does not exist", async () => {
    expect(await executeWriteFile(root, "missing/deep.txt", "x")).toMatch(
      /^error: cannot write/,
    );
  });
  test("the success result carries no payload length (no size signal)", async () => {
    expect(await executeWriteFile(root, "sized.txt", "0123456789")).toBe(
      "wrote sized.txt",
    );
  });
});

describe("executeWriteFile symlink containment", () => {
  // The scoped test sandbox forbids Deno.symlink (a symlink's target cannot be
  // permission-scoped), so the no-follow guard is exercised with an injected
  // lstat. The real OS symlink-follow escape — a dangling in-root link to an
  // outside target — is validated separately by the Codex security PoC.
  test("refuses to write when the target is a symlink, and writes nothing", async () => {
    const fakeSymlinkLstat = () => Promise.resolve({ isSymlink: true });
    const out = await executeWriteFile(
      root,
      "link.txt",
      "escaped",
      fakeSymlinkLstat,
    );
    expect(out).toMatch(/refusing to write through a symlink/);
    // The guard runs before the write, so nothing is created.
    await expect(Deno.stat(`${root}/link.txt`)).rejects.toBeInstanceOf(
      Deno.errors.NotFound,
    );
  });
});

describe("executeEditFile", () => {
  test("replaces a unique fragment and reports the edit", async () => {
    await executeWriteFile(root, "edit-basic.txt", "alpha beta gamma");
    const out = await executeEditFile(root, "edit-basic.txt", "beta", "DELTA");
    expect(out).toBe("edited edit-basic.txt");
    expect(await Deno.readTextFile(`${root}/edit-basic.txt`)).toBe(
      "alpha DELTA gamma",
    );
  });
  test("errors when the old text is absent (file unchanged)", async () => {
    await executeWriteFile(root, "edit-absent.txt", "unchanged");
    expect(await executeEditFile(root, "edit-absent.txt", "missing", "x"))
      .toMatch(/oldString not found/);
    expect(await Deno.readTextFile(`${root}/edit-absent.txt`)).toBe(
      "unchanged",
    );
  });
  test("errors when the old text is not unique (file unchanged)", async () => {
    await executeWriteFile(root, "edit-dup.txt", "x x x");
    expect(await executeEditFile(root, "edit-dup.txt", "x", "y")).toMatch(
      /not unique/,
    );
    expect(await Deno.readTextFile(`${root}/edit-dup.txt`)).toBe("x x x");
  });
  test("errors for a missing file (no create)", async () => {
    expect(await executeEditFile(root, "edit-nope.txt", "a", "b")).toMatch(
      /file not found/,
    );
  });
  test("rejects a traversal escape", async () => {
    expect(await executeEditFile(root, "../escape.txt", "a", "b")).toMatch(
      /^error: path escapes/,
    );
  });
  test("rejects an empty oldString", async () => {
    await executeWriteFile(root, "edit-empty.txt", "content");
    expect(await executeEditFile(root, "edit-empty.txt", "", "x")).toMatch(
      /oldString must be non-empty/,
    );
  });
  test("inherits the write-back symlink guard (refuses, writes nothing)", async () => {
    await executeWriteFile(root, "edit-link.txt", "before");
    const fakeSymlinkLstat = () => Promise.resolve({ isSymlink: true });
    const out = await executeEditFile(
      root,
      "edit-link.txt",
      "before",
      "after",
      fakeSymlinkLstat,
    );
    expect(out).toMatch(/refusing to write through a symlink/);
    expect(await Deno.readTextFile(`${root}/edit-link.txt`)).toBe("before");
  });
});


// ── Search affordances (grep_files / glob_files / ranged read) ────────────────
//
// These exist so read-only questions do not have to route through bash, which
// always requires operator approval. The tests below pin the two properties
// that make that safe: the walk never leaves the workspace, and every traversal
// is bounded.

let sroot: string;

beforeAll(async () => {
  await Deno.mkdir(".vitest-tmp", { recursive: true });
  sroot = await Deno.makeTempDir({ dir: ".vitest-tmp" });
  await Deno.writeTextFile(`${sroot}/alpha.ts`, "const a = 1;\nneedle here\nconst b = 2;\n");
  await Deno.writeTextFile(`${sroot}/beta.md`, "# doc\nneedle in markdown\n");
  await Deno.mkdir(`${sroot}/pkg`);
  await Deno.writeTextFile(`${sroot}/pkg/gamma.ts`, "no match on this line\n");
  await Deno.mkdir(`${sroot}/.git`);
  await Deno.writeTextFile(`${sroot}/.git/config`, "needle should be skipped\n");
  await Deno.writeTextFile(`${sroot}/binary.bin`, "abc\u0000needle\n");
  await Deno.writeTextFile(
    `${sroot}/many.txt`,
    Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n"),
  );
});

afterAll(async () => {
  if (sroot) await Deno.remove(sroot, { recursive: true });
});

describe("executeGrepFiles", () => {
  test("finds matches with path:line:text rows", async () => {
    const out = await executeGrepFiles(sroot, "needle");
    expect(out).toContain("alpha.ts:2:needle here");
    expect(out).toContain("beta.md:2:needle in markdown");
  });
  test("skips .git and binary files", async () => {
    const out = await executeGrepFiles(sroot, "needle");
    expect(out).not.toContain(".git");
    expect(out).not.toContain("binary.bin");
  });
  test("include glob narrows the file set", async () => {
    const out = await executeGrepFiles(sroot, "needle", { include: "**/*.ts" });
    expect(out).toContain("alpha.ts");
    expect(out).not.toContain("beta.md");
  });
  test("reports no matches distinctly from an error", async () => {
    const out = await executeGrepFiles(sroot, "zzz-absent");
    expect(out.startsWith("(no matches)")).toBe(true);
    expect(out.startsWith("error:")).toBe(false);
  });
  test("rejects an invalid regex without throwing", async () => {
    const out = await executeGrepFiles(sroot, "(unclosed");
    expect(out.startsWith("error:")).toBe(true);
    expect(out).toContain("invalid pattern");
  });
  test("rejects an empty pattern", async () => {
    expect(await executeGrepFiles(sroot, "")).toContain("error:");
  });
  test("refuses to search outside the workspace root", async () => {
    const out = await executeGrepFiles(sroot, "needle", { path: "../.." });
    expect(out.startsWith("error:")).toBe(true);
  });
  test("caps matches and says so", async () => {
    const out = await executeGrepFiles(sroot, "line", { maxMatches: 3 });
    expect(out.split("\n").filter((l) => l.includes("many.txt")).length).toBe(3);
    expect(out).toContain("match limit 3 reached");
  });
});

describe("executeGlobFiles", () => {
  test("matches by relative path glob", async () => {
    const out = await executeGlobFiles(sroot, "**/*.ts");
    expect(out).toContain("alpha.ts");
    expect(out).toContain("pkg/gamma.ts");
    expect(out).not.toContain("beta.md");
  });
  test("reports no matches distinctly", async () => {
    expect(await executeGlobFiles(sroot, "**/*.nope")).toBe("(no matches)");
  });
  test("refuses to search outside the workspace root", async () => {
    const out = await executeGlobFiles(sroot, "**/*", { path: "../.." });
    expect(out.startsWith("error:")).toBe(true);
  });
});

// An excluded directory is only ever a *child* during the walk, so naming one
// as the starting point was a way around the exclusion — and .git holds
// remotes, reflogs, and identities that would land in the durable transcript
// with no approval in front of them.
describe("excluded directories cannot be searched by naming them", () => {
  test("grep_files refuses an explicit .git start", async () => {
    const out = await executeGrepFiles(sroot, "needle", { path: ".git" });
    expect(out.startsWith("error:")).toBe(true);
    expect(out).toContain("excluded from search");
  }, 20_000);
  test("glob_files refuses an explicit .git start", async () => {
    const out = await executeGlobFiles(sroot, "**/*", { path: ".git" });
    expect(out.startsWith("error:")).toBe(true);
    expect(out).toContain("excluded from search");
  });
  test("a nested excluded directory is refused too", async () => {
    await Deno.mkdir(`${sroot}/pkg/node_modules/dep`, { recursive: true });
    await Deno.writeTextFile(`${sroot}/pkg/node_modules/dep/i.js`, "needle\n");
    const out = await executeGlobFiles(sroot, "**/*", {
      path: "pkg/node_modules/dep",
    });
    expect(out.startsWith("error:")).toBe(true);
    expect(out).toContain("excluded from search");
  });
  test("a normal sibling directory still searches", async () => {
    const out = await executeGlobFiles(sroot, "**/*.ts", { path: "pkg" });
    expect(out).toContain("gamma.ts");
  });
});

describe("executeReadFile ranged reads", () => {
  test("returns a line window", async () => {
    const out = await executeReadFile(sroot, "many.txt", undefined, {
      offset: 3,
      limit: 2,
    });
    expect(out).toContain("line 3");
    expect(out).toContain("line 4");
    expect(out).not.toContain("line 5");
  });
  test("annotates how much remains", async () => {
    const out = await executeReadFile(sroot, "many.txt", undefined, {
      offset: 1,
      limit: 2,
    });
    expect(out).toContain("lines 1-2 of 40");
  });
  test("reads to end when limit is omitted", async () => {
    const out = await executeReadFile(sroot, "many.txt", undefined, {
      offset: 39,
    });
    expect(out).toContain("line 40");
  });
  test("rejects an offset past end of file", async () => {
    const out = await executeReadFile(sroot, "many.txt", undefined, {
      offset: 999,
    });
    expect(out).toContain("past end");
  });
  test("rejects a non-positive offset", async () => {
    const out = await executeReadFile(sroot, "many.txt", undefined, {
      offset: 0,
    });
    expect(out).toContain("error:");
  });
  test("unranged read is unchanged", async () => {
    const out = await executeReadFile(sroot, "alpha.ts");
    expect(out).toBe("const a = 1;\nneedle here\nconst b = 2;\n");
  });
  test("refuses a file over the hard read ceiling before reading it", async () => {
    // Sparse: stat reports 5MB without writing 5MB, which is exactly the case
    // the pre-read stat is there to catch.
    const huge = `${sroot}/huge.bin`;
    const f = await Deno.create(huge);
    await f.truncate(5 * 1024 * 1024);
    f.close();
    const out = await executeReadFile(sroot, "huge.bin");
    expect(out.startsWith("error:")).toBe(true);
    expect(out).toContain("over the 4194304-byte limit");
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
  test("* does not cross a path separator", () => {
    expect(matchesGlobPath("a.ts", "*.ts")).toBe(true);
    expect(matchesGlobPath("pkg/a.ts", "*.ts")).toBe(false);
  });
  test("** crosses separators and matches zero directories", () => {
    expect(matchesGlobPath("a.ts", "**/*.ts")).toBe(true);
    expect(matchesGlobPath("pkg/deep/a.ts", "**/*.ts")).toBe(true);
  });
  test("? matches exactly one non-separator character", () => {
    expect(matchesGlobPath("ab.ts", "a?.ts")).toBe(true);
    expect(matchesGlobPath("a/b.ts", "a?b.ts")).toBe(false);
  });
  test("character classes work", () => {
    expect(matchesGlobPath("a1.ts", "a[0-9].ts")).toBe(true);
    expect(matchesGlobPath("ax.ts", "a[0-9].ts")).toBe(false);
  });
  test("dots are literal, not regex wildcards", () => {
    expect(matchesGlobPath("axts", "*.ts")).toBe(false);
  });
  test("anchors the whole path", () => {
    expect(matchesGlobPath("src/a.ts.bak", "**/*.ts")).toBe(false);
  });
  test("an unparsable class degrades to no match rather than throwing", () => {
    expect(() => matchesGlobPath("a.ts", "a[.ts")).not.toThrow();
  });
  test("refuses an over-long pattern rather than matching it", () => {
    expect(matchesGlobPath("a.ts", "*".repeat(600) + ".ts")).toBe(false);
  });
  test("many ** segments stay fast (no regex backtracking surface)", () => {
    const started = performance.now();
    expect(
      matchesGlobPath("a/b/c/d/e/f/g/h/i/j/k.txt", "**/".repeat(40) + "*.ts"),
    ).toBe(false);
    expect(performance.now() - started).toBeLessThan(250);
  });
});

// ── Enforced bounds on the auto-approved search tools ────────────────────────
//
// Regression coverage for the resource ceilings on grep_files and glob_files.
// Nothing prompts the operator before these run, so each bound is exercised
// against arguments a model could actually send — an inflated limit, a
// catastrophic regex, a tree shaped to slip past a file-only budget.

describe("clampLimit", () => {
  test("falls back when the value is absent or unusable", () => {
    expect(clampLimit(undefined, 200, 1000)).toBe(200);
    expect(clampLimit(Number.NaN, 200, 1000)).toBe(200);
    expect(clampLimit(Number.POSITIVE_INFINITY, 200, 1000)).toBe(200);
  });
  test("ignores an inflated limit", () => {
    expect(clampLimit(1e9, 200, 1000)).toBe(1000);
  });
  test("floors to at least 1", () => {
    expect(clampLimit(0, 200, 1000)).toBe(1);
    expect(clampLimit(-5, 200, 1000)).toBe(1);
  });
  test("passes through a reasonable request", () => {
    expect(clampLimit(50, 200, 1000)).toBe(50);
  });
});

describe("grep_files resource bounds", () => {
  let broot: string;

  beforeAll(async () => {
    await Deno.mkdir(".vitest-tmp", { recursive: true });
    broot = await Deno.makeTempDir({ dir: ".vitest-tmp" });
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

  test("a catastrophic pattern is cut off instead of hanging", async () => {
    const started = performance.now();
    const out = await executeGrepFiles(broot, "(a+)+$", { budgetMs: 300 });
    const elapsed = performance.now() - started;
    // The budget is what bounds this, so allow generous slack for worker
    // startup — the assertion that matters is that it returns at all.
    expect(elapsed).toBeLessThan(8000);
    expect(out.startsWith("error:")).toBe(true);
    expect(out).toContain("too expensive");
  }, 20_000);

  test("lines over the length cap are never matched", async () => {
    // `a+!` matches the long line trivially; it is skipped for its length, so
    // the only evidence it existed is the note.
    const out = await executeGrepFiles(broot, "a+!");
    expect(out).not.toContain("longline.txt");
    expect(out === "(no matches)" || out.includes("over 4096 chars")).toBe(true);
  }, 20_000);

  test("directories consume the traversal budget", async () => {
    // 5 entries is fewer than the directory chain is deep, so a budget that
    // counted only files would have descended all the way to buried.txt.
    const out = await executeGrepFiles(broot, "needle", { maxFiles: 5 });
    expect(out).not.toContain("buried.txt");
    expect(out).toContain("entry limit 5 reached");
  }, 20_000);

  test("a truncated search says so even when it found nothing", async () => {
    const out = await executeGrepFiles(broot, "zzz-absent", { maxFiles: 5 });
    expect(out).toContain("(no matches)");
    expect(out).toContain("entry limit 5 reached");
  }, 20_000);

  test("a flat directory larger than the cap does not buffer past it", async () => {
    const flat = await Deno.makeTempDir({ dir: ".vitest-tmp" });
    for (let i = 0; i < 60; i++) {
      await Deno.writeTextFile(`${flat}/f${i}.txt`, "needle\n");
    }
    const out = await executeGlobFiles(flat, "**/*.txt", { maxFiles: 10 });
    expect(out.split("\n").filter((l) => l.endsWith(".txt")).length)
      .toBeLessThanOrEqual(10);
    expect(out).toContain("entry limit 10 reached");
    await Deno.remove(flat, { recursive: true });
  }, 20_000);

  test("an over-long include glob is rejected, not silently unmatchable", async () => {
    const out = await executeGrepFiles(broot, "needle", {
      include: "*".repeat(600),
    });
    expect(out.startsWith("error:")).toBe(true);
    expect(out).toContain("include");
  }, 20_000);

  test("an over-long pattern is rejected before compilation", async () => {
    const out = await executeGrepFiles(broot, "a".repeat(2000));
    expect(out.startsWith("error:")).toBe(true);
  }, 20_000);

  test("the walk stops at the depth cap", async () => {
    // buried.txt sits 40 directories down, past HARD_MAX_DEPTH (32), so it is
    // unreachable no matter how large the entry budget is.
    const out = await executeGrepFiles(broot, "needle", { maxFiles: 1e9 });
    expect(out).toContain("plain.txt");
    expect(out).not.toContain("buried.txt");
  }, 20_000);

  test("an oversized file is skipped without being read", async () => {
    const out = await executeGrepFiles(broot, "a+", { maxBytes: 10 });
    expect(out).not.toContain("longline.txt");
  }, 20_000);

  test("an inflated maxMatches does not raise the ceiling", async () => {
    // Not observable in the row count on this small tree; what is observable is
    // that the note reports the clamped value, not the requested one.
    const out = await executeGrepFiles(broot, "needle", { maxMatches: 1e9 });
    expect(out).not.toContain("1000000000");
  }, 20_000);

  test("fails closed when the matcher cannot start", async () => {
    const out = await executeGrepFiles(broot, "needle", {
      workerSpecifier: "file:///nonexistent/regex-worker.ts",
    });
    expect(out.startsWith("error:")).toBe(true);
  }, 20_000);
});

// ── Containment and completeness ─────────────────────────────────────────────

describe("clipToUtf8Bytes", () => {
  test("returns null when the text already fits", () => {
    expect(clipToUtf8Bytes("abc", 10)).toBeNull();
  });
  test("measures bytes, not UTF-16 code units", () => {
    // 10 three-byte characters: 10 code units, 30 bytes.
    const text = "\u4e2d".repeat(10);
    expect(text.length).toBe(10);
    expect(clipToUtf8Bytes(text, 12)).not.toBeNull();
  });
  test("cuts on a character boundary, never mid-sequence", () => {
    const clipped = clipToUtf8Bytes("\u4e2d".repeat(10), 10)!;
    expect(clipped).not.toContain("\ufffd");
    expect(new TextEncoder().encode(clipped).byteLength).toBeLessThanOrEqual(10);
  });
});

describe("ancestor replacement cannot leak a file out of the workspace", () => {
  // The sandbox cannot create real symlinks, so the canonicalizer is the seam:
  // a pathname that is lexically in-root but canonically outside it is exactly
  // what an ancestor directory swapped for a symlink leaves behind.
  const outside = (_p: string) => Promise.resolve("/elsewhere/decoy.ts");

  test("grep_files refuses content whose canonical path escapes", async () => {
    const out = await executeGrepFiles(sroot, "needle", { realPath: outside });
    expect(out).not.toContain("alpha.ts:");
    expect(out).toContain("(no matches)");
  }, 20_000);

  test("glob_files refuses names whose canonical path escapes", async () => {
    const out = await executeGlobFiles(sroot, "**/*.ts", { realPath: outside });
    expect(out).not.toContain("alpha.ts");
    expect(out).toContain("resolved outside the workspace root");
  });

  test("the normal canonicalizer still returns in-root files", async () => {
    const out = await executeGlobFiles(sroot, "**/*.ts");
    expect(out).toContain("alpha.ts");
  });
});

describe("an incomplete walk is never reported as a complete one", () => {
  let droot: string;

  beforeAll(async () => {
    await Deno.mkdir(".vitest-tmp", { recursive: true });
    droot = await Deno.makeTempDir({ dir: ".vitest-tmp" });
    let dir = droot;
    for (let i = 0; i < 40; i++) {
      dir = `${dir}/d${i}`;
      await Deno.mkdir(dir);
    }
    await Deno.writeTextFile(`${dir}/buried.txt`, "needle\n");
  });

  afterAll(async () => {
    if (droot) await Deno.remove(droot, { recursive: true });
  });

  test("grep_files flags content omitted by the depth cap", async () => {
    const out = await executeGrepFiles(droot, "needle");
    expect(out).toContain("(no matches)");
    expect(out).toContain("directory depth limit");
  }, 20_000);

  test("glob_files flags content omitted by the depth cap", async () => {
    const out = await executeGlobFiles(droot, "**/*.txt");
    expect(out).toContain("(no matches)");
    expect(out).toContain("directory depth limit");
  });
});

describe("omissions are disclosed, not dropped", () => {
  let oroot: string;

  beforeAll(async () => {
    await Deno.mkdir(".vitest-tmp", { recursive: true });
    oroot = await Deno.makeTempDir({ dir: ".vitest-tmp" });
    await Deno.writeTextFile(`${oroot}/only.bin`, "abc\u0000needle\n");
  });

  afterAll(async () => {
    if (oroot) await Deno.remove(oroot, { recursive: true });
  });

  test("a binary-only tree cannot return a bare (no matches)", async () => {
    const out = await executeGrepFiles(oroot, "needle");
    expect(out).not.toBe("(no matches)");
    expect(out).toContain("binary file(s) skipped");
  }, 20_000);
});

describe("a raced alias into an excluded directory returns nothing", () => {
  // A replaced ancestor can land a path inside .git while staying in-root, so
  // containment alone would accept it. The canonical path is checked against
  // the exclusions too; the seam stands in for the swap the sandbox cannot make.
  test("grep_files drops content canonically inside .git", async () => {
    const intoGit = (_p: string) => Deno.realPath(`${sroot}/.git/config`);
    const out = await executeGrepFiles(sroot, "needle", { realPath: intoGit });
    expect(out).not.toContain("alpha.ts:");
    expect(out).toContain("resolved into an excluded directory");
  }, 20_000);

  test("glob_files drops names canonically inside .git", async () => {
    const intoGit = (_p: string) => Deno.realPath(`${sroot}/.git/config`);
    const out = await executeGlobFiles(sroot, "**/*.ts", { realPath: intoGit });
    expect(out).not.toContain("alpha.ts");
    expect(out).toContain("resolved into an excluded directory");
  });
});

describe("glob matching is bounded across the whole call", () => {
  let groot: string;

  // Worst case for a star-rewind matcher: a segment of one repeated character
  // with a single mismatching character in the middle, so every star position
  // is retried against nearly the whole segment. Names run near the 255-byte
  // component limit; nesting stays inside PATH_MAX.
  const poison = (n: number) =>
    "s".repeat(Math.floor(n / 2)) + "x" + "s".repeat(n - Math.floor(n / 2) - 1);

  beforeAll(async () => {
    await Deno.mkdir(".vitest-tmp", { recursive: true });
    groot = await Deno.makeTempDir({ dir: ".vitest-tmp" });
    let dir = groot;
    for (let d = 0; d < 3; d++) {
      dir = `${dir}/${poison(110)}${d}`;
      await Deno.mkdir(dir);
    }
    for (let f = 0; f < 1200; f++) {
      await Deno.writeTextFile(
        `${dir}/${poison(240)}${String(f).padStart(4, "0")}`,
        "x\n",
      );
    }
  });

  afterAll(async () => {
    if (groot) await Deno.remove(groot, { recursive: true });
  });

  test("a near-worst-case pattern returns promptly and reports the cutoff", async () => {
    const adversarial = "**/*" + "s".repeat(500) + "t";
    expect(adversarial.length).toBeLessThanOrEqual(512);
    const started = performance.now();
    const out = await executeGlobFiles(groot, adversarial);
    const elapsed = performance.now() - started;
    // Without the aggregate budget this workload runs for minutes.
    expect(elapsed).toBeLessThan(10_000);
    expect(out).toContain("glob matching budget exhausted");
  }, 60_000);

  test("grep_files bounds its include glob the same way", async () => {
    const out = await executeGrepFiles(groot, "zzz-absent", {
      include: "**/*" + "s".repeat(500) + "t",
    });
    expect(out).toContain("include-glob matching budget exhausted");
  }, 60_000);

  test("an ordinary search stays far under the budget", () => {
    const budget = newGlobBudget();
    for (let i = 0; i < 500; i++) {
      matchesGlobPath(
        `src/pkg/deep/module${i}/index.test.ts`,
        "**/*.test.ts",
        budget,
      );
    }
    // Realistic paths cost a tiny fraction of the ceiling, so the bound never
    // fires on real work.
    expect(budget.steps).toBeLessThan(budget.cap / 100);
  });

  test("an exhausted budget stops matching rather than matching everything", () => {
    expect(matchesGlobPath("a.ts", "*.ts", { steps: 0, cap: 1 })).toBe(false);
  });
});

describe("every non-scope omission reaches the completeness note", () => {
  // The sandbox cannot create symlinks or non-regular files (Deno.symlink needs
  // unscoped read+write), so the counters are driven directly. What matters is
  // that no omission class can reach walkNotes and produce nothing.
  test("a symlink skip is disclosed", () => {
    const budget = newWalkBudget(100);
    budget.skippedSymlinks = 2;
    expect(walkNotes(budget).join("; ")).toContain("2 symlink(s) skipped");
  });
  test("a non-regular file skip is disclosed", () => {
    const budget = newWalkBudget(100);
    budget.skippedNonRegular = 1;
    expect(walkNotes(budget).join("; ")).toContain("1 non-regular file(s)");
  });
  test("an untouched walk produces no note at all", () => {
    expect(walkNotes(newWalkBudget(100))).toEqual([]);
  });
  test("contract-excluded directories are not reported as omissions", async () => {
    // sroot contains .git; searching it must still read as complete, or the
    // note fires on every repository and stops carrying information.
    const out = await executeGlobFiles(sroot, "**/*.ts");
    expect(out).not.toContain(".git");
    expect(out).not.toContain("[");
  });
});

describe("glob character classes are charged to the budget", () => {
  test("a long failing class cannot outrun the aggregate bound", async () => {
    // Uncharged, each counted step hid ~500 class comparisons; charged, the
    // budget drains in proportion to the work actually done.
    const classPattern = "**/*[" + "b".repeat(495) + "c]";
    expect(classPattern.length).toBeLessThanOrEqual(512);
    const started = performance.now();
    const out = await executeGlobFiles(sroot, classPattern);
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(typeof out).toBe("string");
  }, 30_000);

  test("the class scan itself costs budget", () => {
    const bare = newGlobBudget();
    matchesGlobPath("abcdefghij.ts", "*.ts", bare);
    const classy = newGlobBudget();
    matchesGlobPath("abcdefghij.ts", "*[" + "b".repeat(400) + "c].ts", classy);
    expect(classy.steps).toBeGreaterThan(bare.steps * 100);
  });
});

describe("dense short-line files stay bounded", () => {
  let droot: string;

  beforeAll(async () => {
    await Deno.mkdir(".vitest-tmp", { recursive: true });
    droot = await Deno.makeTempDir({ dir: ".vitest-tmp" });
    // ~2 MiB of one-character lines: 1,000,000 lines that all match. Split up
    // front this materialises a million strings and clones them into the
    // worker before any row limit applies. The default per-file cap is 64 KiB,
    // so these searches raise maxBytes to reach the worst case at all.
    await Deno.writeTextFile(`${droot}/dense.txt`, "a\n".repeat(1_000_000));
  });

  afterAll(async () => {
    if (droot) await Deno.remove(droot, { recursive: true });
  });

  test("a million matching lines return promptly and within the row cap", async () => {
    const started = performance.now();
    const out = await executeGrepFiles(droot, "a", { maxBytes: 4 * 1024 * 1024 });
    const elapsed = performance.now() - started;
    const rows = out.split("\n").filter((l) => l.startsWith("dense.txt:"));
    expect(rows.length).toBeLessThanOrEqual(200);
    expect(out).toContain("match limit 200 reached");
    expect(elapsed).toBeLessThan(10_000);
  }, 30_000);

  test("the per-file line cap is disclosed when nothing matches", async () => {
    const out = await executeGrepFiles(droot, "zzz-absent", {
      maxBytes: 4 * 1024 * 1024,
    });
    expect(out).toContain("(no matches)");
    expect(out).toContain("truncated at 200000 lines");
  }, 30_000);
});

describe("a raced entry type change is disclosed", () => {
  test("walkNotes reports it", () => {
    const budget = newWalkBudget(100);
    budget.skippedRaced = 3;
    expect(walkNotes(budget).join("; ")).toContain("3 entr(ies) changed type");
  });
});
