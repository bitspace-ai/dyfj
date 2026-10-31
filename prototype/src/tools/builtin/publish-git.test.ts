import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { describe, it } from "node:test";
import {
  FULL_COMMIT,
  GitLayoutError,
  type GitLayout,
  layoutsMatch,
  publishChildEnv,
  publishGitConfigArgs,
  publishGitConfigEnv,
  PUBLISH_GIT_CONFIG,
  publishGitEnvFor,
  readPublishGitLayout,
} from "./publish-git.ts";
import type { BoundedResult } from "./bounded-process.ts";
import { compileWorkspacePolicy } from "./srt-policy.ts";

const posix = process.platform !== "win32";

/** A fixture checkout: an identity is set so `commit` works on any host. */
function git(args: readonly string[]): void {
  execFileSync("git", [...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
    stdio: "ignore",
  });
}

function result(stdout: string, code = 0): BoundedResult {
  return {
    code,
    signal: null,
    stdout,
    stderr: "",
    timedOut: false,
  };
}

/** A runner that answers fixed `rev-parse`/`symbolic-ref` calls. */
function stubRunner(answers: {
  gitDir?: string;
  commonDir?: string;
  topLevel?: string;
  branchRef?: string | null;
  head?: string | null;
  /** What `config --get extensions.worktreeConfig` answers; absent = unset. */
  worktreeConfig?: string;
  /** What `config --get-regexp '^include(if)?\.'` answers; absent = none. */
  includes?: string;
}) {
  const calls: string[][] = [];
  const run = async (
    args: readonly string[],
    _cwd: string,
    _timeoutMs: number,
  ): Promise<BoundedResult> => {
    calls.push([...args]);
    const joined = args.join(" ");
    const value = joined.includes("--git-dir")
      ? answers.gitDir
      : joined.includes("--git-common-dir")
      ? answers.commonDir
      : joined.includes("--show-toplevel")
      ? answers.topLevel
      : joined.includes("symbolic-ref")
      ? answers.branchRef
      : joined.includes("--verify")
      ? answers.head
      : joined.includes("extensions.worktreeConfig")
      ? answers.worktreeConfig
      : joined.includes("get-regexp")
      ? answers.includes
      : undefined;
    return value === undefined || value === null
      ? result("", 1)
      : result(`${value}\n`);
  };
  return { run, calls };
}

const LAYOUT: GitLayout = {
  gitDir: "/repo/.git/worktrees/bit-786",
  commonDir: "/repo/.git",
  topLevel: "/repo",
  branchRef: "refs/heads/chris/bit-786-host-publish-tool",
  head: "0123456789abcdef0123456789abcdef01234567",
};

describe("publish git hardening: the config block", () => {
  it("neutralizes every program-running and discovery key", () => {
    const keys = PUBLISH_GIT_CONFIG.map(([key]) => key);
    for (
      const required of [
        "core.hooksPath",
        "core.fsmonitor",
        "core.sshCommand",
        "core.pager",
        "core.editor",
        "sequence.editor",
        "core.attributesFile",
        "safe.bareRepository",
        "log.showSignature",
        "credential.helper",
        "protocol.ext.allow",
        "uploadpack.allowFilter",
      ]
    ) {
      assert.ok(keys.includes(required), `missing ${required}`);
    }
    // Every entry carries a reason: the list is read by audit as much as by
    // the code.
    for (const [, , why] of PUBLISH_GIT_CONFIG) {
      assert.ok(why.length > 20, "every key states why it is neutralized");
    }
  });

  it("leaves diff.external alone, so a child's git diff still runs", {
    skip: !posix,
  }, async () => {
    // An empty `diff.external` made every gate's `git diff` die with "cannot
    // run": git takes it as a program named "".
    assert.ok(
      !PUBLISH_GIT_CONFIG.some(([key]) => key === "diff.external"),
      "diff.external must not be overridden",
    );
    const root = await mkdtemp(join(tmpdir(), "dyfj-publish-diff-"));
    try {
      git(["init", "--quiet", "--initial-branch=work", root]);
      await writeFile(join(root, "a.txt"), "one\n");
      git(["-C", root, "add", "a.txt"]);
      git(["-C", root, "commit", "--quiet", "-m", "one"]);
      await writeFile(join(root, "a.txt"), "two\n");
      const out = execFileSync("git", ["-C", root, "diff"], {
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          ...publishGitConfigEnv(),
        },
        encoding: "utf8",
      });
      assert.match(out, /^\+two$/m);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("renders the same keys as -c arguments and as GIT_CONFIG_* env", () => {
    const args = publishGitConfigArgs();
    assert.strictEqual(args.length, PUBLISH_GIT_CONFIG.length * 2);
    const env = publishGitConfigEnv();
    assert.strictEqual(
      env["GIT_CONFIG_COUNT"],
      String(PUBLISH_GIT_CONFIG.length),
    );
    PUBLISH_GIT_CONFIG.forEach(([key, value], index) => {
      assert.strictEqual(args[index * 2], "-c");
      assert.strictEqual(args[index * 2 + 1], `${key}=${value}`);
      assert.strictEqual(env[`GIT_CONFIG_KEY_${index}`], key);
      assert.strictEqual(env[`GIT_CONFIG_VALUE_${index}`], value);
    });
  });

  it("gives every child no terminal prompt, no askpass and no pager", () => {
    const env = publishChildEnv({
      get: (name) =>
        name === "PATH" ? "/usr/bin:/bin" : name === "HOME" ? "/fixture" : undefined,
    });
    assert.strictEqual(env["GIT_TERMINAL_PROMPT"], "0");
    assert.strictEqual(env["GIT_ASKPASS"], "/bin/false");
    assert.strictEqual(env["SSH_ASKPASS"], "/bin/false");
    assert.strictEqual(env["SSH_ASKPASS_REQUIRE"], "never");
    assert.strictEqual(env["GIT_CONFIG_NOSYSTEM"], "1");
    assert.strictEqual(env["GIT_ATTR_NOSYSTEM"], "1");
    assert.strictEqual(env["GIT_PAGER"], "cat");
    assert.strictEqual(env["PATH"], "/usr/bin:/bin");
    assert.strictEqual(env["HOME"], "/fixture");
    // No runtime credential travels to a gate, a push or a PR command.
    for (
      const forbidden of [
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "DOLT_PASSWORD",
        "DYFJ_MEMORY_MCP_TOKEN",
        "DYFJ_EXECUTOR_SOCKET",
      ]
    ) {
      assert.ok(!(forbidden in env), `${forbidden} must not travel`);
    }
  });

  it("keeps the config count and the pairs consistent", () => {
    const env = publishChildEnv();
    const count = Number(env["GIT_CONFIG_COUNT"]);
    assert.ok(Number.isSafeInteger(count) && count > 0);
    for (let index = 0; index < count; index++) {
      assert.ok(typeof env[`GIT_CONFIG_KEY_${index}`] === "string");
      assert.ok(typeof env[`GIT_CONFIG_VALUE_${index}`] === "string");
    }
    assert.ok(!(`GIT_CONFIG_KEY_${count}` in env));
  });
});

/**
 * The seams the layouts below run through: their paths are not real, so the
 * policy they are checked against answers for them, and the only pointer file
 * read is the worktree's `gitdir`, answered here.
 */
function trustFor(
  layoutValue: GitLayout,
  writable: readonly string[] = [],
): {
  compilePolicy: typeof compileWorkspacePolicy;
  readTextFile: (path: string) => string;
} {
  return {
    compilePolicy: ((workspace: string) =>
      Promise.resolve({
        filesystem: {
          allowWrite: [workspace, join(layoutValue.commonDir, "objects"), layoutValue.gitDir, ...writable],
          denyWrite: [join(layoutValue.commonDir, "config"), join(workspace, ".git")],
        },
        mainCheckout: false,
      })) as unknown as typeof compileWorkspacePolicy,
    readTextFile: () => join(layoutValue.topLevel, ".git"),
  };
}

describe("publish git hardening: reading the layout", () => {
  it("reads the git dir, commondir, top level, branch and head", async () => {
    const { run, calls } = stubRunner(LAYOUT);
    const layout = await readPublishGitLayout("/repo", {
      run,
      ...trustFor(LAYOUT),
    });
    assert.deepStrictEqual(layout, LAYOUT);
    // Each value comes from its own call: a path may hold whitespace, and the
    // worktree-config and include reads are two of them.
    assert.strictEqual(calls.length, 7);
    // Every call is one of the five reads below, addressed at the root the
    // caller resolved. Nothing asks git to discover a repository elsewhere.
    assert.deepStrictEqual(calls.map((args) => args.slice(0, 1)), [
      ["rev-parse"],
      ["rev-parse"],
      ["rev-parse"],
      // The include read belongs to the trust check, before the layout's own
      // config read.
      ["config"],
      ["config"],
      ["symbolic-ref"],
      ["rev-parse"],
    ]);
  });

  it("refuses a workspace that is not the checkout's top level", async () => {
    const { run } = stubRunner({ ...LAYOUT });
    await assert.rejects(
      readPublishGitLayout("/repo/sub", { run }),
      (error: unknown) =>
        error instanceof GitLayoutError &&
        /not the top level/.test(error.message),
    );
  });

  it("refuses a path that does not resolve to a git dir", async () => {
    const { run } = stubRunner({});
    await assert.rejects(
      readPublishGitLayout("/repo", { run }),
      (error: unknown) =>
        error instanceof GitLayoutError && /not a git checkout/.test(
          error.message,
        ),
    );
  });

  it("reports no branch and no commit when both git reads fail", async () => {
    const { run } = stubRunner({ ...LAYOUT, branchRef: null, head: null });
    const layout = await readPublishGitLayout("/repo", {
      run,
      ...trustFor(LAYOUT),
    });
    assert.strictEqual(layout.branchRef, null);
    assert.strictEqual(layout.head, null);
  });

  it(
    "reads a real checkout with the hardening in force",
    { skip: !posix },
    async () => {
      // A throwaway checkout, so the assertion is about this module's own
      // reading rather than about where the suite happens to run.
      const root = await mkdtemp(join(tmpdir(), "dyfj-publish-git-"));
      try {
        git(["init", "--quiet", "--initial-branch=work", root]);
        git(["-C", root, "commit", "--quiet", "--allow-empty", "-m", "one"]);
        const layout = await readPublishGitLayout(root);
        // git reports the realized path (macOS bridges /tmp to /private/tmp).
        assert.strictEqual(layout.topLevel, realpathSync(root));
        assert.strictEqual(layout.gitDir, join(realpathSync(root), ".git"));
        assert.strictEqual(layout.branchRef, "refs/heads/work");
        assert.match(layout.head ?? "", FULL_COMMIT);
        // A subdirectory of the checkout is refused: the session workspace
        // must be the repository the commits belong to.
        await mkdir(join(root, "sub"), { recursive: true });
        await assert.rejects(
          readPublishGitLayout(join(root, "sub")),
          GitLayoutError,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

describe("publish git hardening: the pin", () => {
  it("matches only on git dir, commondir, branch and head", () => {
    assert.ok(layoutsMatch(LAYOUT, { ...LAYOUT }));
    for (
      const change of [
        { gitDir: "/other" },
        { commonDir: "/other" },
        { branchRef: "refs/heads/main" },
        { head: "1111111111111111111111111111111111111111" },
      ]
    ) {
      assert.ok(!layoutsMatch(LAYOUT, { ...LAYOUT, ...change }));
    }
  });

  it("recognizes only a full commit id as a pin", () => {
    assert.ok(FULL_COMMIT.test(LAYOUT.head!));
    for (
      const notACommit of [
        "0123456",
        "chris/bit-786-host-publish-tool",
        "0123456789abcdef0123456789abcdef0123456z",
        "",
      ]
    ) {
      assert.ok(!FULL_COMMIT.test(notACommit));
    }
  });

  it("points a child at the pinned git dir, not at discovery", () => {
    const env = publishGitEnvFor(LAYOUT);
    assert.strictEqual(env["GIT_DIR"], LAYOUT.gitDir);
    assert.strictEqual(env["GIT_WORK_TREE"], LAYOUT.topLevel);
    assert.strictEqual(env["GIT_CEILING_DIRECTORIES"], "/");
  });
});

describe("publish git hardening: per-worktree config", () => {
  it("refuses a repository with extensions.worktreeConfig on", async () => {
    const { run, calls } = stubRunner({ ...LAYOUT, worktreeConfig: "true" });
    await assert.rejects(
      readPublishGitLayout("/repo", { run, ...trustFor(LAYOUT) }),
      (error: unknown) =>
        error instanceof GitLayoutError &&
        /extensions\.worktreeConfig/.test(error.message),
    );
    // Refused at the config read: no branch or head was ever read.
    assert.deepStrictEqual(calls.map((args) => args[0]), [
      "rev-parse",
      "rev-parse",
      "rev-parse",
      "config",
      "config",
    ]);
  });

  it("reads the value from the shared config file, not the worktree's", async () => {
    const { run, calls } = stubRunner(LAYOUT);
    await readPublishGitLayout("/repo", { run, ...trustFor(LAYOUT) });
    const config = calls.find(
      (args) => args[0] === "config" && args.includes("extensions.worktreeConfig"),
    );
    assert.ok(config !== undefined);
    // --file with the shared path: the worktree's own git dir is never asked,
    // which is what makes the answer trustworthy.
    assert.deepStrictEqual(config.slice(0, 4), [
      "config",
      "--file",
      "/repo/.git/config",
      "--get",
    ]);
    assert.ok(config.includes("extensions.worktreeConfig"));
  });

  it(
    "a real repository with worktreeConfig and a worktree driver is refused",
    { skip: !posix },
    async () => {
      const root = realpathSync(
        await mkdtemp(join(tmpdir(), "dyfj-publish-wtc-")),
      );
      const worktree = join(root, "wt");
      const main = join(root, "main");
      try {
        git(["-C", root, "init", "-q", "-b", "main", main]);
        await mkdir(main, { recursive: true });
        execFileSync("git", ["-C", main, "commit", "-q", "--allow-empty", "-m", "x"], {
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "fixture",
            GIT_AUTHOR_EMAIL: "fixture@example.invalid",
            GIT_COMMITTER_NAME: "fixture",
            GIT_COMMITTER_EMAIL: "fixture@example.invalid",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
          },
          stdio: "ignore",
        });
        git(["-C", main, "config", "extensions.worktreeConfig", "true"]);
        git(["-C", main, "worktree", "add", "-q", "-b", "session", worktree]);
        // A driver defined in the WORKTREE's own config file: exactly what the
        // refusal exists to stop from mattering.
        const worktreeGitDir = execFileSync(
          "git",
          ["-C", worktree, "rev-parse", "--path-format=absolute", "--git-dir"],
          { encoding: "utf8" },
        ).trim();
        await writeFile(
          join(worktreeGitDir, "config.worktree"),
          "[diff \"evil\"]\n\tcommand = /bin/false\n",
        );
        await assert.rejects(
          readPublishGitLayout(worktree),
          (error: unknown) =>
            error instanceof GitLayoutError &&
            /extensions\.worktreeConfig/.test(error.message),
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

describe("publish git hardening: where config lives", () => {
  it("the sandbox policy leaves the shared config unwritable", async () => {
    // The whole hardening rests on this: the config that defines a driver is
    // in the shared git dir, and the sandbox's write grant does not reach it.
    const root = realpathSync(
      await mkdtemp(join(tmpdir(), "dyfj-publish-cfg-")),
    );
    try {
      // A linked worktree: the workspace is the worktree's top level, and the
      // shared git dir belongs to the main checkout somewhere else.
      const topLevel = join(root, "wt");
      await mkdir(topLevel, { recursive: true });
      const commonDir = join(root, "repo", ".git");
      const gitDir = join(commonDir, "worktrees", "session");
      const sharedConfig = join(commonDir, "config");
      await mkdir(gitDir, { recursive: true });
      // A linked worktree: its own git dir is writable (commits work), the
      // shared dir is not.
      const linked = await compileWorkspacePolicy(topLevel, {
        pinnedLayout: {
          gitDir,
          commonDir,
          topLevel,
          branchRef: "refs/heads/session",
        },
        env: { PATH: "/usr/bin:/bin", HOME: root },
      });
      for (const allowed of linked.filesystem.allowWrite) {
        assert.ok(
          !(sharedConfig === allowed || sharedConfig.startsWith(`${allowed}/`)),
          `${allowed} would make ${sharedConfig} writable`,
        );
      }
      // A main checkout: the whole `.git` is write-denied, config included.
      const main = await compileWorkspacePolicy(topLevel, {
        pinnedLayout: {
          gitDir: join(topLevel, ".git"),
          commonDir: join(topLevel, ".git"),
          topLevel,
          branchRef: "refs/heads/main",
        },
        env: { PATH: "/usr/bin:/bin", HOME: root },
      });
      assert.ok(main.filesystem.denyWrite.includes(join(topLevel, ".git")));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("publish git hardening: the layout is checked against the policy", () => {
  /** A real repository with a real linked worktree, for the attack fixtures. */
  async function fixture(): Promise<{
    root: string;
    main: string;
    worktree: string;
    cleanup: () => Promise<void>;
  }> {
    const root = realpathSync(await mkdtemp(join(tmpdir(), "dyfj-publish-trust-")));
    const main = join(root, "main");
    const worktree = join(root, "wt");
    git(["-C", root, "init", "-q", "-b", "main", main]);
    await mkdir(main, { recursive: true });
    execFileSync("git", ["-C", main, "commit", "-q", "--allow-empty", "-m", "x"], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
      stdio: "ignore",
    });
    execFileSync("git", ["-C", main, "worktree", "add", "-q", "-b", "session", worktree], {
      stdio: "ignore",
    });
    return { root, main, worktree, cleanup: () => rm(root, { recursive: true, force: true }) };
  }

  it(
    "accepts a real linked worktree, and pins its git dir",
    { skip: !posix },
    async () => {
      const f = await fixture();
      try {
        const layout = await readPublishGitLayout(f.worktree);
        const sharedDir = realpathSync(join(f.main, ".git"));
        assert.strictEqual(layout.commonDir, sharedDir);
        assert.strictEqual(layout.gitDir, join(sharedDir, "worktrees", "wt"));
        assert.strictEqual(layout.topLevel, realpathSync(f.worktree));
        assert.strictEqual(layout.branchRef, "refs/heads/session");
        // The shape that must be accepted is the one the shape check names.
        assert.strictEqual(join(layout.commonDir, "config"), join(sharedDir, "config"));
      } finally {
        await f.cleanup();
      }
    },
  );

  it(
    "refuses a worktree .git pointing at a fake git dir with a driver",
    { skip: !posix },
    async () => {
      const f = await fixture();
      try {
        // A working copy of the real worktree git dir, inside the writable
        // worktree, with a filter driver added and the workspace's .git
        // repointed at it. git resolves a complete layout from it - the shape
        // check is what has to refuse, not git's own validation.
        const realGitDir = execFileSync(
          "git",
          ["-C", f.worktree, "rev-parse", "--path-format=absolute", "--git-dir"],
          { encoding: "utf8" },
        ).trim();
        const fake = join(f.worktree, "fake-git");
        await cp(realGitDir, fake, { recursive: true });
        // The copy names this workspace and the real shared dir, so git accepts
        // it as the worktree's git dir: the shape check is what must refuse,
        // not git's own validation.
        const sharedDir = join(f.main, ".git");
        await writeFile(join(fake, "commondir"), `${sharedDir}\n`);
        await writeFile(join(fake, "gitdir"), `${join(f.worktree, ".git")}\n`);
        await writeFile(
          join(fake, "config"),
          "[filter \"evil\"]\n\tclean = /bin/false\n",
        );
        await writeFile(join(f.worktree, ".git"), `gitdir: ${fake}\n`);
        assert.strictEqual(
          execFileSync("git", ["-C", f.worktree, "rev-parse", "--git-dir"], {
            encoding: "utf8",
          }).trim(),
          fake,
          "the fixture must put git on the fake git dir",
        );
        await assert.rejects(
          readPublishGitLayout(f.worktree),
          (error: unknown) =>
            error instanceof GitLayoutError &&
            /not a worktree of the shared git dir|does not point back/.test(
              error.message,
            ),
        );
      } finally {
        await f.cleanup();
      }
    },
  );

  it(
    "refuses a git dir whose commondir points at a writable copy",
    { skip: !posix },
    async () => {
      const f = await fixture();
      try {
        const meta = execFileSync(
          "git",
          ["-C", f.worktree, "rev-parse", "--path-format=absolute", "--git-dir"],
          { encoding: "utf8" },
        ).trim();
        const elsewhere = join(f.worktree, "elsewhere");
        await mkdir(elsewhere, { recursive: true });
        await writeFile(join(meta, "commondir"), `${elsewhere}\n`);
        await assert.rejects(
          readPublishGitLayout(f.worktree),
          (error: unknown) =>
            error instanceof GitLayoutError,
        );
      } finally {
        await f.cleanup();
      }
    },
  );

  it(
    "refuses a gitdir pointer that is a FIFO, a symlink or oversized, without reading it",
    { skip: !posix },
    async () => {
      const f = await fixture();
      try {
        const meta = execFileSync(
          "git",
          ["-C", f.worktree, "rev-parse", "--path-format=absolute", "--git-dir"],
          { encoding: "utf8" },
        ).trim();
        const pointer = join(meta, "gitdir");
        const target = join(f.worktree, ".git");
        const replacements: Array<[string, () => Promise<void>]> = [
          ["a FIFO", async () => {
            execFileSync("mkfifo", [pointer]);
          }],
          ["a symlink", async () => {
            const real = join(f.root, "pointer-target");
            await writeFile(real, `${target}\n`);
            await symlink(real, pointer);
          }],
          ["oversized", async () => {
            await writeFile(pointer, `${target}\n${" ".repeat(8192)}`);
          }],
        ];
        for (const [label, plant] of replacements) {
          await rm(pointer, { force: true });
          await plant();
          await assert.rejects(
            readPublishGitLayout(f.worktree),
            (error: unknown) =>
              error instanceof GitLayoutError &&
              /no readable gitdir pointer file/.test(error.message),
            label,
          );
        }
      } finally {
        await f.cleanup();
      }
    },
  );

  it(
    "refuses a shared config with an include",
    { skip: !posix },
    async () => {
      const f = await fixture();
      try {
        git([
          "-C",
          f.main,
          "config",
          "include.path",
          join(f.worktree, "included.cfg"),
        ]);
        await assert.rejects(
          readPublishGitLayout(f.worktree),
          (error: unknown) =>
            error instanceof GitLayoutError &&
            /has an include/.test(error.message),
        );
      } finally {
        await f.cleanup();
      }
    },
  );
});
