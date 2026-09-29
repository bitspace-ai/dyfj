// The two repo-context cases that need grants the unit lane does not give (no
// subprocess, no environment), so they run in the integration lane.
// - The symlink fixture is built with `ln -s`, because `Deno.symlink` needs
//   unscoped read and write.
// - Calling `loadAskRepoContext` without a budget exercises its fallback read
//   of `DYFJ_WORKBENCH_CONTEXT_TOKENS` from the process environment.
import path from "node:path";
import {
  assert,
  assertEquals,
  assertLess,
  assertStrictEquals,
  assertStringIncludes,
} from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { buildAskSystemPrompt, loadAskRepoContext } from "./repo-context.ts";

describe("loadAskRepoContext", () => {
  it("with no budget, resolves it from the process environment and loads generic README and manifest context", async () => {
    const selectedRoot = await Deno.makeTempDir({
      prefix: "ask-context-selected-",
    });
    try {
      await Deno.writeTextFile(
        path.join(selectedRoot, "README.md"),
        "# Music Rotater\n\nRotates a personal music library.\n",
      );
      await Deno.writeTextFile(
        path.join(selectedRoot, "package.json"),
        JSON.stringify({ name: "music-rotater", version: "1.0.0" }),
      );

      const context = await loadAskRepoContext({
        repoRoot: selectedRoot,
        profile: "full",
      });
      const rendered = buildAskSystemPrompt("test companion", context);

      assertEquals(context.sources, [
        { kind: "file", label: "README.md", path: "README.md" },
        { kind: "file", label: "package.json", path: "package.json" },
      ]);
      assertLess(
        rendered.indexOf("untrusted workspace context"),
        rendered.indexOf("Music Rotater"),
      );
      assertStringIncludes(rendered, "Music Rotater");
      assertStringIncludes(rendered, '"name":"music-rotater"');
    } finally {
      await Deno.remove(selectedRoot, { recursive: true });
    }
  });

  it("does not follow a symlinked notes directory outside the selected workspace", async () => {
    const selectedRoot = await Deno.makeTempDir({
      prefix: "ask-context-notes-root-",
    });
    const outsideRoot = await Deno.makeTempDir({
      prefix: "ask-context-notes-outside-",
    });
    const warn = stub(console, "warn");
    try {
      await Deno.writeTextFile(
        path.join(outsideRoot, "workbench-mvp-loop.md"),
        "outside instructions must not load\n",
      );
      const linked = await new Deno.Command("ln", {
        args: ["-s", "--", outsideRoot, path.join(selectedRoot, "notes")],
      }).output();
      assertStrictEquals(linked.success, true);

      const context = await loadAskRepoContext({
        repoRoot: selectedRoot,
        profile: "full",
      });

      assertEquals(context.sources, []);
      assertEquals(context.sections, []);
      const skipped =
        "notes/workbench-mvp-loop.md context skipped: path escapes the workspace root";
      assert(
        warn.calls.some((call) =>
          call.args.length === 1 && call.args[0] === skipped
        ),
        `console.warn was not called with: ${skipped}`,
      );
    } finally {
      warn.restore();
      await Deno.remove(selectedRoot, { recursive: true });
      await Deno.remove(outsideRoot, { recursive: true });
    }
  });
});
