/**
 * The `dyfj dev` snapshot directories are invisible to every lane, the type
 * check and the dev watcher. A snapshot holds a whole copy of `src`, tests
 * included, so a lane that saw it would run, check or count everything twice,
 * and a watcher that saw it would reload on every promotion.
 *
 * Each check uses the lane's own discovery, over a fixture tree that has
 * test-, golden- and module-shaped files in all three directories, or the
 * lane's real configuration.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { collectSources } from "../../scripts/arch-imports.ts";
import { readLayerRules } from "./dev-classify.ts";
import { retiredDir, SNAPSHOT_DIR, stagingDir } from "./dev-snapshot.ts";
import { devTrees } from "./dev-watch.ts";
import { discoverSync, isIntegrationLaneTest, isUnitTest } from "./test-files.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const DIRS = [SNAPSHOT_DIR, stagingDir(SNAPSHOT_DIR, 4242), retiredDir(SNAPSHOT_DIR, 4242)];
const SHAPES = [
  "server/main.ts",
  "engine/agent-loop.test.ts",
  "engine/a.integration.test.ts",
  "testing/golden/turn.test.ts",
];

async function fixtureRepo(): Promise<{ root: string } & AsyncDisposable> {
  const root = await mkdtemp(join(tmpdir(), "dyfj-exclusion-"));
  await mkdir(join(root, "scripts"), { recursive: true });
  await writeFile(
    join(root, "scripts", "arch-layers.json"),
    await readFile(join(REPO, "scripts", "arch-layers.json")),
  );
  for (const path of ["prototype/src/server/main.ts", ...DIRS.flatMap((d) => SHAPES.map((s) => `prototype/${d}/${s}`))]) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), "export const x = 1;\n");
  }
  return {
    root,
    async [Symbol.asyncDispose]() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

const inSnapshot = (path: string) => DIRS.some((dir) => path.includes(dir));

test("test discovery (unit, integration, golden) never finds snapshot files", async () => {
  await using f = await fixtureRepo();
  const found = discoverSync(join(f.root, "prototype"), () => true);
  assert.ok(found.includes("src/server/main.ts"), found.join(", "));
  assert.deepStrictEqual(found.filter(inSnapshot), []);
  // Nor would the lane filters keep one, were it ever found.
  assert.deepStrictEqual(
    found.filter((p) => isUnitTest(p) || isIntegrationLaneTest(p)).filter(inSnapshot),
    [],
  );
});

test("arch.imports and the size lane never read snapshot modules", async () => {
  await using f = await fixtureRepo();
  const sources = [...collectSources(f.root, readLayerRules(f.root)).keys()];
  assert.ok(sources.includes("prototype/src/server/main.ts"), sources.join(", "));
  assert.deepStrictEqual(sources.filter(inSnapshot), []);
});

test("the type check's includes cover no snapshot directory", async () => {
  const text = await readFile(join(REPO, "tsconfig.json"), "utf8");
  const config = JSON.parse(text.replace(/^\s*\/\/.*$/gm, "")) as { include: string[] };
  for (const dir of DIRS) {
    const path = `prototype/${dir}/server/main.ts`;
    const covering = config.include.filter((entry) =>
      entry.includes("*") || entry === "." || path.startsWith(`${entry.replace(/\/$/, "")}/`)
    );
    assert.deepStrictEqual(covering, [], dir);
  }
});

test("the dev watcher watches no snapshot directory", () => {
  for (const tree of devTrees(REPO)) {
    assert.ok(!inSnapshot(tree.dir), tree.dir);
    // A tree that held prototype/ itself would hold the snapshots too.
    assert.notStrictEqual(tree.dir, join(REPO, "prototype"));
    assert.notStrictEqual(tree.dir, REPO);
  }
});

test("the snapshot directories match git's ignore rules", async () => {
  // runtime.neutral and public-safety read `git ls-files` (public-safety's
  // local scan adds `--others --exclude-standard`), and CodeQL reads the CI
  // checkout. An ignored path that is never force-added reaches none of them.
  const paths = DIRS.map((dir) => `prototype/${dir}/server/main.ts`);
  const ignored = await new Promise<string>((resolve, reject) =>
    execFile("git", ["check-ignore", "--no-index", ...paths], { cwd: REPO }, (error, stdout) =>
      error !== null && error.code !== 1 ? reject(error) : resolve(stdout)
    )
  );
  assert.deepStrictEqual(ignored.trim().split("\n").filter(Boolean), paths);
});
