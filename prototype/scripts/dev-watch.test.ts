import assert from "node:assert/strict";
import { test } from "node:test";
import { coreTrees, isEditorNoise, watchTrees, type WatchFn } from "./dev-watch.ts";

test("editor scratch files are noise; sources and deletions are not", () => {
  for (const path of [
    "prototype/src/.agent-loop.ts.swp",
    "prototype/src/engine/.#agent-loop.ts",
    "prototype/src/engine/agent-loop.ts~",
    "prototype/src/engine/4913",
    "core/dyfj-repl/src/link.rs.swx",
    "prototype/src/engine/agent-loop.ts.tmp.12345.1700000000000",
    "core/target/debug/dyfj-repl",
  ]) {
    assert.deepStrictEqual(isEditorNoise(path), true, path);
  }
  for (const path of [
    "prototype/src/engine/agent-loop.ts",
    "core/dyfj-repl/src/link.rs",
    "core/Cargo.lock",
    "prototype/src/context/prompt.md",
  ]) {
    assert.deepStrictEqual(isEditorNoise(path), false, path);
  }
});

test("events map to repo-relative paths under each tree, noise dropped", () => {
  const listeners = new Map<string, (event: string, name: string | null) => void>();
  const closed: string[] = [];
  const fakeWatch: WatchFn = (dir, _options, listener) => {
    listeners.set(dir, listener);
    return { close: () => closed.push(dir) };
  };
  const seen: string[] = [];
  const watcher = watchTrees(
    [
      { dir: "/repo/prototype/src", prefix: "prototype/src" },
      { dir: "/repo/core", prefix: "core" },
    ],
    (path) => seen.push(path),
    fakeWatch,
  );
  listeners.get("/repo/prototype/src")!("change", "engine/agent-loop.ts");
  listeners.get("/repo/core")!("rename", "dyfj-repl/src/link.rs");
  listeners.get("/repo/core")!("change", "target/debug/build/x");
  listeners.get("/repo/core")!("change", null);
  listeners.get("/repo/prototype/src")!("rename", "engine/.agent-loop.ts.swp");
  assert.deepStrictEqual(seen, ["prototype/src/engine/agent-loop.ts", "core/dyfj-repl/src/link.rs"]);
  watcher.close();
  assert.deepStrictEqual(closed.sort(), ["/repo/core", "/repo/prototype/src"]);
});

test("the core tree is watched without core/target: its top level alone, each other directory recursively", async () => {
  const { mkdtemp, mkdir, writeFile, rm, realpath } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const core = await realpath(await mkdtemp(join(tmpdir(), "dyfj-core-")));
  try {
    for (const dir of ["src", "dyfj-repl", "target", ".sqlx"]) await mkdir(join(core, dir));
    await writeFile(join(core, "Cargo.toml"), "");
    assert.deepStrictEqual(coreTrees(core, "core"), [
      { dir: core, prefix: "core", recursive: false },
      { dir: join(core, "dyfj-repl"), prefix: "core/dyfj-repl" },
      { dir: join(core, "src"), prefix: "core/src" },
    ]);
  } finally {
    await rm(core, { recursive: true, force: true });
  }
});

test("a tree marked non-recursive is watched without recursion", () => {
  const seen: boolean[] = [];
  const fakeWatch: WatchFn = (_dir, options) => {
    seen.push(options.recursive);
    return { close() {} };
  };
  watchTrees([{ dir: "/a", prefix: "a" }, { dir: "/b", prefix: "b", recursive: false }], () => {}, fakeWatch);
  assert.deepStrictEqual(seen, [true, false]);
});
