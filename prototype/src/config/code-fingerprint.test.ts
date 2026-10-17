// The code fingerprint: the source-tree content hash against the shared test
// vector (testing/fixtures/code-fingerprint), the git HEAD read from `.git`
// files without a git binary, and the freshness comparison clients run.
// Temp directories only; the real-git cross-check is in
// code-fingerprint.integration.test.ts.
import assert from "node:assert/strict";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  codeFingerprint,
  compareFreshness,
  FINGERPRINT_UNKNOWN,
  gitHead,
  prototypeSourceDir,
  sourceTreeHash,
} from "./code-fingerprint.ts";

const FIXTURE = fileURLToPath(
  new URL("../../testing/fixtures/code-fingerprint/", import.meta.url),
);
const SHA_A = "0123456789abcdef0123456789abcdef01234567";
const SHA_B = "89abcdef0123456789abcdef0123456789abcdef";

const temps: string[] = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dyfj-fingerprint-"));
  temps.push(dir);
  return dir;
}

async function expectedFixtureHash(): Promise<string> {
  return (await readFile(join(FIXTURE, "expected-hash.txt"), "utf8")).trim();
}

/** A copy of the fixture tree that a test may change. */
async function fixtureCopy(): Promise<string> {
  const dir = join(await tempDir(), "tree");
  await cp(join(FIXTURE, "tree"), dir, { recursive: true });
  return dir;
}

describe("sourceTreeHash", () => {
  it("hashes the shared fixture tree to the shared expected value", async () => {
    assert.equal(
      await sourceTreeHash(join(FIXTURE, "tree")),
      await expectedFixtureHash(),
    );
  });

  it("skips symlinks, to files and to directories, without following them", async () => {
    const tree = await fixtureCopy();
    await symlink(join(tree, "a.txt"), join(tree, "link-to-file.txt"));
    await symlink(join(tree, "nested"), join(tree, "link-to-dir"));
    assert.equal(await sourceTreeHash(tree), await expectedFixtureHash());
  });

  it("skips dotfiles and dot-directories", async () => {
    const tree = await fixtureCopy();
    await writeFile(join(tree, ".another"), "ignored");
    await mkdir(join(tree, "nested", ".cache"));
    await writeFile(join(tree, "nested", ".cache", "x.ts"), "ignored");
    assert.equal(await sourceTreeHash(tree), await expectedFixtureHash());
  });

  it("changes when a file's content changes, or a file is added", async () => {
    const tree = await fixtureCopy();
    await writeFile(join(tree, "a.txt"), "export const a = 2;\n");
    const edited = await sourceTreeHash(tree);
    assert.notEqual(edited, await expectedFixtureHash());
    await writeFile(join(tree, "new.txt"), "");
    assert.notEqual(await sourceTreeHash(tree), edited);
  });

  it("is unknown, never partial, when a file cannot be read", async (t) => {
    if (process.getuid?.() === 0) {
      t.skip("root reads a mode-000 file");
      return;
    }
    const tree = await fixtureCopy();
    await chmod(join(tree, "nested", "c.txt"), 0o000);
    assert.equal(await sourceTreeHash(tree), FINGERPRINT_UNKNOWN);
  });

  it("is unknown when the source directory does not exist", async () => {
    assert.equal(
      await sourceTreeHash(join(await tempDir(), "missing")),
      FINGERPRINT_UNKNOWN,
    );
  });
});

/** A repository root holding `prototype/src`, with the given `.git` layout. */
async function repo(
  git: Record<string, string>,
): Promise<{ root: string; src: string }> {
  const root = await tempDir();
  const src = join(root, "prototype", "src");
  await mkdir(src, { recursive: true });
  for (const [path, content] of Object.entries(git)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return { root, src };
}

describe("gitHead (no git binary)", () => {
  it("resolves a symbolic HEAD through a loose ref", async () => {
    const { src } = await repo({
      ".git/HEAD": "ref: refs/heads/main\n",
      ".git/refs/heads/main": `${SHA_A}\n`,
    });
    assert.equal(await gitHead(src), SHA_A);
  });

  it("resolves a symbolic HEAD through packed-refs", async () => {
    const { src } = await repo({
      ".git/HEAD": "ref: refs/heads/main\n",
      ".git/packed-refs": "# pack-refs with: peeled fully-peeled sorted \n" +
        `${SHA_B} refs/heads/other\n${SHA_A} refs/heads/main\n^${SHA_B}\n`,
    });
    assert.equal(await gitHead(src), SHA_A);
  });

  it("prefers a loose ref over a packed one", async () => {
    const { src } = await repo({
      ".git/HEAD": "ref: refs/heads/main\n",
      ".git/refs/heads/main": `${SHA_B}\n`,
      ".git/packed-refs": `${SHA_A} refs/heads/main\n`,
    });
    assert.equal(await gitHead(src), SHA_B);
  });

  it("reads a detached HEAD", async () => {
    const { src } = await repo({ ".git/HEAD": `${SHA_B}\n` });
    assert.equal(await gitHead(src), SHA_B);
  });

  it("follows a worktree's .git file to its gitdir and common dir", async () => {
    const { root, src } = await repo({
      "main/.git/refs/heads/feature": `${SHA_B}\n`,
      "main/.git/worktrees/wt/HEAD": "ref: refs/heads/feature\n",
      "main/.git/worktrees/wt/commondir": "../..\n",
    });
    await writeFile(
      join(root, ".git"),
      `gitdir: ${join(root, "main", ".git", "worktrees", "wt")}\n`,
    );
    assert.equal(await gitHead(src), SHA_B);
  });

  it("is unknown without a .git anywhere above the source", async () => {
    const { src } = await repo({});
    assert.equal(await gitHead(src), FINGERPRINT_UNKNOWN);
  });

  it("is unknown for a ref that does not resolve or a malformed HEAD", async () => {
    const unborn = await repo({ ".git/HEAD": "ref: refs/heads/main\n" });
    assert.equal(await gitHead(unborn.src), FINGERPRINT_UNKNOWN);
    const garbage = await repo({ ".git/HEAD": "not a head\n" });
    assert.equal(await gitHead(garbage.src), FINGERPRINT_UNKNOWN);
    const escape = await repo({ ".git/HEAD": "ref: ../../etc/passwd\n" });
    assert.equal(await gitHead(escape.src), FINGERPRINT_UNKNOWN);
  });
});

describe("codeFingerprint", () => {
  it("records HEAD and the content hash together", async () => {
    const { src } = await repo({
      ".git/HEAD": "ref: refs/heads/main\n",
      ".git/refs/heads/main": `${SHA_A}\n`,
    });
    await writeFile(join(src, "x.ts"), "x");
    assert.deepEqual(await codeFingerprint(src), {
      head: SHA_A,
      contentHash: await sourceTreeHash(src),
    });
  });

  it("still hashes the source when there is no git checkout", async () => {
    const { src } = await repo({});
    await writeFile(join(src, "x.ts"), "x");
    const fingerprint = await codeFingerprint(src);
    assert.equal(fingerprint.head, FINGERPRINT_UNKNOWN);
    assert.match(fingerprint.contentHash, /^sha256:[0-9a-f]{64}$/);
  });

  it("locates this checkout's prototype/src from the module URL", () => {
    assert.equal(
      prototypeSourceDir(),
      fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, ""),
    );
  });
});

describe("compareFreshness", () => {
  const hash = `sha256:${"a".repeat(64)}`;
  const other = `sha256:${"b".repeat(64)}`;

  it("is current when the hashes match and behind when they differ", () => {
    assert.equal(compareFreshness({ head: SHA_A, contentHash: hash }, hash), "current");
    assert.equal(compareFreshness({ head: SHA_A, contentHash: hash }, other), "behind");
  });

  it("makes no comparison when either side is unknown or absent", () => {
    assert.equal(
      compareFreshness({ contentHash: FINGERPRINT_UNKNOWN }, hash),
      "unknown",
    );
    assert.equal(
      compareFreshness({ contentHash: hash }, FINGERPRINT_UNKNOWN),
      "unknown",
    );
    // An older runtime sends no fingerprint at all.
    assert.equal(compareFreshness(undefined, hash), "unknown");
    assert.equal(compareFreshness({ contentHash: 42 }, hash), "unknown");
    assert.equal(compareFreshness("sha256:x", hash), "unknown");
  });
});

describe("compareFreshness with malformed hashes", () => {
  const valid = `sha256:${"a".repeat(64)}`;
  const malformed = [
    "sha256:not-a-hash",
    "sha256:",
    `sha256:${"a".repeat(63)}`,
    `sha256:${"a".repeat(65)}`,
    `sha256:${"A".repeat(64)}`,
    `sha256:${"a".repeat(64)}\n`,
    `SHA256:${"a".repeat(64)}`,
  ];

  it("makes no comparison when the runtime's hash is malformed", () => {
    for (const hash of malformed) {
      assert.equal(
        compareFreshness({ contentHash: hash }, valid),
        "unknown",
        JSON.stringify(hash),
      );
    }
  });

  it("makes no comparison when this checkout's hash is malformed", () => {
    for (const hash of malformed) {
      assert.equal(
        compareFreshness({ contentHash: valid }, hash),
        "unknown",
        JSON.stringify(hash),
      );
    }
  });

  it("makes no comparison between two identical malformed hashes", () => {
    assert.equal(
      compareFreshness({ contentHash: "sha256:x" }, "sha256:x"),
      "unknown",
    );
  });
});
