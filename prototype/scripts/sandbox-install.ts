/**
 * The isolated machine's trusted installer (BIT-735). Run as root inside the
 * OrbStack isolated machine, it turns one composition of the runtime grants
 * and the machine profile into the files `dyfj-sandbox` starts roles from:
 *
 *   node sandbox-install.ts --profile <profile.json> --out <dir>
 *
 * writes `<dir>/{runtime,executor,cli}.plan.json` and `<dir>/receipt.json`,
 * each owned by root and mode 0644. A run starts from these files, never from
 * anything its own roles can write.
 *
 * From the composition and the profile it derives:
 * - the run envelope: the composed policy with the machine's filesystem
 *   roots (toolchain, code, workspace, runtime home, secrets) and a tmpfs;
 * - the runtime role: direct execute on exactly its run grants, each
 *   resolved to its real path here, and the dynamic loader they need (the
 *   loader can still run any readable binary); the workspace without
 *   execute; and only the network
 *   entries the run needs here: the database, the resolver, operator
 *   additions, and each `tls` provider the profile accepts enforced by address
 *   set. Other providers and local model servers are dropped;
 * - the executor role: toolchain and workspace only, no network, no secrets,
 *   no database, and the bash and git tools' command environment. Its job is
 *   running arbitrary programs, so it executes from its roots whole
 *   (`executeScope: "roots"`), as does the CLI role;
 * - the CLI role: its own composition, with the profile's network additions
 *   for the Claude Code and Codex CLIs, its own home and its own workspace.
 *
 * Workspace git metadata is writable by the roles that write the workspace;
 * Landlock cannot deny beneath a writable mount, so no envelope claims to
 * protect it. What keeps a planted hook harmless is that nothing outside the
 * executor runs git where the executor writes: the runtime's git and bash
 * tools run in the executor, the export runs there with hooks and config
 * disabled, and the CLI has a workspace of its own.
 *
 * Each role is checked to sit inside its run, compiled for the machine's Linux
 * target (hostname assurance `none`, address-set downgrade offered) and
 * planned. The receipt records each role's policy and plan digests and, per
 * allowed destination, the assurance asked for, the assurance enforced and the
 * addresses it resolved to. It records no secret and no workspace content.
 */

import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import {
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import process from "node:process";
import {
  compileLinux,
  type CompileAcceptance,
  type LinuxOutput,
  type LinuxTarget,
} from "../src/config/effective-policy-compile.ts";
import { canonicalPolicyJson, policyDigest } from "../src/config/effective-policy-digest.ts";
import { assertSessionWithinRun } from "../src/config/effective-policy-subset.ts";
import {
  composeEffectivePolicy,
  type EffectivePolicy,
  type EffectivePolicyIdentityInput,
  type FilesystemRoot,
  type NetworkEntry,
  parseEffectivePolicy,
} from "../src/config/effective-policy.ts";
import {
  type LaunchTemplate,
  type LinuxLaunchPlan,
  planLinuxLaunch,
  type ResolvedHosts,
} from "../src/config/linux-launch-plan.ts";
import {
  isAddressLiteral,
  RUNTIME_RUN_GRANTS,
} from "../src/config/runtime-policy.ts";
import { GIT_COMMAND_ENV_KEYS } from "../src/tools/builtin/git.ts";

export interface RoleIds {
  readonly uid: number;
  readonly gid: number;
}

export interface MachineProfile {
  readonly identity: EffectivePolicyIdentityInput;
  /** The run's Linux-resident workspace. */
  readonly workspace: string;
  /** `tls` provider entries (`host:port`) accepted enforced by address set. */
  readonly acceptAddressSet: readonly string[];
  readonly runtime: RoleIds;
  readonly executor: RoleIds;
  /**
   * The CLI's own workspace, apart from the executor's: the executor can
   * write git metadata in its workspace, and the CLI runs git with its own
   * login and egress, so it never runs git where the executor writes.
   */
  readonly cli: RoleIds & {
    readonly workspace: string;
    readonly networkAllow: readonly string[];
  };
}

/** What the installer read from the machine itself. */
export interface MachineFacts {
  readonly nodePath: string;
  /** `<ip>:53` for each nameserver in the machine's resolver configuration. */
  readonly nameservers: readonly string[];
  /** The machine files each sandbox binds read-only (those that exist). */
  readonly systemReadOnly: readonly string[];
  /** Each runtime run grant, resolved on PATH and to its real path. */
  readonly executables: Readonly<Record<string, string>>;
  /** The dynamic loader's real path. */
  readonly loader: string;
}

export interface RoleOutput {
  readonly policy: EffectivePolicy;
  readonly compiled: LinuxOutput;
  readonly plan: LinuxLaunchPlan;
}

// ── The machine layout: the trusted template ────────────────────────────────

export const HELPER = "/usr/libexec/dyfj/dyfj-sandbox";
export const EXECUTOR_SOCKET_DIR = "/run/dyfj-exec";
export const EXECUTOR_SOCKET = `${EXECUTOR_SOCKET_DIR}/exec.sock`;
export const SECRETS_DIR = "/run/dyfj/secrets";
const RUNTIME_HOME = "/srv/dyfj/state/runtime";
const CLI_HOME = "/srv/dyfj/state/cli";
const DOLT = { host: "127.0.0.1", port: 3306 };

/** Candidate files under /etc that programs in a sandbox expect. */
export const SYSTEM_READ_ONLY_CANDIDATES: readonly string[] = [
  "/etc/ld.so.cache",
  "/etc/passwd",
  "/etc/group",
  "/etc/nsswitch.conf",
  "/etc/hosts",
  "/etc/resolv.conf",
  "/etc/ssl",
  "/etc/ca-certificates",
  "/etc/alternatives",
  "/etc/localtime",
  "/etc/gitconfig",
];

const SYMLINKS = [
  { link: "/bin", target: "usr/bin" },
  { link: "/lib", target: "usr/lib" },
  { link: "/sbin", target: "usr/sbin" },
];

const TARGET: Omit<LinuxTarget, "services"> = {
  capabilities: {
    filesystemRights: ["read", "write", "execute"],
    protocols: ["tcp", "udp"],
    hostnameAssurances: ["none"],
    tlsByAddressSet: true,
    dnsModes: ["none", "resolver"],
    executeByDigest: false,
    requireExecutableDigest: false,
    processLimit: true,
    forbidDescendants: false,
    syscallProfiles: [],
    requireSyscallProfile: false,
  },
  mountBase: "/",
};

function root(
  name: string,
  source: string,
  rights: FilesystemRoot["rights"],
): FilesystemRoot {
  return { name, source, target: name, rights };
}

// ── Derivation ───────────────────────────────────────────────────────────────

/** `policy` with `edit` applied, re-digested and validated. */
function derive(
  policy: EffectivePolicy,
  edit: (draft: any) => void,
): EffectivePolicy {
  const draft = JSON.parse(JSON.stringify(policy));
  edit(draft);
  draft.identity.digest = "";
  draft.identity.digest = policyDigest(draft);
  return parseEffectivePolicy(draft);
}

const entryName = (e: NetworkEntry) => `${e.host}:${e.port}`;

/** The entries a contained role keeps: see the module comment. */
function keptEntries(
  policy: EffectivePolicy,
  accepted: readonly string[],
  roles: readonly NetworkEntry["role"][],
): NetworkEntry[] {
  return policy.network.entries.filter((entry) =>
    entry.hostnameAssurance === "tls"
      ? accepted.includes(entryName(entry))
      : roles.includes(entry.role)
  );
}

function sha256(value: unknown): string {
  return `sha256:${
    createHash("sha256").update(canonicalPolicyJson(value)).digest("hex")
  }`;
}

function template(
  role: LaunchTemplate["role"],
  ids: RoleIds,
  machine: MachineFacts,
  extra: Partial<LaunchTemplate> = {},
): LaunchTemplate {
  return {
    role,
    uid: ids.uid,
    gid: ids.gid,
    systemReadOnly: [...machine.systemReadOnly],
    symlinks: SYMLINKS,
    helper: HELPER,
    executeScope: "roots",
    ...extra,
  };
}

function compileRole(
  policy: EffectivePolicy,
  acceptance: CompileAcceptance,
  launch: LaunchTemplate,
  resolved: ResolvedHosts,
): RoleOutput {
  const services = policy.network.dolt === null
    ? []
    : [{ entry: policy.network.dolt, host: DOLT.host, port: DOLT.port }];
  const compiled = compileLinux(policy, { ...TARGET, services }, acceptance);
  return { policy, compiled, plan: planLinuxLaunch(compiled, launch, resolved) };
}

function receiptRole(output: RoleOutput, resolved: ResolvedHosts) {
  return {
    uid: output.plan.uid,
    executeScope: output.plan.executeScope,
    policyDigest: output.policy.identity.digest,
    planDigest: sha256(output.plan),
    egress: output.compiled.firewall.accept.map((entry) => ({
      policyEntry: entry.policyEntry,
      protocol: entry.protocol,
      hostnameAssurance: entry.hostnameAssurance,
      enforcedAssurance: entry.enforcedAssurance,
      addresses: isAddressLiteral(entry.host)
        ? [entry.host.replace(/^\[|\]$/g, "")]
        : [...(resolved[entry.host] ?? [])],
    })),
  };
}

/** Every policy, compiled output, plan and the receipt, or a refusal. */
export function buildMachinePlans(input: {
  profile: MachineProfile;
  machine: MachineFacts;
  resolved: ResolvedHosts;
}) {
  const { profile, machine, resolved } = input;
  const uids = [profile.runtime.uid, profile.executor.uid, profile.cli.uid];
  if (new Set(uids).size !== uids.length) {
    throw new Error("each role needs a distinct uid");
  }
  const work = profile.workspace;
  const cliWork = profile.cli.workspace;
  if (
    cliWork === work || cliWork.startsWith(`${work}/`) ||
    work.startsWith(`${cliWork}/`)
  ) {
    throw new Error("the CLI workspace must be apart from the executor's");
  }

  const base = {
    nameserverGrants: machine.nameservers,
    runtimeExecutable: machine.nodePath,
    secrets: null,
  };
  const run = composeEffectivePolicy(
    { ...base, dolt: DOLT },
    {
      identity: profile.identity,
      filesystem: {
        roots: [
          root("usr", "/usr", ["read", "execute"]),
          root("opt", "/opt", ["read", "execute"]),
          root("work", work, ["read", "write", "execute"]),
          root("home", RUNTIME_HOME, ["read", "write"]),
          root("secrets", SECRETS_DIR, ["read"]),
        ],
        scratch: "tmp",
        // Workspace git metadata is writable on this target (Landlock cannot
        // deny beneath a writable mount), so no envelope claims to protect
        // it. Instead nothing outside the executor runs git in it: the git
        // and bash tools run there, and the export disables hooks and config.
        protectedGit: [],
      },
    },
  );

  const accepted = profile.acceptAddressSet;
  const runtimePolicy = derive(run, (draft) => {
    draft.filesystem.roots = draft.filesystem.roots.map((r: FilesystemRoot) =>
      r.name === "work" ? { ...r, rights: ["read", "write"] } : r
    );
    draft.network.entries = keptEntries(run, accepted, ["dolt", "dns", "operator"]);
  });
  const executorPolicy = derive(run, (draft) => {
    draft.filesystem.roots = draft.filesystem.roots.filter((r: FilesystemRoot) =>
      r.name === "usr" || r.name === "work"
    );
    draft.network = { entries: [], brokerOperations: [], dolt: null };
    draft.processes.environment = run.processes.environment.filter((name) =>
      ["PATH", "HOME", "USER"].includes(name)
    );
    draft.secrets = [];
  });
  assertSessionWithinRun(runtimePolicy, run);
  assertSessionWithinRun(executorPolicy, run);

  const cliRun = composeEffectivePolicy(
    { ...base, networkAllow: profile.cli.networkAllow },
    {
      identity: profile.identity,
      filesystem: {
        roots: [
          root("usr", "/usr", ["read", "execute"]),
          root("work", cliWork, ["read", "write", "execute"]),
          root("home", CLI_HOME, ["read", "write"]),
        ],
        scratch: "tmp",
        protectedGit: [],
      },
    },
  );
  const cliPolicy = derive(cliRun, (draft) => {
    draft.network.entries = keptEntries(cliRun, accepted, ["dns", "operator"]);
    draft.network.dolt = null;
  });
  assertSessionWithinRun(cliPolicy, cliRun);
  const cliTls = cliPolicy.network.entries.filter((e) => e.hostnameAssurance === "tls")
    .map(entryName);

  // The runtime may directly execute only its run grants (and the loader they
  // need). The executor and the CLIs run arbitrary programs as their job, so
  // they take their execute roots whole, and the plan says so.
  const runtime = compileRole(
    runtimePolicy,
    { addressSet: accepted },
    template("runtime", profile.runtime, machine, {
      systemReadOnly: [...machine.systemReadOnly, EXECUTOR_SOCKET_DIR],
      executeScope: "files",
      resolvedExecutables: machine.executables,
      loader: machine.loader,
    }),
    resolved,
  );
  const executor = compileRole(
    executorPolicy,
    {},
    template("executor", profile.executor, machine, {
      commandEnvironment: GIT_COMMAND_ENV_KEYS,
    }),
    resolved,
  );
  // The CLI's own role is a runtime-shaped sandbox: shared network, its uid.
  const cli = compileRole(
    cliPolicy,
    { addressSet: accepted.filter((name) => cliTls.includes(name)) },
    template("runtime", profile.cli, machine),
    resolved,
  );

  const receipt = {
    version: 1,
    run: profile.identity.run,
    target: { hostnameAssurances: TARGET.capabilities.hostnameAssurances, tlsByAddressSet: true },
    runDigest: run.identity.digest,
    roles: {
      runtime: receiptRole(runtime, resolved),
      executor: receiptRole(executor, resolved),
      cli: receiptRole(cli, resolved),
    },
  };
  return { run, cliRun, runtime, executor, cli, receipt };
}

// ── Machine IO ───────────────────────────────────────────────────────────────

function nameservers(): string[] {
  return readFileSync("/etc/resolv.conf", "utf8").split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts[0] === "nameserver" && parts[1] !== undefined)
    .map((parts) => parts[1]!.includes(":") ? `[${parts[1]}]:53` : `${parts[1]}:53`);
}

async function resolveHosts(policies: readonly EffectivePolicy[]): Promise<ResolvedHosts> {
  const hosts = new Set(
    policies.flatMap((p) => p.network.entries.map((e) => e.host))
      .filter((host) => !isAddressLiteral(host)),
  );
  const resolved: Record<string, string[]> = {};
  for (const host of hosts) {
    try {
      const answers = await lookup(host, { all: true });
      resolved[host] = [...new Set(answers.map((a) => a.address))];
    } catch {
      // Left unresolved: the plan refuses the entry by name.
    }
  }
  return resolved;
}

/** A program's real path: an absolute one as given, a bare name on PATH. */
function resolveProgram(program: string): string | undefined {
  const candidates = program.startsWith("/")
    ? [program]
    : ["/usr/local/bin", "/usr/bin", "/bin"].map((dir) => `${dir}/${program}`);
  const found = candidates.find((path) => existsSync(path));
  return found === undefined ? undefined : realpathSync(found);
}

/** The dynamic loader's real path. */
function dynamicLoader(): string {
  const name = readdirSync("/usr/lib").find((entry) =>
    /^ld-linux.*\.so\.\d+$/.test(entry)
  );
  if (name === undefined) throw new Error("no dynamic loader in /usr/lib");
  return realpathSync(`/usr/lib/${name}`);
}

function flag(args: readonly string[], name: string): string {
  const at = args.indexOf(name);
  const value = at === -1 ? undefined : args[at + 1];
  if (value === undefined) throw new Error(`missing ${name}`);
  return value;
}

async function main(args: readonly string[]) {
  const profile = JSON.parse(readFileSync(flag(args, "--profile"), "utf8"));
  const out = flag(args, "--out");
  const machine: MachineFacts = {
    nodePath: process.execPath,
    nameservers: nameservers(),
    systemReadOnly: SYSTEM_READ_ONLY_CANDIDATES.filter((path) => existsSync(path)),
    // A grant left unresolved here is refused by the plan, by name.
    executables: Object.fromEntries(
      [...RUNTIME_RUN_GRANTS, process.execPath].flatMap((program) => {
        const path = resolveProgram(program);
        return path === undefined ? [] : [[program, path]];
      }),
    ),
    loader: dynamicLoader(),
  };
  // Every host any role can keep: the static rows and the CLI's additions.
  const resolved = await resolveHosts([
    composeEffectivePolicy(
      { networkAllow: profile.cli.networkAllow, nameserverGrants: machine.nameservers },
      { identity: profile.identity },
    ),
  ]);
  const result = buildMachinePlans({ profile, machine, resolved });
  mkdirSync(out, { recursive: true, mode: 0o755 });
  // Set explicitly, not left to the umask or a previous run's file: the
  // launcher trusts a plan only when root owns it and no one else can write.
  const write = (path: string, value: unknown) => {
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
    chownSync(path, 0, 0);
    chmodSync(path, 0o644);
  };
  for (const role of ["runtime", "executor", "cli"] as const) {
    write(`${out}/${role}.plan.json`, result[role].plan);
  }
  write(`${out}/receipt.json`, result.receipt);
  process.stdout.write(`${JSON.stringify(result.receipt, null, 2)}\n`);
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`sandbox-install: ${(error as Error).message}\n`);
    process.exitCode = 1;
  });
}
