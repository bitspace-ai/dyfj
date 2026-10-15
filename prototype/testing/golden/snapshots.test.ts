import { rejects, strictEqual } from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  GOLDEN_UPDATE_ENV,
  matchSnapshot,
  updateMode,
  writeSnapshot,
} from "./snapshots.ts";

const PLAIN = {};
const UPDATE = { [GOLDEN_UPDATE_ENV]: "1" };

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "dyfj_golden_snapshots_"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

test("update mode is on only when the variable is exactly 1", () => {
  strictEqual(updateMode(PLAIN), false);
  strictEqual(updateMode({ [GOLDEN_UPDATE_ENV]: "" }), false);
  strictEqual(updateMode({ [GOLDEN_UPDATE_ENV]: "true" }), false);
  strictEqual(updateMode(UPDATE), true);
});

test("a plain run cannot create a snapshot by writing it directly", async () => {
  await withDir(async (dir) => {
    await rejects(writeSnapshot(dir, "01-new", "{}\n", PLAIN), /update/);
    strictEqual(await exists(join(dir, "01-new.json")), false);
  });
});

test("a plain run cannot overwrite a snapshot by writing it directly", async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, "01-old.json"), "committed\n");
    await rejects(writeSnapshot(dir, "01-old", "{}\n", PLAIN), /update/);
    strictEqual(
      await readFile(join(dir, "01-old.json"), "utf8"),
      "committed\n",
    );
  });
});

test("a plain run fails on a missing snapshot without creating it", async () => {
  await withDir(async (dir) => {
    await rejects(
      matchSnapshot(dir, "02-missing", { a: 1 }, PLAIN),
      /missing golden snapshot 02-missing/,
    );
    strictEqual(await exists(join(dir, "02-missing.json")), false);
  });
});

test("a plain run fails on a stale snapshot without rewriting it", async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, "03-stale.json"), '{\n  "a": 0\n}\n');
    await rejects(
      matchSnapshot(dir, "03-stale", { a: 1 }, PLAIN),
      /golden snapshot 03-stale changed at line 2/,
    );
    strictEqual(
      await readFile(join(dir, "03-stale.json"), "utf8"),
      '{\n  "a": 0\n}\n',
    );
  });
});

test("a plain run passes on a matching snapshot", async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, "04-same.json"), '{\n  "a": 1\n}\n');
    await matchSnapshot(dir, "04-same", { a: 1 }, PLAIN);
  });
});

test("an update run creates a missing snapshot and rewrites a stale one", async () => {
  await withDir(async (dir) => {
    const snapshots = join(dir, "snapshots");
    await matchSnapshot(snapshots, "05-new", { a: 1 }, UPDATE);
    strictEqual(
      await readFile(join(snapshots, "05-new.json"), "utf8"),
      '{\n  "a": 1\n}\n',
    );
    await writeFile(join(snapshots, "06-stale.json"), "stale\n");
    await matchSnapshot(snapshots, "06-stale", { b: 2 }, UPDATE);
    strictEqual(
      await readFile(join(snapshots, "06-stale.json"), "utf8"),
      '{\n  "b": 2\n}\n',
    );
  });
});
