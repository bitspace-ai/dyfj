/**
 * The sandbox-runtime (srt) policy for one workspace (BIT-662): what a
 * sandboxed bash, git or file-write command may write, read and reach.
 * `srt-sandbox.ts` passes it to `SandboxManager.wrapWithSandbox` per call.
 *
 * Writes. srt denies every write outside `allowWrite`. The workspace is
 * writable, plus what a commit on the session branch needs when the
 * workspace is in a linked git worktree: the shared object store, this
 * worktree's own metadata directory, and the current branch's ref, its lock
 * file and its reflog (probe P0a; each entry was shown necessary). Other
 * branches' refs, other worktrees' metadata, `packed-refs`, `rr-cache`,
 * hooks and config stay outside `allowWrite`. srt also denies `.git/hooks`
 * and `.git/config` inside an allowed root by itself.
 *
 * Four `denyWrite` entries cover the gitdir pointer files (`<wt>/.git`, and
 * `commondir`, `gitdir` and `config.worktree` under the worktree's metadata).
 * Observed with srt 0.0.81: it leaves them writable on macOS; writable, they would let a
 * sandboxed command repoint the worktree at a git directory whose config a
 * later host-side git would run.
 *
 * A workspace whose git directory is a main checkout's `.git` (not a linked
 * worktree):
 * - On macOS (Seatbelt), allows sandboxed `git add` and `git commit` while
 *   write-denying the host-execution, pointer, and shared-integrity paths
 *   under `.git`: `config`, `config.worktree`, `commondir`, `gitdir`, `hooks`,
 *   `info`, `objects/pack`, `objects/info`, `packed-refs`, `shallow`,
 *   `worktrees`, `refs/remotes`, `refs/tags`, and `refs/replace` (with
 *   Seatbelt move-blocking on `.git` and those entries). Because srt's
 *   `denyWrite` overrides `allowWrite`, a main checkout cannot deny
 *   `.git/refs/heads` while allowing only the checked-out branch; other local
 *   branch refs under `.git/refs/heads/*` and `HEAD` therefore remain writable
 *   in a main checkout, along with `.git/refs/notes/*` and repositories using
 *   `extensions.refStorage=reftable` (where refs live under `.git/reftable/`
 *   rather than `refs/`), whereas a linked worktree isolates writes to the
 *   single checked-out branch ref.
 * - On Linux (`bwrap`), keeps the entire `.git` directory write-denied
 *   (`gitDirDenied: true`): `bwrap` blocks absent `denyWrite` targets via
 *   placeholder bind mounts that break `git`'s own reads of `.git/commondir`
 *   and absent `.git/packed-refs`. Read-only `git` commands (`status`, `diff`,
 *   `log`) continue to work, while sandboxed `git add` and `git commit` fail
 *   closed with a clear note.
 *
 * In the shared object store, a commit needs only to add loose objects, so
 * the packfiles and the store's `info` directory (alternates, the pack
 * list) are write-denied: no sandboxed command can delete or replace the
 * packed history that every branch and worktree reads.
 *
 * Residuals, stated rather than closed: a sandboxed command can add, delete
 * or overwrite loose (not yet packed) objects in the shared object store,
 * which every worktree reads; it can retarget its checkout's `HEAD`, and
 * delete or recreate the session branch's own ref (and, in a macOS main
 * checkout, other local branch refs under `.git/refs/heads/*`,
 * `.git/refs/notes/*`, and refs in `extensions.refStorage=reftable`
 * repositories).
 * srt also keeps its own scratch writable (`/tmp/claude`, shared by every
 * sandboxed command of this user) and `~/.npm/_logs`.
 *
 * Reads. srt allows reads by default; `denyRead` lists the credential paths
 * (IAM design §2.7) plus the runtime's own directory. A credential file not
 * on the list is readable to a sandboxed command, as to any process of this
 * uid.
 *
 * Git discovery runs host-side with git's program-running config switched
 * off. The sandbox (`srt-sandbox.ts`) pins the layout it finds the first
 * time per workspace, before any sandboxed command has run there, and
 * passes it back as `pinnedLayout`. A linked worktree's four pointer files
 * are write-denied, a macOS main checkout's protected subpaths under `.git`
 * are write-denied, and a Linux main checkout's whole `.git` is write-denied;
 * a workspace that had no repository at first stays without git grants,
 * whatever a sandboxed command later creates in it.
 */

import { mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { runBounded } from "./bounded-process.ts";

/**
 * Host-side discovery runs `git rev-parse` and `git symbolic-ref`, neither of
 * which runs hooks; this also keeps system config and fsmonitor out of it.
 */
const DISCOVERY_GIT_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "core.fsmonitor",
  GIT_CONFIG_VALUE_0: "false",
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
};

/**
 * Credential paths, relative to the home directory, that a sandboxed command
 * may not read: the standard tools' credential stores and the runtime's own
 * directory. `.claude/debug` is listed so srt does not make it writable as a
 * convenience; nothing in the sandbox needs it. The operator adds paths of
 * their own with `[sandbox] deny_read` (`config/sandbox-config.ts`), which
 * adds to this list and never removes from it.
 */
export const CREDENTIAL_READ_DENY: readonly string[] = Object.freeze([
  ".ssh",
  ".claude/.credentials.json",
  ".claude/debug",
  ".codex/auth.json",
  ".dyfj",
  ".config/gh",
  ".config/op",
  ".kube/config",
  ".docker/config.json",
]);

/**
 * npm's cache for sandboxed commands, under srt's scratch directory: the
 * default `~/.npm` is not writable in the sandbox. npm checks each cached
 * package against the lockfile's integrity hash, which bounds what a planted
 * cache entry can do; the directory is shared by this user's sandboxed
 * commands.
 */
export const SANDBOX_NPM_CACHE = "/tmp/claude/npm-cache";

/** The registry a sandboxed command may reach when the operator adds none. */
export const DEFAULT_ALLOWED_DOMAINS: readonly string[] = Object.freeze([
  "registry.npmjs.org",
]);

/**
 * Domains a sandboxed command may never reach, whatever the operator's
 * `[sandbox] allow_domains` says: srt applies `deniedDomains` before
 * `allowedDomains`. Publishing goes through the host-side publish tool.
 */
export const DENIED_DOMAINS: readonly string[] = Object.freeze([
  "github.com",
  "*.github.com",
  "githubusercontent.com",
  "*.githubusercontent.com",
]);

export interface WorkspaceFilesystemPolicy {
  allowWrite: string[];
  denyWrite: string[];
  denyRead: string[];
  allowRead: string[];
}

export interface WorkspacePolicy {
  filesystem: WorkspaceFilesystemPolicy;
  /**
   * True when the platform's sandbox write-denies the entire `.git` directory
   * of a main checkout (Linux `bwrap`), so sandboxed `git add`/`commit` cannot
   * succeed while read-only git commands still work.
   */
  gitDirDenied: boolean;
  /**
   * Why `gitDirDenied` is set: the platform's sandbox (`bwrap` on Linux), or
   * this workspace's own `sandbox.require_worktree`. Null when git writes are
   * allowed. The tools' refusal note says which, so the operator reads the
   * cause rather than a platform note that does not apply.
   */
  gitDirDeniedBy: "platform" | "require_worktree" | null;
}

/** What host-side git says about the workspace; null outside a repository. */
export interface GitLayout {
  /** This checkout's git directory (`.git`, or `.git/worktrees/<name>`). */
  gitDir: string;
  /** The repository's shared git directory. */
  commonDir: string;
  /** The checkout's top level. */
  topLevel: string;
  /** The checked-out branch's ref (`refs/heads/...`), or null when detached. */
  branchRef: string | null;
}

export type GitLayoutReader = (
  root: string,
  env: Record<string, string>,
) => Promise<GitLayout | null>;

async function hostGit(
  root: string,
  args: readonly string[],
  env: Record<string, string>,
): Promise<string | null> {
  const result = await runBounded({
    command: "git",
    args: ["-C", root, ...args],
    cwd: root,
    env: { ...env, ...DISCOVERY_GIT_ENV },
    timeoutMs: 10_000,
  });
  // Strip only git's trailing newline: a path may itself contain spaces or
  // newlines, so each value is read from a call of its own.
  return result.code === 0 ? result.stdout.replace(/\n$/, "") : null;
}

/** The workspace's git layout, read host-side through the guarded spawn. */
export const readGitLayout: GitLayoutReader = async (root, env) => {
  const dir = (flag: string) =>
    hostGit(root, ["rev-parse", "--path-format=absolute", flag], env);
  const gitDir = await dir("--git-dir");
  const commonDir = await dir("--git-common-dir");
  const topLevel = await dir("--show-toplevel");
  if (!gitDir || !commonDir || !topLevel) return null;
  const branchRef = await hostGit(root, ["symbolic-ref", "-q", "HEAD"], env);
  return {
    gitDir: realpathSync(gitDir),
    commonDir: realpathSync(commonDir),
    topLevel: realpathSync(topLevel),
    branchRef: branchRef !== null && branchRef.startsWith("refs/heads/")
      ? branchRef
      : null,
  };
};

/** A branch ref safe to turn into a path under the git directory. */
function refPath(ref: string): string | null {
  const parts = ref.split("/");
  return parts.every((part) => part !== "" && part !== "." && part !== "..")
    ? join(...parts)
    : null;
}

export interface CompileOptions {
  /**
   * The git layout pinned by the caller, used in place of discovering it
   * now. A sandboxed command can retarget its worktree's `HEAD`, or create a
   * `.git` pointer in a workspace that had none, so the sandbox pins the
   * layout it first saw (`srt-sandbox.ts`).
   */
  pinnedLayout?: GitLayout | null;
  /** The environment host-side git runs with (PATH, HOME). */
  env?: Record<string, string>;
  home?: string;
  /**
   * The operator's `[sandbox] deny_read` entries, and any workspace profile's:
   * home-relative or absolute paths, added to the built-in credential deny list.
   */
  extraDenyRead?: readonly string[];
  /**
   * A workspace profile's `sandbox.require_worktree`: refuse sandboxed
   * `git add` and `git commit` in a main checkout, on every platform. A local
   * guard rail the operator asks for, so the work is committed through the
   * host-side tool from a linked worktree; a linked worktree is unaffected.
   */
  requireWorktree?: boolean;
  readLayout?: GitLayoutReader;
  /** Target OS platform for main-checkout `.git` policy selection; defaults to `process.platform`. */
  platform?: NodeJS.Platform;
}

/**
 * The policy for a workspace rooted at `root`. Creates the shared
 * `rr-cache` host-side when a linked worktree lacks it (git's rerere, when
 * enabled, fails a commit without it; it stays read-only to the sandbox).
 */
export async function compileWorkspacePolicy(
  root: string,
  options: CompileOptions = {},
): Promise<WorkspacePolicy> {
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const workspace = realpathSync(root);
  const allowWrite = [workspace];
  const denyWrite: string[] = [join(home, ".dyfj")];
  let gitDirDenied = false;
  let gitDirDeniedBy: WorkspacePolicy["gitDirDeniedBy"] = null;

  const requireWorktree = options.requireWorktree === true;
  const layout = options.pinnedLayout !== undefined
    ? options.pinnedLayout
    : await (options.readLayout ?? readGitLayout)(
    workspace,
    options.env ?? { PATH: "/usr/bin:/bin", HOME: home },
  );
  if (layout !== null) {
    const { gitDir, commonDir, topLevel, branchRef } = layout;
    if (gitDir === commonDir && requireWorktree) {
      // The operator asked this workspace's commits to happen from a linked
      // worktree, so the main checkout's whole `.git` is write-denied: on every
      // platform the sandbox's git writes fail closed, exactly as Linux
      // `bwrap` does by default, while read-only git commands still work.
      gitDirDenied = true;
      gitDirDeniedBy = "require_worktree";
      denyWrite.push(gitDir);
    } else if (gitDir === commonDir) {
      if (platform === "darwin") {
        // A main checkout on macOS (Seatbelt): allow commits under `.git` while
        // keeping host-execution, pointer, packed-object, remote/tag/replace,
        // shallow and worktree-metadata paths write-denied. Because `denyWrite`
        // overrides `allowWrite` in srt, `.git/refs/heads` cannot be denied
        // while allowing only the checked-out branch (stated residual vs a
        // linked worktree, alongside `.git/refs/notes/*` and
        // `extensions.refStorage=reftable` repositories).
        denyWrite.push(
          join(gitDir, "config"),
          join(gitDir, "config.worktree"),
          join(gitDir, "commondir"),
          join(gitDir, "gitdir"),
          join(gitDir, "hooks"),
          join(gitDir, "info"),
          join(gitDir, "objects", "pack"),
          join(gitDir, "objects", "info"),
          join(gitDir, "packed-refs"),
          join(gitDir, "shallow"),
          join(gitDir, "worktrees"),
          join(gitDir, "refs", "remotes"),
          join(gitDir, "refs", "tags"),
          join(gitDir, "refs", "replace"),
        );
      } else {
        // On Linux (`bwrap`), blocking absent `denyWrite` entries under a
        // writable `.git` creates placeholder bind mounts that break git's
        // reads of `.git/commondir` and absent `.git/packed-refs`. Keep the
        // whole `.git` write-denied so read-only git works and writes fail closed.
        gitDirDenied = true;
        gitDirDeniedBy = "platform";
        denyWrite.push(gitDir);
      }
    } else {
      allowWrite.push(join(commonDir, "objects"), gitDir);
      const ref = branchRef === null ? null : refPath(branchRef);
      if (ref !== null) {
        allowWrite.push(
          join(commonDir, ref),
          `${join(commonDir, ref)}.lock`,
          join(commonDir, "logs", ref),
        );
      }
      denyWrite.push(
        join(commonDir, "objects", "pack"),
        join(commonDir, "objects", "info"),
        join(topLevel, ".git"),
        join(gitDir, "commondir"),
        join(gitDir, "gitdir"),
        join(gitDir, "config.worktree"),
        // The shared config and the rest of the shared git dir: what a
        // definition of a diff, filter or textconv driver would come from.
        join(commonDir, "config"),
        join(commonDir, "config.worktree"),
        join(commonDir, "hooks"),
        join(commonDir, "info"),
      );
      try {
        mkdirSync(join(commonDir, "rr-cache"), { mode: 0o755 });
      } catch (error) {
        // Another compilation, or git itself, created it first.
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
  }

  return {
    filesystem: {
      allowWrite,
      denyWrite,
      denyRead: [
        ...new Set(
          [...CREDENTIAL_READ_DENY, ...(options.extraDenyRead ?? [])].map(
            (path) => resolve(home, path),
          ),
        ),
      ],
      allowRead: [],
    },
    gitDirDenied,
    gitDirDeniedBy,
  };
}
