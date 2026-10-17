import assert from "node:assert/strict";
import { test } from "node:test";
import { isEditorNoise, watchTrees, type WatchFn } from "./dev-watch.ts";

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
