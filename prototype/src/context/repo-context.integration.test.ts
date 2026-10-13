// The two repo-context cases that need grants the unit lane does not give (no
// subprocess, no environment), so they run in the integration lane.
// - The symlink fixture is built with `ln -s`, because creating a symlink
//   in-process (`node:fs` `symlink` included) needs unscoped read and write.
// - Calling `loadAskRepoContext` without a budget exercises its fallback read
//   of `DYFJ_WORKBENCH_CONTEXT_TOKENS` from the process environment.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { mock } from "node:test";
import path from "node:path";
import { describe, it } from "@std/testing/bdd";
import { buildAskSystemPrompt, loadAskRepoContext } from "./repo-context.ts";

describe("loadAskRepoContext", () => {
  it("with no budget, resolves it from the process environment and loads generic README and manifest context", async () => {
    const selectedRoot = await mkdtemp(
      path.join(tmpdir(), "ask-context-selected-"),
    );
    try {
      await writeFile(
        path.join(selectedRoot, "README.md"),
        "# Music Rotater\n\nRotates a personal music library.\n",
      );
      await writeFile(
        path.join(selectedRoot, "package.json"),
        JSON.stringify({ name: "music-rotater", version: "1.0.0" }),
      );

      const context = await loadAskRepoContext({
        repoRoot: selectedRoot,
        profile: "full",
      });
      const rendered = buildAskSystemPrompt("test companion", context);

      assert.deepStrictEqual(context.sources, [
        { kind: "file", label: "README.md", path: "README.md" },
        { kind: "file", label: "package.json", path: "package.json" },
      ]);
      assert.ok(
        rendered.indexOf("untrusted workspace context") <
          rendered.indexOf("Music Rotater"),
        `expected rendered.indexOf("untrusted workspace context") < rendered.indexOf("Music Rotater")`,
      );
      assert.ok(
        rendered.includes("Music Rotater"),
        `expected ${JSON.stringify(rendered)} to include "Music Rotater"`,
      );
      assert.ok(
        rendered.includes('"name":"music-rotater"'),
        `expected ${
          JSON.stringify(rendered)
        } to include '"name":"music-rotater"'`,
      );
    } finally {
      await rm(selectedRoot, { recursive: true });
    }
  });

  it("does not follow a symlinked notes directory outside the selected workspace", async () => {
    const selectedRoot = await mkdtemp(
      path.join(tmpdir(), "ask-context-notes-root-"),
    );
    const outsideRoot = await mkdtemp(
      path.join(tmpdir(), "ask-context-notes-outside-"),
    );
    const warn = mock.method(console, "warn", () => {});
    try {
      await writeFile(
        path.join(outsideRoot, "workbench-mvp-loop.md"),
        "outside instructions must not load\n",
      );
      // An explicit environment, so the spawn reads none from the process.
      const linked = spawnSync("ln", [
        "-s",
        "--",
        outsideRoot,
        path.join(selectedRoot, "notes"),
      ], { env: {} });
      assert.ifError(linked.error);
      assert.strictEqual(linked.status, 0);

      const context = await loadAskRepoContext({
        repoRoot: selectedRoot,
        profile: "full",
      });

      assert.deepStrictEqual(context.sources, []);
      assert.deepStrictEqual(context.sections, []);
      const skipped =
        "notes/workbench-mvp-loop.md context skipped: path escapes the workspace root";
      assert.ok(
        warn.mock.calls.some((call) =>
          call.arguments.length === 1 && call.arguments[0] === skipped
        ),
        `console.warn was not called with: ${skipped}`,
      );
    } finally {
      warn.mock.restore();
      await rm(selectedRoot, { recursive: true });
      await rm(outsideRoot, { recursive: true });
    }
  });
});
