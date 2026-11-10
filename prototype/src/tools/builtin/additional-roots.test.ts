// Tests for the admission of a session's extra roots (`--add-dir`):
// protected paths stay out whichever way a root overlaps them.

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { MAX_ADDITIONAL_ROOTS } from "../../contract/mod.ts";
import {
  AdditionalRootRefusedError,
  admitAdditionalRoots,
  overlapsProtectedPath,
  protectedPaths,
} from "./additional-roots.ts";

let base: string;
let home: string;
let proto: string;
let guarded: string[];

before(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "dyfj-add-dir-")));
  home = join(base, "home");
  proto = join(base, "checkout", "prototype");
  await mkdir(join(home, ".dyfj", "runner-homes", "codex-chatgpt", "home"), {
    recursive: true,
  });
  await mkdir(join(home, ".config", "dyfj"), { recursive: true });
  await mkdir(join(home, "projects", "main-repo"), { recursive: true });
  await mkdir(join(home, "projects", "worktree", "prototype"), { recursive: true });
  await mkdir(proto, { recursive: true });
  // A synthetic canary, never a real value.
  await writeFile(join(proto, ".env"), "CANARY_TOKEN=not-a-secret\n");
  guarded = await protectedPaths({ home, prototypeRoot: proto });
});

after(() => {
  rmSync(base, { recursive: true, force: true });
});

function refused(position: number) {
  return (error: unknown) =>
    error instanceof AdditionalRootRefusedError &&
    error.message.startsWith(`Additional root ${position} `) &&
    !error.message.includes(base);
}

describe("admitAdditionalRoots", () => {
  it("admits a read-write and a read-only root with their canonical paths", async () => {
    const roots = await admitAdditionalRoots([
      { path: join(home, "projects", "main-repo"), readOnly: false },
      { path: join(home, "projects", "worktree"), readOnly: true },
    ], { protectedPaths: guarded });
    assert.deepStrictEqual(roots, [
      { name: "main-repo", path: join(home, "projects", "main-repo"), readOnly: false },
      { name: "worktree", path: join(home, "projects", "worktree"), readOnly: true },
    ]);
  });

  for (
    const [label, path] of [
      ["the home directory, which contains ~/.dyfj", () => home],
      ["~/.dyfj itself", () => join(home, ".dyfj")],
      ["a Codex runner home inside ~/.dyfj", () =>
        join(home, ".dyfj", "runner-homes", "codex-chatgpt", "home")],
      ["~/.config, which contains ~/.config/dyfj", () => join(home, ".config")],
      ["~/.config/dyfj itself", () => join(home, ".config", "dyfj")],
      ["the checkout that contains prototype/.env", () => join(base, "checkout")],
      ["the prototype directory that holds .env", () => proto],
    ] as const
  ) {
    it(`refuses ${label}`, async () => {
      await assert.rejects(
        admitAdditionalRoots([
          { path: join(home, "projects", "main-repo"), readOnly: false },
          { path: path(), readOnly: true },
        ], { protectedPaths: guarded }),
        refused(2),
      );
    });
  }

  it("refuses a symlink that leads to a protected path", async () => {
    const link = join(base, "innocent-looking");
    await symlink(join(home, ".dyfj"), link);
    await assert.rejects(
      admitAdditionalRoots([{ path: link, readOnly: false }], {
        protectedPaths: guarded,
      }),
      refused(1),
    );
  });

  it("refuses a child of ~/.dyfj whose name starts with two dots", async () => {
    await mkdir(join(home, ".dyfj", "..cache"));
    await assert.rejects(
      admitAdditionalRoots([{ path: join(home, ".dyfj", "..cache"), readOnly: false }], {
        protectedPaths: guarded,
      }),
      refused(1),
    );
  });

  it("refuses a symlinked home whose protected paths do not exist yet", async () => {
    const real = join(base, "disk-home");
    await mkdir(real);
    const alias = join(base, "alias-home");
    await symlink(real, alias);
    await assert.rejects(
      admitAdditionalRoots([{ path: alias, readOnly: false }], {
        protectedPaths: await protectedPaths({ home: alias }),
      }),
      refused(1),
    );
  });

  it("refuses every root without an absolute HOME", async () => {
    for (const missing of [undefined, "relative/home"]) {
      await assert.rejects(
        protectedPaths({ home: missing, prototypeRoot: proto }),
        AdditionalRootRefusedError,
      );
    }
  });

  it("follows a symlink before a .. segment in a protected path", async () => {
    const real = join(base, "srv", "app");
    await mkdir(real, { recursive: true });
    await mkdir(join(base, "srv", "config"));
    await mkdir(join(base, "work"));
    await symlink(real, join(base, "work", "link"));
    await assert.rejects(
      admitAdditionalRoots([{ path: join(base, "srv", "config"), readOnly: false }], {
        protectedPaths: await protectedPaths({
          home,
          dyfjRoot: `${base}/work/link/../config`,
        }),
      }),
      refused(1),
    );
  });

  it("protects the target of a dangling .env symlink", async () => {
    const checkout = join(base, "dangling-checkout", "prototype");
    await mkdir(checkout, { recursive: true });
    const secrets = join(base, "secrets");
    await mkdir(secrets);
    await symlink(join(secrets, "runtime.env"), join(checkout, ".env"));
    await assert.rejects(
      admitAdditionalRoots([{ path: secrets, readOnly: false }], {
        protectedPaths: await protectedPaths({ home, prototypeRoot: checkout }),
      }),
      refused(1),
    );
  });

  it("refuses DYFJ_ROOT when it is set", async () => {
    const configRoot = join(base, "config-root");
    await mkdir(configRoot);
    await assert.rejects(
      admitAdditionalRoots([{ path: configRoot, readOnly: true }], {
        protectedPaths: await protectedPaths({ home, dyfjRoot: configRoot }),
      }),
      refused(1),
    );
  });

  it("refuses a relative path, a file and a missing directory", async () => {
    await writeFile(join(base, "a-file"), "x");
    for (const path of ["relative/dir", join(base, "a-file"), join(base, "absent")]) {
      await assert.rejects(
        admitAdditionalRoots([{ path, readOnly: false }], { protectedPaths: guarded }),
        refused(1),
      );
    }
  });

  it("refuses more than the limit", async () => {
    const many = Array.from({ length: MAX_ADDITIONAL_ROOTS + 1 }, () => ({
      path: join(home, "projects", "main-repo"),
      readOnly: false,
    }));
    await assert.rejects(
      admitAdditionalRoots(many, { protectedPaths: guarded }),
      AdditionalRootRefusedError,
    );
  });

  it("drops the primary workspace and merges duplicates, read-write winning", async () => {
    const roots = await admitAdditionalRoots([
      { path: join(home, "projects", "main-repo"), readOnly: false },
      { path: join(home, "projects", "worktree"), readOnly: true },
      { path: join(home, "projects", "worktree", "."), readOnly: false },
    ], { primary: join(home, "projects", "main-repo"), protectedPaths: guarded });
    assert.deepStrictEqual(roots, [
      { name: "worktree", path: join(home, "projects", "worktree"), readOnly: false },
    ]);
  });

  it("gives roots with the same basename distinct names", async () => {
    await mkdir(join(base, "a", "repo"), { recursive: true });
    await mkdir(join(base, "b", "repo"), { recursive: true });
    const roots = await admitAdditionalRoots([
      { path: join(base, "a", "repo"), readOnly: false },
      { path: join(base, "b", "repo"), readOnly: false },
    ], { protectedPaths: guarded });
    assert.deepStrictEqual(roots.map((root) => root.name), ["repo", "repo-2"]);
  });
});

describe("protectedPaths", () => {
  it("lists a protected path that does not exist yet by its lexical form", async () => {
    const empty = join(base, "empty-home");
    await mkdir(empty);
    const listed = await protectedPaths({ home: empty });
    assert.ok(listed.includes(join(empty, ".dyfj")));
    assert.ok(listed.includes(join(empty, ".config", "dyfj")));
  });

  it("overlap covers equal, inside and containing", () => {
    assert.ok(overlapsProtectedPath("/h/.dyfj", "/h/.dyfj"));
    assert.ok(overlapsProtectedPath("/h/.dyfj/runner-homes", "/h/.dyfj"));
    assert.ok(overlapsProtectedPath("/h", "/h/.dyfj"));
    assert.ok(!overlapsProtectedPath("/h/projects", "/h/.dyfj"));
    assert.ok(!overlapsProtectedPath("/h/.dyfjx", "/h/.dyfj"));
    assert.ok(overlapsProtectedPath("/h/.dyfj/..cache", "/h/.dyfj"));
    assert.ok(!overlapsProtectedPath("/h/a", "/h/b"));
  });
});
