import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { test } from "node:test";
import {
  changeScope,
  classifyChangedPaths,
  isMarkdownPath,
} from "./change-scope.ts";

test("only paths ending in .md classify as Markdown", () => {
  assert.deepStrictEqual(isMarkdownPath("README.md"), true);
  assert.deepStrictEqual(isMarkdownPath("specs/notes/NOTE.MD"), true);
  assert.deepStrictEqual(isMarkdownPath("scripts/gate.ts"), false);
  assert.deepStrictEqual(isMarkdownPath("docs/page.mdx"), false);
  assert.deepStrictEqual(isMarkdownPath("md"), false);
});

test("a range is markdown-only when every path, and at least one, is Markdown", () => {
  assert.deepStrictEqual(
    classifyChangedPaths(["README.md", "specs/a.md"]),
    "markdown-only",
  );
  assert.deepStrictEqual(
    classifyChangedPaths(["README.md", "deno.json"]),
    "other",
  );
  assert.deepStrictEqual(classifyChangedPaths([]), "other");
});

async function git(dir: string, ...args: string[]): Promise<string> {
  const output = spawnSync(
    "git",
    [
      "-c",
      "user.name=Gate Test",
      "-c",
      "user.email=gate-test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    {
      cwd: dir,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (output.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${output.stderr}`);
  }
  return output.stdout.trim();
}

// A throwaway repository with one base commit; `change` makes the range.
async function withRange(
  change: (dir: string) => Promise<void>,
  check: (dir: string, base: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "dyfj-change-scope-"));
  try {
    await git(dir, "init", "-q", "-b", "main");
    await writeFile(`${dir}/README.md`, "# base\n");
    await writeFile(`${dir}/tool.ts`, "export const x = 1;\n");
    await git(dir, "add", "-A");
    await git(dir, "commit", "-q", "-m", "base");
    const base = await git(dir, "rev-parse", "HEAD");
    await change(dir);
    await git(dir, "add", "-A");
    await git(dir, "commit", "-q", "--allow-empty", "-m", "change");
    await check(dir, base);
  } finally {
    await rm(dir, { recursive: true });
  }
}

const envReader = (values: Record<string, string>) => (name: string) =>
  values[name];

const ciEnv = (base: string) =>
  envReader({ GITHUB_ACTIONS: "true", DYFJ_GATE_RANGE_BASE: base });

test("a bound range that changes only Markdown is markdown-only", async () => {
  await withRange(
    async (dir) => {
      await writeFile(`${dir}/README.md`, "# changed\n");
      await writeFile(`${dir}/NEW.md`, "new\n");
    },
    async (dir, base) => {
      assert.deepStrictEqual(
        await changeScope(dir, ciEnv(base)),
        "markdown-only",
      );
    },
  );
});

test("any non-Markdown path in the bound range keeps the full gate", async () => {
  await withRange(
    async (dir) => {
      await writeFile(`${dir}/README.md`, "# changed\n");
      await writeFile(`${dir}/tool.ts`, "export const x = 2;\n");
    },
    async (dir, base) => {
      assert.deepStrictEqual(await changeScope(dir, ciEnv(base)), "other");
    },
  );
});

test("deleting a non-Markdown file keeps the full gate", async () => {
  await withRange(
    async (dir) => {
      await rm(`${dir}/tool.ts`);
    },
    async (dir, base) => {
      assert.deepStrictEqual(await changeScope(dir, ciEnv(base)), "other");
    },
  );
});

test("renaming a non-Markdown file to a .md name keeps the full gate", async () => {
  await withRange(
    async (dir) => {
      await git(dir, "mv", "tool.ts", "tool.md");
    },
    async (dir, base) => {
      assert.deepStrictEqual(await changeScope(dir, ciEnv(base)), "other");
    },
  );
});

test("an empty range keeps the full gate", async () => {
  await withRange(
    async () => {},
    async (dir, base) => {
      assert.deepStrictEqual(await changeScope(dir, ciEnv(base)), "other");
    },
  );
});

test("a local, unbound range keeps the full gate", async () => {
  await withRange(
    async (dir) => {
      await writeFile(`${dir}/README.md`, "# changed\n");
    },
    async (dir, base) => {
      const local = envReader({ DYFJ_GATE_RANGE_BASE: base });
      assert.deepStrictEqual(await changeScope(dir, local), "other");
    },
  );
});
