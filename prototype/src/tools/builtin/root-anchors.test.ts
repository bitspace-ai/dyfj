import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RootAnchors, WorkspaceRootChangedError } from "./root-anchors.ts";

async function withTempBase(
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), "dyfj-root-anchors-"));
  try {
    await fn(base);
  } finally {
    await rm(base, { recursive: true });
  }
}

test("a root is anchored on first use and verified after", async () => {
  await withTempBase(async (base) => {
    const root = `${base}/root`;
    await mkdir(root);
    const anchors = new RootAnchors();
    const real = await anchors.verify(root);
    assert.deepStrictEqual(await anchors.verify(root), real);
    assert.deepStrictEqual(await anchors.root(root).verify(), real);
  });
});

test("a root replaced after its first use fails closed", async () => {
  await withTempBase(async (base) => {
    const root = `${base}/root`;
    await mkdir(root);
    const anchors = new RootAnchors();
    const workspace = anchors.root(root);
    await workspace.verify();
    await rename(root, `${base}/moved-away`);
    await mkdir(root);
    await assert.rejects(() => workspace.verify(), WorkspaceRootChangedError);
  });
});

test("each RootAnchors owns its own anchors", async () => {
  await withTempBase(async (base) => {
    const root = `${base}/root`;
    await mkdir(root);
    const first = new RootAnchors();
    await first.verify(root);
    await rename(root, `${base}/moved-away`);
    await mkdir(root);
    // The replacement is new to a second owner, so it anchors there; the
    // first owner still holds the original and refuses it.
    await new RootAnchors().verify(root);
    await assert.rejects(() => first.verify(root), WorkspaceRootChangedError);
  });
});
