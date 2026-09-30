import { assertEquals, assertRejects } from "@std/assert";
import { RootAnchors, WorkspaceRootChangedError } from "./root-anchors.ts";

async function withTempBase(
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const base = await Deno.makeTempDir({ prefix: "dyfj-root-anchors-" });
  try {
    await fn(base);
  } finally {
    await Deno.remove(base, { recursive: true });
  }
}

Deno.test("a root is anchored on first use and verified after", async () => {
  await withTempBase(async (base) => {
    const root = `${base}/root`;
    await Deno.mkdir(root);
    const anchors = new RootAnchors();
    const real = await anchors.verify(root);
    assertEquals(await anchors.verify(root), real);
    assertEquals(await anchors.root(root).verify(), real);
  });
});

Deno.test("a root replaced after its first use fails closed", async () => {
  await withTempBase(async (base) => {
    const root = `${base}/root`;
    await Deno.mkdir(root);
    const anchors = new RootAnchors();
    const workspace = anchors.root(root);
    await workspace.verify();
    await Deno.rename(root, `${base}/moved-away`);
    await Deno.mkdir(root);
    await assertRejects(() => workspace.verify(), WorkspaceRootChangedError);
  });
});

Deno.test("each RootAnchors owns its own anchors", async () => {
  await withTempBase(async (base) => {
    const root = `${base}/root`;
    await Deno.mkdir(root);
    const first = new RootAnchors();
    await first.verify(root);
    await Deno.rename(root, `${base}/moved-away`);
    await Deno.mkdir(root);
    // The replacement is new to a second owner, so it anchors there; the
    // first owner still holds the original and refuses it.
    await new RootAnchors().verify(root);
    await assertRejects(() => first.verify(root), WorkspaceRootChangedError);
  });
});
