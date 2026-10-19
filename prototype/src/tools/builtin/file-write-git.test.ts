import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { executeEditFile, executeWriteFile } from "./file-write.ts";
import { RootAnchors } from "./root-anchors.ts";

// Repository config can make read-only git commands run programs
// (core.fsmonitor, diff drivers). The allowlist lets those commands run without
// a prompt, so the write tools must not be a way to plant that config.
let root = "";
const anchors = new RootAnchors();

describe("the write tools refuse paths inside .git", () => {
  before(async () => {
    root = await mkdtemp(join(tmpdir(), "write-git-"));
    await mkdir(join(root, ".git", "info"), { recursive: true });
    await writeFile(join(root, ".git", "config"), "[core]\n");
    await mkdir(join(root, "sub"));
    await symlink(join(root, ".git"), join(root, "gitlink"));
  });

  after(async () => {
    await rm(root, { recursive: true });
  });

  for (
    const path of [
      ".git/config",
      ".git/info/attributes",
      ".GIT/config",
      "sub/.git/config",
      ".git",
      "sub/.git",
      "gitlink/config",
    ]
  ) {
    it(`write_file ${path}`, async () => {
      const out = await executeWriteFile(anchors.root(root), path, "[core]\n\tfsmonitor = x\n");
      assert.match(out, /^error: .*\.git/i, out);
    });
  }

  it("edit_file .git/config", async () => {
    const out = await executeEditFile(anchors.root(root), ".git/config", "[core]", "[core]\n\tfsmonitor = x");
    assert.match(out, /^error: .*\.git/i, out);
    assert.equal(await readFile(join(root, ".git", "config"), "utf8"), "[core]\n");
  });

  it("an ordinary path whose name only contains .git still writes", async () => {
    assert.equal(await executeWriteFile(anchors.root(root), ".gitignore", "x\n"), "wrote .gitignore");
    assert.equal(await executeWriteFile(anchors.root(root), "sub/a.git", "x\n"), "wrote sub/a.git");
  });
});
