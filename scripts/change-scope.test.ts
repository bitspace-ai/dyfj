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

Deno.test("only paths ending in .md classify as Markdown", () => {
  assertEquals(isMarkdownPath("README.md"), true);
  assertEquals(isMarkdownPath("specs/notes/NOTE.MD"), true);
  assertEquals(isMarkdownPath("scripts/gate.ts"), false);
  assertEquals(isMarkdownPath("docs/page.mdx"), false);
  assertEquals(isMarkdownPath("md"), false);
});

Deno.test("a range is markdown-only when every path, and at least one, is Markdown", () => {
  assertEquals(
    classifyChangedPaths(["README.md", "specs/a.md"]),
    "markdown-only",
  );
  assertEquals(classifyChangedPaths(["README.md", "deno.json"]), "other");
  assertEquals(classifyChangedPaths([]), "other");
});

async function git(dir: string, ...args: string[]): Promise<string> {
  const output = await new Deno.Command("git", {
    args: [
      "-c",
      "user.name=Gate Test",
      "-c",
      "user.email=gate-test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) {
    throw new Error(
      `git ${args[0]} failed: ${new TextDecoder().decode(output.stderr)}`,
    );
  }
  return new TextDecoder().decode(output.stdout).trim();
}

// A throwaway repository with one base commit; `change` makes the range.
async function withRange(
  change: (dir: string) => Promise<void>,
  check: (dir: string, base: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "dyfj-change-scope-" });
  try {
    await git(dir, "init", "-q", "-b", "main");
    await Deno.writeTextFile(`${dir}/README.md`, "# base\n");
    await Deno.writeTextFile(`${dir}/tool.ts`, "export const x = 1;\n");
    await git(dir, "add", "-A");
    await git(dir, "commit", "-q", "-m", "base");
    const base = await git(dir, "rev-parse", "HEAD");
    await change(dir);
    await git(dir, "add", "-A");
    await git(dir, "commit", "-q", "--allow-empty", "-m", "change");
    await check(dir, base);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const envReader = (values: Record<string, string>) => (name: string) =>
  values[name];

const ciEnv = (base: string) =>
  envReader({ GITHUB_ACTIONS: "true", DYFJ_GATE_RANGE_BASE: base });

Deno.test("a bound range that changes only Markdown is markdown-only", async () => {
  await withRange(
    async (dir) => {
      await Deno.writeTextFile(`${dir}/README.md`, "# changed\n");
      await Deno.writeTextFile(`${dir}/NEW.md`, "new\n");
    },
    async (dir, base) => {
      assertEquals(await changeScope(dir, ciEnv(base)), "markdown-only");
    },
  );
});

Deno.test("any non-Markdown path in the bound range keeps the full gate", async () => {
  await withRange(
    async (dir) => {
      await Deno.writeTextFile(`${dir}/README.md`, "# changed\n");
      await Deno.writeTextFile(`${dir}/tool.ts`, "export const x = 2;\n");
    },
    async (dir, base) => {
      assertEquals(await changeScope(dir, ciEnv(base)), "other");
    },
  );
});

Deno.test("deleting a non-Markdown file keeps the full gate", async () => {
  await withRange(
    async (dir) => {
      await Deno.remove(`${dir}/tool.ts`);
    },
    async (dir, base) => {
      assertEquals(await changeScope(dir, ciEnv(base)), "other");
    },
  );
});

Deno.test("renaming a non-Markdown file to a .md name keeps the full gate", async () => {
  await withRange(
    async (dir) => {
      await git(dir, "mv", "tool.ts", "tool.md");
    },
    async (dir, base) => {
      assertEquals(await changeScope(dir, ciEnv(base)), "other");
    },
  );
});

Deno.test("an empty range keeps the full gate", async () => {
  await withRange(
    async () => {},
    async (dir, base) => {
      assertEquals(await changeScope(dir, ciEnv(base)), "other");
    },
  );
});

Deno.test("a local, unbound range keeps the full gate", async () => {
  await withRange(
    async (dir) => {
      await Deno.writeTextFile(`${dir}/README.md`, "# changed\n");
    },
    async (dir, base) => {
      const local = envReader({ DYFJ_GATE_RANGE_BASE: base });
      assertEquals(await changeScope(dir, local), "other");
    },
  );
});
