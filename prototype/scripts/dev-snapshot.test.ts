import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sourceTreeHash } from "../src/config/mod.ts";
import {
  checkSnapshot,
  lockFileHash,
  promoteSnapshot,
  SNAPSHOT_DIR,
  type SnapshotPaths,
  snapshotPaths,
  stagingDir,
} from "./dev-snapshot.ts";

async function fixture(): Promise<SnapshotPaths & AsyncDisposable> {
  const repo = await mkdtemp(join(tmpdir(), "dyfj-snapshot-"));
  const paths = snapshotPaths(repo);
  await mkdir(join(paths.source, "server"), { recursive: true });
  await writeFile(join(paths.source, "server", "main.ts"), "export const v = 1;\n");
  await writeFile(join(paths.source, "a.ts"), "export const a = 1;\n");
  await writeFile(paths.lock, '{"lockfileVersion":3}\n');
  return {
    ...paths,
    async [Symbol.asyncDispose]() {
      await rm(repo, { recursive: true, force: true });
    },
  };
}

const at = new Date("2026-10-17T20:15:00Z");

test("the snapshot sits beside src, so its parent is the prototype root", async () => {
  await using f = await fixture();
  assert.strictEqual(f.snapshot, join(f.prototype, SNAPSHOT_DIR));
  assert.strictEqual(SNAPSHOT_DIR, ".dyfj-dev-last-good");
  assert.strictEqual(f.entry, join(SNAPSHOT_DIR, "server", "main.ts"));
});

test("a copy whose hash is what the runtime booted is promoted and checks out", async () => {
  await using f = await fixture();
  const booted = await sourceTreeHash(f.source);
  assert.deepStrictEqual(await promoteSnapshot(f, booted, at), { ok: true });
  const check = await checkSnapshot(f);
  assert.ok(check.ok, JSON.stringify(check));
  assert.strictEqual(check.meta.contentHash, booted);
  assert.strictEqual(check.meta.takenAt, at.toISOString());
  assert.strictEqual(await sourceTreeHash(f.snapshot), booted);
  assert.deepStrictEqual(
    (await readdir(f.prototype)).filter((name) => name.startsWith(".dyfj-dev")),
    [SNAPSHOT_DIR],
  );
});

test("a copy that differs from what booted is not promoted; the old snapshot stays", async () => {
  await using f = await fixture();
  const first = await sourceTreeHash(f.source);
  await promoteSnapshot(f, first, at);
  // A save landed between the boot and the copy.
  const booted = first;
  await writeFile(join(f.source, "a.ts"), "export const a = 2;\n");
  const result = await promoteSnapshot(f, booted, new Date(at.getTime() + 1000));
  assert.strictEqual(result.ok, false);
  const check = await checkSnapshot(f);
  assert.ok(check.ok);
  assert.strictEqual(check.meta.takenAt, at.toISOString());
  assert.strictEqual(await sourceTreeHash(f.snapshot), first);
});

test("no snapshot yet reads as none", async () => {
  await using f = await fixture();
  assert.deepStrictEqual(await checkSnapshot(f), { ok: false, reason: "none" });
});

test("a snapshot whose files no longer match its record is never used", async () => {
  await using f = await fixture();
  await promoteSnapshot(f, await sourceTreeHash(f.source), at);
  await unlink(join(f.snapshot, "a.ts"));
  assert.deepStrictEqual(await checkSnapshot(f), { ok: false, reason: "corrupt" });
});

test("a staging copy left by an interrupted promotion is never used", async () => {
  await using f = await fixture();
  // Another process's, and this one's own from before a crash.
  for (const staging of [stagingDir(f.snapshot, 1), stagingDir(f.snapshot)]) {
    await mkdir(join(staging, "server"), { recursive: true });
    await writeFile(join(staging, "server", "main.ts"), "partial");
  }
  assert.deepStrictEqual(await checkSnapshot(f), { ok: false, reason: "none" });
  // The next promotion replaces it.
  assert.deepStrictEqual(await promoteSnapshot(f, await sourceTreeHash(f.source), at), {
    ok: true,
  });
  assert.ok((await checkSnapshot(f)).ok);
  assert.deepStrictEqual(
    (await readdir(f.prototype)).filter((name) => name.startsWith(".dyfj-dev")).sort(),
    [SNAPSHOT_DIR, `${SNAPSHOT_DIR}.staging-1`],
  );
});

test("a changed package-lock.json refuses the snapshot", async () => {
  await using f = await fixture();
  await promoteSnapshot(f, await sourceTreeHash(f.source), at);
  await writeFile(f.lock, '{"lockfileVersion":3,"packages":{}}\n');
  assert.deepStrictEqual(await checkSnapshot(f), { ok: false, reason: "lock" });
});

test("a failed copy leaves the previous snapshot whole", async () => {
  await using f = await fixture();
  const first = await sourceTreeHash(f.source);
  await promoteSnapshot(f, first, at);
  const failing = {
    ...f,
    copy: async () => {
      throw new Error("disk full");
    },
  };
  const result = await promoteSnapshot(failing, "sha256:" + "0".repeat(64), at);
  assert.strictEqual(result.ok, false);
  const check = await checkSnapshot(f);
  assert.ok(check.ok);
  assert.strictEqual(check.meta.contentHash, first);
});

test("a swap that fails after the old snapshot moved aside puts it back", async () => {
  await using f = await fixture();
  const first = await sourceTreeHash(f.source);
  await promoteSnapshot(f, first, at);
  await writeFile(join(f.source, "a.ts"), "export const a = 3;\n");
  let renames = 0;
  const failing: SnapshotPaths = {
    ...f,
    rename: async (from, to) => {
      // The second rename, staging into place, fails.
      if (++renames === 2) throw new Error("EIO");
      await rename(from, to);
    },
  };
  const result = await promoteSnapshot(failing, await sourceTreeHash(f.source), at);
  assert.strictEqual(result.ok, false);
  const check = await checkSnapshot(f);
  assert.ok(check.ok, JSON.stringify(check));
  assert.strictEqual(check.meta.contentHash, first);
});

test("the lock recorded is the one the runtime booted on, not the one at copy time", async () => {
  await using f = await fixture();
  const bootLock = await lockFileHash(f.lock);
  // package-lock.json changes between the boot and the copy.
  await writeFile(f.lock, '{"lockfileVersion":3,"changed":true}\n');
  await promoteSnapshot(f, await sourceTreeHash(f.source), at, bootLock);
  assert.deepStrictEqual(await checkSnapshot(f), { ok: false, reason: "lock" });
});

test("a swap whose restore also fails says where the previous snapshot is", async () => {
  await using f = await fixture();
  await promoteSnapshot(f, await sourceTreeHash(f.source), at);
  await writeFile(join(f.source, "a.ts"), "export const a = 4;\n");
  let renames = 0;
  const failing: SnapshotPaths = {
    ...f,
    rename: async (from, to) => {
      if (++renames >= 2) throw new Error("EIO");
      await rename(from, to);
    },
  };
  const result = await promoteSnapshot(failing, await sourceTreeHash(f.source), at);
  assert.ok(!result.ok);
  assert.match(result.error, /could not be put back and is at .*\.dyfj-dev-last-good\.retired-\d+$/);
});
