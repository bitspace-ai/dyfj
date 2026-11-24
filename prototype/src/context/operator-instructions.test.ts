import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import {
  loadOperatorInstructions,
  OPERATOR_INSTRUCTIONS_MAX_BYTES,
  OPERATOR_INSTRUCTIONS_MAX_TOKENS,
  OPERATOR_INSTRUCTIONS_SOURCE_PATH,
} from "./operator-instructions.ts";

async function ownedTempDir(prefix = "op-inst-"): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  await chmod(dir, 0o700);
  return dir;
}

async function ownedFile(
  dir: string,
  name: string,
  content: string | Buffer,
  mode = 0o600,
): Promise<string> {
  const target = path.join(dir, name);
  await writeFile(target, content, { mode });
  await chmod(target, mode);
  return target;
}

test("loadOperatorInstructions: loads an owner-owned regular file with path-free source metadata", async () => {
  const dir = await ownedTempDir();
  try {
    const file = await ownedFile(dir, "instructions.md", "# Rules\n\nBe concise.\n");
    const loaded = await loadOperatorInstructions(file);
    assert.ok(loaded !== null);
    assert.strictEqual(loaded.body, "# Rules\n\nBe concise.");
    assert.strictEqual(loaded.bytes, Buffer.byteLength("# Rules\n\nBe concise.\n"));
    assert.deepStrictEqual(loaded.source, {
      kind: "file",
      label: "operator instructions",
      path: OPERATOR_INSTRUCTIONS_SOURCE_PATH,
    });
    assert.ok(!loaded.source.path.includes(dir));
    assert.ok(!loaded.source.path.includes("instructions.md"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadOperatorInstructions: resolves symlinked parent directories while keeping regular leaf verification", async () => {
  const root = await ownedTempDir("op-inst-parent-sym-");
  try {
    const realDir = path.join(root, "real");
    await mkdir(realDir, { mode: 0o700 });
    await chmod(realDir, 0o700);
    const linkDir = path.join(root, "alias");
    await symlink(realDir, linkDir);
    await ownedFile(realDir, "context.md", "# Canonical Parent\n");

    const loaded = await loadOperatorInstructions(path.join(linkDir, "context.md"));
    assert.ok(loaded !== null);
    assert.strictEqual(loaded.body, "# Canonical Parent");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadOperatorInstructions: refuses a symlink leaf fail-closed", async () => {
  const dir = await ownedTempDir("op-inst-leaf-sym-");
  const warn = mock.method(console, "warn", () => {});
  try {
    const realFile = await ownedFile(dir, "real.md", "# Real\n");
    const linkFile = path.join(dir, "link.md");
    await symlink(realFile, linkFile);

    assert.strictEqual(await loadOperatorInstructions(linkFile), null);
    assert.strictEqual(warn.mock.callCount(), 1);
    const message = String(warn.mock.calls[0].arguments[0]);
    assert.match(message, /Operator instructions skipped:.*regular file/);
    assert.ok(!message.includes(dir));
  } finally {
    warn.mock.restore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadOperatorInstructions: refuses a directory target fail-closed", async () => {
  const dir = await ownedTempDir("op-inst-dir-");
  const warn = mock.method(console, "warn", () => {});
  try {
    const sub = path.join(dir, "not-a-file.md");
    await mkdir(sub, { mode: 0o700 });
    assert.strictEqual(await loadOperatorInstructions(sub), null);
    assert.strictEqual(warn.mock.callCount(), 1);
    assert.match(
      String(warn.mock.calls[0].arguments[0]),
      /Operator instructions skipped:.*regular file/,
    );
  } finally {
    warn.mock.restore();
    await rm(dir, { recursive: true, force: true });
  }
});

for (const mode of [0o620, 0o602, 0o664, 0o666]) {
  test(`loadOperatorInstructions: refuses file with shared write bits (0${mode.toString(8)})`, async () => {
    const dir = await ownedTempDir("op-inst-fmode-");
    const warn = mock.method(console, "warn", () => {});
    try {
      const file = await ownedFile(dir, "shared.md", "# Writable\n", mode);
      assert.strictEqual(await loadOperatorInstructions(file), null);
      assert.strictEqual(warn.mock.callCount(), 1);
      const message = String(warn.mock.calls[0].arguments[0]);
      assert.match(message, /Operator instructions skipped:.*write/);
      assert.ok(!message.includes(dir));
    } finally {
      warn.mock.restore();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

for (const mode of [0o720, 0o702, 0o775, 0o777]) {
  test(`loadOperatorInstructions: refuses parent directory with shared write bits (0${mode.toString(8)})`, async () => {
    const dir = await ownedTempDir("op-inst-dmode-");
    const warn = mock.method(console, "warn", () => {});
    try {
      const file = await ownedFile(dir, "instructions.md", "# Owned file\n", 0o600);
      await chmod(dir, mode);
      assert.strictEqual(await loadOperatorInstructions(file), null);
      assert.strictEqual(warn.mock.callCount(), 1);
      const message = String(warn.mock.calls[0].arguments[0]);
      assert.match(message, /Operator instructions skipped:.*parent directory/);
      assert.ok(!message.includes(dir));
    } finally {
      warn.mock.restore();
      await chmod(dir, 0o700).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("loadOperatorInstructions: refuses file exceeding byte limit fail-closed", async () => {
  const dir = await ownedTempDir("op-inst-bytes-");
  const warn = mock.method(console, "warn", () => {});
  try {
    const file = await ownedFile(
      dir,
      "huge.md",
      "a".repeat(OPERATOR_INSTRUCTIONS_MAX_BYTES + 1),
    );
    assert.strictEqual(await loadOperatorInstructions(file), null);
    assert.strictEqual(warn.mock.callCount(), 1);
    assert.match(
      String(warn.mock.calls[0].arguments[0]),
      /Operator instructions skipped:.*byte limit/,
    );
  } finally {
    warn.mock.restore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadOperatorInstructions: refuses file exceeding token budget fail-closed", async () => {
  const dir = await ownedTempDir("op-inst-tokens-");
  const warn = mock.method(console, "warn", () => {});
  try {
    // 4 * MAX_TOKENS + 1 ASCII chars fits under 65,536 bytes while exceeding MAX_TOKENS.
    const chars = OPERATOR_INSTRUCTIONS_MAX_TOKENS * 4 + 1;
    assert.ok(chars <= OPERATOR_INSTRUCTIONS_MAX_BYTES);
    const file = await ownedFile(dir, "long.md", "b".repeat(chars));
    assert.strictEqual(await loadOperatorInstructions(file), null);
    assert.strictEqual(warn.mock.callCount(), 1);
    assert.match(
      String(warn.mock.calls[0].arguments[0]),
      /Operator instructions skipped:.*token budget/,
    );
  } finally {
    warn.mock.restore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadOperatorInstructions: missing file degrades safely with a path-free warning", async () => {
  const dir = await ownedTempDir("op-inst-missing-");
  const warn = mock.method(console, "warn", () => {});
  try {
    const missing = path.join(dir, "does-not-exist.md");
    assert.strictEqual(await loadOperatorInstructions(missing), null);
    assert.strictEqual(warn.mock.callCount(), 1);
    const message = String(warn.mock.calls[0].arguments[0]);
    assert.match(message, /Operator instructions skipped:.*not found/);
    assert.ok(!message.includes(dir));
  } finally {
    warn.mock.restore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadOperatorInstructions: refuses empty or invalid UTF-8 files with warning", async () => {
  const dir = await ownedTempDir("op-inst-content-");
  const warn = mock.method(console, "warn", () => {});
  try {
    const empty = await ownedFile(dir, "empty.md", "   \n\t  ");
    assert.strictEqual(await loadOperatorInstructions(empty), null);
    const invalidUtf8 = await ownedFile(dir, "bad.md", Buffer.from([0xff, 0xfe, 0xfd]));
    assert.strictEqual(await loadOperatorInstructions(invalidUtf8), null);
    assert.strictEqual(warn.mock.callCount(), 2);
  } finally {
    warn.mock.restore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadOperatorInstructions: defensively refuses malformed path inputs", async () => {
  const warn = mock.method(console, "warn", () => {});
  try {
    for (const bad of ["", "relative.md", "/a/../b.md", "/a/b\nc.md", "/a/b/"]) {
      assert.strictEqual(await loadOperatorInstructions(bad), null, bad);
    }
    assert.strictEqual(warn.mock.callCount(), 5);
  } finally {
    warn.mock.restore();
  }
});
