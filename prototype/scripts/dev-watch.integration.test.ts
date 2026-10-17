// The real recursive watcher on this platform: `dyfj dev` relies on
// `fs.watch(dir, { recursive: true })`, which Node supports on macOS and
// Linux. A save in a nested directory must arrive as one repo-relative path.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { watchTrees } from "./dev-watch.ts";

test("a save two directories down reaches the watcher as a tree-relative path", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dyfj-dev-watch-")));
  await mkdir(join(root, "engine", "deep"), { recursive: true });
  const seen = new Set<string>();
  const watcher = watchTrees([{ dir: root, prefix: "prototype/src" }], (path) => seen.add(path));
  try {
    // Recursive watches on Linux attach to subdirectories asynchronously.
    await new Promise((r) => setTimeout(r, 300));
    const deadline = Date.now() + 5000;
    while (!seen.has("prototype/src/engine/deep/module.ts") && Date.now() < deadline) {
      await writeFile(join(root, "engine", "deep", "module.ts"), `export const t = ${Date.now()};\n`);
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(seen.has("prototype/src/engine/deep/module.ts"), [...seen].join(", "));
  } finally {
    watcher.close();
    await rm(root, { recursive: true, force: true });
  }
});
