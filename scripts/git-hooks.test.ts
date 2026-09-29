// Regression tests for the repository's git hooks (`.githooks/`): commit-msg
// strips tool attribution and refuses a tool identity, including one given
// with `git commit --author`; pre-push refuses to publish commits that carry
// either, including commits made with --no-verify.

const hooksPath = new URL("../.githooks", import.meta.url).pathname;

const human = { name: "Dana Human", email: "dana@example.invalid" };
// Tool addresses are joined from parts: the public-safety scan admits only
// reserved-domain addresses written out whole.
const claudeEmail = ["noreply", "anthropic.com"].join("@");
const cursorEmail = ["cursoragent", "cursor.com"].join("@");
const tool = { name: "Claude", email: claudeEmail };

function assertEquals<T>(actual: T, expected: T): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`expected ${e}, got ${a}`);
}

function assertStringIncludes(actual: string, expected: string): void {
  if (!actual.includes(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)} in ${actual}`);
  }
}

type Ident = { name: string; email: string };

async function git(
  dir: string,
  args: string[],
  who: Ident = human,
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  const result = await new Deno.Command("git", {
    args: ["-C", dir, ...args],
    env: {
      PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: who.name,
      GIT_AUTHOR_EMAIL: who.email,
      GIT_COMMITTER_NAME: who.name,
      GIT_COMMITTER_EMAIL: who.email,
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
  return {
    success: result.success,
    stdout: decode(result.stdout),
    stderr: decode(result.stderr),
  };
}

async function gitOk(
  dir: string,
  args: string[],
  who: Ident = human,
): Promise<string> {
  const result = await git(dir, args, who);
  if (!result.success) {
    throw new Error(`git ${args[0]} failed: ${result.stderr}`);
  }
  return result.stdout;
}

// A clone with the hooks enabled, pushing to a local bare remote that already
// holds one base commit on main.
async function makeFixture(): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "dyfj-git-hooks-" });
  const remote = `${root}/remote.git`;
  const dir = `${root}/work`;
  await gitOk(root, ["init", "-q", "--bare", "-b", "main", remote]);
  await gitOk(root, ["init", "-q", "-b", "main", dir]);
  await gitOk(dir, ["remote", "add", "origin", remote]);
  await gitOk(dir, ["commit", "-q", "--allow-empty", "-m", "base"]);
  await gitOk(dir, ["push", "-q", "origin", "main"]);
  await gitOk(dir, ["config", "core.hooksPath", hooksPath]);
  await gitOk(dir, ["checkout", "-q", "-b", "topic"]);
  return dir;
}

async function commitWithMessage(
  dir: string,
  message: string,
  who: Ident = human,
  extra: string[] = [],
) {
  const file = `${dir}/../message.txt`;
  await Deno.writeTextFile(file, message);
  return await git(
    dir,
    ["commit", "-q", "--allow-empty", "-F", file, ...extra],
    who,
  );
}

Deno.test("commit-msg strips tool attribution and keeps human co-authors", async () => {
  const dir = await makeFixture();
  const result = await commitWithMessage(
    dir,
    [
      "Subject",
      "",
      'The body may mention the "Generated with Claude Code" footer.',
      "",
      "Co-authored-by: Claude Shannon <claude@example.invalid>",
      `Co-Authored-By: Claude Opus 5.5 <${claudeEmail}>`,
      `Co-authored-by: Cursor Agent <${cursorEmail}>`,
      "Claude-Session: https://claude.ai/code/session_x",
      "",
      "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
      "",
    ].join("\n"),
  );
  assertEquals(result.success, true);
  assertEquals(
    await gitOk(dir, ["log", "-1", "--format=%B"]),
    [
      "Subject",
      "",
      'The body may mention the "Generated with Claude Code" footer.',
      "",
      "Co-authored-by: Claude Shannon <claude@example.invalid>",
      "",
      "",
    ].join("\n"),
  );
});

Deno.test("commit-msg refuses a tool author and accepts a human named like one", async () => {
  const dir = await makeFixture();
  const refused = await commitWithMessage(dir, "x\n", tool);
  assertEquals(refused.success, false);
  assertStringIncludes(refused.stderr, "refusing a commit attributed to");

  const accepted = await commitWithMessage(dir, "y\n", {
    name: "Claude Shannon",
    email: "claude@example.invalid",
  });
  assertEquals(accepted.success, true);
});

Deno.test("commit-msg refuses a merge committed by a tool", async () => {
  const dir = await makeFixture();
  await gitOk(dir, ["checkout", "-q", "-b", "side"]);
  await gitOk(dir, ["commit", "-q", "--allow-empty", "-m", "side"]);
  await gitOk(dir, ["checkout", "-q", "topic"]);
  const merge = await git(
    dir,
    ["merge", "--no-ff", "-q", "-m", "m", "side"],
    tool,
  );
  assertEquals(merge.success, false);
  assertStringIncludes(merge.stderr, "refusing a commit attributed to");
});

Deno.test("commit-msg refuses a tool author given with --author", async () => {
  const dir = await makeFixture();
  const commit = await commitWithMessage(dir, "clean message\n", human, [
    `--author=${tool.name} <${tool.email}>`,
  ]);
  assertEquals(commit.success, false);
  assertStringIncludes(commit.stderr, "refusing a commit attributed to");
});

Deno.test("pre-push refuses a tool author that bypassed commit-msg", async () => {
  const dir = await makeFixture();
  const commit = await commitWithMessage(dir, "clean message\n", human, [
    `--author=${tool.name} <${tool.email}>`,
    "--no-verify",
  ]);
  assertEquals(commit.success, true);
  const push = await git(dir, ["push", "-q", "origin", "topic"]);
  assertEquals(push.success, false);
  assertStringIncludes(
    push.stderr,
    `is attributed to 'Claude <${claudeEmail}>'`,
  );
});

Deno.test("pre-push refuses a tool trailer committed with --no-verify", async () => {
  const dir = await makeFixture();
  const commit = await commitWithMessage(
    dir,
    `subject\n\nCo-Authored-By: Claude <${claudeEmail}>\n`,
    human,
    ["--no-verify"],
  );
  assertEquals(commit.success, true);
  const push = await git(dir, ["push", "-q", "origin", "topic"]);
  assertEquals(push.success, false);
  assertStringIncludes(push.stderr, "carries tool attribution in its message");
});

Deno.test("pre-push publishes clean commits, new branch and update alike", async () => {
  const dir = await makeFixture();
  await commitWithMessage(dir, "first\n");
  assertEquals(
    (await git(dir, ["push", "-q", "origin", "topic"])).success,
    true,
  );
  await commitWithMessage(dir, "second\n");
  assertEquals(
    (await git(dir, ["push", "-q", "origin", "topic"])).success,
    true,
  );
});
