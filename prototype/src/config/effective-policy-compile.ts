/**
 * The platform compilers: a frozen effective policy plus an explicit platform
 * target in, plain data out. `compileKubernetes` describes pod volumes, mounts,
 * a security context and Cilium-shaped egress rules; `compileLinux` describes
 * namespace bind mounts, Landlock path sets, a default-drop firewall and
 * process limits. The Mac target runs `compileLinux` inside its isolated Linux
 * machine. Nothing here writes YAML, starts anything or touches the host, and
 * the output shapes are unverified against real platforms.
 *
 * Every host the output names comes from the policy or the target's service
 * map; this module holds no host of its own. A loopback entry is mapped
 * explicitly, because inside a pod or a network namespace it names that
 * environment's loopback, not the database or model server the policy means.
 *
 * A right the target cannot enforce, or a field the target requires and the
 * policy lacks, refuses: `UnsupportedRightError` lists every offender (group,
 * path, right; never a value) and no partial output is returned. Nothing is
 * dropped silently.
 */

import type {
  EffectivePolicy,
  ExecutableGrant,
  FilesystemRight,
  HostnameAssurance,
  NetworkEntry,
  NetworkProtocol,
} from "./effective-policy.ts";
import { verifyDigest } from "./effective-policy-digest.ts";
import { isAddressLiteral, isLoopbackHost } from "./runtime-policy.ts";

/** What a target can enforce, declared by its launcher. */
export interface PlatformCapabilities {
  readonly filesystemRights: readonly FilesystemRight[];
  readonly protocols: readonly NetworkProtocol[];
  /** `tls` needs a gateway that checks the certificate's host name. */
  readonly hostnameAssurances: readonly HostnameAssurance[];
  /** `resolver`: the target can send DNS to the resolver an entry names. */
  readonly dnsModes: readonly ("none" | "resolver")[];
  readonly executeByDigest: boolean;
  readonly requireExecutableDigest: boolean;
  readonly processLimit: boolean;
  readonly forbidDescendants: boolean;
  readonly syscallProfiles: readonly string[];
  readonly requireSyscallProfile: boolean;
}

/** Where a policy entry (`host:port`) is reached on the target. */
export interface ServiceMapping {
  readonly entry: string;
  readonly host: string;
  readonly port: number;
}

interface CommonTarget {
  readonly capabilities: PlatformCapabilities;
  readonly services: readonly ServiceMapping[];
  /** The directory the policy's mount names are placed under. */
  readonly mountBase: string;
}

export interface KubernetesTarget extends CommonTarget {
  /** The volume claim that backs each filesystem root, by root name. */
  readonly volumes: readonly { readonly root: string; readonly claim: string }[];
}

export type LinuxTarget = CommonTarget;

export type Platform = "kubernetes" | "linux";

export interface UnsupportedRight {
  readonly group: string;
  readonly path: string;
  readonly right: string;
}

/** The target cannot enforce the policy. Carries every offender. */
export class UnsupportedRightError extends Error {
  readonly platform: Platform;
  readonly offenders: readonly UnsupportedRight[];

  constructor(platform: Platform, offenders: readonly UnsupportedRight[]) {
    super(
      `${platform} cannot enforce the effective policy: ${
        offenders.map((o) => `${o.path} (${o.right})`).join(", ")
      }`,
    );
    this.name = "UnsupportedRightError";
    this.platform = platform;
    this.offenders = Object.freeze(offenders.map((o) => Object.freeze(o)));
  }
}

/** One allowed destination, as the policy names it and as the target reaches it. */
export interface CompiledEgress {
  readonly role: NetworkEntry["role"];
  readonly policyEntry: string;
  readonly host: string;
  readonly port: number;
  readonly protocol: NetworkProtocol;
  readonly dns: string;
  readonly hostnameAssurance: HostnameAssurance;
}

export interface CiliumEgressRule {
  readonly toFQDNs?: readonly { readonly matchName: string }[];
  readonly toCIDR?: readonly string[];
  readonly toPorts: readonly {
    readonly ports: readonly {
      readonly port: string;
      readonly protocol: "TCP" | "UDP";
    }[];
  }[];
}

export interface KubernetesOutput {
  readonly platform: "kubernetes";
  readonly policyDigest: string;
  readonly volumes: readonly (
    | {
      readonly name: string;
      readonly persistentVolumeClaim: { readonly claimName: string };
    }
    | { readonly name: string; readonly emptyDir: Record<string, never> }
  )[];
  readonly volumeMounts: readonly {
    readonly name: string;
    readonly mountPath: string;
    readonly readOnly: boolean;
  }[];
  readonly securityContext: {
    readonly runAsNonRoot: true;
    readonly allowPrivilegeEscalation: false;
    readonly readOnlyRootFilesystem: true;
    readonly capabilities: { readonly drop: readonly ["ALL"] };
    readonly seccompProfile:
      | { readonly type: "RuntimeDefault" }
      | { readonly type: "Localhost"; readonly localhostProfile: string };
  };
  readonly egress: readonly CompiledEgress[];
  readonly ciliumEgress: readonly CiliumEgressRule[];
  readonly doltEndpoint: string | null;
  readonly brokerOperations: readonly string[];
  readonly executables: readonly ExecutableGrant[];
  readonly descendants: boolean;
  readonly maxProcesses: number | null;
  readonly environment: readonly string[];
  readonly forbiddenPaths: readonly string[];
  readonly protectedGit: readonly string[];
}

export interface LinuxOutput {
  readonly platform: "linux";
  readonly policyDigest: string;
  readonly mounts: readonly {
    readonly source: string;
    readonly target: string;
    readonly readOnly: boolean;
    readonly exec: boolean;
  }[];
  readonly scratch: { readonly target: string; readonly type: "tmpfs" } | null;
  readonly landlock: {
    readonly read: readonly string[];
    readonly write: readonly string[];
    readonly execute: readonly string[];
  };
  readonly firewall: {
    readonly defaultAction: "drop";
    readonly accept: readonly CompiledEgress[];
  };
  readonly doltEndpoint: string | null;
  readonly brokerOperations: readonly string[];
  readonly process: {
    readonly noNewPrivileges: true;
    readonly executables: readonly ExecutableGrant[];
    readonly descendants: boolean;
    readonly maxProcesses: number | null;
    readonly seccompProfile: string | null;
  };
  readonly environment: readonly string[];
  readonly forbiddenPaths: readonly string[];
  readonly protectedGit: readonly string[];
}

type Report = (group: string, path: string, right: string) => void;

function hostOf(entry: string): string {
  return entry.slice(0, entry.lastIndexOf(":"));
}

function mapping(
  services: readonly ServiceMapping[],
  entry: string,
): ServiceMapping | undefined {
  return services.find((service) => service.entry === entry);
}

/** The offenders every target shares, in policy order. */
function commonOffenders(
  policy: EffectivePolicy,
  target: CommonTarget,
  report: Report,
) {
  const capabilities = target.capabilities;
  if (!verifyDigest(policy)) {
    report("identity", "identity.digest", "digest-mismatch");
  }

  const targets = new Set<string>();
  policy.filesystem.roots.forEach((root, index) => {
    const path = `filesystem.roots[${index}]`;
    for (const right of root.rights) {
      if (!capabilities.filesystemRights.includes(right)) {
        report("filesystem", `${path}.rights`, right);
      }
    }
    if (targets.has(root.target) || root.target === policy.filesystem.scratch) {
      report("filesystem", `${path}.target`, "mount-target-conflict");
    }
    targets.add(root.target);
  });

  policy.network.entries.forEach((entry, index) => {
    const path = `network.entries[${index}]`;
    if (
      isLoopbackHost(entry.host) &&
      mapping(target.services, `${entry.host}:${entry.port}`) === undefined
    ) {
      report("network", path, "loopback-unmapped");
    }
    if (!capabilities.protocols.includes(entry.protocol)) {
      report("network", `${path}.protocol`, entry.protocol);
    }
    if (!capabilities.dnsModes.includes(entry.dns === "none" ? "none" : "resolver")) {
      report("network", `${path}.dns`, "dns-resolver");
    }
    if (!capabilities.hostnameAssurances.includes(entry.hostnameAssurance)) {
      report("network", `${path}.hostnameAssurance`, entry.hostnameAssurance);
    }
  });
  const dolt = policy.network.dolt;
  if (
    dolt !== null && isLoopbackHost(hostOf(dolt)) &&
    mapping(target.services, dolt) === undefined
  ) {
    report("network", "network.dolt", "loopback-unmapped");
  }

  const processes = policy.processes;
  processes.executables.forEach((executable, index) => {
    const path = `processes.executables[${index}].digest`;
    if (executable.digest !== null && !capabilities.executeByDigest) {
      report("processes", path, "execute-by-digest");
    }
    if (executable.digest === null && capabilities.requireExecutableDigest) {
      report("processes", path, "executable-digest-required");
    }
  });
  if (!processes.descendants && !capabilities.forbidDescendants) {
    report("processes", "processes.descendants", "no-descendants");
  }
  if (processes.maxProcesses !== null && !capabilities.processLimit) {
    report("processes", "processes.maxProcesses", "process-limit");
  }
  if (processes.syscallProfile === null) {
    if (capabilities.requireSyscallProfile) {
      report("processes", "processes.syscallProfile", "syscall-profile-required");
    }
  } else if (!capabilities.syscallProfiles.includes(processes.syscallProfile)) {
    report("processes", "processes.syscallProfile", "syscall-profile");
  }
}

function refuseUnlessClean(
  platform: Platform,
  check: (report: Report) => void,
) {
  const offenders: UnsupportedRight[] = [];
  check((group, path, right) => offenders.push({ group, path, right }));
  if (offenders.length > 0) throw new UnsupportedRightError(platform, offenders);
}

function egress(
  policy: EffectivePolicy,
  services: readonly ServiceMapping[],
): CompiledEgress[] {
  return policy.network.entries.map((entry) => {
    const policyEntry = `${entry.host}:${entry.port}`;
    const mapped = mapping(services, policyEntry);
    return {
      role: entry.role,
      policyEntry,
      host: mapped?.host ?? entry.host,
      port: mapped?.port ?? entry.port,
      protocol: entry.protocol,
      dns: entry.dns,
      hostnameAssurance: entry.hostnameAssurance,
    };
  });
}

function doltEndpoint(
  policy: EffectivePolicy,
  services: readonly ServiceMapping[],
): string | null {
  const dolt = policy.network.dolt;
  if (dolt === null) return null;
  const mapped = mapping(services, dolt);
  return mapped === undefined ? dolt : `${mapped.host}:${mapped.port}`;
}

function mountPath(target: CommonTarget, name: string): string {
  return `${target.mountBase}/${name}`;
}

function ciliumRule(entry: CompiledEgress): CiliumEgressRule {
  const toPorts = [{
    ports: [{
      port: String(entry.port),
      protocol: entry.protocol === "udp" ? "UDP" as const : "TCP" as const,
    }],
  }];
  if (!isAddressLiteral(entry.host)) {
    return { toFQDNs: [{ matchName: entry.host }], toPorts };
  }
  const cidr = entry.host.startsWith("[")
    ? `${entry.host.slice(1, -1)}/128`
    : `${entry.host}/32`;
  return { toCIDR: [cidr], toPorts };
}

function copyExecutables(policy: EffectivePolicy): ExecutableGrant[] {
  return policy.processes.executables.map((executable) => ({ ...executable }));
}

/** The pod description for `policy` on the cluster `target` describes. */
export function compileKubernetes(
  policy: EffectivePolicy,
  target: KubernetesTarget,
): KubernetesOutput {
  refuseUnlessClean("kubernetes", (report) => {
    commonOffenders(policy, target, report);
    policy.filesystem.roots.forEach((root, index) => {
      if (!target.volumes.some((volume) => volume.root === root.name)) {
        report("filesystem", `filesystem.roots[${index}]`, "volume-unmapped");
      }
    });
  });

  const roots = policy.filesystem.roots;
  const scratch = policy.filesystem.scratch;
  const net = egress(policy, target.services);
  const profile = policy.processes.syscallProfile;
  return {
    platform: "kubernetes",
    policyDigest: policy.identity.digest,
    volumes: [
      ...roots.map((root) => ({
        name: root.target,
        persistentVolumeClaim: {
          claimName: target.volumes.find((v) => v.root === root.name)!.claim,
        },
      })),
      ...(scratch === null ? [] : [{ name: scratch, emptyDir: {} }]),
    ],
    volumeMounts: [
      ...roots.map((root) => ({
        name: root.target,
        mountPath: mountPath(target, root.target),
        readOnly: !root.rights.includes("write"),
      })),
      ...(scratch === null ? [] : [{
        name: scratch,
        mountPath: mountPath(target, scratch),
        readOnly: false,
      }]),
    ],
    securityContext: {
      runAsNonRoot: true,
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ["ALL"] },
      seccompProfile: profile === null
        ? { type: "RuntimeDefault" }
        : { type: "Localhost", localhostProfile: profile },
    },
    egress: net,
    ciliumEgress: net.map(ciliumRule),
    doltEndpoint: doltEndpoint(policy, target.services),
    brokerOperations: [...policy.network.brokerOperations],
    executables: copyExecutables(policy),
    descendants: policy.processes.descendants,
    maxProcesses: policy.processes.maxProcesses,
    environment: [...policy.processes.environment],
    forbiddenPaths: [...policy.filesystem.forbiddenPaths],
    protectedGit: [...policy.filesystem.protectedGit],
  };
}

/** The namespace description for `policy` on the Linux `target` describes. */
export function compileLinux(
  policy: EffectivePolicy,
  target: LinuxTarget,
): LinuxOutput {
  refuseUnlessClean("linux", (report) => commonOffenders(policy, target, report));

  const roots = policy.filesystem.roots;
  const scratch = policy.filesystem.scratch === null
    ? null
    : mountPath(target, policy.filesystem.scratch);
  const withRight = (right: FilesystemRight) =>
    roots.filter((root) => root.rights.includes(right)).map((root) =>
      mountPath(target, root.target)
    );
  const scratchPaths = scratch === null ? [] : [scratch];
  return {
    platform: "linux",
    policyDigest: policy.identity.digest,
    mounts: roots.map((root) => ({
      source: root.source,
      target: mountPath(target, root.target),
      readOnly: !root.rights.includes("write"),
      exec: root.rights.includes("execute"),
    })),
    scratch: scratch === null ? null : { target: scratch, type: "tmpfs" },
    landlock: {
      read: [...withRight("read"), ...scratchPaths],
      write: [...withRight("write"), ...scratchPaths],
      execute: withRight("execute"),
    },
    firewall: { defaultAction: "drop", accept: egress(policy, target.services) },
    doltEndpoint: doltEndpoint(policy, target.services),
    brokerOperations: [...policy.network.brokerOperations],
    process: {
      noNewPrivileges: true,
      executables: copyExecutables(policy),
      descendants: policy.processes.descendants,
      maxProcesses: policy.processes.maxProcesses,
      seccompProfile: policy.processes.syscallProfile,
    },
    environment: [...policy.processes.environment],
    forbiddenPaths: [...policy.filesystem.forbiddenPaths],
    protectedGit: [...policy.filesystem.protectedGit],
  };
}
