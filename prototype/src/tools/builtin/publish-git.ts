/**
 * The publish tool's git hardening (BIT-786).
 *
 * The publish tool runs in the runtime, outside the sandbox, on a worktree a
 * sandboxed command may have written to. Part of its git metadata is therefore
 * untrusted: a linked worktree's own git dir and pointer files, everything
 * inside the worktree itself, and the index. The shared `<commonDir>` - where
 * `config` and `hooks` live - is outside the sandbox's write grant, and the
 * last paragraph says how that is checked rather than assumed. Three rules
 * follow:
 *
 * 1. **Resolve nothing from inside the worktree but the repository git itself
 *    must read.** The root comes from the runtime's own record of the session's
 *    workspace (an anchored root); the layout is then read with `git -C <root>`
 *    with the listed program-naming keys overridden, and refused unless
 *    the root is the checkout's own top level. Children are pointed at the
 *    pinned git dir through `GIT_DIR`/`GIT_WORK_TREE`
 *    (`publishGitEnvFor`), so a child never rediscovers a repository.
 * 2. **Every child gets the neutralizing keys in its environment.** `-c` flags
 *    reach only the git this module spawns. The operator's gate and, in the
 *    next slice, its push and PR commands run their own git, so the same keys
 *    travel as `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n`,
 *    which every descendant git reads as its own configuration. Our own calls
 *    carry the `-c` flags as well.
 * 3. **The pins are compared, never assumed.** `layoutsMatch` compares a
 *    re-read layout with a pinned one, so a caller that re-reads before each
 *    later step can refuse a different git dir, commondir, branch or commit
 *    rather than follow the new one.
 *
 * What this cannot do is stated rather than papered over:
 *
 * - **Diff, filter and textconv drivers are honored only from config the
 *   sandbox cannot write, and that is enforced rather than assumed.** No key in
 *   the list below disables a driver that repository config defines, so the
 *   check is on where a definition can come from. The discovered layout is
 *   checked against the sandbox policy (`compileWorkspacePolicy`), which is the
 *   trusted reference:
 *
 *   - the shape must be a main checkout (`gitDir === commonDir ===
 *     <workspace>/.git`, write-denied) or a linked worktree (`gitDir` exactly
 *     `<commonDir>/worktrees/<name>`, its `gitdir` file pointing back at
 *     `<workspace>/.git`), with every path realpath'd;
 *   - the shared `config` and the shared git dir must fall outside every write
 *     grant the policy compiles (an allow entry is cancelled by a deny entry
 *     that covers it), so a sandboxed command cannot write the file that
 *     defines a driver;
 *   - the shared config must name no `include` or `includeIf` key: an include
 *     reaches a file nothing here inspects.
 *
 *   Anything else is refused with a `GitLayoutError`. The only processes
 *   started before that refusal are this module's own hardened git reads.
 *   The attribute sources that would assign a driver name are closed as well:
 *   `GIT_ATTR_SOURCE` at the empty tree, `core.attributesFile=/dev/null`,
 *   `GIT_ATTR_NOSYSTEM`.
 *
 *   One residual remains, stated: `$GIT_DIR/info/attributes` is reachable by
 *   the same writes (the worktree's own git dir is in the grant, because
 *   commits need it) and is not closed by these checks. A name it assigned
 *   would still need a definition in config this check refuses to leave
 *   writable.
 * - **The configured commands are operator tooling.** Whatever they do with
 *   the environment they inherit is outside this module's boundary.
 */

import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { buildSafeBashEnv } from "./exec.ts";
import { type BoundedResult, runBounded } from "./bounded-process.ts";
import type { Env } from "../../config/mod.ts";
import { compileWorkspacePolicy } from "./srt-policy.ts";

/**
 * The empty tree. `GIT_ATTR_SOURCE` pointed at it means no tree or index
 * attributes apply; `$GIT_DIR/info/attributes` is unaffected (see the header).
 */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * The finite list of git configuration keys the publish tool overrides, with
 * why. Each names a program git would run, or a discovery behaviour that would
 * let a worktree choose what git reads.
 *
 * "Finite" is the honest word: this is not a sandbox of git's configuration. A
 * key not in this list keeps whatever the operator's own `~/.gitconfig` says,
 * which is trusted (the sandbox cannot write it). What the list buys is that
 * the keys a worktree's writes could reach, and the ones that execute programs,
 * are set by this module for every child rather than inherited.
 */
export const PUBLISH_GIT_CONFIG: readonly (readonly [string, string, string])[] =
  Object.freeze([
    [
      "core.hooksPath",
      "/dev/null",
      "pre-push, post-checkout and reference-transaction are arbitrary programs; " +
      "the hooks directory is worktree-writable",
    ],
    [
      "core.fsmonitor",
      "false",
      "the fsmonitor hook runs on every index refresh",
    ],
    [
      "core.sshCommand",
      "/bin/false",
      "repository config could point any ssh operation at any executable; a " +
      "push over ssh is the operator helper's business, not this repository's",
    ],
    [
      "core.pager",
      "cat",
      "a pager is a program; none runs without a terminal, and this pins it",
    ],
    [
      "core.editor",
      "/bin/false",
      "an editor is a program and no phase is interactive",
    ],
    [
      "sequence.editor",
      "/bin/false",
      "as core.editor, for the commands that would open one",
    ],
    [
      "core.attributesFile",
      "/dev/null",
      "attribute files assign diff, filter and textconv drivers, which are " +
      "programs; this closes the global and worktree attribute files only",
    ],
    [
      "safe.bareRepository",
      "explicit",
      "a bare repository planted in the worktree must not be discovered",
    ],
    [
      "log.showSignature",
      "false",
      "signature verification runs gpg",
    ],
    [
      "credential.helper",
      "",
      "no interactive or configured credential helper on our own git calls; " +
      "authenticating a push is the operator helper's job",
    ],
    [
      "protocol.ext.allow",
      "never",
      "the ext:: transport runs an arbitrary command",
    ],
    [
      "uploadpack.allowFilter",
      "false",
      "no server-side partial-clone machinery is needed by any phase",
    ],
    [
      "diff.external",
      "",
      "an external diff driver is a program; an empty value makes git fail " +
      "rather than run one",
    ],
  ]);

/**
 * `-c key=value` arguments for every neutralized key, for the git this module
 * spawns itself. The environment below carries the same keys to descendants.
 */
export function publishGitConfigArgs(): string[] {
  const args: string[] = [];
  for (const [key, value] of PUBLISH_GIT_CONFIG) args.push("-c", `${key}=${value}`);
  return args;
}

/** The `GIT_CONFIG_*` block every child of the publish tool receives. */
export function publishGitConfigEnv(): Record<string, string> {
  const env: Record<string, string> = {
    GIT_CONFIG_COUNT: String(PUBLISH_GIT_CONFIG.length),
  };
  PUBLISH_GIT_CONFIG.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

/**
 * The whole environment every publish child runs with: the safe bash base (no
 * runtime credentials), the config block above, and the few names that keep
 * git from asking anything or taking a lock it cannot get.
 */
export function publishChildEnv(source?: Env): Record<string, string> {
  return {
    ...buildSafeBashEnv(source),
    ...publishGitConfigEnv(),
    // No tree, system or per-user attribute source assigns a driver name.
    // `$GIT_DIR/info/attributes` is not closed here; a name it assigned would
    // still need a definition in the main git dir's config to run anything.
    GIT_ATTR_SOURCE: EMPTY_TREE,
    // No pager, though none runs without a terminal.
    GIT_PAGER: "cat",
    // No terminal prompt and no ambient askpass: a phase that would ask a
    // question fails instead of hanging the runtime.
    GIT_TERMINAL_PROMPT: "0",
    SSH_ASKPASS: "/bin/false",
    SSH_ASKPASS_REQUIRE: "never",
    GIT_ASKPASS: "/bin/false",
    // Read-only phases must not take the index lock; a blocked lock is a
    // stall, not a result.
    GIT_OPTIONAL_LOCKS: "0",
    // No system-wide config. The operator's own ~/.gitconfig IS read: it is
  // trusted (the sandbox cannot write it), and only the keys in
  // PUBLISH_GIT_CONFIG above are overridden for a descendant.
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ATTR_NOSYSTEM: "1",
  };
}

/** The worktree's git layout as the host resolves it. */
export interface GitLayout {
  /** This checkout's git directory (`.git`, or `.git/worktrees/<name>`). */
  gitDir: string;
  /** The repository's shared git directory. */
  commonDir: string;
  /** The checkout's top level. */
  topLevel: string;
  /** The checked-out branch's ref (`refs/heads/...`), or null when detached. */
  branchRef: string | null;
  /** The commit `HEAD` names, or null when the branch has no commit yet. */
  head: string | null;
}

/** Why a layout could not be read, as a path-free reason for the operator. */
export class GitLayoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitLayoutError";
  }
}

/** The runner the layout reader uses; injectable so tests need no git. */
export type PublishGitRunner = (
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
) => Promise<BoundedResult>;

const DISCOVERY_TIMEOUT_MS = 10_000;

const defaultRunner: PublishGitRunner = (args, cwd, timeoutMs) =>
  runBounded({
    command: "git",
    args: [...publishGitConfigArgs(), "-C", cwd, ...args],
    cwd,
    env: publishChildEnv(),
    timeoutMs,
  });

/** One git read, trimmed of its trailing newline only. Null on any failure. */
async function gitRead(
  run: PublishGitRunner,
  cwd: string,
  args: readonly string[],
): Promise<string | null> {
  const result = await run(args, cwd, DISCOVERY_TIMEOUT_MS);
  if (result.code !== 0) return null;
  return result.stdout.replace(/\n$/u, "");
}

/**
 * Read the worktree's git layout, host-side, with the listed program-naming
 * keys overridden. `root` must be a path the caller already resolved
 * and anchored (the runtime's own record of the session's workspace): this
 * function never discovers a root from inside a worktree.
 *
 * Discovery here is `git -C <root>`, which still reads `<root>/.git` to find
 * the git dir — that is unavoidable and is why the result is *pinned* by the
 * caller and re-read at every later phase. What discovery cannot do with this
 * environment is run a program or take a lock while it looks.
 */
export async function readPublishGitLayout(
  root: string,
  options: { run?: PublishGitRunner } & Partial<TrustedLayoutPorts> = {},
): Promise<GitLayout> {
  const run = options.run ?? defaultRunner;
  const absolute = async (flag: string): Promise<string> => {
    const value = await gitRead(run, root, [
      "rev-parse",
      "--path-format=absolute",
      flag,
    ]);
    if (value === null || value === "") {
      throw new GitLayoutError(
        "the workspace is not a git checkout this tool can resolve",
      );
    }
    return value;
  };
  const gitDir = await absolute("--git-dir");
  const commonDir = await absolute("--git-common-dir");
  const topLevel = await absolute("--show-toplevel");
  // Both sides are canonicalized: git reports the real path, and a caller may
  // hold a symlinked one (a temp directory on macOS, for example).
  if (canonical(topLevel) !== canonical(root)) {
    // A root inside a checkout is not the repository this session works in:
    // publishing would ship commits the session never made.
    throw new GitLayoutError(
      "the session workspace is not the top level of its git checkout",
    );
  }
  // The discovered layout is checked against the sandbox policy before its
  // paths are believed: the pointer files that led git here are writable.
  await assertTrustedLayout(
    root,
    { gitDir, commonDir, topLevel, branchRef: null, head: null },
    run,
    {
      compilePolicy: options.compilePolicy ?? realPorts.compilePolicy,
      readTextFile: options.readTextFile ?? realPorts.readTextFile,
    },
  );
  // A linked worktree's `<gitDir>/config.worktree` is inside the sandbox's
  // write grant, and git reads it when `extensions.worktreeConfig` is on. That
  // would put a driver definition (or a hook path) back in the sandbox's hands,
  // so a repository that turns it on is refused rather than reasoned about.
  // The value is read from the SHARED config file only, never through the
  // worktree's own git dir.
  const worktreeConfig = await gitRead(run, root, [
    "config",
    "--file",
    join(commonDir, "config"),
    "--get",
    "--type=bool",
    "extensions.worktreeConfig",
  ]);
  if (worktreeConfig !== null && worktreeConfig.trim() === "true") {
    throw new GitLayoutError(
      "the repository turns on extensions.worktreeConfig, so per-worktree " +
        "config in the worktree's git dir would apply; refusing to publish a " +
        "repository whose config a sandboxed command can write",
    );
  }
  const branchRef = await gitRead(run, root, ["symbolic-ref", "-q", "HEAD"]);
  const head = await gitRead(run, root, ["rev-parse", "--verify", "-q", "HEAD"]);
  return {
    gitDir,
    commonDir,
    topLevel,
    branchRef: branchRef === null || branchRef === "" ? null : branchRef,
    head: head === null || head === "" ? null : head,
  };
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Check a discovered layout against the sandbox policy, which is the trusted
 * reference: it is compiled from the operator's own configuration and the
 * workspace, not from anything the worktree says.
 *
 * The pointer files git follows are sandbox-writable, so `git -C <root>`
 * answering at all proves nothing. Two shapes are accepted, and only two:
 *
 * - a main checkout, where the git dir and the common dir are both exactly
 *   `<workspace>/.git`, and the policy write-denies it;
 * - a linked worktree, where the git dir is exactly
 *   `<commonDir>/worktrees/<name>` and its `gitdir` file points back at
 *   `<workspace>/.git`.
 *
 * Then the shared config must be outside every write grant and must name no
 * include: `include.path` reaches a file nothing here can inspect, which would
 * put the config that defines a driver back in the sandbox's hands.
 */
async function assertTrustedLayout(
  root: string,
  layout: GitLayout,
  run: PublishGitRunner,
  ports: TrustedLayoutPorts,
): Promise<void> {
  const workspace = canonical(root);
  const dotGit = join(workspace, ".git");
  const gitDir = canonical(layout.gitDir);
  const commonDir = canonical(layout.commonDir);
  const mainCheckout = gitDir === commonDir;

  if (mainCheckout) {
    if (gitDir !== dotGit) {
      throw new GitLayoutError(
        "the git dir is not the workspace's own .git; a main checkout's git " +
          "directory cannot be anywhere else",
      );
    }
  } else {
    if (dirname(gitDir) !== join(commonDir, "worktrees") || basename(gitDir) === "") {
      throw new GitLayoutError(
        "the git dir is not a worktree of the shared git dir: a linked " +
          "worktree's git directory is exactly <commonDir>/worktrees/<name>",
      );
    }
    let pointer: string;
    try {
      // The file names this worktree's own `<workspace>/.git`, relative to the
      // git dir or absolute.
      pointer = canonical(resolve(gitDir, ports.readTextFile(join(gitDir, "gitdir")).trim()));
    } catch {
      throw new GitLayoutError(
        "the worktree's git dir has no readable gitdir pointer file",
      );
    }
    if (pointer !== dotGit) {
      throw new GitLayoutError(
        "the worktree's git dir does not point back at the workspace's .git",
      );
    }
  }

  let policy: Awaited<ReturnType<TrustedLayoutPorts["compilePolicy"]>>;
  try {
    policy = await ports.compilePolicy(workspace, {
      pinnedLayout: {
        gitDir,
        commonDir,
        topLevel: workspace,
        branchRef: layout.branchRef,
      },
    });
  } catch (error) {
    throw new GitLayoutError(
      `the sandbox policy for the workspace could not be compiled: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  // What the sandbox can write is `allowWrite` minus `denyWrite` (the deny
  // list wins, as srt applies it). The shared config must fall outside the
  // writable set: an allow entry that covered it would let a sandboxed command
  // define a driver there.
  const denied = (path: string): boolean =>
    policy.filesystem.denyWrite.map(canonical).some((entry) =>
      path === entry || path.startsWith(`${entry}/`)
    );
  const writable = (path: string): boolean =>
    !denied(path) &&
    policy.filesystem.allowWrite.map(canonical).some((entry) =>
      path === entry || path.startsWith(`${entry}/`)
    );
  const config = join(commonDir, "config");
  for (const target of [config, commonDir]) {
    if (writable(target)) {
      throw new GitLayoutError(
        "the sandbox's write grant reaches the shared git config, so a " +
          "sandboxed command could define a driver there; refusing to publish",
      );
    }
  }
  if (!denied(config)) {
    throw new GitLayoutError(
      "the shared git config is not write-denied by the sandbox, so where a " +
        "driver is defined is not somewhere a sandboxed command cannot write; " +
        "refusing to publish",
    );
  }
  if (mainCheckout && !denied(dotGit)) {
    throw new GitLayoutError(
      "the sandbox does not write-deny the workspace's .git; refusing to " +
        "publish",
    );
  }

  const includes = await gitRead(run, root, [
    "config",
    "--file",
    config,
    "--get-regexp",
    "^include(if)?\\.",
  ]);
  if (includes !== null && includes.trim() !== "") {
    throw new GitLayoutError(
      "the shared git config has an include, which can pull in a config file " +
        "nothing here can inspect; refusing to publish",
    );
  }
}

/**
 * The two seams the trusted-layout check reads through: the sandbox policy it
 * compares against, and the pointer file it reads back. Both default to the
 * real implementations; tests that answer for a fake path supply their own.
 */
export interface TrustedLayoutPorts {
  compilePolicy: typeof compileWorkspacePolicy;
  readTextFile: (path: string) => string;
}

/** A `gitdir` pointer holds one path; anything larger is not one. */
const MAX_POINTER_BYTES = 4096;

/**
 * Read a pointer file the sandbox may have replaced: no symlink is followed,
 * and anything but a small regular file is refused before a byte is read, so a
 * FIFO or a huge file cannot stall or exhaust the runtime.
 */
function readPointerFile(path: string): string {
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > MAX_POINTER_BYTES) {
      throw new Error("not a small regular file");
    }
    const buffer = Buffer.alloc(info.size);
    const read = readSync(fd, buffer, 0, info.size, 0);
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

const realPorts: TrustedLayoutPorts = {
  compilePolicy: compileWorkspacePolicy,
  readTextFile: readPointerFile,
};

/** A full lower-case commit id. Anything else is not a pin. */
export const FULL_COMMIT = /^[0-9a-f]{40}$/u;

/** True when two layouts name the same repository, branch and commit. */
export function layoutsMatch(a: GitLayout, b: GitLayout): boolean {
  return a.gitDir === b.gitDir &&
    a.commonDir === b.commonDir &&
    a.branchRef === b.branchRef &&
    a.head === b.head;
}

/**
 * The git directory a child is pointed at, so a child that runs its own git
 * reads the same repository the pins name rather than rediscovering one.
 */
export function publishGitEnvFor(layout: GitLayout): Record<string, string> {
  return {
    GIT_DIR: layout.gitDir,
    GIT_WORK_TREE: layout.topLevel,
    // Discovery cannot walk above the worktree, so a planted parent repository
    // is never picked up.
    GIT_CEILING_DIRECTORIES: dirname(layout.topLevel),
  };
}
