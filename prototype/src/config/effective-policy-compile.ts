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
 * The compilers cover the filesystem, network and process groups. Identity,
 * secrets and effects (tools, approval posture, paid routing, limits) are not
 * compiled: the output carries only the policy digest, which binds them, for a
 * launcher integration that does not exist yet. Nothing enforces those groups
 * from this output.
 *
 * Refusal covers the conditions `commonOffenders` and each compiler check, and
 * no others: a filesystem right, protocol, DNS mode, hostname assurance,
 * executable digest, process limit, descendant ban or syscall profile the
 * target does not declare; an unmapped loopback host or resolver; a host not
 * spelled canonically; an invalid service mapping; a mount name that is not
 * one plain segment, or two mounts on one name; a digest that does not
 * verify; and, on the cluster, a root no volume holds. `UnsupportedRightError`
 * lists every offender found (group, path, right; never a value) and no
 * partial output is returned.
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
import {
  isAddressLiteral,
  isCanonicalHost,
  isLoopbackHost,
} from "./runtime-policy.ts";

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
  /**
   * The volume claims and the host directory each one holds. A root is
   * mounted from the claim whose source contains it, at the sub-path between
   * the two.
   */
  readonly volumes: readonly {
    readonly source: string;
    readonly claim: string;
  }[];
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

/**
 * The mount roots granted each filesystem right; everything beneath a listed
 * root inherits it. A mount not listed for a right is denied it, so a
 * writable workspace without `execute` gets no direct execute permission,
 * which a mount's read-only flag alone cannot say. An allowed interpreter can
 * still read and run a script from it.
 */
export interface LandlockPaths {
  readonly read: readonly string[];
  readonly write: readonly string[];
  readonly execute: readonly string[];
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
    readonly subPath?: string;
    readonly readOnly: boolean;
  }[];
  /** Path sets for the Landlock floor the launcher installs in the pod. */
  readonly landlock: LandlockPaths;
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
  readonly landlock: LandlockPaths;
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

/** Scratch is private storage the runtime both reads and writes. */
const SCRATCH_RIGHTS: readonly FilesystemRight[] = ["read", "write"];

/** Refuse a service mapping the target could not reach. */
function checkService(service: ServiceMapping, path: string, report: Report) {
  const group = path.split(".")[0]!;
  if (!isCanonicalHost(service.host)) {
    report(group, path, "service-host-invalid");
  }
  if (!isPort(service.port)) report(group, path, "service-port-invalid");
}

function isPort(port: number): boolean {
  return Number.isSafeInteger(port) && port >= 1 && port <= 65535;
}

function portOf(entry: string): number {
  const text = entry.slice(entry.lastIndexOf(":") + 1);
  return /^[0-9]{1,5}$/.test(text) ? Number(text) : NaN;
}

/** A mount name: one path segment, never `.` or `..`. */
const MOUNT_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/** The `host:port` of the resolver an entry's DNS behaviour names, or null. */
function resolverEntry(dns: string): string | null {
  return dns.startsWith("resolver:") ? dns.slice("resolver:".length) : null;
}

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
  if (segments(target.mountBase) === null) {
    report("target", "target.mountBase", "mount-base-invalid");
  }
  // The service map is the target author's explicit table: two rows for one
  // entry would leave the destination to input order, so both are refused.
  const entries = new Set<string>();
  target.services.forEach((service, index) => {
    if (entries.has(service.entry)) {
      report("target", `target.services[${index}]`, "service-duplicate");
    }
    entries.add(service.entry);
  });

  const targets = new Set<string>();
  policy.filesystem.roots.forEach((root, index) => {
    const path = `filesystem.roots[${index}]`;
    for (const right of root.rights) {
      if (!capabilities.filesystemRights.includes(right)) {
        report("filesystem", `${path}.rights`, right);
      }
    }
    if (segments(root.source) === null) {
      report("filesystem", `${path}.source`, "source-not-canonical");
    }
    if (!MOUNT_NAME.test(root.target)) {
      report("filesystem", `${path}.target`, "mount-target-invalid");
    } else if (
      targets.has(root.target) || root.target === policy.filesystem.scratch
    ) {
      report("filesystem", `${path}.target`, "mount-target-conflict");
    }
    targets.add(root.target);
  });
  const scratch = policy.filesystem.scratch;
  if (scratch !== null) {
    if (!MOUNT_NAME.test(scratch)) {
      report("filesystem", "filesystem.scratch", "mount-target-invalid");
    }
    for (const right of SCRATCH_RIGHTS) {
      if (!capabilities.filesystemRights.includes(right)) {
        report("filesystem", "filesystem.scratch", right);
      }
    }
  }

  policy.network.entries.forEach((entry, index) => {
    const path = `network.entries[${index}]`;
    const mapped = mapping(target.services, `${entry.host}:${entry.port}`);
    if (!isCanonicalHost(entry.host)) {
      report("network", `${path}.host`, "host-invalid");
    } else if (isLoopbackHost(entry.host) && mapped === undefined) {
      report("network", path, "loopback-unmapped");
    }
    if (mapped !== undefined) checkService(mapped, path, report);
    const resolver = resolverEntry(entry.dns);
    if (resolver !== null) {
      const resolverMapped = mapping(target.services, resolver);
      if (!isCanonicalHost(hostOf(resolver)) || !isPort(portOf(resolver))) {
        report("network", `${path}.dns`, "host-invalid");
      } else if (
        isLoopbackHost(hostOf(resolver)) && resolverMapped === undefined
      ) {
        report("network", `${path}.dns`, "loopback-unmapped");
      }
      if (resolverMapped !== undefined) {
        checkService(resolverMapped, `${path}.dns`, report);
      }
      const granted = policy.network.entries.some((other) =>
        other.role === "dns" && other.protocol === "udp" &&
        `${other.host}:${other.port}` === resolver
      );
      if (!granted) report("network", `${path}.dns`, "resolver-not-granted");
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
  if (dolt !== null) {
    const doltMapped = mapping(target.services, dolt);
    if (!isCanonicalHost(hostOf(dolt)) || !isPort(portOf(dolt))) {
      report("network", "network.dolt", "host-invalid");
    } else if (isLoopbackHost(hostOf(dolt)) && doltMapped === undefined) {
      report("network", "network.dolt", "loopback-unmapped");
    }
    if (doltMapped !== undefined) {
      checkService(doltMapped, "network.dolt", report);
    }
    const granted = policy.network.entries.some((entry) =>
      entry.role === "dolt" && entry.protocol === "tcp" &&
      `${entry.host}:${entry.port}` === dolt
    );
    const valid = isCanonicalHost(hostOf(dolt)) && isPort(portOf(dolt));
    if (valid && !granted) {
      report("network", "network.dolt", "dolt-not-granted");
    }
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
    const resolver = resolverEntry(entry.dns);
    const resolverMapped = resolver === null
      ? undefined
      : mapping(services, resolver);
    return {
      role: entry.role,
      policyEntry,
      host: mapped?.host ?? entry.host,
      port: mapped?.port ?? entry.port,
      protocol: entry.protocol,
      dns: resolverMapped === undefined
        ? entry.dns
        : `resolver:${resolverMapped.host}:${resolverMapped.port}`,
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
  return target.mountBase === "/" ? `/${name}` : `${target.mountBase}/${name}`;
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

const CONTROL = /[\u0000-\u001f\u007f]/;

/** The segments of a canonical absolute path, or null. */
function segments(path: string): string[] | null {
  if (!path.startsWith("/")) return null;
  if (path === "/") return [];
  const parts = path.slice(1).split("/");
  return parts.every((part) =>
      part !== "" && part !== "." && part !== ".." && !CONTROL.test(part)
    )
    ? parts
    : null;
}

/**
 * The claim whose source holds `source`, the longest such source winning, and
 * the sub-path from it; null when no claim holds it or a path is not
 * canonical.
 */
function volumeFor(
  target: KubernetesTarget,
  source: string,
): { claim: string; subPath: string } | null {
  const inner = segments(source);
  if (inner === null) return null;
  let best: { claim: string; depth: number } | null = null;
  for (const volume of target.volumes) {
    const outer = segments(volume.source);
    if (
      outer !== null && outer.length <= inner.length &&
      outer.every((part, index) => inner[index] === part) &&
      (best === null || outer.length > best.depth)
    ) {
      best = { claim: volume.claim, depth: outer.length };
    }
  }
  return best === null
    ? null
    : { claim: best.claim, subPath: inner.slice(best.depth).join("/") };
}

function landlockPaths(
  policy: EffectivePolicy,
  target: CommonTarget,
): LandlockPaths {
  const roots = policy.filesystem.roots;
  const withRight = (right: FilesystemRight) =>
    roots.filter((root) => root.rights.includes(right)).map((root) =>
      mountPath(target, root.target)
    );
  const scratch = policy.filesystem.scratch === null
    ? []
    : [mountPath(target, policy.filesystem.scratch)];
  return {
    read: [...withRight("read"), ...scratch],
    write: [...withRight("write"), ...scratch],
    execute: withRight("execute"),
  };
}

function copyExecutables(policy: EffectivePolicy): ExecutableGrant[] {
  return policy.processes.executables.map((executable) => ({ ...executable }));
}

/** A Kubernetes volume name: a DNS-1123 label. Mount names become these. */
const VOLUME_NAME = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;

/** The pod description for `policy` on the cluster `target` describes. */
export function compileKubernetes(
  policy: EffectivePolicy,
  target: KubernetesTarget,
): KubernetesOutput {
  refuseUnlessClean("kubernetes", (report) => {
    commonOffenders(policy, target, report);
    policy.filesystem.roots.forEach((root, index) => {
      if (MOUNT_NAME.test(root.target) && !VOLUME_NAME.test(root.target)) {
        report(
          "filesystem",
          `filesystem.roots[${index}].target`,
          "volume-name-invalid",
        );
      }
    });
    const scratch = policy.filesystem.scratch;
    if (
      scratch !== null && MOUNT_NAME.test(scratch) && !VOLUME_NAME.test(scratch)
    ) {
      report("filesystem", "filesystem.scratch", "volume-name-invalid");
    }
    policy.filesystem.roots.forEach((root, index) => {
      if (volumeFor(target, root.source) === null) {
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
          claimName: volumeFor(target, root.source)!.claim,
        },
      })),
      ...(scratch === null ? [] : [{ name: scratch, emptyDir: {} }]),
    ],
    volumeMounts: [
      ...roots.map((root) => {
        const subPath = volumeFor(target, root.source)!.subPath;
        return {
          name: root.target,
          mountPath: mountPath(target, root.target),
          ...(subPath === "" ? {} : { subPath }),
          readOnly: !root.rights.includes("write"),
        };
      }),
      ...(scratch === null ? [] : [{
        name: scratch,
        mountPath: mountPath(target, scratch),
        readOnly: false,
      }]),
    ],
    landlock: landlockPaths(policy, target),
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
    landlock: landlockPaths(policy, target),
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
