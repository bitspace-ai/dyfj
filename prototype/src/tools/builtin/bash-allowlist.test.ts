import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { classifyReadOnlyBash, MAX_ALLOWLIST_COMMAND_LENGTH } from "./bash-allowlist.ts";

let base = "";
let root = "";
let outside = "";

before(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "bash-allowlist-")));
  root = join(base, "ws");
  outside = join(base, "outside");
  mkdirSync(join(root, "src", "deep"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(root, "f"), "a\nb\n");
  writeFileSync(join(root, "src", "x.ts"), "x\n");
  writeFileSync(join(root, "patterns"), "a\n");
  // bash's cd is logical: `link/..` is the workspace root, not `src`.
  symlinkSync(join(root, "src", "deep"), join(root, "deep-link"));
  writeFileSync(join(outside, "secret"), "s\n");
  symlinkSync(join(outside, "secret"), join(root, "escape"));
  symlinkSync(outside, join(root, "escape-dir"));
  // A link to a link to outside.
  symlinkSync(join(root, "escape-dir"), join(root, "chain"));
});

after(() => rmSync(base, { recursive: true }));

function allowed(command: string, cwd = root): boolean {
  return classifyReadOnlyBash(command, cwd, root).allow;
}

describe("classifyReadOnlyBash: read-only commands run without asking", () => {
  for (
    const command of [
      "git status",
      "git status --short",
      "git diff",
      "git diff --stat origin/main..HEAD",
      "git log --oneline -5",
      "git show HEAD:prototype/src/x.ts",
      "git branch --show-current",
      "git rev-parse --abbrev-ref HEAD",
      "ls",
      "ls -la src",
      "cat f",
      "head -n 20 f",
      "tail -5 f",
      "wc -l f src/x.ts",
      "grep -rn foo src",
      "grep -n 'a b' f",
      "rg -n foo src",
      "rg --files -g '*.ts' src",
      "sed -n '1,40p' f",
      "sed -n 5p f",
      "sed -n -e '1,2p' -e '$p' f",
      "sed -n '10,$p' f",
      'cd "$PWD" && git status',
      "cd $PWD && git status",
      "cd src && ls",
      `cd ${"'"}${"src/deep"}${"'"} && ls`,
      "git status && git diff",
      "git status; git log --oneline -3",
      "git diff 2>&1 | head -50",
      "git log 2>&1 | tail -n 20",
      'cd "$PWD" && git status && git diff 2>&1 | head -50',
      // The option forms models actually use.
      "grep -f patterns f",
      "grep --file=patterns f",
      "grep -e foo -n f",
      "grep -A3 -B 2 foo f",
      "grep -rn --include='*.ts' foo src",
      "head -c 10 f",
      "tail -n +2 f",
      "wc -lw f",
      "rg -n -g '*.ts' foo src",
      "rg -C2 -i foo",
      "rg --ignore-file=patterns foo",
      "git status --porcelain",
      "git status -sb",
      "git status --short --branch",
      "git diff --cached --name-only",
      "git diff --staged --stat",
      "git diff -U3 HEAD~1",
      "git log --format=%H -n 3",
      "git log --pretty=format:%h%x20%s -5",
      "git log -n5 --stat",
      "git log --oneline -- src",
      "git show --stat HEAD",
      "git show --name-only HEAD~2",
      "git rev-parse --show-toplevel",
      "git rev-parse --git-dir",
      "git rev-parse --short HEAD",
    ]
  ) {
    it(command, () => assert.equal(allowed(command), true, command));
  }

  it("an absolute path inside the workspace", () => {
    assert.equal(allowed(`cat ${root}/f`), true);
    assert.equal(allowed(`cd ${root}/src && ls`), true);
  });

  it("paths resolve against the effective cwd", () => {
    assert.equal(allowed("cat ../f", join(root, "src")), true);
    assert.equal(allowed("cd src && cat ../f"), true);
  });
});

describe("classifyReadOnlyBash: anything else asks", () => {
  for (
    const [label, command] of [
      ["git global -c before the subcommand", "git -c core.pager=less log"],
      ["git -C", "git -C /tmp status"],
      ["git --git-dir", "git --git-dir=/tmp/x status"],
      ["git -p pager", "git -p log"],
      ["git hook-running subcommand", "git commit -m x"],
      ["git checkout", "git checkout main"],
      ["git push", "git push"],
      ["git branch other than --show-current", "git branch -D main"],
      ["git diff --output", "git diff --output=out"],
      ["git diff --ext-diff", "git diff --ext-diff"],
      ["git diff --textconv", "git log -p --textconv"],
      ["git log --show-signature", "git log --show-signature"],
      ["git diff --no-index", "git diff --no-index f src/x.ts"],
      ["sed -i", "sed -i s/a/b/ f"],
      ["sed -i attached", "sed -n -i '1p' f"],
      ["sed --in-place", "sed --in-place -n 1p f"],
      ["sed without -n", "sed 1p f"],
      ["sed write command", "sed -n '1w out' f"],
      ["sed substitute", "sed -n 's/a/b/p' f"],
      ["sed execute", "sed -n '1e id' f"],
      ["redirect to a file", "grep x f > out"],
      ["append redirect", "cat f >> out"],
      ["input redirect", "cat < f"],
      ["stderr redirect to a file", "git status 2> out"],
      ["home path", "cat ~/.ssh/id_rsa"],
      ["parent escape", "cat ../../x"],
      ["absolute outside", "cat /etc/passwd"],
      ["symlink to an outside file", "cat escape"],
      ["symlink to an outside directory", "ls escape-dir"],
      ["cd outside", "cd /tmp && ls"],
      ["cd up and out", "cd .. && ls"],
      ["cd followed by ;", "cd src; ls"],
      ["bare cd", "cd && ls"],
      ["cd -", "cd - && ls"],
      ["cd ~", "cd ~ && ls"],
      ["cd through a symlink then .. (logical cd)", "cd deep-link/.. && cat escape"],
      ["cd into a symlink then cd .. (logical cd)", "cd deep-link && cd .. && cat escape"],
      ["cd into an in-workspace symlink", "cd deep-link && ls"],
      ["cd to a file", "cd f && ls"],
      ["cd to a missing directory", "cd nope && ls"],
      ["substitution in double quotes", 'grep "$(id)" f'],
      ["backticks in double quotes", 'grep "`id`" f'],
      ["bare substitution", "cat $(echo f)"],
      ["variable", "cat $HOME/f"],
      ["backticks", "cat `echo f`"],
      ["process substitution", "cat <(echo f)"],
      ["test command chained with rm", "npm test; rm -rf x"],
      ["npm test", "npm test"],
      ["npm run test:fast", "npm run test:fast"],
      ["cargo test", "SQLX_OFFLINE=true cargo test -p dyfj-repl"],
      ["fullwidth semicolon", "ls ； rm x"],
      ["fullwidth ampersand", "ls ＆＆ rm x"],
      ["non-ASCII inside quotes", "grep 'é' f"],
      ["unknown command in a chain", "git status && foo"],
      ["unknown command", "rm -rf x"],
      ["pipe to a non-head stage", "cat f | sh"],
      ["two pipes", "cat f | head | tail"],
      ["head with a path in a pipe", "git log | head f"],
      ["pager", "less f"],
      ["environment assignment", "FOO=1 git status"],
      ["background &", "git status &"],
      ["or chain", "git status || rm x"],
      ["subshell", "(git status)"],
      ["newline", "git status\nrm x"],
      ["tab", "git\tstatus"],
      ["backslash escape", "cat f\\ x"],
      ["glob", "cat *.ts"],
      ["brace", "cat {f,g}"],
      ["comment", "git status # x"],
      ["unterminated quote", "cat 'f"],
      ["empty", ""],
      ["only an operator", "&&"],
      ["trailing operator", "git status &&"],
      ["rg --pre", "rg --pre cat foo"],
      ["rg -z cluster", "rg -nz foo"],
      ["rg --follow", "rg -L foo"],
      ["grep -R", "grep -R foo ."],
      ["ls -L", "ls -L"],
      ["tail -f", "tail -f f"],
      ["short option with an attached path", "grep -f/etc/passwd f"],
      ["long option with an outside value", "grep --file=/etc/passwd f"],
      // File-bearing option values are path-checked in every form.
      ["attached short pattern file through a symlink", "grep -fescape f"],
      ["separate short pattern file through a symlink", "grep -f escape f"],
      ["long pattern file through a symlink", "grep --file=escape f"],
      ["long pattern file as the next word", "grep --file escape f"],
      ["rg ignore file through a symlink", "rg --ignore-file=escape foo"],
      ["rg ignore file as the next word", "rg --ignore-file escape foo"],
      ["rg pattern file through a symlink", "rg -fescape foo"],
      // The kernel follows a symlink before `..`, so `..` must not be
      // collapsed lexically first.
      ["a symlink then .. out of the workspace", "cat escape-dir/../outside/secret"],
      ["cd through a symlink then ..", "cd escape-dir/.. && cat outside/secret"],
      ["a symlink chain to outside", "cat chain/secret"],
      ["a symlink chain then ..", "cat chain/../outside/secret"],
      [".. past the workspace root", "cat src/../../outside/secret"],
      ["a missing path under an escaping symlink", "cat escape-dir/missing"],
      ["a missing path under a symlink chain", "ls chain/missing/deeper"],
      ["an option value through a symlink then ..", "grep -f escape-dir/../outside/secret f"],
      ["filename indirection", "wc --files0-from=f"],
      ["an option abbreviation", "wc --files0=f"],
      ["an unknown ls option", "ls --dereference"],
      ["an unknown cat option", "cat --unknown f"],
      ["an unknown grep option", "grep --devices=read x f"],
      ["an unknown rg option", "rg --type-add=x:* foo"],
      ["a non-numeric count", "head -n x f"],
      ["an unknown git status option", "git status --untracked-files=all"],
      ["an unknown git diff option", "git diff --relative"],
      ["git diff orderfile through a symlink", "git diff -Oescape"],
      ["an unknown git log option", "git log --walk-reflogs"],
      ["a git format that verifies signatures", "git log '--format=%G?'"],
      ["a git pretty that verifies signatures", "git log --pretty=format:%GS"],
      ["an unknown git show option", "git show --ext-diff HEAD"],
      ["an unknown git rev-parse option", "git rev-parse --local-env-vars"],
    ] as const
  ) {
    it(label, () => assert.equal(allowed(command), false, command));
  }

  it("an over-long command", () => {
    const command = `cat ${"f ".repeat(MAX_ALLOWLIST_COMMAND_LENGTH)}`;
    assert.ok(command.length > MAX_ALLOWLIST_COMMAND_LENGTH);
    assert.equal(allowed(command), false);
  });

  it("says why it asked", () => {
    const verdict = classifyReadOnlyBash("rm x", root, root);
    assert.equal(verdict.allow, false);
    assert.ok(!verdict.allow && verdict.why.length > 0);
  });
});
