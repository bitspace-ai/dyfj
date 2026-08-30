import {
  headCommit,
  recomputeCommitDigest,
  resolveSubjectBinding,
  runSubjectCheck,
} from "./subject-check.ts";

function assertEquals<T>(actual: T, expected: T): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assertStringIncludes(actual: string, expected: string): void {
  if (!actual.includes(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(actual)} to include ${expected}`,
    );
  }
}

function envOf(
  vars: Record<string, string>,
): (name: string) => string | undefined {
  return (name) => vars[name];
}

// Fixture repositories run git with a pinned identity and without operator
// configuration, so a global commit-signing or hooks setting cannot break or
// leak into the fixture.
async function gitIn(dir: string, args: string[]): Promise<void> {
  const result = await new Deno.Command("git", {
    args: ["-C", dir, ...args],
    env: {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "dyfj-test",
      GIT_AUTHOR_EMAIL: "gate@example.invalid",
      GIT_COMMITTER_NAME: "dyfj-test",
      GIT_COMMITTER_EMAIL: "gate@example.invalid",
    },
    stdout: "null",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(`git ${args[0]} failed in fixture (exit ${result.code})`);
  }
}

async function makeRepo(): Promise<{ dir: string; sha: string }> {
  const dir = await Deno.makeTempDir({ prefix: "dyfj-subject-check-" });
  await gitIn(dir, ["init", "-q"]);
  await Deno.writeTextFile(`${dir}/file.txt`, "fixture content\n");
  await gitIn(dir, ["add", "."]);
  await gitIn(dir, ["commit", "-q", "-m", "fixture"]);
  const sha = await headCommit(dir);
  return { dir, sha };
}

Deno.test("subject binding fails closed in CI without an immutable id", () => {
  assertEquals(resolveSubjectBinding(envOf({})), { authoritative: false });
  const cases: Record<string, string>[] = [
    { GITHUB_ACTIONS: "true" },
    { GITHUB_ACTIONS: "true", DYFJ_GATE_SUBJECT: "" },
    { GITHUB_ACTIONS: "true", DYFJ_GATE_SUBJECT: "main" },
    { GITHUB_ACTIONS: "true", DYFJ_GATE_SUBJECT: "0".repeat(40) },
    { DYFJ_GATE_SUBJECT: "refs/heads/main" },
  ];
  for (const vars of cases) {
    let threw = false;
    try {
      resolveSubjectBinding(envOf(vars));
    } catch (error) {
      threw = true;
      assertStringIncludes(String(error), "failing closed");
    }
    if (!threw) {
      throw new Error(`binding accepted ${JSON.stringify(vars)}`);
    }
  }
  const sha = "a".repeat(40);
  assertEquals(
    resolveSubjectBinding(
      envOf({ GITHUB_ACTIONS: "true", DYFJ_GATE_SUBJECT: sha }),
    ),
    { expected: sha, authoritative: true },
  );
  assertEquals(
    resolveSubjectBinding(envOf({ DYFJ_GATE_SUBJECT: sha })),
    { expected: sha, authoritative: false },
  );
});

Deno.test("the commit digest is recomputed from object bytes", async () => {
  const { dir, sha } = await makeRepo();
  try {
    assertEquals(await recomputeCommitDigest(dir, sha), sha);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("subject.resolve passes locally and labels itself", async () => {
  const { dir } = await makeRepo();
  const logs: string[] = [];
  try {
    const code = await runSubjectCheck("subject.resolve", {
      root: dir,
      env: envOf({}),
      out: { log: (m) => logs.push(m), error: (m) => logs.push(m) },
    });
    assertEquals(code, 0);
    assertStringIncludes(logs.join("\n"), "non-authoritative");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a bound subject mismatch fails closed", async () => {
  const { dir } = await makeRepo();
  const logs: string[] = [];
  try {
    const code = await runSubjectCheck("subject.resolve", {
      root: dir,
      env: envOf({
        GITHUB_ACTIONS: "true",
        DYFJ_GATE_SUBJECT: "b".repeat(40),
      }),
      out: { log: (m) => logs.push(m), error: (m) => logs.push(m) },
    });
    assertEquals(code, 1);
    assertStringIncludes(logs.join("\n"), "does not match the bound subject");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("an authoritative run rejects a modified subject tree", async () => {
  const { dir, sha } = await makeRepo();
  const logs: string[] = [];
  try {
    await Deno.writeTextFile(`${dir}/file.txt`, "modified after commit\n");
    const code = await runSubjectCheck("subject.resolve", {
      root: dir,
      env: envOf({ GITHUB_ACTIONS: "true", DYFJ_GATE_SUBJECT: sha }),
      out: { log: (m) => logs.push(m), error: (m) => logs.push(m) },
    });
    assertEquals(code, 1);
    assertStringIncludes(logs.join("\n"), "local modifications");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("subject.digest passes and reports the recomputation", async () => {
  const { dir, sha } = await makeRepo();
  const logs: string[] = [];
  try {
    const code = await runSubjectCheck("subject.digest", {
      root: dir,
      env: envOf({ GITHUB_ACTIONS: "true", DYFJ_GATE_SUBJECT: sha }),
      out: { log: (m) => logs.push(m), error: (m) => logs.push(m) },
    });
    assertEquals(code, 0);
    assertStringIncludes(logs.join("\n"), `sha1 ${sha} recomputed`);
    assertStringIncludes(logs.join("\n"), "git version");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("an unavailable git tool fails closed and value-free", async () => {
  const { dir, sha } = await makeRepo();
  try {
    let message = "";
    try {
      await recomputeCommitDigest(dir, sha, "./missing-git-for-this-test");
      throw new Error("expected recomputeCommitDigest to throw");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assertEquals(
      message,
      "subject check: cannot run git (is it installed and executable?)",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
