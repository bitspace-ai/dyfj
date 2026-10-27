/**
 * The tool executor's OS sandbox: Anthropic's sandbox-runtime (srt), used as
 * a library (BIT-662). When the boot probe passes, the bash, git and file
 * write tools run each command through `wrapWithSandbox`: Seatbelt on macOS,
 * bubblewrap with seccomp on Linux. The policy is `srt-policy.ts`'s, per
 * workspace; the network is srt's proxy, with a domain allowlist and no ask
 * callback, so an unlisted host is denied without a prompt.
 *
 * srt confines the command, not this runtime: on macOS a process cannot
 * apply a second Seatbelt profile from inside one (probe P0b), so the runtime
 * stays unwrapped and keeps the BIT-663 code-level seams as its boundary.
 * srt's proxies run in this process, so a sandboxed command is awaited with
 * an asynchronous spawn (`runBounded`); a synchronous one would hang a
 * networked child.
 *
 * A boot failure turns off the sandbox's auto-approval; it never runs a
 * command unconfined without a prompt. When srt is switched off (`DYFJ_SANDBOX=off`), the
 * platform is unsupported, a dependency is missing, srt's scratch directory
 * is not safely ours, or the probe does not see the outcomes it expects, the
 * sandbox is `off` with a reason. The tools then take the native route,
 * which prompts as it did before the sandbox (bash's read-only allowlist and
 * session grants still apply), and the posture line says so.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import {
  SandboxManager,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";
import { type Env, processEnv } from "../../config/mod.ts";
import { configFilePath } from "../../config/toml.ts";
import type { Containment } from "../definition.ts";
import { type BoundedResult, runBounded } from "./bounded-process.ts";
import {
  compileWorkspacePolicy,
  DEFAULT_ALLOWED_DOMAINS,
  DENIED_DOMAINS,
  type GitLayout,
  type GitLayoutReader,
  readGitLayout,
  type WorkspacePolicy,
} from "./srt-policy.ts";

/** The pinned srt version, as the posture line names it. */
export const SRT_BACKEND = "srt 0.0.81";

/** srt's fixed scratch directory: it sets `TMPDIR` to it and keeps it writable. */
export const SRT_SCRATCH_DIR = "/tmp/claude";

export type SandboxStatus =
  | { readonly state: "on"; readonly backend: string }
  | { readonly state: "off"; readonly backend: string; readonly reason: string };

/** One sandboxed run: a shell command, or an argv with optional stdin. */
export interface SandboxRun {
  /** The workspace whose policy applies. */
  root: string;
  cwd: string;
  timeoutMs: number;
  env: Record<string, string>;
  stdin?: string;
}

/** The sandbox port the tools receive from the composition root. */
export interface CommandSandbox {
  readonly status: SandboxStatus;
  /** The policy for a workspace, as the next run there would get it. */
  policy(root: string): Promise<WorkspacePolicy>;
  /**
   * Runs `bash -c <command>` sandboxed. A command's own failure is its
   * result; the call rejects when compiling the policy, wrapping, starting
   * or cleaning up fails.
   */
  runShell(command: string, run: SandboxRun): Promise<BoundedResult>;
  /** Runs `argv` sandboxed; rejects as `runShell` does. */
  runArgv(argv: readonly string[], run: SandboxRun): Promise<BoundedResult>;
}

/**
 * A sandbox that is off: its own runs reject. The tools do not call it; they
 * see `off` and take the native route, which prompts.
 */
export function offSandbox(reason: string): CommandSandbox {
  const refuse = () =>
    Promise.reject(new Error(`the sandbox is off: ${reason}`));
  return {
    status: { state: "off", backend: SRT_BACKEND, reason },
    policy: refuse,
    runShell: refuse,
    runArgv: refuse,
  };
}

/** POSIX single-quoting, for turning an argv into one shell word list. */
export function shellQuote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * The network policy: the default registry plus the operator's
 * `[sandbox] allow_domains`, with the GitHub domains always denied.
 */
export function sandboxNetwork(allowDomains: readonly string[]): {
  allowedDomains: string[];
  deniedDomains: string[];
} {
  const allowed = [...DEFAULT_ALLOWED_DOMAINS];
  for (const domain of allowDomains) {
    if (!allowed.includes(domain)) allowed.push(domain);
  }
  return { allowedDomains: allowed, deniedDomains: [...DENIED_DOMAINS] };
}

/** The srt calls the sandbox makes; injectable so tests can fake a broken srt. */
export interface SrtLibrary {
  isSupportedPlatform(): boolean;
  checkDependencies(): { errors: string[] };
  initialize(config: SandboxRuntimeConfig): Promise<void>;
  wrapWithSandbox(
    command: string,
    binShell: string,
    custom: Partial<SandboxRuntimeConfig>,
  ): Promise<string>;
  cleanupAfterCommand(): void;
  reset(): Promise<void>;
}

const srtLibrary: SrtLibrary = {
  isSupportedPlatform: () => SandboxManager.isSupportedPlatform(),
  checkDependencies: () => SandboxManager.checkDependencies(),
  initialize: (config) => SandboxManager.initialize(config),
  wrapWithSandbox: (command, binShell, custom) =>
    SandboxManager.wrapWithSandbox(command, binShell, custom),
  cleanupAfterCommand: () => SandboxManager.cleanupAfterCommand(),
  reset: () => SandboxManager.reset(),
};

/**
 * A loopback TCP listener on a free port that records whether anything
 * connected to it. The composition root supplies it from the transport
 * unit, which owns sockets (`listenLoopbackProbe`).
 */
export interface LoopbackProbe {
  readonly port: number;
  accepted(): boolean;
  close(): void;
}

export interface BootOptions {
  /** Opens the boot probe's listener; required, so the probe always checks the network. */
  listenProbe: () => Promise<LoopbackProbe>;
  env?: Env;
  /** `[sandbox] allow_domains` from config.toml. */
  allowDomains?: readonly string[];
  /** `[sandbox] deny_read` from config.toml: added to the built-in deny list. */
  denyRead?: readonly string[];
  srt?: SrtLibrary;
  home?: string;
  readLayout?: GitLayoutReader;
  /** srt's scratch directory; tests point it elsewhere only to check the ownership refusal. */
  scratchDir?: string;
}

/**
 * Creates srt's scratch directory if it is missing (mode 700), and refuses
 * one this user does not own or that others can write: srt hands it to every
 * sandboxed command as `TMPDIR`.
 */
export function ensureScratchDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory()) throw new Error(`${dir} is not a directory`);
  if (stat.uid !== process.getuid?.()) {
    throw new Error(`${dir} is owned by another user`);
  }
  if ((stat.mode & 0o022) !== 0) {
    throw new Error(`${dir} is writable by group or others`);
  }
}

function createSandbox(
  srt: SrtLibrary,
  options: BootOptions,
  baseEnv: Record<string, string>,
): CommandSandbox {
  // The git layout (git directories and session branch) is pinned per
  // workspace, from the first time this runtime compiles a policy there,
  // before any sandboxed command has run in it. A sandboxed command can
  // retarget its worktree's HEAD (a stated residual), or create a `.git`
  // pointer in a workspace that had none; pinning keeps either from widening
  // a later call's writes. Switching the workspace's branch host-side needs
  // a runtime restart before sandboxed commits follow it.
  const readLayout = options.readLayout ?? readGitLayout;
  const pins = new Map<string, Promise<GitLayout | null>>();
  const pinnedLayout = (root: string): Promise<GitLayout | null> => {
    const key = realpathSync(root);
    let pin = pins.get(key);
    if (pin === undefined) {
      pin = readLayout(key, baseEnv).then(
        (layout) => layout,
        (error) => {
          // Not pinned: the next call reads the layout again.
          pins.delete(key);
          throw error;
        },
      );
      pins.set(key, pin);
    }
    return pin;
  };
  const policy = async (root: string) =>
    compileWorkspacePolicy(root, {
      pinnedLayout: await pinnedLayout(root),
      env: baseEnv,
      ...(options.home === undefined ? {} : { home: options.home }),
      ...(options.denyRead === undefined
        ? {}
        : { extraDenyRead: options.denyRead }),
      ...(options.readLayout === undefined
        ? {}
        : { readLayout: options.readLayout }),
    });
  const runShell = async (
    command: string,
    run: SandboxRun,
  ): Promise<BoundedResult> => {
    const { filesystem } = await policy(run.root);
    const wrapped = await srt.wrapWithSandbox(command, "bash", { filesystem });
    // srt returns the command unchanged when it has no restriction to
    // apply. Every policy here has some, so an unchanged command means the
    // sandbox did not engage: refuse rather than run it bare.
    if (wrapped === command) {
      throw new Error("the sandbox did not wrap the command; refusing to run it");
    }
    try {
      return await runBounded({
        command: "bash",
        args: ["-c", wrapped],
        cwd: run.cwd,
        env: run.env,
        timeoutMs: run.timeoutMs,
        ...(run.stdin === undefined ? {} : { stdin: run.stdin }),
      });
    } finally {
      srt.cleanupAfterCommand();
    }
  };
  return {
    status: { state: "on", backend: SRT_BACKEND },
    policy,
    runShell,
    runArgv: (argv, run) => runShell(argv.map(shellQuote).join(" "), run),
  };
}

/**
 * The boot probe. In a fresh directory it checks that srt refuses a write
 * outside that directory and a direct connect to a local listener (the proxy
 * is the only route out), and allows a write inside it. The last is the
 * positive control: a sandbox that refuses everything does not pass.
 * Returns null when every outcome is as expected, otherwise the reason.
 */
export async function probeSandbox(
  sandbox: CommandSandbox,
  env: Record<string, string>,
  listenProbe: () => Promise<LoopbackProbe>,
): Promise<string | null> {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "dyfj-srt-probe-")));
  const root = join(parent, "root");
  mkdirSync(root);
  const outside = join(parent, "outside");
  let listener: LoopbackProbe | undefined;
  try {
    const run = { root, cwd: root, timeoutMs: 20_000, env };
    // A control connect, outside the sandbox, shows this bash can make the
    // connection at all; without it, a bash with no /dev/tcp support would
    // pass the refusal check below without srt refusing anything.
    const control = await listenProbe();
    try {
      const reached = await runBounded({
        command: "bash",
        args: ["-c", connectCommand(control.port)],
        ...run,
      });
      if (reached.code !== 0 || !(await acceptedSoon(control))) {
        return "the probe's control connect, outside the sandbox, did not succeed";
      }
    } finally {
      control.close();
    }
    listener = await listenProbe();
    const inside = await sandbox.runShell("printf ok > inside", run);
    if (inside.code !== 0 || readFileSync(join(root, "inside"), "utf8") !== "ok") {
      return "the probe's write inside its directory did not succeed";
    }
    const write = await sandbox.runShell(`printf x > ${shellQuote(outside)}`, run);
    if (write.code === 0 || existsSync(outside)) {
      return "the probe's write outside its directory was not refused";
    }
    const connect = await sandbox.runShell(connectCommand(listener.port), run);
    if (
      connect.code === 0 || connect.timedOut || (await acceptedSoon(listener))
    ) {
      return "the probe's direct connect was not refused";
    }
    return null;
  } catch (error) {
    return `the probe could not run: ${(error as Error).message}`;
  } finally {
    listener?.close();
    try {
      rmSync(parent, { recursive: true, force: true });
    } catch {
      // A probe directory left in the temp dir does not change the verdict.
    }
  }
}

/** A bash command that opens a TCP connection to `port` on loopback. */
function connectCommand(port: number): string {
  return `exec 3<>/dev/tcp/127.0.0.1/${port}`;
}

/** Whether `listener` has accepted a connection, allowing its accept event a moment to arrive. */
async function acceptedSoon(listener: LoopbackProbe): Promise<boolean> {
  for (let attempt = 0; attempt < 10; attempt++) {
    if (listener.accepted()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return listener.accepted();
}

/** The `DYFJ_SANDBOX` switch: only `off` is meaningful. */
export function sandboxSwitchedOff(env: Env): boolean {
  try {
    return env.get("DYFJ_SANDBOX")?.trim().toLowerCase() === "off";
  } catch {
    return false;
  }
}

/**
 * Starts srt once for the runtime and probes it. A failure to start or probe
 * is an `off` sandbox with its reason.
 */
export async function bootSandbox(
  options: BootOptions,
): Promise<CommandSandbox> {
  const env = options.env ?? processEnv;
  if (sandboxSwitchedOff(env)) return offSandbox("DYFJ_SANDBOX=off");
  const srt = options.srt ?? srtLibrary;
  try {
    if (!srt.isSupportedPlatform()) {
      return offSandbox(`unsupported platform (${process.platform})`);
    }
    const deps = srt.checkDependencies();
    if (deps.errors.length > 0) {
      return offSandbox(`missing dependencies: ${deps.errors.join("; ")}`);
    }
    ensureScratchDir(options.scratchDir ?? SRT_SCRATCH_DIR);
    await srt.initialize({
      network: sandboxNetwork(options.allowDomains ?? []),
      filesystem: {
        denyRead: [],
        allowWrite: [],
        denyWrite: [],
      },
    });
  } catch (error) {
    // initialize may have opened its proxies before it failed.
    await srt.reset().catch(() => {});
    return offSandbox(`srt failed to start: ${(error as Error).message}`);
  }
  const baseEnv = hostEnv(env);
  // The runtime's own directory is DYFJ_ROOT when set, so it is denied by
  // path as well as under the built-in `.dyfj` entry.
  const runtimeDir = dirname(configFilePath(env));
  const sandbox = createSandbox(
    srt,
    { ...options, denyRead: [...(options.denyRead ?? []), runtimeDir] },
    baseEnv,
  );
  const failure = await probeSandbox(sandbox, baseEnv, options.listenProbe)
    .catch((error) => `the probe could not run: ${(error as Error).message}`);
  if (failure !== null) {
    await srt.reset().catch(() => {});
    return offSandbox(`boot probe failed: ${failure}`);
  }
  return sandbox;
}

/** PATH, HOME, USER and LANG from `env`: the probe's and host-side git's environment. */
function hostEnv(env: Env): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "USER", "LANG"]) {
    try {
      const value = env.get(key);
      if (value !== undefined) result[key] = value;
    } catch {
      // not granted: absent
    }
  }
  return result;
}

/**
 * The containment of a tool whose commands run in `sandbox`. Its verdict is
 * `sandboxed` only while the sandbox is on; the policy then decides by
 * posture (`tools/policy.ts`).
 */
export function sandboxContainment(sandbox: CommandSandbox): Containment {
  return {
    route: "srt",
    attest: () => {
      const status = sandbox.status;
      return Promise.resolve(
        status.state === "on"
          ? { status: "sandboxed", backend: status.backend }
          : { status: "unattested", reason: `the sandbox is off: ${status.reason}` },
      );
    },
  };
}

/**
 * Appended to a failed sandboxed command's output in a main checkout, where
 * the sandbox denies every write under `.git`.
 */
export const MAIN_CHECKOUT_NOTE =
  "note: this workspace is a main checkout, not a linked git worktree. The " +
  "sandbox denies every write under its .git, so git add and git commit " +
  "fail here. Sandboxed commits need a linked worktree: use a worktree.";

/** The posture line's sandbox segment. */
export function describeSandbox(status: SandboxStatus): string {
  return status.state === "on"
    ? `sandbox ${status.backend}`
    : `sandbox OFF (${status.reason}): commands ask`;
}
