// The two repo-context cases that need process grants the `Deno.test` unit
// lane does not give (no subprocess, no environment): they stay on the Vitest
// lane until the test sweep decides where process-granted cases run.
// - The symlink fixture is built with `/bin/sh -c 'ln -s ...'`, because
//   `Deno.symlink` needs unscoped read and write.
// - Calling `loadAskRepoContext` without a budget exercises its fallback read
//   of `DYFJ_WORKBENCH_CONTEXT_TOKENS` from the process environment.
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { buildAskSystemPrompt, loadAskRepoContext } from "./repo-context.ts";

describe("loadAskRepoContext", () => {
  test("with no budget, resolves it from the process environment and loads generic README and manifest context", async () => {
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

      expect(context.sources).toEqual([
        { kind: "file", label: "README.md", path: "README.md" },
        { kind: "file", label: "package.json", path: "package.json" },
      ]);
      expect(rendered.indexOf("untrusted workspace context")).toBeLessThan(
        rendered.indexOf("Music Rotater"),
      );
      expect(rendered).toContain("Music Rotater");
      expect(rendered).toContain('"name":"music-rotater"');
    } finally {
      await Deno.remove(selectedRoot, { recursive: true });
    }
  });

  test("does not follow a symlinked notes directory outside the selected workspace", async () => {
    const selectedRoot = await Deno.makeTempDir({
      prefix: "ask-context-notes-root-",
    });
    const outsideRoot = await Deno.makeTempDir({
      prefix: "ask-context-notes-outside-",
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await Deno.writeTextFile(
        path.join(outsideRoot, "workbench-mvp-loop.md"),
        "outside instructions must not load\n",
      );
      // the existing test profile permits /bin/sh for POSIX fixture setup.
      const linked = await new Deno.Command("/bin/sh", {
        args: [
          "-c",
          'ln -s -- "$1" "$2"',
          "bash",
          outsideRoot,
          path.join(selectedRoot, "notes"),
        ],
      }).output();
      expect(linked.success).toBe(true);

      const context = await loadAskRepoContext({
        repoRoot: selectedRoot,
        profile: "full",
      });

      expect(context.sources).toEqual([]);
      expect(context.sections).toEqual([]);
      expect(warn).toHaveBeenCalledWith(
        "notes/workbench-mvp-loop.md context skipped: path escapes the workspace root",
      );
    } finally {
      warn.mockRestore();
      await Deno.remove(selectedRoot, { recursive: true });
      await Deno.remove(outsideRoot, { recursive: true });
    }
  });
});
