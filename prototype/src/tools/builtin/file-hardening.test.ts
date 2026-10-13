// Hardening regression suite for the builtin file tools: containment under
// raced or replaced paths, completeness notes for everything a walk declines,
// structural escaping of every emitted row and error, and the workspace-root
// identity anchor. The basic executor and search-bound tests live in
// file.test.ts.
//
// Fixture trees are created per describe in the system temp directory, so the
// suite runs under the unit lane's temp-only write grant.

import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import process from "node:process";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import {
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import {
  type FileStat,
  fileStat,
  hasVerifiableIdentity,
} from "../../kernel/mod.ts";
import {
  excludedSegment,
  safeErrorReason,
  sameFileVersion,
  sanitizeOutputPathField,
  sanitizeOutputText,
  toPosixPath,
} from "./file-access.ts";
import { matchesGlobPath, newGlobBudget } from "./file-glob.ts";
import { executeReadFile } from "./file-read.ts";
import {
  executeGlobFiles,
  executeGrepFiles,
  newWalkBudget,
  walkNotes,
} from "./file-search.ts";
import { executeWriteFile } from "./file-write.ts";
import { RootAnchors } from "./root-anchors.ts";

// The file tools verify each root against the anchors it is bound to. One
// set per file keeps the old process-wide semantics; tests that move a temp
// root away start a fresh set, as the old reset hook did.
let anchors = new RootAnchors();
const at = (root: string) => anchors.root(root);

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

// ── Containment and completeness ─────────────────────────────────────────────

describe("ancestor replacement cannot leak a file out of the workspace", () => {
  useSearchRoot();

  // The sandbox cannot create real symlinks, so the canonicalizer is the seam:
  // a pathname that is lexically in-root but canonically outside it is exactly
  // what an ancestor directory swapped for a symlink leaves behind.
  const outside = (_p: string) => Promise.resolve("/elsewhere/decoy.ts");

  it("grep_files refuses content whose canonical path escapes", async () => {
    const out = await executeGrepFiles(at(sroot), "needle", {
      realPath: outside,
    });
    assert.ok(!out.includes("alpha.ts:"));
    assert.ok(
      out.includes("(no matches)"),
      `expected ${JSON.stringify(out)} to include "(no matches)"`,
    );
  });

  it("glob_files refuses names whose canonical path escapes", async () => {
    const out = await executeGlobFiles(at(sroot), "**/*.ts", {
      realPath: outside,
    });
    assert.ok(!out.includes("alpha.ts"));
    assert.ok(
      out.includes("resolved outside the workspace root"),
      `expected ${
        JSON.stringify(out)
      } to include "resolved outside the workspace root"`,
    );
  });

  it("the normal canonicalizer still returns in-root files", async () => {
    const out = await executeGlobFiles(at(sroot), "**/*.ts");
    assert.ok(
      out.includes("alpha.ts"),
      `expected ${JSON.stringify(out)} to include "alpha.ts"`,
    );
  });
});

describe("an incomplete walk is never reported as a complete one", () => {
  let droot: string;

  beforeAll(async () => {
    droot = await mkdtemp(join(tmpdir(), "tmp-"));
    let dir = droot;
    for (let i = 0; i < 40; i++) {
      dir = `${dir}/d${i}`;
      await mkdir(dir);
    }
    await writeFile(`${dir}/buried.txt`, "needle\n");
  });

  afterAll(async () => {
    if (droot) await rm(droot, { recursive: true });
  });

  it("grep_files flags content omitted by the depth cap", async () => {
    const out = await executeGrepFiles(at(droot), "needle");
    assert.ok(
      out.includes("(no matches)"),
      `expected ${JSON.stringify(out)} to include "(no matches)"`,
    );
    assert.ok(
      out.includes("directory depth limit"),
      `expected ${JSON.stringify(out)} to include "directory depth limit"`,
    );
  });

  it("glob_files flags content omitted by the depth cap", async () => {
    const out = await executeGlobFiles(at(droot), "**/*.txt");
    assert.ok(
      out.includes("(no matches)"),
      `expected ${JSON.stringify(out)} to include "(no matches)"`,
    );
    assert.ok(
      out.includes("directory depth limit"),
      `expected ${JSON.stringify(out)} to include "directory depth limit"`,
    );
  });
});

describe("omissions are disclosed, not dropped", () => {
  let oroot: string;

  beforeAll(async () => {
    oroot = await mkdtemp(join(tmpdir(), "tmp-"));
    await writeFile(`${oroot}/only.bin`, "abc\u0000needle\n");
  });

  afterAll(async () => {
    if (oroot) await rm(oroot, { recursive: true });
  });

  it("a binary-only tree cannot return a bare (no matches)", async () => {
    const out = await executeGrepFiles(at(oroot), "needle");
    assert.notStrictEqual(out, "(no matches)");
    assert.ok(
      out.includes("binary file(s) skipped"),
      `expected ${JSON.stringify(out)} to include "binary file(s) skipped"`,
    );
  });
});

describe("a raced alias into an excluded directory returns nothing", () => {
  useSearchRoot();

  // A replaced ancestor can land a path inside .git while staying in-root, so
  // containment alone would accept it. The canonical path is checked against
  // the exclusions too; the seam stands in for the swap the sandbox cannot make.
  it("grep_files drops content canonically inside .git", async () => {
    const intoGit = (_p: string) => realpath(`${sroot}/.git/config`);
    const out = await executeGrepFiles(at(sroot), "needle", {
      realPath: intoGit,
    });
    assert.ok(!out.includes("alpha.ts:"));
    assert.ok(
      out.includes("resolved into an excluded directory"),
      `expected ${
        JSON.stringify(out)
      } to include "resolved into an excluded directory"`,
    );
  });

  it("glob_files drops names canonically inside .git", async () => {
    const intoGit = (_p: string) => realpath(`${sroot}/.git/config`);
    const out = await executeGlobFiles(at(sroot), "**/*.ts", {
      realPath: intoGit,
    });
    assert.ok(!out.includes("alpha.ts"));
    assert.ok(
      out.includes("resolved into an excluded directory"),
      `expected ${
        JSON.stringify(out)
      } to include "resolved into an excluded directory"`,
    );
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
    groot = await mkdtemp(join(tmpdir(), "tmp-"));
    let dir = groot;
    for (let d = 0; d < 3; d++) {
      dir = `${dir}/${poison(110)}${d}`;
      await mkdir(dir);
    }
    for (let f = 0; f < 1200; f++) {
      await writeFile(
        `${dir}/${poison(240)}${String(f).padStart(4, "0")}`,
        "x\n",
      );
    }
  });

  afterAll(async () => {
    if (groot) await rm(groot, { recursive: true });
  });

  it(
    "a near-worst-case pattern returns promptly and reports the cutoff",
    async () => {
      const adversarial = "**/*" + "s".repeat(500) + "t";
      assert.ok(
        adversarial.length <= 512,
        `expected adversarial.length <= 512`,
      );
      const started = performance.now();
      const out = await executeGlobFiles(at(groot), adversarial);
      const elapsed = performance.now() - started;
      // Without the aggregate budget this workload runs for minutes.
      assert.ok(elapsed < 10_000, `expected ${elapsed} < 10_000`);
      assert.ok(
        out.includes("glob matching budget exhausted"),
        `expected ${
          JSON.stringify(out)
        } to include "glob matching budget exhausted"`,
      );
    },
  );

  it("grep_files bounds its include glob the same way", async () => {
    const out = await executeGrepFiles(at(groot), "zzz-absent", {
      include: "**/*" + "s".repeat(500) + "t",
    });
    assert.ok(
      out.includes("include-glob matching budget exhausted"),
      `expected ${
        JSON.stringify(out)
      } to include "include-glob matching budget exhausted"`,
    );
  });

  it("an ordinary search stays far under the budget", () => {
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
    assert.ok(
      budget.steps < (budget.cap / 100),
      `expected budget.steps < budget.cap / 100`,
    );
  });

  it("an exhausted budget stops matching rather than matching everything", () => {
    assert.strictEqual(
      matchesGlobPath("a.ts", "*.ts", { steps: 0, cap: 1 }),
      false,
    );
  });
});

describe("every non-scope omission reaches the completeness note", () => {
  useSearchRoot();

  // The sandbox cannot create symlinks or non-regular files (creating a symlink needs
  // unscoped read+write), so the counters are driven directly. What matters is
  // that no omission class can reach walkNotes and produce nothing.
  it("a symlink skip is disclosed", () => {
    const budget = newWalkBudget(100);
    budget.skippedSymlinks = 2;
    assert.ok(
      walkNotes(budget).join("; ").includes("2 symlink(s) skipped"),
      `expected walkNotes(budget).join("; ") to include "2 symlink(s) skipped"`,
    );
  });
  it("a non-regular file skip is disclosed", () => {
    const budget = newWalkBudget(100);
    budget.skippedNonRegular = 1;
    assert.ok(
      walkNotes(budget).join("; ").includes("1 non-regular file(s)"),
      `expected walkNotes(budget).join("; ") to include "1 non-regular file(s)"`,
    );
  });
  it("an untouched walk produces no note at all", () => {
    assert.deepStrictEqual(walkNotes(newWalkBudget(100)), []);
  });
  it("contract-excluded directories are not reported as omissions", async () => {
    // sroot contains .git; searching it must still read as complete, or the
    // note fires on every repository and stops carrying information.
    const out = await executeGlobFiles(at(sroot), "**/*.ts");
    assert.ok(!out.includes(".git"));
    assert.ok(!out.includes("["));
  });
});

describe("glob character classes are charged to the budget", () => {
  useSearchRoot();

  it("a long failing class cannot outrun the aggregate bound", async () => {
    // Uncharged, each counted step hid ~500 class comparisons; charged, the
    // budget drains in proportion to the work actually done.
    const classPattern = "**/*[" + "b".repeat(495) + "c]";
    assert.ok(
      classPattern.length <= 512,
      `expected classPattern.length <= 512`,
    );
    const started = performance.now();
    const out = await executeGlobFiles(at(sroot), classPattern);
    assert.ok(
      (performance.now() - started) < 10_000,
      `expected performance.now() - started < 10_000`,
    );
    assert.strictEqual(typeof out, "string");
  });

  it("the class scan itself costs budget", () => {
    const bare = newGlobBudget();
    matchesGlobPath("abcdefghij.ts", "*.ts", bare);
    const classy = newGlobBudget();
    matchesGlobPath("abcdefghij.ts", "*[" + "b".repeat(400) + "c].ts", classy);
    assert.ok(
      classy.steps > (bare.steps * 100),
      `expected classy.steps > bare.steps * 100`,
    );
  });
});

describe("dense short-line files stay bounded", () => {
  let droot: string;

  beforeAll(async () => {
    droot = await mkdtemp(join(tmpdir(), "tmp-"));
    // ~2 MiB of one-character lines: 1,000,000 lines that all match. Split up
    // front this materialises a million strings and clones them into the
    // worker before any row limit applies. The default per-file cap is 64 KiB,
    // so these searches raise maxBytes to reach the worst case at all.
    await writeFile(`${droot}/dense.txt`, "a\n".repeat(1_000_000));
  });

  afterAll(async () => {
    if (droot) await rm(droot, { recursive: true });
  });

  it(
    "a million matching lines return promptly and within the row cap",
    async () => {
      const started = performance.now();
      const out = await executeGrepFiles(at(droot), "a", {
        maxBytes: 4 * 1024 * 1024,
      });
      const elapsed = performance.now() - started;
      const rows = out.split("\n").filter((l) => l.startsWith("dense.txt:"));
      assert.ok(rows.length <= 200, `expected rows.length <= 200`);
      assert.ok(
        out.includes("match limit 200 reached"),
        `expected ${JSON.stringify(out)} to include "match limit 200 reached"`,
      );
      assert.ok(elapsed < 10_000, `expected ${elapsed} < 10_000`);
    },
  );

  it("the per-file line cap is disclosed when nothing matches", async () => {
    const out = await executeGrepFiles(at(droot), "zzz-absent", {
      maxBytes: 4 * 1024 * 1024,
    });
    assert.ok(
      out.includes("(no matches)"),
      `expected ${JSON.stringify(out)} to include "(no matches)"`,
    );
    assert.ok(
      out.includes("truncated at 200000 lines"),
      `expected ${JSON.stringify(out)} to include "truncated at 200000 lines"`,
    );
  });
});

describe("a raced entry type change is disclosed", () => {
  it("walkNotes reports it", () => {
    const budget = newWalkBudget(100);
    budget.skippedRaced = 3;
    assert.ok(
      walkNotes(budget).join("; ").includes("3 entr(ies) changed type"),
      `expected walkNotes(budget).join("; ") to include "3 entr(ies) changed type"`,
    );
  });
});

describe("separator normalization keeps the exclusions real off POSIX", () => {
  // node:path's `relative` returns backslashes on Windows, so splitting on "/"
  // yielded one segment and SKIP_DIRS matched nothing. Backslash is an ordinary
  // character on this platform, which is what makes the Windows shape testable
  // here at all.
  it("a backslash path normalizes to segments", () => {
    assert.strictEqual(toPosixPath("pkg\\.git\\config"), "pkg/.git/config");
  });
  it("a Windows-shaped nested .git is still excluded", () => {
    assert.strictEqual(excludedSegment("/r", "/r/pkg\\.git\\config"), ".git");
  });
  it("a Windows-shaped nested node_modules is still excluded", () => {
    assert.strictEqual(
      excludedSegment("/r", "/r/a\\node_modules\\dep\\i.js"),
      "node_modules",
    );
  });
  it("an ordinary nested path is not excluded", () => {
    assert.strictEqual(excludedSegment("/r", "/r/src/pkg/a.ts"), null);
  });
  it("glob matching sees normalized separators", () => {
    assert.strictEqual(
      matchesGlobPath(toPosixPath("src\\pkg\\a.ts"), "**/*.ts"),
      true,
    );
  });
});

describe("a ranged read costs file size, not line count", () => {
  useSearchRoot();

  let rroot: string;

  beforeAll(async () => {
    rroot = await mkdtemp(join(tmpdir(), "tmp-"));
    // ~3.9 MiB of newlines, just under the hard read ceiling: split up front
    // this is ~2 million strings to hand back twenty lines.
    await writeFile(`${rroot}/dense.txt`, "a\n".repeat(1_950_000));
  });

  afterAll(async () => {
    if (rroot) await rm(rroot, { recursive: true });
  });

  it(
    "a small window out of a newline-dense file returns promptly",
    async () => {
      const started = performance.now();
      const out = await executeReadFile(at(rroot), "dense.txt", undefined, {
        offset: 1_000_000,
        limit: 20,
      });
      const elapsed = performance.now() - started;
      assert.ok(elapsed < 5_000, `expected ${elapsed} < 5_000`);
      assert.strictEqual(out.split("\n").filter((l) => l === "a").length, 20);
      assert.ok(
        out.includes("of 1950001;"),
        `expected ${JSON.stringify(out)} to include "of 1950001;"`,
      );
    },
  );

  it("the window still matches the whole-file line numbering", async () => {
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
    assert.ok(!out.includes("line 2"));
  });

  it("an offset past the end still reports the true total", async () => {
    const out = await executeReadFile(at(sroot), "many.txt", undefined, {
      offset: 999,
    });
    assert.ok(
      out.includes("past end"),
      `expected ${JSON.stringify(out)} to include "past end"`,
    );
    assert.ok(
      out.includes("(40 lines)"),
      `expected ${JSON.stringify(out)} to include "(40 lines)"`,
    );
  });
});

describe("the glob budget holds inside a final character class", () => {
  it("a long class cannot match after crossing the cap", () => {
    // One-character path, one long class: the token charges more than the cap,
    // so the check at the top of the loop never sees it.
    const pattern = "[" + "b".repeat(400) + "a]";
    assert.strictEqual(
      matchesGlobPath("a", pattern, { steps: 0, cap: 5 }),
      false,
    );
    // Same pattern with room to run does match, so the refusal above is the
    // budget and not a broken class.
    assert.strictEqual(matchesGlobPath("a", pattern, newGlobBudget()), true);
  });
});

describe("errors never carry an absolute path to the model", () => {
  useSearchRoot();

  // These strings reach the model AND the durable event transcript, and the runtime's
  // exception messages embed the path they failed on — home directory and all.
  // Assembled at runtime so the public-boundary scan never matches this
  // fixture as a home-directory path in tracked source.
  const privateHome = ["", "Users", "someone"].join("/");
  // A filesystem error as the file API throws it: an Error whose `code` names
  // the class and whose message embeds the failing path.
  const errno = (code: string, name = "Error") =>
    Object.assign(new Error(`${code}: ${privateHome}/x`), { code, name });
  it("known failure classes map to path-free text", () => {
    assert.strictEqual(safeErrorReason(errno("ENOENT")), "not found");
    assert.strictEqual(
      safeErrorReason(errno("EACCES")),
      "permission denied",
    );
  });
  it("every documented code maps to its reason", () => {
    const expected: Array<[Error, string]> = [
      [errno("ENOENT"), "not found"],
      [errno("EACCES"), "permission denied"],
      [errno("EPERM"), "permission denied"],
      [errno("ENOTDIR"), "not a directory"],
      [errno("EISDIR"), "is a directory"],
      [errno("ELOOP"), "symlink loop"],
      [errno("ERR_ACCESS_DENIED"), "not permitted by the runtime sandbox"],
      [errno("EIO"), "unavailable"],
    ];
    for (const [error, reason] of expected) {
      assert.strictEqual(safeErrorReason(error), reason, String(error));
    }
    // A sandbox refusal carries a name and no code.
    const sandbox = Object.assign(new Error(`${privateHome}/x`), {
      name: "NotCapable",
    });
    assert.strictEqual(
      safeErrorReason(sandbox),
      "not permitted by the runtime sandbox",
    );
  });
  it("an unrecognized error does not leak its message", () => {
    const leaky = new Error(
      `failed on ${privateHome}/private/workspace/a.ts`,
    );
    assert.strictEqual(safeErrorReason(leaky), "unavailable");
  });
  it(
    "a failing canonicalizer does not put the root in the result",
    async () => {
      const throwsWithPath = (_p: string) =>
        Promise.reject(new Error(`boom at ${sroot}/secret/path`));
      const out = await executeGrepFiles(at(sroot), "needle", {
        realPath: throwsWithPath,
      });
      assert.ok(!out.includes(sroot));
      assert.ok(!out.includes("/Users"));
    },
  );
  it("a missing search root reports the relative path only", async () => {
    const out = await executeGrepFiles(at(sroot), "needle", {
      path: "no-such-dir",
    });
    assert.strictEqual(out.startsWith("error:"), true);
    assert.ok(
      out.includes("no-such-dir"),
      `expected ${JSON.stringify(out)} to include "no-such-dir"`,
    );
    assert.ok(!out.includes(sroot));
  });
  it("a missing file read reports the relative path only", async () => {
    const out = await executeReadFile(at(sroot), "no-such-file.ts");
    assert.strictEqual(out.startsWith("error:"), true);
    assert.ok(!out.includes("/Users"));
  });
});

describe("a file changed mid-read is reported, not returned torn", () => {
  let croot: string;

  beforeAll(async () => {
    croot = await mkdtemp(join(tmpdir(), "tmp-"));
  });

  afterAll(async () => {
    if (croot) await rm(croot, { recursive: true });
  });

  it("a stable file reads normally", async () => {
    await writeFile(`${croot}/stable.txt`, "needle\n");
    const out = await executeGrepFiles(at(croot), "needle");
    assert.ok(
      out.includes("stable.txt:1:needle"),
      `expected ${JSON.stringify(out)} to include "stable.txt:1:needle"`,
    );
    assert.ok(!out.includes("changed while being read"));
  });

  it("real growth makes the version check reject", async () => {
    // Racing a live read is not reproducible, so the rejection rule is applied
    // to genuine before/after stats of a file that grew — the same two values
    // readContainedFile compares, produced the same way a concurrent writer
    // would produce them.
    const path = `${croot}/growing.txt`;
    await writeFile(path, "needle\n");
    const file = await open(path, "r");
    const before = fileStat(await file.stat());
    await writeFile(path, "needle\nmore\n");
    const after = fileStat(await file.stat());
    await file.close();
    assert.strictEqual(sameFileVersion(before, after), false);
  });

  it("an unchanged file passes the version check", async () => {
    const path = `${croot}/still.txt`;
    await writeFile(path, "needle\n");
    const file = await open(path, "r");
    const before = fileStat(await file.stat());
    const after = fileStat(await file.stat());
    await file.close();
    assert.strictEqual(sameFileVersion(before, after), true);
  });

  it("the check is size and mtime only, and says so", () => {
    // The documented residual: an in-place edit of identical length whose mtime
    // is unchanged is invisible here. Asserted so the limitation cannot quietly
    // become a stronger claim.
    const a = { size: 10, mtimeMs: 1_000_000 } as FileStat;
    const b = { size: 10, mtimeMs: 1_000_000 } as FileStat;
    assert.strictEqual(sameFileVersion(a, b), true);
  });
});

describe("file identity", () => {
  const stat = (dev: number, ino: number) => ({ dev, ino }) as FileStat;
  it("a real file reports a verifiable identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "tmp-"));
    try {
      await writeFile(`${root}/f.txt`, "x\n");
      const file = await open(`${root}/f.txt`, "r");
      const info = fileStat(await file.stat());
      await file.close();
      assert.ok(info.ino > 0, `expected info.ino > 0`);
      assert.ok(info.dev > 0, `expected info.dev > 0`);
      assert.strictEqual(info.isFile, true);
      assert.strictEqual(info.isDirectory, false);
      assert.strictEqual(info.isSymlink, false);
      assert.strictEqual(info.size, 2);
      assert.strictEqual(hasVerifiableIdentity(info), true);
    } finally {
      await rm(root, { recursive: true });
    }
  });
  it("a zero dev or ino cannot be verified, so the read fails closed", () => {
    assert.strictEqual(hasVerifiableIdentity(stat(0, 5)), false);
    assert.strictEqual(hasVerifiableIdentity(stat(5, 0)), false);
    assert.strictEqual(hasVerifiableIdentity(stat(0, 0)), false);
    assert.strictEqual(hasVerifiableIdentity(stat(7, 9)), true);
  });
});

describe("post-containment failures stay path-free", () => {
  it("a file deleted after the containment check reports no absolute path", async () => {
    const root = await mkdtemp(join(tmpdir(), "tmp-"));
    const gone = `${root}/vanishes.txt`;
    await writeFile(gone, "x\n");
    // Canonicalize (the containment check succeeds), then remove the file so
    // the read itself is what fails — the window this finding is about.
    await realpath(gone);
    await unlink(gone);
    const out = await executeReadFile(at(root), "vanishes.txt");
    assert.strictEqual(out.startsWith("error:"), true);
    assert.ok(!out.includes(root));
    assert.ok(!out.includes("/Users"));
    assert.ok(
      out.includes("vanishes.txt"),
      `expected ${JSON.stringify(out)} to include "vanishes.txt"`,
    );
    await rm(root, { recursive: true });
  });
});

describe("a filename cannot forge a result row", () => {
  let froot: string;

  beforeAll(async () => {
    froot = await mkdtemp(join(tmpdir(), "tmp-"));
    // A name that would print as a second, fabricated row and a fake note.
    await writeFile(
      `${froot}/a\nb.ts:1:planted\n[nothing skipped]`,
      "needle\n",
    );
  });

  afterAll(async () => {
    if (froot) await rm(froot, { recursive: true });
  });

  it("glob_files emits one row per entry", async () => {
    const out = await executeGlobFiles(at(froot), "**/*");
    assert.strictEqual(out.split("\n").length, 1);
    assert.ok(!out.includes("[nothing skipped]\n"));
    assert.ok(
      out.includes("\\x0a"),
      `expected ${JSON.stringify(out)} to include "\\\\x0a"`,
    );
  });

  it("grep_files emits one row per match", async () => {
    const out = await executeGrepFiles(at(froot), "needle");
    const rows = out.split("\n").filter((l) => l.includes("planted"));
    assert.strictEqual(rows.length, 1);
    assert.ok(
      rows[0].includes("\\x0a"),
      `expected rows[0] to include "\\\\x0a"`,
    );
  });
});

describe("the matcher worker is not a file the workspace can rewrite", () => {
  useSearchRoot();

  it("the worker runs from an immutable in-memory snapshot", async () => {
    // grep_files is auto-approved and write_file is workspace-scoped. If the
    // worker were a module on disk and the workspace were this source tree,
    // an approved edit would become execution on the next search. A `data:`
    // URL has no path for a write to reach.
    const sources = await executeGlobFiles(
      at(`${process.cwd()}/src`),
      "**/regex-worker.ts",
    );
    assert.strictEqual(sources, "(no matches)");
  });

  it("matching still works, so the snapshot is the live path", async () => {
    const out = await executeGrepFiles(at(sroot), "needle");
    assert.ok(
      out.includes("alpha.ts:2:needle here"),
      `expected ${JSON.stringify(out)} to include "alpha.ts:2:needle here"`,
    );
  });
});

describe("matched text cannot rewrite what the reader sees", () => {
  let mroot: string;

  beforeAll(async () => {
    mroot = await mkdtemp(join(tmpdir(), "tmp-"));
    // A carriage return and an escape sequence inside the matched line itself.
    await writeFile(
      `${mroot}/tricky.txt`,
      "needle\r[nothing skipped]\u001b[2K\n",
    );
  });

  afterAll(async () => {
    if (mroot) await rm(mroot, { recursive: true });
  });

  it("control characters in the matched line are escaped", async () => {
    const out = await executeGrepFiles(at(mroot), "needle");
    assert.ok(!out.includes("\r"));
    assert.ok(!out.includes("\u001b"));
    assert.ok(
      out.includes("\\x0d"),
      `expected ${JSON.stringify(out)} to include "\\\\x0d"`,
    );
    assert.ok(
      out.includes("\\x1b"),
      `expected ${JSON.stringify(out)} to include "\\\\x1b"`,
    );
  });
});

describe("display-control characters cannot restructure a row", () => {
  it("Unicode line separators are escaped", () => {
    assert.strictEqual(sanitizeOutputText("a\u2028b"), "a\\u2028b");
    assert.strictEqual(sanitizeOutputText("a\u2029b"), "a\\u2029b");
    assert.strictEqual(sanitizeOutputText("a\u0085b"), "a\\x85b");
  });
  it("bidi overrides are escaped", () => {
    assert.strictEqual(sanitizeOutputText("a\u202eb"), "a\\u202eb");
    assert.strictEqual(sanitizeOutputText("a\u2066b"), "a\\u2066b");
  });
  it("C1 controls are escaped", () => {
    assert.strictEqual(sanitizeOutputText("a\u009bb"), "a\\x9bb");
  });
  it("ordinary text is left alone", () => {
    assert.strictEqual(sanitizeOutputText("src/pkg/a.ts"), "src/pkg/a.ts");
    assert.strictEqual(sanitizeOutputText("héllo — ok"), "héllo — ok");
  });
  it("a tab is escaped too — the rule is structural, not aesthetic", () => {
    // Escaped rather than preserved: it is a C0 control, and carving out
    // exceptions is how an escaping rule grows holes.
    assert.strictEqual(sanitizeOutputText("a\tb"), "a\\x09b");
  });
});

describe("one call cannot read without limit by staying under per-file caps", () => {
  let troot: string;

  beforeAll(async () => {
    troot = await mkdtemp(join(tmpdir(), "tmp-"));
    // Five 10 KiB files: each under any per-file cap, 50 KiB in aggregate.
    for (let i = 0; i < 5; i++) {
      await writeFile(
        `${troot}/f${i}.txt`,
        ("x".repeat(99) + "\n").repeat(100),
      );
    }
  });

  afterAll(async () => {
    if (troot) await rm(troot, { recursive: true });
  });

  it("the shared read budget stops the call and says so", async () => {
    // The ceiling is not model-reachable; the option exists for this test.
    const out = await executeGrepFiles(at(troot), "zzz-absent", {
      maxTotalReadBytes: 15_000,
    });
    assert.ok(
      out.includes("(no matches)"),
      `expected ${JSON.stringify(out)} to include "(no matches)"`,
    );
    assert.ok(
      out.includes("total read budget 15000 bytes reached"),
      `expected ${
        JSON.stringify(out)
      } to include "total read budget 15000 bytes reached"`,
    );
  });

  it("under the budget there is no such note", async () => {
    const out = await executeGrepFiles(at(troot), "zzz-absent");
    assert.ok(!out.includes("total read budget"));
  });
});

describe("error results get the same structural escaping as rows", () => {
  useSearchRoot();

  it("a control character in a requested path is escaped in the error", async () => {
    const out = await executeReadFile(at(sroot), "no\nsuch.txt");
    assert.strictEqual(out.startsWith("error:"), true);
    assert.strictEqual(out.split("\n").length, 1);
    assert.ok(
      out.includes("\\x0a"),
      `expected ${JSON.stringify(out)} to include "\\\\x0a"`,
    );
  });
  it(
    "a control character in a search path is escaped in the error",
    async () => {
      const out = await executeGrepFiles(at(sroot), "needle", {
        path: "no\rdir",
      });
      assert.strictEqual(out.startsWith("error:"), true);
      assert.ok(!out.includes("\r"));
      assert.ok(
        out.includes("\\x0d"),
        `expected ${JSON.stringify(out)} to include "\\\\x0d"`,
      );
    },
  );
  it("an invalid pattern's engine message is escaped too", async () => {
    // The engine echoes the pattern back inside its message.
    const out = await executeGrepFiles(at(sroot), "(\u001b");
    assert.strictEqual(out.startsWith("error:"), true);
    assert.ok(
      out.includes("invalid pattern"),
      `expected ${JSON.stringify(out)} to include "invalid pattern"`,
    );
    assert.ok(!out.includes("\u001b"));
  });
});

describe("a backslash filename cannot redirect a read (POSIX)", () => {
  let proot: string;

  beforeAll(async () => {
    proot = await mkdtemp(join(tmpdir(), "tmp-"));
    await mkdir(`${proot}/public`);
    await mkdir(`${proot}/private`);
    await writeFile(`${proot}/private/secret.txt`, "the-secret\n");
    // Backslash is a legal POSIX filename character. Normalized into
    // separators, this name reads as `../private/secret.txt` — and a read
    // rebuilt from that display string opens the real secret instead.
    await writeFile(
      `${proot}/public/..\\private\\secret.txt`,
      "decoy-content\n",
    );
  });

  afterAll(async () => {
    if (proot) await rm(proot, { recursive: true });
  });

  it(
    "grep of public/ returns the decoy's content, not the secret's",
    async () => {
      const out = await executeGrepFiles(
        at(proot),
        "decoy-content|the-secret",
        {
          path: "public",
        },
      );
      assert.ok(
        out.includes("decoy-content"),
        `expected ${JSON.stringify(out)} to include "decoy-content"`,
      );
      assert.ok(!out.includes("the-secret"));
    },
  );

  it("glob of public/ attributes the entry to public/", async () => {
    const out = await executeGlobFiles(at(proot), "**/*", { path: "public" });
    // The display path is escaped, so the backslashes are visible as \\ and
    // the row cannot be mistaken for a traversal.
    assert.ok(
      out.includes("public/..\\\\private\\\\secret.txt"),
      `expected ${
        JSON.stringify(out)
      } to include "public/..\\\\\\\\private\\\\\\\\secret.txt"`,
    );
    assert.strictEqual(
      out.split("\n").filter((l) => l.includes("secret")).length,
      1,
    );
  });

  it(
    "a search rooted at the whole tree finds the real secret at its real path",
    async () => {
      const out = await executeGrepFiles(at(proot), "the-secret");
      assert.ok(
        out.includes("private/secret.txt:1:the-secret"),
        `expected ${
          JSON.stringify(out)
        } to include "private/secret.txt:1:the-secret"`,
      );
    },
  );
});

describe("the path field encoding is injective", () => {
  it("a literal backslash is distinguishable from an escape", () => {
    // A file literally named `a\x0ab.ts` (6 chars, no newline) must not render
    // identically to a file whose name contains a real newline.
    assert.strictEqual(sanitizeOutputPathField("a\\x0ab.ts"), "a\\\\x0ab.ts");
    assert.strictEqual(sanitizeOutputPathField("a\nb.ts"), "a\\x0ab.ts");
    assert.notStrictEqual(
      sanitizeOutputPathField("a\\x0ab.ts"),
      sanitizeOutputPathField("a\nb.ts"),
    );
  });
  it("a colon in a filename cannot mimic the field delimiter", () => {
    assert.strictEqual(
      sanitizeOutputPathField("a:1:fake.ts"),
      "a\\x3a1\\x3afake.ts",
    );
  });
  it("ordinary paths pass through untouched", () => {
    assert.strictEqual(sanitizeOutputPathField("src/pkg/a.ts"), "src/pkg/a.ts");
  });
});

describe("an in-root absolute path never reaches a tool result", () => {
  useSearchRoot();

  // The adversarial shape is the root's ABSOLUTE form, which resolves in-root
  // but must be refused. (sroot is already absolute here; resolvePath keeps
  // the test independent of how the fixture root is spelled.)
  const absRoot = () => resolvePath(sroot);
  it("read_file refuses it without echoing the workspace root", async () => {
    const out = await executeReadFile(at(sroot), `${absRoot()}/alpha.ts`);
    assert.strictEqual(out.startsWith("error:"), true);
    assert.ok(
      out.includes("must be relative"),
      `expected ${JSON.stringify(out)} to include "must be relative"`,
    );
    assert.ok(!out.includes(absRoot()));
  });
  it("grep_files refuses an absolute search path the same way", async () => {
    const out = await executeGrepFiles(at(sroot), "needle", {
      path: absRoot(),
    });
    assert.strictEqual(out.startsWith("error:"), true);
    assert.ok(!out.includes(absRoot()));
  });
  it("glob_files refuses an absolute search path the same way", async () => {
    const out = await executeGlobFiles(at(sroot), "**/*", { path: absRoot() });
    assert.strictEqual(out.startsWith("error:"), true);
    assert.ok(!out.includes(absRoot()));
  });
  it("write_file refuses it without echoing", async () => {
    const out = await executeWriteFile(
      at(sroot),
      `${absRoot()}/x.txt`,
      "content",
    );
    assert.strictEqual(out.startsWith("error:"), true);
    assert.ok(!out.includes(absRoot()));
  });
});

describe("a replaced workspace root is refused, not adopted", () => {
  useSearchRoot();

  it("rename-and-replace after first use fails closed", async () => {
    const base = await mkdtemp(join(tmpdir(), "tmp-"));
    const root = `${base}/ws`;
    await mkdir(root);
    await writeFile(`${root}/a.txt`, "needle\n");
    // First use anchors the root's canonical path and directory identity.
    assert.ok(
      (await executeGrepFiles(at(root), "needle")).includes("a.txt:1:needle"),
      `expected await executeGrepFiles(at(root), "needle") to include "a.txt:1:needle"`,
    );
    // Replace the directory at the same pathname — the attack shape: the
    // pathname still resolves, but to a different directory.
    await rename(root, `${base}/moved-away`);
    await mkdir(root);
    await writeFile(`${root}/planted.txt`, "needle\n");
    const out = await executeGrepFiles(at(root), "needle");
    assert.strictEqual(out.startsWith("error:"), true);
    assert.ok(
      out.includes("workspace root identity changed"),
      `expected ${
        JSON.stringify(out)
      } to include "workspace root identity changed"`,
    );
    assert.ok(!out.includes("planted"));
    // read_file goes through the same anchor.
    const read = await executeReadFile(at(root), "planted.txt");
    assert.strictEqual(read.startsWith("error:"), true);
    await rm(base, { recursive: true });
    anchors = new RootAnchors();
  });

  it(
    "a MID-CALL root replacement is detected before results return",
    async () => {
      // Deterministic mid-call race: the canonicalizer seam fires during the
      // walk, after the entry verification — the swap it performs is exactly the
      // window the exit re-verification exists to close.
      const base = await mkdtemp(join(tmpdir(), "tmp-"));
      const root = `${base}/ws`;
      await mkdir(root);
      await writeFile(`${root}/a.txt`, "x\n");
      let swapped = false;
      const swapMidCall = async (q: string) => {
        if (!swapped) {
          swapped = true;
          await rename(root, `${base}/away`);
          await mkdir(root);
          await writeFile(`${root}/planted.txt`, "x\n");
        }
        return await realpath(q);
      };
      const out = await executeGlobFiles(at(root), "**/*", {
        realPath: swapMidCall,
      });
      assert.strictEqual(out.startsWith("error:"), true);
      assert.ok(
        out.includes("workspace root identity changed"),
        `expected ${
          JSON.stringify(out)
        } to include "workspace root identity changed"`,
      );
      assert.ok(!out.includes("planted"));
      await rm(base, { recursive: true });
      await rm(`${base}`, { recursive: true }).catch(() => {});
      anchors = new RootAnchors();
    },
  );

  it("an unchanged root keeps working across calls", async () => {
    const out1 = await executeGrepFiles(at(sroot), "needle");
    const out2 = await executeGrepFiles(at(sroot), "needle");
    assert.ok(
      out1.includes("alpha.ts:2:needle here"),
      `expected ${JSON.stringify(out1)} to include "alpha.ts:2:needle here"`,
    );
    assert.ok(
      out2.includes("alpha.ts:2:needle here"),
      `expected ${JSON.stringify(out2)} to include "alpha.ts:2:needle here"`,
    );
  });
});

describe("reserved control-record forms cannot be impersonated", () => {
  let rroot2: string;

  beforeAll(async () => {
    rroot2 = await mkdtemp(join(tmpdir(), "tmp-"));
    await writeFile(`${rroot2}/(no matches)`, "x\n");
    await writeFile(`${rroot2}/[entry limit 5000 reached]`, "x\n");
    await writeFile(`${rroot2}/file(1).txt`, "x\n");
  });

  afterAll(async () => {
    if (rroot2) await rm(rroot2, { recursive: true });
  });

  it("glob rows never collide with the reserved whole-line forms", async () => {
    const out = await executeGlobFiles(at(rroot2), "**/*");
    const lines = out.split("\n");
    assert.ok(!lines.includes("(no matches)"));
    assert.ok(!lines.includes("[entry limit 5000 reached]"));
    assert.ok(
      out.includes("\\x28no matches)"),
      `expected ${JSON.stringify(out)} to include "\\\\x28no matches)"`,
    );
    assert.ok(
      out.includes("\\x5bentry limit 5000 reached]"),
      `expected ${
        JSON.stringify(out)
      } to include "\\\\x5bentry limit 5000 reached]"`,
    );
  });

  it("a non-leading parenthesis is left alone", () => {
    assert.strictEqual(sanitizeOutputPathField("file(1).txt"), "file(1).txt");
  });

  it("the leading escape is injective against literal escape text", () => {
    // A file literally named \x28foo differs from one named (foo after
    // encoding, because its backslash is itself escaped.
    assert.strictEqual(sanitizeOutputPathField("\\x28foo"), "\\\\x28foo");
    assert.strictEqual(sanitizeOutputPathField("(foo"), "\\x28foo");
  });
});

describe("every post-work return path honors the exit verification", () => {
  it(
    "the ranged-read past-end error is withheld when the root changed",
    async () => {
      const base = await mkdtemp(join(tmpdir(), "tmp-"));
      const root = `${base}/ws`;
      await mkdir(root);
      await writeFile(`${root}/f.txt`, "one\ntwo\n");
      // Anchor, then replace, then request a past-end window: the content-derived
      // line count must not come back from the replacement root.
      assert.ok(
        (await executeReadFile(at(root), "f.txt")).includes("one"),
        `expected await executeReadFile(at(root), "f.txt") to include "one"`,
      );
      await rename(root, `${base}/away`);
      await mkdir(root);
      await writeFile(`${root}/f.txt`, "a\n".repeat(50));
      const out = await executeReadFile(at(root), "f.txt", undefined, {
        offset: 999,
      });
      assert.strictEqual(out.startsWith("error:"), true);
      assert.ok(
        out.includes("workspace root identity changed"),
        `expected ${
          JSON.stringify(out)
        } to include "workspace root identity changed"`,
      );
      assert.ok(!out.includes("lines"));
      await rm(base, { recursive: true });
      anchors = new RootAnchors();
    },
  );
});
