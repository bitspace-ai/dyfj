/**
 * The Linux launch plan: what the trusted launcher applies to start one role
 * of a Workbench run inside the isolated Linux machine. `compileLinux` output,
 * a role template and the trusted installer's host resolution in; plain,
 * frozen data out:
 *
 * - bubblewrap options that build the role's mount view from the template's
 *   read-only system paths and the policy's mounts. The runtime keeps the
 *   machine's network namespace, so the firewall below governs it; the
 *   executor gets its own, with loopback only.
 * - the command the sandbox runs first: the launcher's helper, which applies
 *   the Landlock path sets and then starts the role's command.
 * - an nftables ruleset, in a table of the role's own, that lets the role's
 *   uid open new connections only to the resolved policy entries, and logs,
 *   counts and rejects every other new packet it sends (TCP with a reset, the
 *   rest with an ICMP error). Established and related traffic is accepted, so
 *   a connection opened under an earlier plan outlives a narrower one until
 *   it closes.
 *
 * Every host comes from the policy, by way of `compileLinux`; the addresses
 * come from the installer's resolution, never from this module. A named host
 * is filtered by the addresses it resolved to when the policy was installed,
 * so this target gives hostname assurance `none`. Nothing here starts a
 * process or touches the host.
 *
 * An executor that the policy grants any network entry is refused: this
 * target runs executors without a network. A seccomp profile is refused too,
 * because the launcher installs none, and so is any filesystem protection the
 * plan cannot honour (`checkProtections`).
 */

import type {
  CompiledEgress,
  LandlockPaths,
  LinuxOutput,
} from "./effective-policy-compile.ts";
import { isAddressLiteral } from "./runtime-policy.ts";

export type LaunchRole = "runtime" | "executor";
export const LAUNCH_ROLES: readonly LaunchRole[] = ["runtime", "executor"];

/**
 * How a role's execute rights are drawn. `files`: exactly the policy's
 * executables, resolved to real paths at install, and the dynamic loader an
 * ELF program needs, so a direct `execve` of any unlisted program is refused.
 * `roots`: the policy's execute roots whole, for a role whose job is running
 * arbitrary programs (the executor, an agent CLI); its executable list is not
 * enforced, and the plan and receipt say so. Either way execute governs
 * `execve` only: the loader or an interpreter can still run a readable file.
 */
export type ExecuteScope = "files" | "roots";
export const EXECUTE_SCOPES: readonly ExecuteScope[] = ["files", "roots"];

/** The trusted launcher's fixed description of one role. */
export interface LaunchTemplate {
  readonly role: LaunchRole;
  /** The role's own uid and gid. Never root. */
  readonly uid: number;
  readonly gid: number;
  /** Machine paths bound read-only at the same place, and granted read. */
  readonly systemReadOnly: readonly string[];
  /** Symlinks in the sandbox root, each target relative to that root. */
  readonly symlinks: readonly {
    readonly link: string;
    readonly target: string;
  }[];
  /** The launcher's helper, run inside the sandbox from a read-only path. */
  readonly helper: string;
  /**
   * Environment names the role's commands carry besides the policy's: the
   * bash tool's command environment, which holds no secret by construction.
   * Names only; the launcher takes each value from the request.
   */
  readonly commandEnvironment?: readonly string[];
  readonly executeScope: ExecuteScope;
  /** Under `files`: each policy executable's real path, resolved at install. */
  readonly resolvedExecutables?: Readonly<Record<string, string>>;
  /** Under `files`: the dynamic loader's path inside the sandbox. */
  readonly loader?: string;
}

/** The addresses each named policy host resolved to at install time. */
export type ResolvedHosts = Readonly<Record<string, readonly string[]>>;

export interface LinuxLaunchPlan {
  readonly role: LaunchRole;
  readonly policyDigest: string;
  readonly executeScope: ExecuteScope;
  readonly uid: number;
  readonly gid: number;
  /**
   * `bwrap <options> [--setenv NAME VALUE]... -- <inner> <command>...`: the
   * launcher adds the environment, taking only `environment`'s names.
   */
  readonly bwrap: {
    readonly options: readonly string[];
    readonly inner: readonly string[];
  };
  readonly landlock: LandlockPaths;
  /** The writable mounts, where the supervisor lets a command start. */
  readonly writableTargets: readonly string[];
  readonly nftables: string;
  readonly environment: readonly string[];
  readonly maxProcesses: number | null;
}

export interface LaunchPlanOffender {
  readonly group: string;
  readonly path: string;
  readonly right: string;
}

/** The plan cannot be built. Carries every offender, never a value. */
export class LaunchPlanError extends Error {
  readonly offenders: readonly LaunchPlanOffender[];

  constructor(offenders: readonly LaunchPlanOffender[]) {
    super(
      `the Linux launch plan is refused: ${
        offenders.map((o) => `${o.path} (${o.right})`).join(", ")
      }`,
    );
    this.name = "LaunchPlanError";
    this.offenders = Object.freeze(offenders.map((o) => Object.freeze(o)));
  }
}

const CONTROL = /[\u0000-\u001f\u007f]/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A canonical absolute path other than the root itself. */
function isCanonicalPath(path: unknown): path is string {
  if (typeof path !== "string" || !path.startsWith("/") || path === "/") {
    return false;
  }
  return path.slice(1).split("/").every((part) =>
    part !== "" && part !== "." && part !== ".." && !CONTROL.test(part)
  );
}

/** `path` is `root` or lies beneath it. */
function within(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/** A relative symlink target that stays inside the sandbox root. */
function isRootedTarget(target: unknown): target is string {
  return typeof target === "string" && target !== "" &&
    !target.startsWith("/") &&
    target.split("/").every((part) =>
      part !== "" && part !== "." && part !== ".." && !CONTROL.test(part)
    );
}

/** An id the role may run as: an unsigned 32-bit integer other than root. */
function isRoleId(id: unknown): id is number {
  return Number.isInteger(id) && (id as number) > 0 &&
    (id as number) < 2 ** 32 - 1;
}

type Report = (group: string, path: string, right: string) => void;

function checkTemplate(
  output: LinuxOutput,
  template: LaunchTemplate,
  report: Report,
) {
  if (!LAUNCH_ROLES.includes(template.role)) {
    report("template", "template.role", "role-invalid");
  }
  if (!EXECUTE_SCOPES.includes(template.executeScope)) {
    report("template", "template.executeScope", "execute-scope-invalid");
  }
  if (!isRoleId(template.uid)) report("template", "template.uid", "id-invalid");
  if (!isRoleId(template.gid)) report("template", "template.gid", "id-invalid");

  const mounted = [
    ...output.mounts.map((mount) => mount.target),
    ...(output.scratch === null ? [] : [output.scratch.target]),
  ];
  template.systemReadOnly.forEach((path, index) => {
    const at = `template.systemReadOnly[${index}]`;
    if (!isCanonicalPath(path)) {
      report("template", at, "path-invalid");
    } else if (
      mounted.some((target) => within(target, path) || within(path, target))
    ) {
      report("template", at, "mount-collides");
    }
  });
  (template.commandEnvironment ?? []).forEach((name, index) => {
    if (typeof name !== "string" || !ENV_NAME.test(name)) {
      report("template", `template.commandEnvironment[${index}]`, "name-invalid");
    }
  });
  template.symlinks.forEach((symlink, index) => {
    if (!isCanonicalPath(symlink.link) || !isRootedTarget(symlink.target)) {
      report("template", `template.symlinks[${index}]`, "symlink-invalid");
    }
  });

  const readOnly = [
    ...template.systemReadOnly.filter(isCanonicalPath),
    ...output.mounts.filter((mount) => mount.readOnly).map((mount) =>
      mount.target
    ),
  ];
  if (
    !isCanonicalPath(template.helper) ||
    !readOnly.some((root) => within(template.helper, root))
  ) {
    report("template", "template.helper", "helper-not-read-only");
  }
}

/** 4 or 6 for a bare IPv4 or IPv6 address, 0 for anything else. */
function addressFamily(address: string): 0 | 4 | 6 {
  if (address.includes(":")) return isAddressLiteral(`[${address}]`) ? 6 : 0;
  return isAddressLiteral(address) ? 4 : 0;
}

/** Every path the sandbox makes visible: its mounts and the template's binds. */
function visible(output: LinuxOutput, template: LaunchTemplate): string[] {
  return [
    ...output.mounts.map((mount) => mount.target),
    ...template.systemReadOnly.filter(isCanonicalPath),
  ];
}

/** Under `files` scope, every policy executable must resolve inside the sandbox. */
function checkExecutables(
  output: LinuxOutput,
  template: LaunchTemplate,
  report: Report,
) {
  if (template.executeScope !== "files") return;
  const seen = visible(output, template);
  const inside = (path: unknown) =>
    isCanonicalPath(path) && seen.some((root) => within(path, root));
  if (!inside(template.loader)) {
    report("template", "template.loader", "loader-invalid");
  }
  const resolved = template.resolvedExecutables ?? {};
  output.process.executables.forEach((executable, index) => {
    const at = `process.executables[${index}]`;
    const path = Object.hasOwn(resolved, executable.program)
      ? resolved[executable.program]
      : undefined;
    if (path === undefined) {
      report("processes", at, "executable-unresolved");
    } else if (!inside(path)) {
      report("processes", at, "executable-not-mounted");
    }
  });
}

/** The address each accepted entry is filtered by, as nftables spells it. */
function addresses(
  entry: CompiledEgress,
  resolved: ResolvedHosts,
): readonly string[] | null {
  if (isAddressLiteral(entry.host)) {
    return [entry.host.startsWith("[") ? entry.host.slice(1, -1) : entry.host];
  }
  const found = Object.hasOwn(resolved, entry.host)
    ? resolved[entry.host]
    : undefined;
  return found === undefined || found.length === 0 ? null : found;
}

function checkNetwork(
  output: LinuxOutput,
  template: LaunchTemplate,
  resolved: ResolvedHosts,
  report: Report,
) {
  output.firewall.accept.forEach((entry, index) => {
    const at = `firewall.accept[${index}]`;
    if (template.role === "executor") {
      report("network", at, "executor-network");
      return;
    }
    const found = addresses(entry, resolved);
    if (found === null) {
      report("network", at, "host-unresolved");
    } else if (!found.every((address) => addressFamily(address) !== 0)) {
      report("network", at, "address-invalid");
    }
  });
}

/**
 * The filesystem protections this plan can honour. Landlock only grants, so
 * nothing beneath a writable mount can be denied: protected git metadata in a
 * role that writes anywhere is refused rather than silently dropped. A
 * forbidden path that equals, contains or lies beneath any path the sandbox
 * binds (a policy mount's source or a template read-only path) is refused
 * too. A forbidden path related to none of them is not bound into the sandbox.
 */
function checkProtections(
  output: LinuxOutput,
  template: LaunchTemplate,
  report: Report,
) {
  const bound = [
    ...output.mounts.map((mount) => mount.source),
    ...template.systemReadOnly,
  ];
  if (output.landlock.write.length > 0) {
    output.protectedGit.forEach((_, index) => {
      report("filesystem", `protectedGit[${index}]`, "protected-git-unsupported");
    });
  }
  output.forbiddenPaths.forEach((path, index) => {
    if (bound.some((source) => within(path, source) || within(source, path))) {
      report("filesystem", `forbiddenPaths[${index}]`, "forbidden-path-mounted");
    }
  });
}

function nftables(
  output: LinuxOutput,
  template: LaunchTemplate,
  resolved: ResolvedHosts,
): string {
  // One table per role and uid: two roles of one shape (the runtime and the
  // CLI) must never replace each other's rules.
  const table = `inet dyfj_${template.role}_${template.uid}`;
  const accepts = output.firewall.accept.flatMap((entry) =>
    addresses(entry, resolved)!.map((address) =>
      `    ${addressFamily(address) === 6 ? "ip6" : "ip"} daddr ${address} ${entry.protocol} dport ${entry.port} accept`
    )
  );
  const established = template.role === "runtime"
    ? ["    ct state established,related accept"]
    : [];
  return [
    // Declaring the table first makes the delete succeed on a fresh machine,
    // so a reinstall replaces the rules rather than adding to them.
    `table ${table}`,
    `delete table ${table}`,
    `table ${table} {`,
    "  chain output {",
    "    type filter hook output priority filter; policy accept;",
    // Matched positively: a packet with no socket, such as the ICMP error a
    // reject sends back, has no uid and must not be refused in turn.
    `    meta skuid ${template.uid} jump role`,
    "  }",
    "  chain role {",
    ...established,
    ...accepts,
    // Rejected, not silently dropped: a refused connect fails at once with an
    // errno instead of waiting out its retries. TCP gets a reset, because the
    // kernel rate-limits the ICMP errors a burst of refusals would need. The
    // counters are the evidence.
    `    meta l4proto tcp log prefix "dyfj-drop ${template.role} " counter reject with tcp reset`,
    `    log prefix "dyfj-drop ${template.role} " counter reject with icmpx admin-prohibited`,
    "  }",
    "}",
    "",
  ].join("\n");
}

function bwrapOptions(
  output: LinuxOutput,
  template: LaunchTemplate,
): string[] {
  // `--unshare-all` only tries a user namespace; `--disable-userns` needs one.
  const namespaces = template.role === "runtime"
    ? ["--unshare-all", "--unshare-user", "--share-net"]
    : ["--unshare-all", "--unshare-user"];
  const writable = output.mounts.find((mount) => !mount.readOnly);
  return [
    ...namespaces,
    "--disable-userns",
    "--die-with-parent",
    "--new-session",
    "--cap-drop",
    "ALL",
    "--clearenv",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    ...template.systemReadOnly.flatMap((path) => ["--ro-bind", path, path]),
    ...template.symlinks.flatMap((s) => ["--symlink", s.target, s.link]),
    ...output.mounts.flatMap((mount) => [
      mount.readOnly ? "--ro-bind" : "--bind",
      mount.source,
      mount.target,
    ]),
    ...(output.scratch === null ? [] : ["--tmpfs", output.scratch.target]),
    "--chdir",
    writable === undefined ? "/" : writable.target,
  ];
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** The launch plan for one role of the run `output` describes. */
export function planLinuxLaunch(
  output: LinuxOutput,
  template: LaunchTemplate,
  resolved: ResolvedHosts,
): LinuxLaunchPlan {
  const offenders: LaunchPlanOffender[] = [];
  const report: Report = (group, path, right) =>
    offenders.push({ group, path, right });
  checkTemplate(output, template, report);
  checkNetwork(output, template, resolved, report);
  checkProtections(output, template, report);
  checkExecutables(output, template, report);
  if (output.process.seccompProfile !== null) {
    report("processes", "process.seccompProfile", "seccomp-unsupported");
  }
  if (offenders.length > 0) throw new LaunchPlanError(offenders);

  // bubblewrap makes a private /proc and a /dev of the harmless device nodes;
  // shells read the one and write /dev/null in the other.
  const landlock: LandlockPaths = {
    read: [...template.systemReadOnly, "/proc", "/dev", ...output.landlock.read],
    write: ["/dev", ...output.landlock.write],
    execute: template.executeScope === "files"
      ? [
        ...output.process.executables.map((executable) =>
          template.resolvedExecutables![executable.program]!
        ),
        template.loader!,
      ]
      : [...output.landlock.execute],
  };
  return deepFreeze({
    role: template.role,
    policyDigest: output.policyDigest,
    executeScope: template.executeScope,
    uid: template.uid,
    gid: template.gid,
    bwrap: {
      options: bwrapOptions(output, template),
      inner: [template.helper, "apply-landlock", JSON.stringify(landlock), "--"],
    },
    landlock,
    writableTargets: [...output.landlock.write],
    nftables: nftables(output, template, resolved),
    environment: [
      ...new Set([...output.environment, ...(template.commandEnvironment ?? [])]),
    ],
    maxProcesses: output.process.maxProcesses,
  });
}
