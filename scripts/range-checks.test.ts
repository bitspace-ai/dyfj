import {
  markdownLinkHits,
  markdownLinkTargets,
  resolveLinkTarget,
  runRangeCheck,
  secretDiffHits,
  shellParseHits,
  untrackedSecretHits,
  whitespaceHits,
} from "./range-checks.ts";
import {
  parseAddedLines,
  rangeCommits,
  type ReleaseRange,
  resolveRangeBase,
  resolveReleaseRange,
} from "./release-range.ts";
import { formatHits, type PublicSafetyHit } from "./public-safety-scan.ts";
import { MAX_UNTRACKED_FILE_BYTES, MAX_UNTRACKED_FILES } from "./scan-lib.ts";
import { headCommit, isWorktreeClean } from "./subject-check.ts";

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

function awsKeyFixture(): string {
  return ["AKIA", "EXAMPLE0", "12345678"].join("");
}

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

async function writeFiles(
  dir: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await Deno.writeTextFile(`${dir}/${path}`, content);
  }
}

async function commitAll(dir: string, message: string): Promise<void> {
  await gitIn(dir, ["add", "-A"]);
  await gitIn(dir, ["commit", "-q", "--allow-empty", "-m", message]);
}

// A fixture repository holding `files` in a single base commit, whose id the
// caller builds a range from.
async function makeBaseFixture(
  files: Record<string, string>,
): Promise<{ dir: string; base: string }> {
  const dir = await Deno.makeTempDir({ prefix: "dyfj-range-check-" });
  await gitIn(dir, ["init", "-q"]);
  await writeFiles(dir, files);
  await commitAll(dir, "base");
  return { dir, base: await headCommit(dir) };
}

// Both views of the fixture range: the net diff against the base tree and the
// commits the range makes newly reachable.
function fixtureRange(base: string): ReleaseRange {
  return {
    diffArgs: [base],
    historyArgs: [`${base}..HEAD`],
    authoritative: false,
    description: "fixture range",
  };
}

// A fixture repository: `files` land in the base commit, `changes` land in a
// second commit, and the returned range covers base → worktree.
async function makeRangeFixture(
  files: Record<string, string>,
  changes: Record<string, string>,
): Promise<{ dir: string; range: ReleaseRange }> {
  const { dir, base } = await makeBaseFixture(files);
  await writeFiles(dir, changes);
  await commitAll(dir, "change");
  return { dir, range: fixtureRange(base) };
}

// Findings are compared as a set: which commit of a range a value entered by
// is not something the check promises to report in any particular order.
function sortHits(hits: PublicSafetyHit[]): PublicSafetyHit[] {
  return [...hits].sort((left, right) =>
    `${left.path} ${left.line}`.localeCompare(`${right.path} ${right.line}`)
  );
}

Deno.test("range base binding fails closed in CI without an immutable id", () => {
  assertEquals(resolveRangeBase(envOf({})), { authoritative: false });
  const rejected: Record<string, string>[] = [
    { GITHUB_ACTIONS: "true" },
    { GITHUB_ACTIONS: "true", DYFJ_GATE_RANGE_BASE: "" },
    { GITHUB_ACTIONS: "true", DYFJ_GATE_RANGE_BASE: "main" },
    { GITHUB_ACTIONS: "true", DYFJ_GATE_RANGE_BASE: "0".repeat(40) },
    { DYFJ_GATE_RANGE_BASE: "--upload-pack=x" },
  ];
  for (const vars of rejected) {
    let threw = false;
    try {
      resolveRangeBase(envOf(vars));
    } catch (error) {
      threw = true;
      assertStringIncludes(String(error), "failing closed");
    }
    if (!threw) throw new Error(`accepted ${JSON.stringify(vars)}`);
  }
  const sha = "a".repeat(40);
  assertEquals(
    resolveRangeBase(
      envOf({ GITHUB_ACTIONS: "true", DYFJ_GATE_RANGE_BASE: sha }),
    ),
    { base: sha, authoritative: true },
  );
});

Deno.test("a bound range resolves exactly and rejects unknown bases", async () => {
  const { dir, range } = await makeRangeFixture({ "a.txt": "one\n" }, {});
  try {
    const base = range.diffArgs[0] ?? "";
    const resolved = await resolveReleaseRange(
      dir,
      envOf({ GITHUB_ACTIONS: "true", DYFJ_GATE_RANGE_BASE: base }),
    );
    assertEquals(resolved.diffArgs, [`${base}...HEAD`]);
    assertEquals(resolved.historyArgs, [`${base}..HEAD`]);
    assertEquals(resolved.authoritative, true);
    let threw = false;
    try {
      await resolveReleaseRange(
        dir,
        envOf({
          GITHUB_ACTIONS: "true",
          DYFJ_GATE_RANGE_BASE: "b".repeat(40),
        }),
      );
    } catch (error) {
      threw = true;
      assertStringIncludes(String(error), "git rev-parse failed");
    }
    if (!threw) throw new Error("an absent base commit resolved");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("parseAddedLines numbers added lines from hunk headers", () => {
  const diff = [
    "diff --git a/f b/f",
    "--- a/f",
    "+++ b/f",
    "@@ -1,0 +2,2 @@",
    "+added two",
    "+added three",
    "@@ -9,1 +11,1 @@",
    "-removed",
    "+added eleven",
  ].join("\n");
  assertEquals(parseAddedLines(diff), [
    { line: 2, text: "added two" },
    { line: 3, text: "added three" },
    { line: 11, text: "added eleven" },
  ]);
});

Deno.test("parseAddedLines keeps added lines that look like file headers", () => {
  // The first added line's own content starts with `++`, so its raw diff line
  // starts with `+++` — identical in shape to the file header four lines
  // above it. Only hunk state tells them apart, and a scan that dropped it
  // would never see the value it carries.
  const diff = [
    "diff --git a/f b/f",
    "index 1111111..2222222 100644",
    "--- a/f",
    "+++ b/f",
    "@@ -0,0 +1,2 @@",
    `+++token ${awsKeyFixture()}`,
    "+plain",
    "diff --git a/g b/g",
    "--- a/g",
    "+++ b/g",
    "@@ -0,0 +1 @@",
    "+in the second file",
  ].join("\n");
  assertEquals(parseAddedLines(diff), [
    { line: 1, text: `++token ${awsKeyFixture()}` },
    { line: 2, text: "plain" },
    { line: 1, text: "in the second file" },
  ]);
});

Deno.test("parseAddedLines reads combined merge hunks", () => {
  // `git diff-tree -c` marks each line once per parent. Only a line added
  // against every parent is content the merge itself introduced; the line
  // inherited from one parent belongs to that parent's own commit.
  const diff = [
    "diff --combined f",
    "index 1111111,2222222..3333333",
    "--- a/f",
    "+++ b/f",
    "@@@ -3,1 -3,0 +3,2 @@@",
    " +inherited from the first parent",
    `++token ${awsKeyFixture()}`,
  ].join("\n");
  assertEquals(parseAddedLines(diff), [
    { line: 4, text: `token ${awsKeyFixture()}` },
  ]);
});

Deno.test("the range history walk is bounded and fails closed", async () => {
  const { dir, range } = await makeRangeFixture({ "a.txt": "one\n" }, {});
  try {
    const commits = await rangeCommits(dir, range);
    assertEquals(commits.length, 1);
    assertEquals(commits[0]?.isMerge, false);
    // A range with no history view has no commits to walk.
    assertEquals(
      await rangeCommits(dir, { ...range, historyArgs: undefined }),
      [],
    );
    let threw = false;
    try {
      await rangeCommits(dir, range, "git", 0);
    } catch (error) {
      threw = true;
      assertStringIncludes(String(error), "failing closed");
    }
    if (!threw) throw new Error("a range past the commit bound was walked");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("secret.diff flags added secrets, not preexisting ones", async () => {
  const { dir, range } = await makeRangeFixture(
    {
      "base-secret.txt": `key ${awsKeyFixture()}\n`,
      "a.txt": "clean\n",
    },
    { "a.txt": `clean\ntoken ${awsKeyFixture()}\n` },
  );
  try {
    const hits = await secretDiffHits(dir, range);
    assertEquals(hits, [
      { path: "a.txt", line: 2, rule: "secret.diff/aws-access-key-id" },
    ]);
    const formatted = formatHits(hits);
    if (formatted.includes(awsKeyFixture())) {
      throw new Error("secret-shaped content reached formatted output");
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("secret.diff fails on a secret a later commit removed", async () => {
  const { dir, base } = await makeBaseFixture({ "a.txt": "clean\n" });
  try {
    // The value is published in the range's ancestry even though the range's
    // endpoints never hold it. The second added line's content starts with
    // `++`, so its raw diff line is shaped exactly like a file header.
    await writeFiles(dir, {
      "a.txt": `clean\ntoken ${awsKeyFixture()}\n`,
      "b.txt": `++token ${awsKeyFixture()}\n`,
    });
    await commitAll(dir, "introduce");
    await writeFiles(dir, { "a.txt": "clean\n", "b.txt": "clean\n" });
    await commitAll(dir, "remove");
    const range = fixtureRange(base);

    // Net endpoints only: the gap this check must not have.
    assertEquals(
      await secretDiffHits(dir, { ...range, historyArgs: undefined }),
      [],
    );
    assertEquals(sortHits(await secretDiffHits(dir, range)), [
      { path: "a.txt", line: 2, rule: "secret.diff/aws-access-key-id" },
      { path: "b.txt", line: 1, rule: "secret.diff/aws-access-key-id" },
    ]);

    // The authoritative CI lane fails on it, value-free.
    const ci = captureOut();
    assertEquals(
      await runRangeCheck(
        "secret.diff",
        dir,
        envOf({ GITHUB_ACTIONS: "true", DYFJ_GATE_RANGE_BASE: base }),
        ci.out,
      ),
      1,
    );
    assertStringIncludes(ci.text(), "a.txt:2: secret.diff/aws-access-key-id");
    assertStringIncludes(ci.text(), "b.txt:1: secret.diff/aws-access-key-id");
    if (ci.text().includes(awsKeyFixture())) {
      throw new Error("secret-shaped content reached range-check output");
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("secret.diff covers merged branches and the merge itself", async () => {
  const { dir, base } = await makeBaseFixture({ "a.txt": "clean\n" });
  try {
    // A merged branch introduces a secret and takes it back out again.
    await gitIn(dir, ["checkout", "-qb", "side"]);
    await writeFiles(dir, { "side.txt": `token ${awsKeyFixture()}\n` });
    await commitAll(dir, "side introduces");
    await writeFiles(dir, { "side.txt": "clean\n" });
    await commitAll(dir, "side removes");
    // The merge itself then introduces one that is in neither parent — an
    // edit made while merging — which a later commit removes in turn.
    await gitIn(dir, ["checkout", "-q", base]);
    await writeFiles(dir, { "a.txt": "clean\nmainline\n" });
    await commitAll(dir, "mainline");
    await gitIn(dir, ["merge", "-q", "--no-ff", "--no-commit", "side"]);
    await writeFiles(dir, {
      "a.txt": `clean\nmainline\ntoken ${awsKeyFixture()}\n`,
    });
    await commitAll(dir, "merge");
    await writeFiles(dir, { "a.txt": "clean\nmainline\n" });
    await commitAll(dir, "drop the merge edit");
    const range = fixtureRange(base);

    assertEquals(
      await secretDiffHits(dir, { ...range, historyArgs: undefined }),
      [],
    );
    const commits = await rangeCommits(dir, range);
    assertEquals(commits.filter((commit) => commit.isMerge).length, 1);
    assertEquals(sortHits(await secretDiffHits(dir, range)), [
      { path: "a.txt", line: 3, rule: "secret.diff/aws-access-key-id" },
      { path: "side.txt", line: 1, rule: "secret.diff/aws-access-key-id" },
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("secret.diff sanitizes hostile filenames", async () => {
  const hostile = "evil\x1b[2J\rname.txt";
  const { dir, range } = await makeRangeFixture(
    {},
    { [hostile]: `token ${awsKeyFixture()}\n` },
  );
  try {
    const hits = await secretDiffHits(dir, range);
    assertEquals(hits.length, 1);
    const formatted = formatHits(hits);
    for (const ch of formatted) {
      const code = ch.codePointAt(0) ?? 0;
      if (code < 0x20 || code === 0x7f) {
        throw new Error("control byte reached formatted output");
      }
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("secret.diff does not skip the scanner's own source path", async () => {
  const { dir, range } = await makeRangeFixture({}, {});
  try {
    await Deno.mkdir(`${dir}/scripts`);
    await Deno.writeTextFile(
      `${dir}/scripts/public-safety-scan.ts`,
      `token ${awsKeyFixture()}\n`,
    );
    await gitIn(dir, ["add", "."]);
    await gitIn(dir, ["commit", "-q", "-m", "scanner change"]);
    const hits = await secretDiffHits(dir, range);
    assertEquals(hits, [{
      path: "scripts/public-safety-scan.ts",
      line: 1,
      rule: "secret.diff/aws-access-key-id",
    }]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

function captureOut(): {
  out: Pick<Console, "log" | "error">;
  text: () => string;
} {
  const lines: string[] = [];
  const record = (...parts: unknown[]) => {
    lines.push(parts.map((part) => String(part)).join(" "));
  };
  return { out: { log: record, error: record }, text: () => lines.join("\n") };
}

Deno.test("secret.diff sees untracked non-ignored files only in a local range", async () => {
  const { dir, range } = await makeRangeFixture({ "a.txt": "clean\n" }, {});
  try {
    await Deno.writeTextFile(`${dir}/.gitignore`, "ignored-local/\n");
    await Deno.mkdir(`${dir}/ignored-local`);
    await Deno.writeTextFile(
      `${dir}/ignored-local/key.txt`,
      `token ${awsKeyFixture()}\n`,
    );
    await Deno.writeTextFile(
      `${dir}/untracked.txt`,
      `token ${awsKeyFixture()}\n`,
    );
    // The gap: a path git does not track appears in no diff, so the range
    // scan alone reports nothing at all.
    assertEquals(await secretDiffHits(dir, range), []);
    const untracked = await untrackedSecretHits(dir);
    assertEquals(untracked.coverage, {
      inventoryBound: false,
      truncatedPaths: [],
      unlistedTruncated: 0,
    });
    // The ignored file is absent: ignored paths stay excluded.
    assertEquals(untracked.hits, [
      { path: "untracked.txt", line: 1, rule: "secret.diff/aws-access-key-id" },
    ]);

    const local = captureOut();
    assertEquals(
      await runRangeCheck("secret.diff", dir, envOf({}), local.out),
      1,
    );
    assertStringIncludes(
      local.text(),
      "untracked.txt:1: secret.diff/aws-access-key-id",
    );
    if (local.text().includes(awsKeyFixture())) {
      throw new Error("secret-shaped content reached range-check output");
    }

    // An authoritative CI range stays exactly what the bound subject
    // introduces. CI does not scan untracked files because it rejects a
    // dirty subject tree instead — `subject.resolve` fails closed here.
    const base = range.diffArgs[0] ?? "";
    const ci = captureOut();
    assertEquals(
      await runRangeCheck(
        "secret.diff",
        dir,
        envOf({ GITHUB_ACTIONS: "true", DYFJ_GATE_RANGE_BASE: base }),
        ci.out,
      ),
      0,
    );
    assertStringIncludes(ci.text(), "secret.diff: clean");
    assertEquals(await isWorktreeClean(dir), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("untracked secret feedback sanitizes hostile filenames", async () => {
  const { dir } = await makeRangeFixture({}, {});
  const value = awsKeyFixture();
  try {
    await Deno.writeTextFile(
      `${dir}/evil\x1b[2J\rname.txt`,
      `token ${value}\n`,
    );
    const { hits } = await untrackedSecretHits(dir);
    assertEquals(hits.length, 1);
    const formatted = formatHits(hits);
    if (formatted.includes(value)) {
      throw new Error("untracked content reached formatted output");
    }
    for (const ch of formatted) {
      const code = ch.codePointAt(0) ?? 0;
      if (code < 0x20 || code === 0x7f) {
        throw new Error("control byte reached formatted output");
      }
    }
    assertEquals(formatted, "evil[2Jname.txt:1: secret.diff/aws-access-key-id");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test({
  name: "an untracked symlink is never followed by secret feedback",
  ignore: Deno.build.os === "windows",
  async fn() {
    const outside = await Deno.makeTempDir({ prefix: "dyfj-untracked-out-" });
    const { dir } = await makeRangeFixture({}, {});
    try {
      // Following the link would surface the target's secret shape; the link
      // text itself carries none, so an empty result proves containment.
      await Deno.writeTextFile(
        `${outside}/target.txt`,
        `token ${awsKeyFixture()}\n`,
      );
      // Deno 2.9.6 rejects path-scoped grants for Deno.symlink, so the link
      // is created via the already-allowed `ln`; output is never relayed.
      const ln = await new Deno.Command("ln", {
        args: ["-s", `${outside}/target.txt`, `${dir}/link.txt`],
        stdout: "piped",
        stderr: "piped",
      }).output();
      if (!ln.success) throw new Error(`ln -s failed (exit ${ln.code})`);
      assertEquals((await untrackedSecretHits(dir)).hits, []);
    } finally {
      await Deno.remove(dir, { recursive: true });
      await Deno.remove(outside, { recursive: true });
    }
  },
});

Deno.test("an oversized untracked file fails the local secret.diff check", async () => {
  const { dir, range } = await makeRangeFixture({ "a.txt": "clean\n" }, {});
  try {
    // The secret shape sits past the per-file prefix bound, so the untracked
    // sweep cannot see it. Reporting `clean` here would assert coverage the
    // check never had.
    await Deno.writeTextFile(
      `${dir}/artifact.bin`,
      `${"x".repeat(MAX_UNTRACKED_FILE_BYTES)}\ntoken ${awsKeyFixture()}\n`,
    );
    const untracked = await untrackedSecretHits(dir);
    assertEquals(untracked.hits, []);
    assertEquals(untracked.coverage.truncatedPaths, ["artifact.bin"]);

    const local = captureOut();
    assertEquals(
      await runRangeCheck("secret.diff", dir, envOf({}), local.out),
      1,
    );
    assertStringIncludes(local.text(), "secret.diff: incomplete coverage");
    assertStringIncludes(
      local.text(),
      "artifact.bin: read only its leading bytes",
    );
    if (local.text().includes("secret.diff: clean")) {
      throw new Error("partial coverage reported as a clean check");
    }
    if (local.text().includes(awsKeyFixture())) {
      throw new Error("secret-shaped content reached range-check output");
    }

    // CI is unaffected: the authoritative range is the bound diff, read whole,
    // and a dirty subject tree is rejected by `subject.resolve` instead.
    const ci = captureOut();
    assertEquals(
      await runRangeCheck(
        "secret.diff",
        dir,
        envOf({
          GITHUB_ACTIONS: "true",
          DYFJ_GATE_RANGE_BASE: range.diffArgs[0] ?? "",
        }),
        ci.out,
      ),
      0,
    );
    assertStringIncludes(ci.text(), "secret.diff: clean");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("an overflowing untracked count fails the local secret.diff check", async () => {
  const { dir } = await makeRangeFixture({ "a.txt": "clean\n" }, {});
  try {
    for (let index = 0; index <= MAX_UNTRACKED_FILES; index++) {
      await Deno.writeTextFile(
        `${dir}/file-${String(index).padStart(6, "0")}.txt`,
        "clean\n",
      );
    }
    const untracked = await untrackedSecretHits(dir);
    // Every admitted file is clean, so a hits-only verdict would pass while an
    // unknown number of untracked files were never opened.
    assertEquals(untracked.hits, []);
    assertEquals(untracked.coverage.inventoryBound, true);

    const local = captureOut();
    assertEquals(
      await runRangeCheck("secret.diff", dir, envOf({}), local.out),
      1,
    );
    assertStringIncludes(local.text(), "secret.diff: incomplete coverage");
    assertStringIncludes(
      local.text(),
      "untracked inventory reached its file-count bound",
    );
    if (local.text().includes("secret.diff: clean")) {
      throw new Error("capped inventory reported as a clean check");
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("diff.whitespace reports class and line, never content", async () => {
  const secretish = `password-shaped ${awsKeyFixture()}`;
  const { dir, range } = await makeRangeFixture(
    { "a.txt": "clean\n" },
    { "a.txt": `clean\n${secretish}   \n` },
  );
  try {
    const hits = await whitespaceHits(dir, range);
    assertEquals(hits, [
      { path: "a.txt", line: 2, rule: "diff.whitespace/trailing-whitespace" },
    ]);
    if (formatHits(hits).includes(secretish)) {
      throw new Error("line content reached formatted output");
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("markdown.links validates changed repository-relative links", async () => {
  const doc = [
    "[ok](target.md)",
    "[broken](missing.md)",
    "[external](https://example.invalid/page)",
    "[anchor](#section)",
    "[escape](../outside.md)",
    "```",
    "[fenced](also-missing.md)",
    "```",
  ].join("\n");
  const { dir, range } = await makeRangeFixture(
    { "target.md": "# target\n" },
    { "doc.md": `${doc}\n` },
  );
  try {
    const hits = await markdownLinkHits(dir, range);
    assertEquals(hits, [
      { path: "doc.md", line: 2, rule: "markdown.links/broken-relative-link" },
      { path: "doc.md", line: 5, rule: "markdown.links/escapes-repository" },
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("markdown.links flags an unclosed fence", async () => {
  const { dir, range } = await makeRangeFixture(
    {},
    { "doc.md": "start\n```sh\nnever closed\n" },
  );
  try {
    assertEquals(await markdownLinkHits(dir, range), [
      { path: "doc.md", line: 2, rule: "markdown.links/unclosed-fence" },
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("markdown link extraction resolves targets structurally", () => {
  const { links } = markdownLinkTargets(
    "see [a](x/y.md) and `[b](in-code.md)` and [c](z.md#frag)\n",
  );
  assertEquals(links.map((link) => link.target), ["x/y.md", "z.md#frag"]);
  assertEquals(
    resolveLinkTarget("docs/guide.md", "../README.md"),
    "README.md",
  );
  assertEquals(
    resolveLinkTarget("README.md", "/core/README.md"),
    "core/README.md",
  );
  assertEquals(resolveLinkTarget("README.md", "../escape.md"), undefined);
  assertEquals(resolveLinkTarget("docs/a.md", "b.md#x"), "docs/b.md");
});

Deno.test("shell.parse fails changed shell files that do not parse", async () => {
  const { dir, range } = await makeRangeFixture(
    {},
    {
      "good.sh": "#!/bin/bash\necho ok\n",
      "bad.sh": '#!/bin/bash\nif [ -z "$x" ; then\necho\n',
      "shebang-tool": "#!/usr/bin/env bash\nwhile do\n",
      "notes.txt": "while do\n",
    },
  );
  try {
    const hits = await shellParseHits(dir, range);
    assertEquals(
      hits.map((hit) => [hit.path, hit.rule]),
      [
        ["bad.sh", "shell.parse/parse-error"],
        ["shebang-tool", "shell.parse/parse-error"],
      ],
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test({
  name:
    "shell.parse fails closed on a changed shell-named symlink without following it",
  ignore: Deno.build.os === "windows",
  async fn() {
    const outside = await Deno.makeTempDir({ prefix: "dyfj-shell-outside-" });
    const { dir, range } = await makeRangeFixture({}, {});
    try {
      // The external target parses cleanly: if the check followed the link
      // and handed the target to a real parser, no hit would appear.
      await Deno.writeTextFile(
        `${outside}/target.sh`,
        "#!/bin/bash\necho ok\n",
      );
      // Deno 2.9.6 rejects path-scoped grants for Deno.symlink, so the link
      // is created via the already-allowed `ln`; output is never relayed.
      const ln = await new Deno.Command("ln", {
        args: ["-s", `${outside}/target.sh`, `${dir}/link.sh`],
        stdout: "piped",
        stderr: "piped",
      }).output();
      if (!ln.success) throw new Error(`ln -s failed (exit ${ln.code})`);
      await gitIn(dir, ["add", "."]);
      await gitIn(dir, ["commit", "-q", "-m", "symlink change"]);
      // A nonexistent parser command proves containment: any attempt to
      // parse would throw the fail-closed parser-unavailable error instead
      // of reporting the fixed symlink class.
      const hits = await shellParseHits(
        dir,
        range,
        "git",
        "./missing-shell-for-test",
      );
      assertEquals(hits, [
        { path: "link.sh", line: 0, rule: "shell.parse/symlink-not-parsed" },
      ]);
    } finally {
      await Deno.remove(dir, { recursive: true });
      await Deno.remove(outside, { recursive: true });
    }
  },
});

Deno.test("an unavailable shell parser fails closed", async () => {
  const { dir, range } = await makeRangeFixture(
    {},
    { "any.sh": "echo ok\n" },
  );
  try {
    let message = "";
    try {
      await shellParseHits(dir, range, "git", "./missing-shell-for-test");
      throw new Error("expected shellParseHits to throw");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assertEquals(
      message,
      "range check: cannot run the shell parser; failing closed",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
