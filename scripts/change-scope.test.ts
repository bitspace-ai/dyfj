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

function assertEquals<T>(actual: T, expected: T): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

test("only paths ending in .md classify as Markdown", () => {
  assertEquals(isMarkdownPath("README.md"), true);
  assertEquals(isMarkdownPath("specs/notes/NOTE.MD"), true);
  assertEquals(isMarkdownPath("scripts/gate.ts"), false);
  assertEquals(isMarkdownPath("docs/page.mdx"), false);
  assertEquals(isMarkdownPath("md"), false);
});

test("a range is markdown-only when every path, and at least one, is Markdown", () => {
  assertEquals(
    classifyChangedPaths(["README.md", "specs/a.md"]),
    "markdown-only",
  );
  assertEquals(classifyChangedPaths(["README.md", "deno.json"]), "other");
  assertEquals(classifyChangedPaths([]), "other");
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
      assertEquals(await changeScope(dir, ciEnv(base)), "markdown-only");
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
      assertEquals(await changeScope(dir, ciEnv(base)), "other");
    },
  );
});

test("deleting a non-Markdown file keeps the full gate", async () => {
  await withRange(
    async (dir) => {
      await rm(`${dir}/tool.ts`);
    },
    async (dir, base) => {
      assertEquals(await changeScope(dir, ciEnv(base)), "other");
    },
  );
});

test("renaming a non-Markdown file to a .md name keeps the full gate", async () => {
  await withRange(
    async (dir) => {
      await git(dir, "mv", "tool.ts", "tool.md");
    },
    async (dir, base) => {
      assertEquals(await changeScope(dir, ciEnv(base)), "other");
    },
  );
});

test("an empty range keeps the full gate", async () => {
  await withRange(
    async () => {},
    async (dir, base) => {
      assertEquals(await changeScope(dir, ciEnv(base)), "other");
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
      assertEquals(await changeScope(dir, local), "other");
    },
  );
});
