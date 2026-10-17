import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  classifyBatch,
  classifyPath,
  type ClassifyContext,
  type CrateMember,
  crateMembersFromMetadata,
  loadServerReachable,
  replCrateDirs,
  serverReachableFrom,
} from "./dev-classify.ts";
import { loadModuleGraph } from "../../scripts/arch-imports-graph.ts";
import type { LayerRules } from "../../scripts/arch-imports.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");

const RULES = JSON.parse(
  readFileSync(`${REPO}/scripts/arch-layers.json`, "utf8"),
) as LayerRules;

/** The workspace as `cargo metadata` reports it today: the root package is
 * also the workspace root, and dyfj-repl has no path dependencies. */
const METADATA = {
  workspace_root: `${REPO}/core`,
  packages: [
    {
      name: "dyfj-core",
      manifest_path: `${REPO}/core/Cargo.toml`,
      dependencies: [{ name: "anyhow" }],
    },
    {
      name: "dyfj-repl",
      manifest_path: `${REPO}/core/dyfj-repl/Cargo.toml`,
      dependencies: [{ name: "serde" }],
    },
  ],
};

function context(reachable: Iterable<string>): ClassifyContext {
  const crates = crateMembersFromMetadata(METADATA, REPO);
  return {
    rules: RULES,
    serverReachable: new Set(reachable),
    crates,
    replCrates: new Set(replCrateDirs(crates, "dyfj-repl")),
  };
}

test("reachability follows value edges from the server entry, not type-only ones", () => {
  const sources = new Map([
    ["prototype/src/server/main.ts", `import { run } from "../engine/loop.ts";\nimport type { T } from "../engine/types.ts";`],
    ["prototype/src/engine/loop.ts", `export { x } from "../contract/turn.ts";\nexport const run = 1;`],
    ["prototype/src/engine/types.ts", `export type T = 1;`],
    ["prototype/src/contract/turn.ts", `export const x = 1;`],
    ["prototype/src/cli/render.ts", `import { x } from "../contract/turn.ts";`],
  ]);
  const graph = loadModuleGraph(REPO, sources, (path) => sources.has(path));
  assert.deepStrictEqual(
    [...serverReachableFrom(graph, "prototype/src/server/main.ts")].sort(),
    [
      "prototype/src/contract/turn.ts",
      "prototype/src/engine/loop.ts",
      "prototype/src/server/main.ts",
    ],
  );
});

test("a module the server reaches restarts the runtime", () => {
  const ctx = context(["prototype/src/engine/loop.ts"]);
  assert.deepStrictEqual(classifyPath("prototype/src/engine/loop.ts", ctx), "runtime");
});

test("a contract or transport module restarts both", () => {
  const ctx = context([]);
  assert.deepStrictEqual(classifyPath("prototype/src/contract/turn.ts", ctx), "both");
  assert.deepStrictEqual(classifyPath("prototype/src/transport/node-socket.ts", ctx), "both");
});

test("a test or fixture file reloads nothing, wherever it sits", () => {
  const ctx = context(["prototype/src/engine/loop.ts"]);
  assert.deepStrictEqual(classifyPath("prototype/src/engine/loop.test.ts", ctx), "none");
  assert.deepStrictEqual(classifyPath("prototype/src/contract/turn.test.ts", ctx), "none");
  assert.deepStrictEqual(classifyPath("prototype/src/engine/x.fixture.ts", ctx), "none");
});

test("a module only the TypeScript client reaches reloads nothing", () => {
  const ctx = context(["prototype/src/engine/loop.ts"]);
  assert.deepStrictEqual(classifyPath("prototype/src/cli/render.ts", ctx), "none");
});

test("a non-TypeScript file under prototype/src restarts the runtime", () => {
  const ctx = context([]);
  assert.deepStrictEqual(classifyPath("prototype/src/context/prompt.md", ctx), "runtime");
});

test("a REPL crate file rebuilds the REPL; another member's file does not", () => {
  const ctx = context([]);
  assert.deepStrictEqual(classifyPath("core/dyfj-repl/src/link.rs", ctx), "repl");
  assert.deepStrictEqual(classifyPath("core/dyfj-repl/Cargo.toml", ctx), "repl");
  assert.deepStrictEqual(classifyPath("core/src/events.rs", ctx), "none");
  assert.deepStrictEqual(classifyPath("core/README.md", ctx), "none");
});

test("workspace-wide Cargo files rebuild the REPL", () => {
  const ctx = context([]);
  assert.deepStrictEqual(classifyPath("core/Cargo.lock", ctx), "repl");
  assert.deepStrictEqual(classifyPath("core/Cargo.toml", ctx), "repl");
  assert.deepStrictEqual(classifyPath("core/rust-toolchain.toml", ctx), "repl");
});

test("build output under core/target reloads nothing", () => {
  const ctx = context([]);
  assert.deepStrictEqual(classifyPath("core/target/debug/dyfj-repl", ctx), "none");
});

test("a workspace crate the REPL depends on counts as the REPL", () => {
  const metadata = {
    workspace_root: `${REPO}/core`,
    packages: [
      ...METADATA.packages.slice(0, 1),
      {
        name: "dyfj-repl",
        manifest_path: `${REPO}/core/dyfj-repl/Cargo.toml`,
        dependencies: [{ name: "dyfj-wire", path: `${REPO}/core/dyfj-wire` }],
      },
      {
        name: "dyfj-wire",
        manifest_path: `${REPO}/core/dyfj-wire/Cargo.toml`,
        dependencies: [{ name: "dyfj-util", path: `${REPO}/core/dyfj-util` }],
      },
      {
        name: "dyfj-util",
        manifest_path: `${REPO}/core/dyfj-util/Cargo.toml`,
        dependencies: [],
      },
    ],
  };
  const crates: CrateMember[] = crateMembersFromMetadata(metadata, REPO);
  assert.deepStrictEqual(replCrateDirs(crates, "dyfj-repl").sort(), [
    "core/dyfj-repl",
    "core/dyfj-util",
    "core/dyfj-wire",
  ]);
});

test("a batch reports what to restart and how many files changed", () => {
  const ctx = context(["prototype/src/engine/loop.ts"]);
  assert.deepStrictEqual(
    classifyBatch(["prototype/src/engine/loop.ts", "prototype/src/cli/render.ts"], ctx),
    { runtime: true, repl: false, files: 2 },
  );
  assert.deepStrictEqual(
    classifyBatch(["prototype/src/contract/turn.ts"], ctx),
    { runtime: true, repl: true, files: 1 },
  );
  assert.deepStrictEqual(
    classifyBatch(["core/dyfj-repl/src/link.rs"], ctx),
    { runtime: false, repl: true, files: 1 },
  );
  assert.deepStrictEqual(
    classifyBatch(["prototype/src/engine/loop.test.ts"], ctx),
    { runtime: false, repl: false, files: 1 },
  );
});

test("on this tree: the four kinds of change classify from the real import graph", () => {
  const reachable = loadServerReachable(REPO);
  const crates = crateMembersFromMetadata(METADATA, REPO);
  const ctx: ClassifyContext = {
    rules: RULES,
    serverReachable: reachable,
    crates,
    replCrates: new Set(replCrateDirs(crates, "dyfj-repl")),
  };
  assert.deepStrictEqual(classifyPath("prototype/src/engine/agent-loop.ts", ctx), "runtime");
  assert.deepStrictEqual(classifyPath("core/dyfj-repl/src/link.rs", ctx), "repl");
  assert.deepStrictEqual(classifyPath("prototype/src/contract/turn.ts", ctx), "both");
  assert.deepStrictEqual(classifyPath("prototype/src/engine/agent-loop.test.ts", ctx), "none");
});

test("without cargo metadata, every core/ change outside target/ rebuilds the REPL", () => {
  const ctx: ClassifyContext = {
    rules: RULES,
    serverReachable: new Set(),
    crates: null,
    replCrates: new Set(),
  };
  assert.deepStrictEqual(classifyPath("core/src/events.rs", ctx), "repl");
  assert.deepStrictEqual(classifyPath("core/dyfj-repl/src/link.rs", ctx), "repl");
  assert.deepStrictEqual(classifyPath("core/target/debug/x", ctx), "none");
});

test("a path outside the watched trees reloads nothing", () => {
  const ctx = context([]);
  assert.deepStrictEqual(classifyPath("README.md", ctx), "none");
  assert.deepStrictEqual(classifyPath("prototype/mcp/server.ts", ctx), "none");
});
