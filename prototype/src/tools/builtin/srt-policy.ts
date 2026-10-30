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
 * srt 0.0.81 leaves them writable on macOS; writable, they would let a
 * sandboxed command repoint the worktree at a git directory whose config a
 * later host-side git would run.
 *
 * A workspace whose git directory is a main checkout's `.git` (not a linked
 * worktree) gets the whole `.git` write-denied, so a sandboxed commit there
 * fails; `mainCheckout` lets the tools say so ("use a worktree").
 *
 * In the shared object store, a commit needs only to add loose objects, so
 * the packfiles and the store's `info` directory (alternates, the pack
 * list) are write-denied: no sandboxed command can delete or replace the
 * packed history that every branch and worktree reads.
 *
 * Residuals, stated rather than closed: a sandboxed command can add, delete
 * or overwrite loose (not yet packed) objects in the shared object store,
 * which every worktree reads; it can retarget this worktree's own HEAD, and
 * delete or recreate the session branch's own ref.
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
 * are write-denied, and a main checkout's whole `.git` is; a workspace that
 * had no repository at first stays without git grants, whatever a
 * sandboxed command later creates in it.
 */

import { mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
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
  /** The workspace's git directory is a main checkout's `.git`, all write-denied. */
  mainCheckout: boolean;
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
   * The operator's `[sandbox] deny_read` entries: home-relative or absolute
   * paths, added to `CREDENTIAL_READ_DENY`.
   */
  extraDenyRead?: readonly string[];
  readLayout?: GitLayoutReader;
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
  const workspace = realpathSync(root);
  const allowWrite = [workspace];
  const denyWrite: string[] = [];
  let mainCheckout = false;

  const layout = options.pinnedLayout !== undefined
    ? options.pinnedLayout
    : await (options.readLayout ?? readGitLayout)(
    workspace,
    options.env ?? { PATH: "/usr/bin:/bin", HOME: home },
  );
  if (layout !== null) {
    const { gitDir, commonDir, topLevel, branchRef } = layout;
    if (gitDir === commonDir) {
      // A main checkout: its `.git` holds every branch's refs and the
      // config, so none of it is writable.
      mainCheckout = true;
      denyWrite.push(gitDir);
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
    mainCheckout,
  };
}
