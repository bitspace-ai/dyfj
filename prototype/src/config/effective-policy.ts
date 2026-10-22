/**
 * The effective policy: one versioned, deeply frozen description of what a
 * runtime may do, in six groups: identity, filesystem, network, processes,
 * secrets and effects (tools, approval posture, paid routing and limits).
 *
 * It is built from the same composition as `composeRuntimePolicy`, never from
 * a second list: `composeEffectivePolicy` calls `composeRuntimeGrants`, then
 * describes each entry it produced from the entry's recorded provenance. `projectRuntimePolicy` goes back to the `{net, run, env, dolt}`
 * the egress, spawn and env seams read, so a test can prove the two agree.
 * Nothing here is enforced yet and no runtime behaviour reads this policy.
 *
 * A static entry's role is the one its row declares in the tagged tables of
 * `runtime-policy.ts`; an operator entry's role follows from its source.
 * Protocol, DNS behaviour and hostname assurance follow from the role and the
 * entry's own shape. Anything the composition does not know (filesystem
 * roots, tools, process limits, executable digests, syscall profile) is absent
 * or `null` ("not requested"); a platform that requires it refuses.
 *
 * `null` in a limit means unbounded. Spend is integer micro-USD.
 */

import {
  canonicalPolicyJson,
  policyDigest,
} from "./effective-policy-digest.ts";
import { BUDGET_DEFAULTS, AGENT_DEFAULTS } from "./defaults.ts";
import {
  type ComposedGrant,
  composeRuntimeGrants,
  isAddressLiteral,
  isLoopbackHost,
  type NetGrantSource,
  type RunGrantSource,
  type RuntimePolicy,
  type RuntimePolicyInputs,
} from "./runtime-policy.ts";
import {
  CONFIG_SCHEMA,
  type PermissionLevel,
  PERMISSION_LEVELS,
} from "./schema.ts";

/** The version of the effective policy format. A digest covers it. */
export const EFFECTIVE_POLICY_VERSION = 1;

export type FilesystemRight = "read" | "write" | "execute";
export type NetworkProtocol = "tcp" | "udp";
export type HostnameAssurance = "tls" | "none";

export const FILESYSTEM_RIGHTS: readonly FilesystemRight[] = [
  "read",
  "write",
  "execute",
];
export const NETWORK_PROTOCOLS: readonly NetworkProtocol[] = ["tcp", "udp"];
export const HOSTNAME_ASSURANCES: readonly HostnameAssurance[] = [
  "tls",
  "none",
];

/** Why a network entry is in the policy. */
export type NetworkRole =
  | "provider"
  | "local-model"
  | "dolt"
  | "dns"
  | "memory"
  | "mcp"
  | "operator";
export const NETWORK_ROLES: readonly NetworkRole[] = [
  "provider",
  "local-model",
  "dolt",
  "dns",
  "memory",
  "mcp",
  "operator",
];

/** What a started program is for. */
export type ExecutionRole = "tool" | "runner" | "resolver";
export const EXECUTION_ROLES: readonly ExecutionRole[] = [
  "tool",
  "runner",
  "resolver",
];

export interface IdentityGroup {
  readonly principal: string;
  readonly job: string;
  readonly run: string;
  readonly repositories: readonly string[];
  /** An input, an ISO 8601 UTC instant (`Z`). Never read from a clock. */
  readonly expiresAt: string;
  /** `sha256:<hex>` of the rest of the policy (`effective-policy-digest.ts`). */
  readonly digest: string;
}

export interface FilesystemRoot {
  readonly name: string;
  /** The canonical absolute path on the host. */
  readonly source: string;
  /** The mount name inside the runtime. */
  readonly target: string;
  readonly rights: readonly FilesystemRight[];
}

export interface FilesystemGroup {
  readonly roots: readonly FilesystemRoot[];
  /** The private scratch mount name, or null for none. */
  readonly scratch: string | null;
  readonly forbiddenPaths: readonly string[];
  readonly protectedGit: readonly string[];
}

export interface NetworkEntry {
  readonly role: NetworkRole;
  /** A host name or address; an IPv6 literal keeps its brackets. */
  readonly host: string;
  readonly port: number;
  readonly protocol: NetworkProtocol;
  /** `none`, or `resolver:<host>:<port>` (the resolver that answers). */
  readonly dns: string;
  /**
   * `tls` when the host is named and reached over https, so the connection's
   * certificate verifies the name: a hosted provider, or an MCP or memory
   * endpoint whose configured URL is https. Otherwise `none`.
   */
  readonly hostnameAssurance: HostnameAssurance;
}

export interface NetworkGroup {
  readonly entries: readonly NetworkEntry[];
  readonly brokerOperations: readonly string[];
  /** The one database endpoint as `host:port`, or null when none. */
  readonly dolt: string | null;
}

export interface ExecutableGrant {
  /** An absolute path, or a bare name resolved on `PATH`. */
  readonly program: string;
  readonly role: ExecutionRole;
  /** `sha256:<hex>` of the executable, or null when not requested. */
  readonly digest: string | null;
}

export interface ProcessGroup {
  readonly executables: readonly ExecutableGrant[];
  readonly descendants: boolean;
  /** Null: not requested. */
  readonly maxProcesses: number | null;
  /** Null: not requested. */
  readonly syscallProfile: string | null;
  /** The environment names the runtime may see. */
  readonly environment: readonly string[];
}

export interface CredentialRef {
  /** An environment name. Never a value, never a wildcard. */
  readonly name: string;
  readonly owner: string;
}

export interface SpendLimits {
  readonly session: number | null;
  readonly perCall: number | null;
  readonly daily: number | null;
}

export interface EffectLimits {
  readonly timeMs: number | null;
  readonly steps: number | null;
  readonly outputBytes: number | null;
  readonly spendMicroUsd: SpendLimits;
}

export interface EffectsGroup {
  readonly tools: readonly string[];
  readonly externalMutations: readonly string[];
  readonly approvalPosture: PermissionLevel;
  readonly paidRouting: boolean;
  readonly limits: EffectLimits;
}

export interface EffectivePolicy {
  readonly version: 1;
  readonly identity: IdentityGroup;
  readonly filesystem: FilesystemGroup;
  readonly network: NetworkGroup;
  readonly processes: ProcessGroup;
  readonly secrets: readonly CredentialRef[];
  readonly effects: EffectsGroup;
}

// ── Parsing ───────────────────────────────────────────────────────────────────

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

type Record_ = Record<string, unknown>;

/** `value` as an object with exactly `keys`: no unknown key, none missing. */
function exact(value: unknown, path: string, keys: readonly string[]): Record_ {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`effective policy: ${path} must be an object`);
  }
  const record = value as Record_;
  for (const key of Object.keys(record)) {
    if (!keys.includes(key)) {
      throw new Error(`effective policy: unknown key "${key}" in ${path}`);
    }
  }
  for (const key of keys) {
    if (!(key in record) || record[key] === undefined) {
      throw new Error(`effective policy: ${path} is missing "${key}"`);
    }
  }
  return record;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value === "") {
    throw new Error(`effective policy: ${path} must be a non-empty string`);
  }
  return value;
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`effective policy: ${path} must be a boolean`);
  }
  return value;
}

function count(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `effective policy: ${path} must be a non-negative integer`,
    );
  }
  return value;
}

function limit(value: unknown, path: string): number | null {
  return value === null ? null : count(value, path);
}

function oneOf<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new Error(
      `effective policy: ${path} must be one of ${allowed.join(", ")}`,
    );
  }
  return value as T;
}

function list<T>(
  value: unknown,
  path: string,
  each: (element: unknown, path: string) => T,
): T[] {
  if (!Array.isArray(value)) {
    throw new Error(`effective policy: ${path} must be an array`);
  }
  const parsed: T[] = [];
  for (let index = 0; index < value.length; index++) {
    if (!(index in value)) {
      throw new Error(`effective policy: ${path}[${index}] is missing`);
    }
    parsed.push(each(value[index], `${path}[${index}]`));
  }
  // Every list is a set: the digest sorts it, so a duplicate would make two
  // policies that grant the same thing hash differently.
  const seen = new Set<string>();
  parsed.forEach((element, index) => {
    const key = canonicalPolicyJson(element);
    if (seen.has(key)) {
      throw new Error(`effective policy: ${path}[${index}] is a duplicate`);
    }
    seen.add(key);
  });
  return parsed;
}

const CREDENTIAL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const EXECUTABLE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const DNS_BEHAVIOUR = /^(?:none|resolver:\S+:[0-9]{1,5})$/;

const UTC_INSTANT =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,3})?Z$/;

function instant(value: unknown, path: string): string {
  const stamp = text(value, path);
  const parsed = Date.parse(stamp);
  // `Date.parse` rolls an impossible date (February 30) into the next month;
  // printing it back catches that.
  if (
    !UTC_INSTANT.test(stamp) || Number.isNaN(parsed) ||
    new Date(parsed).toISOString().slice(0, 19) !== stamp.slice(0, 19)
  ) {
    throw new Error(
      `effective policy: ${path} must be an ISO 8601 UTC instant`,
    );
  }
  return stamp;
}

function credentialName(value: unknown, path: string): string {
  const name = text(value, path);
  if (!CREDENTIAL_NAME.test(name)) {
    throw new Error(
      `effective policy: ${path} must be a literal secret name, not a wildcard or pattern`,
    );
  }
  return name;
}

function digestOrNull(value: unknown, path: string): string | null {
  if (value === null) return null;
  const digest = text(value, path);
  if (!EXECUTABLE_DIGEST.test(digest)) {
    throw new Error(`effective policy: ${path} must be sha256:<64 hex>`);
  }
  return digest;
}

function parseIdentity(value: unknown): IdentityGroup {
  const fields = exact(value, "identity", [
    "principal",
    "job",
    "run",
    "repositories",
    "expiresAt",
    "digest",
  ]);
  return {
    principal: text(fields["principal"], "identity.principal"),
    job: text(fields["job"], "identity.job"),
    run: text(fields["run"], "identity.run"),
    repositories: list(fields["repositories"], "identity.repositories", text),
    expiresAt: instant(fields["expiresAt"], "identity.expiresAt"),
    digest: text(fields["digest"], "identity.digest"),
  };
}

function parseRoot(root: unknown, path: string): FilesystemRoot {
  const fields = exact(root, path, ["name", "source", "target", "rights"]);
  return {
    name: text(fields["name"], `${path}.name`),
    source: text(fields["source"], `${path}.source`),
    target: text(fields["target"], `${path}.target`),
    rights: list(fields["rights"], `${path}.rights`, (right, rightPath) =>
      oneOf(right, rightPath, FILESYSTEM_RIGHTS)),
  };
}

function parseFilesystem(value: unknown): FilesystemGroup {
  const fields = exact(value, "filesystem", [
    "roots",
    "scratch",
    "forbiddenPaths",
    "protectedGit",
  ]);
  return {
    roots: list(fields["roots"], "filesystem.roots", parseRoot),
    scratch: fields["scratch"] === null
      ? null
      : text(fields["scratch"], "filesystem.scratch"),
    forbiddenPaths: list(
      fields["forbiddenPaths"],
      "filesystem.forbiddenPaths",
      text,
    ),
    protectedGit: list(fields["protectedGit"], "filesystem.protectedGit", text),
  };
}

function parseEntry(entry: unknown, path: string): NetworkEntry {
  const fields = exact(entry, path, [
    "role",
    "host",
    "port",
    "protocol",
    "dns",
    "hostnameAssurance",
  ]);
  const port = count(fields["port"], `${path}.port`);
  if (port < 1 || port > 65535) {
    throw new Error(`effective policy: ${path}.port must be 1 to 65535`);
  }
  const dns = text(fields["dns"], `${path}.dns`);
  if (!DNS_BEHAVIOUR.test(dns)) {
    throw new Error(
      `effective policy: ${path}.dns must be "none" or "resolver:<host>:<port>"`,
    );
  }
  return {
    role: oneOf(fields["role"], `${path}.role`, NETWORK_ROLES),
    host: text(fields["host"], `${path}.host`),
    port,
    protocol: oneOf(fields["protocol"], `${path}.protocol`, NETWORK_PROTOCOLS),
    dns,
    hostnameAssurance: oneOf(
      fields["hostnameAssurance"],
      `${path}.hostnameAssurance`,
      HOSTNAME_ASSURANCES,
    ),
  };
}

function parseNetwork(value: unknown): NetworkGroup {
  const fields = exact(value, "network", [
    "entries",
    "brokerOperations",
    "dolt",
  ]);
  return {
    entries: list(fields["entries"], "network.entries", parseEntry),
    brokerOperations: list(
      fields["brokerOperations"],
      "network.brokerOperations",
      text,
    ),
    dolt: fields["dolt"] === null ? null : text(fields["dolt"], "network.dolt"),
  };
}

function parseExecutable(executable: unknown, path: string): ExecutableGrant {
  const fields = exact(executable, path, ["program", "role", "digest"]);
  return {
    program: text(fields["program"], `${path}.program`),
    role: oneOf(fields["role"], `${path}.role`, EXECUTION_ROLES),
    digest: digestOrNull(fields["digest"], `${path}.digest`),
  };
}

function parseProcesses(value: unknown): ProcessGroup {
  const fields = exact(value, "processes", [
    "executables",
    "descendants",
    "maxProcesses",
    "syscallProfile",
    "environment",
  ]);
  return {
    executables: list(
      fields["executables"],
      "processes.executables",
      parseExecutable,
    ),
    descendants: bool(fields["descendants"], "processes.descendants"),
    maxProcesses: limit(fields["maxProcesses"], "processes.maxProcesses"),
    syscallProfile: fields["syscallProfile"] === null
      ? null
      : text(fields["syscallProfile"], "processes.syscallProfile"),
    environment: list(fields["environment"], "processes.environment", text),
  };
}

function parseCredentialRef(credential: unknown, path: string): CredentialRef {
  const fields = exact(credential, path, ["name", "owner"]);
  return {
    name: credentialName(fields["name"], `${path}.name`),
    owner: text(fields["owner"], `${path}.owner`),
  };
}

function parseEffects(value: unknown): EffectsGroup {
  const fields = exact(value, "effects", [
    "tools",
    "externalMutations",
    "approvalPosture",
    "paidRouting",
    "limits",
  ]);
  const limits = exact(fields["limits"], "effects.limits", [
    "timeMs",
    "steps",
    "outputBytes",
    "spendMicroUsd",
  ]);
  const spend = exact(limits["spendMicroUsd"], "effects.limits.spendMicroUsd", [
    "session",
    "perCall",
    "daily",
  ]);
  return {
    tools: list(fields["tools"], "effects.tools", text),
    externalMutations: list(
      fields["externalMutations"],
      "effects.externalMutations",
      text,
    ),
    approvalPosture: oneOf(
      fields["approvalPosture"],
      "effects.approvalPosture",
      PERMISSION_LEVELS,
    ),
    paidRouting: bool(fields["paidRouting"], "effects.paidRouting"),
    limits: {
      timeMs: limit(limits["timeMs"], "effects.limits.timeMs"),
      steps: limit(limits["steps"], "effects.limits.steps"),
      outputBytes: limit(limits["outputBytes"], "effects.limits.outputBytes"),
      spendMicroUsd: {
        session: limit(spend["session"], "effects.limits.spendMicroUsd.session"),
        perCall: limit(spend["perCall"], "effects.limits.spendMicroUsd.perCall"),
        daily: limit(spend["daily"], "effects.limits.spendMicroUsd.daily"),
      },
    },
  };
}

/**
 * Validate plain data as an effective policy and return a frozen copy. An
 * unknown key anywhere, a missing group or field, a value of the wrong type
 * and any version but 1 are refused. The digest is not verified here: call
 * `verifyDigest` for that.
 */
export function parseEffectivePolicy(input: unknown): EffectivePolicy {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("effective policy: must be an object");
  }
  if ((input as Record_)["version"] !== EFFECTIVE_POLICY_VERSION) {
    throw new Error(
      `effective policy: unsupported version (only ${EFFECTIVE_POLICY_VERSION} is known)`,
    );
  }
  const top = exact(input, "policy", [
    "version",
    "identity",
    "filesystem",
    "network",
    "processes",
    "secrets",
    "effects",
  ]);
  return deepFreeze({
    version: EFFECTIVE_POLICY_VERSION,
    identity: parseIdentity(top["identity"]),
    filesystem: parseFilesystem(top["filesystem"]),
    network: parseNetwork(top["network"]),
    processes: parseProcesses(top["processes"]),
    secrets: list(top["secrets"], "secrets", parseCredentialRef),
    effects: parseEffects(top["effects"]),
  });
}

// ── Composition ───────────────────────────────────────────────────────────────

/** The job's identity: who runs what, for how long. */
export interface EffectivePolicyIdentityInput {
  readonly principal: string;
  readonly job: string;
  readonly run: string;
  readonly repositories: readonly string[];
  /** ISO 8601 UTC. An input; no clock is read. */
  readonly expiresAt: string;
}

/**
 * The job input that the code seams do not know. Only identity is required.
 * Without the rest, the policy is today's composition with nothing added:
 * no filesystem roots, no tools, the declared budget and step defaults.
 */
export interface EffectivePolicyEnvelope {
  readonly identity: EffectivePolicyIdentityInput;
  readonly filesystem?: Partial<FilesystemGroup>;
  readonly effects?: {
    readonly tools?: readonly string[];
    readonly externalMutations?: readonly string[];
    readonly approvalPosture?: PermissionLevel;
    readonly paidRouting?: boolean;
    readonly limits?: Partial<Omit<EffectLimits, "spendMicroUsd">> & {
      readonly spendMicroUsd?: Partial<SpendLimits>;
    };
  };
}

function microUsd(usd: number): number {
  return Math.round(usd * 1_000_000);
}

function splitHostPort(entry: string): { host: string; port: number } {
  const colon = entry.lastIndexOf(":");
  return { host: entry.slice(0, colon), port: Number(entry.slice(colon + 1)) };
}

/** A host that needs a DNS answer to reach: not an address, not loopback. */
function needsDns(host: string): boolean {
  return !(isAddressLiteral(host) || isLoopbackHost(host));
}

function byBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * The source that names an entry's role when several added it, highest
 * first: the most specific. Only sources that need the same transport can
 * share an entry; `networkEntries` refuses the rest.
 */
const NET_SOURCE_PRECEDENCE: readonly NetGrantSource["kind"][] = [
  "static",
  "dolt-endpoint",
  "nameserver",
  "memory-mcp",
  "mcp-server",
  "network-allow",
];

function primary<Source extends { readonly kind: string }>(
  sources: readonly Source[],
  precedence: readonly Source["kind"][],
): Source {
  for (const kind of precedence) {
    const found = sources.find((source) => source.kind === kind);
    if (found !== undefined) return found;
  }
  return sources[0]!;
}

function networkRole(sources: readonly NetGrantSource[]): NetworkRole {
  const source = primary(sources, NET_SOURCE_PRECEDENCE);
  switch (source.kind) {
    case "static":
      return source.role;
    case "memory-mcp":
      return "memory";
    case "mcp-server":
      return "mcp";
    case "network-allow":
      return "operator";
    case "nameserver":
      return "dns";
    case "dolt-endpoint":
      return "dolt";
  }
}

/**
 * The source reaches its host over https, so the certificate verifies the host
 * name: the hosted providers, and an MCP or memory endpoint configured with an
 * https URL. A `[network] allow` entry names no scheme and claims none.
 */
function carriesTls(source: NetGrantSource): boolean {
  switch (source.kind) {
    case "static":
      return source.role === "provider";
    case "memory-mcp":
    case "mcp-server":
      return source.tls;
    default:
      return false;
  }
}

function networkEntries(
  net: readonly ComposedGrant<NetGrantSource>[],
): NetworkEntry[] {
  // One resolver names the DNS behaviour; the smallest, so that the order a
  // composition lists nameservers in never changes the policy. Every
  // nameserver is its own `dns` entry.
  const resolver = net
    .filter((grant) => networkRole(grant.sources) === "dns")
    .map((grant) => grant.entry)
    .sort(byBytes)[0];

  return net.map(({ entry, sources }): NetworkEntry => {
    const { host, port } = splitHostPort(entry);
    const role = networkRole(sources);
    // One entry has one protocol. A nameserver (UDP) that another source
    // also grants over TCP cannot be described without losing one of them,
    // so the composition is refused rather than narrowed or widened.
    const protocols = new Set(
      sources.map((source) => source.kind === "nameserver" ? "udp" : "tcp"),
    );
    if (protocols.size > 1) {
      throw new Error(
        `effective policy: ${entry} is granted as a nameserver and over TCP; ` +
          "one entry cannot carry both",
      );
    }
    const dns = role !== "dns" && needsDns(host) && resolver !== undefined
      ? `resolver:${resolver}`
      : "none";
    return {
      role,
      host,
      port,
      protocol: role === "dns" ? "udp" : "tcp",
      dns,
      hostnameAssurance: needsDns(host) && sources.some(carriesTls)
        ? "tls"
        : "none",
    };
  });
}

const RUN_SOURCE_PRECEDENCE: readonly RunGrantSource["kind"][] = [
  "static",
  "secrets-resolver",
  "runtime-executable",
  "node-path",
];

function executionRole(sources: readonly RunGrantSource[]): ExecutionRole {
  const source = primary(sources, RUN_SOURCE_PRECEDENCE);
  switch (source.kind) {
    case "static":
      return source.role;
    case "secrets-resolver":
      return "resolver";
    case "runtime-executable":
    case "node-path":
      return "runner";
  }
}

function executables(
  run: readonly ComposedGrant<RunGrantSource>[],
): ExecutableGrant[] {
  return run.map(({ entry, sources }): ExecutableGrant => ({
    program: entry,
    role: executionRole(sources),
    digest: null,
  }));
}

/** The owner of a declared secret pointer, from its logical config key. */
function credentialOwner(key: string): string {
  if (key.startsWith("dolt")) return "dolt";
  if (key.startsWith("memoryMcp")) return "memory";
  return "provider";
}

function credentialRefs(inputs: RuntimePolicyInputs): CredentialRef[] {
  const references = new Map<string, CredentialRef>();
  for (const spec of CONFIG_SCHEMA) {
    if (spec.domain === "engine" && spec.kind === "secret-pointer") {
      references.set(spec.envVar, {
        name: spec.envVar,
        owner: credentialOwner(spec.key),
      });
    }
  }
  for (const name of inputs.secrets?.inheritEnv ?? []) {
    if (!references.has(name)) references.set(name, { name, owner: "resolver" });
  }
  return [...references.values()];
}

/**
 * The effective policy for `inputs` (the same inputs `composeRuntimePolicy`
 * takes) and the job's `envelope`. The result is validated and deeply frozen,
 * and carries its digest. The inputs and the envelope are copied, never kept.
 */
export function composeEffectivePolicy(
  inputs: RuntimePolicyInputs,
  envelope: EffectivePolicyEnvelope,
): EffectivePolicy {
  const runtime = composeRuntimeGrants(inputs);
  const job = envelope.effects;
  const spend = job?.limits?.spendMicroUsd;
  const candidate = {
    version: EFFECTIVE_POLICY_VERSION,
    identity: {
      principal: envelope.identity.principal,
      job: envelope.identity.job,
      run: envelope.identity.run,
      repositories: [...envelope.identity.repositories],
      expiresAt: envelope.identity.expiresAt,
      digest: "",
    },
    filesystem: {
      roots: (envelope.filesystem?.roots ?? []).map((root) => ({
        ...root,
        rights: [...root.rights],
      })),
      scratch: envelope.filesystem?.scratch ?? null,
      forbiddenPaths: [...(envelope.filesystem?.forbiddenPaths ?? [])],
      protectedGit: [...(envelope.filesystem?.protectedGit ?? [])],
    },
    network: {
      entries: networkEntries(runtime.net),
      brokerOperations: [],
      dolt: runtime.dolt,
    },
    processes: {
      executables: executables(runtime.run),
      descendants: true,
      maxProcesses: null,
      syscallProfile: null,
      environment: [...runtime.env],
    },
    secrets: credentialRefs(inputs),
    effects: {
      tools: [...(job?.tools ?? [])],
      externalMutations: [...(job?.externalMutations ?? [])],
      approvalPosture: job?.approvalPosture ?? "strict",
      paidRouting: job?.paidRouting ?? false,
      limits: {
        timeMs: job?.limits?.timeMs ?? null,
        steps: job?.limits?.steps !== undefined
          ? job.limits.steps
          : AGENT_DEFAULTS.maxToolSteps,
        outputBytes: job?.limits?.outputBytes ?? null,
        spendMicroUsd: {
          session: spend?.session !== undefined
            ? spend.session
            : microUsd(BUDGET_DEFAULTS.sessionLimitUsd),
          perCall: spend?.perCall !== undefined
            ? spend.perCall
            : microUsd(BUDGET_DEFAULTS.perCallLimitUsd),
          daily: spend?.daily !== undefined
            ? spend.daily
            : microUsd(BUDGET_DEFAULTS.dailyLimitUsd),
        },
      },
    },
  };
  candidate.identity.digest = policyDigest(candidate);
  return parseEffectivePolicy(candidate);
}

/**
 * The `{net, run, env, dolt}` the egress, spawn and env seams read, rebuilt
 * from `policy`. It keeps the order of every list.
 */
export function projectRuntimePolicy(policy: EffectivePolicy): RuntimePolicy {
  return Object.freeze({
    net: Object.freeze(
      policy.network.entries.map((entry) => `${entry.host}:${entry.port}`),
    ),
    run: Object.freeze(policy.processes.executables.map((e) => e.program)),
    env: Object.freeze([...policy.processes.environment]),
    dolt: policy.network.dolt,
  });
}
