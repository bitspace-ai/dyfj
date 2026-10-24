/**
 * The runtime's egress, spawn and env policy: one product-owned source for the
 * hosts the runtime may reach, the binaries it may start and the environment
 * names it may see.
 *
 * The static tables below are the only source of the runtime's fixed entries;
 * each entry carries the role it is granted for, and the exported lists are
 * derived from them. `composeRuntimePolicy` adds the operator's launch-resolved entries, plus
 * `[network] allow` from config.toml (`network-config.ts`), the operator's one
 * way to add a host. The launcher
 * builds the runtime's explicit env from the composed policy, and the engine
 * composes the same policy at boot and enforces it in code at its own seams:
 * the guarded fetch and Dolt connect check (`egress.ts`) and the guarded spawn
 * (`spawn-guard.ts`). These seams are the runtime's egress, spawn and env
 * boundary; the runtime itself runs without Node's permission model
 * (`RUNTIME_NODE_PERMISSION_FLAGS`).
 *
 * Accepted risks: the seams govern the product's own calls. A compromised
 * dependency that opens its own socket or process is outside them, and so is
 * the web tools' DNS preflight (`tools/web/dns.ts`), which queries the
 * nameservers in /etc/resolv.conf directly; those nameservers are policy
 * entries, but no guard checks the query. An OS-level sandbox is the
 * follow-up that closes both gaps.
 */

import process from "node:process";
import type { Env } from "./env.ts";
import { mcpServerNetGrants, validateDoltPort } from "./mcp-net-grants.ts";
import type { McpHttpServerConfig } from "./mcp-servers.ts";
import { memoryMcpNetGrant } from "./memory-url.ts";
import type { SecretsConfig } from "./secrets-config.ts";

/** Why a static host is granted. */
export type StaticNetRole = "provider" | "local-model" | "dolt";

/** What a static binary is for. */
export type StaticRunRole = "tool" | "runner";

/** One static grant and the role it is granted for. */
export interface TaggedGrant<Role extends string> {
  readonly entry: string;
  readonly role: Role;
}

function taggedTable<Role extends string>(
  rows: readonly TaggedGrant<Role>[],
): readonly TaggedGrant<Role>[] {
  return Object.freeze(rows.map((row) => Object.freeze({ ...row })));
}

/**
 * Hosts every runtime may reach, each with its role: Dolt, local model
 * servers, hosted providers. The one source of the static net entries.
 */
export const RUNTIME_NET_GRANT_TABLE: readonly TaggedGrant<StaticNetRole>[] =
  taggedTable<StaticNetRole>([
    { entry: "127.0.0.1:3306", role: "dolt" },
    { entry: "127.0.0.1:8080", role: "local-model" },
    { entry: "localhost:8080", role: "local-model" },
    { entry: "127.0.0.1:18080", role: "local-model" },
    { entry: "localhost:18080", role: "local-model" },
    { entry: "127.0.0.1:11434", role: "local-model" },
    { entry: "localhost:11434", role: "local-model" },
    { entry: "api.anthropic.com:443", role: "provider" },
    { entry: "api.openai.com:443", role: "provider" },
    { entry: "openrouter.ai:443", role: "provider" },
    { entry: "generativelanguage.googleapis.com:443", role: "provider" },
    { entry: "api.x.ai:443", role: "provider" },
  ]);

/** Hosts every runtime may reach, in table order. */
export const RUNTIME_NET_GRANTS: readonly string[] = Object.freeze(
  RUNTIME_NET_GRANT_TABLE.map((row) => row.entry),
);

/**
 * Binaries every runtime may start, each with its role: the exec tools' `bash`
 * and `git`, and the ACP runner's `/bin/kill` signaler and `/bin/sleep`
 * process-group probe. The runtime's own Node executable is granted by path in
 * the base policy.
 */
export const RUNTIME_RUN_GRANT_TABLE: readonly TaggedGrant<StaticRunRole>[] =
  taggedTable<StaticRunRole>([
    { entry: "bash", role: "tool" },
    { entry: "git", role: "tool" },
    { entry: "/bin/kill", role: "runner" },
    { entry: "/bin/sleep", role: "runner" },
  ]);

/** Binaries every runtime may start, in table order. */
export const RUNTIME_RUN_GRANTS: readonly string[] = Object.freeze(
  RUNTIME_RUN_GRANT_TABLE.map((row) => row.entry),
);

/** Environment names the runtime reads. */
export const RUNTIME_ENV_GRANTS: readonly string[] = Object.freeze([
  "PATH",
  "DYFJ_NODE_PATH",
  "DYFJ_CODEX_TOOLCHAIN_PATH",
  "DYFJ_CODEX_RUSTUP_HOME",
  "DYFJ_EXECUTOR_SOCKET",
  "USER",
  "HOME",
  "XDG_RUNTIME_DIR",
  "DYFJ_SOCKET",
  "DYFJ_ROOT",
  "DYFJ_PRINCIPAL_ID",
  "DYFJ_WORKBENCH_MODEL",
  "DYFJ_WORKBENCH_HINT",
  "DYFJ_WORKBENCH_TIER",
  "DYFJ_WORKBENCH_CONTEXT_PROFILE",
  "DYFJ_WORKBENCH_CONTEXT_TOKENS",
  "DYFJ_BUDGET_SESSION_USD",
  "DYFJ_BUDGET_PER_CALL_USD",
  "DYFJ_BUDGET_DAILY_USD",
  "DYFJ_ANOMALY_TURN_MULTIPLE",
  "DYFJ_ANOMALY_SCOPE_MULTIPLE",
  "DYFJ_APPROVE_PAID_DEFAULT",
  "DYFJ_TRUST_WORKSPACE_INSTRUCTIONS",
  "DYFJ_MAX_TOOL_STEPS",
  "DYFJ_MAX_TOOL_STEPS_CEILING",
  "DYFJ_BUDGET_TALLY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY",
  "XAI_API_KEY",
  "DOLT_HOST",
  "DOLT_PORT",
  "DOLT_USER",
  "DOLT_PASSWORD",
  "DOLT_DATABASE",
  "DYFJ_MEMORY_MCP_URL",
  "DYFJ_MEMORY_MCP_TOOL",
  "DYFJ_FRICTION_ISSUE_ID",
  "DYFJ_MEMORY_MCP_TOKEN",
  "DYFJ_MEMORY_MCP_TOKEN_HEADER",
  "DYFJ_PERMISSION_LEVEL",
  "NODE_DEBUG_NATIVE",
  "NODE_V8_COVERAGE",
  "NODE_DISABLE_COMPILE_CACHE",
  "NODE_COMPILE_CACHE_PORTABLE",
  "NODE_COMPILE_CACHE",
]);

/**
 * The runtime's Node permission flags: none. The runtime runs as plain `node`
 * (decision D32, S4). Its egress, spawn and env limits are the in-code seams
 * above, which Node's permission model cannot express (it grants network,
 * child-process and worker access only whole). And Node writes a process's
 * permission flags into the `NODE_OPTIONS` of every process it starts, so a
 * sandboxed runtime would sandbox every Node descendant too: the ACP fixture
 * and Codex agents, and any `node` or `npm` the exec tools run in the
 * operator's workspace, which could then load no native addon. Scoping the
 * runtime's own process without that leak is the OS-sandbox follow-up.
 */
export const RUNTIME_NODE_PERMISSION_FLAGS: readonly string[] = Object.freeze(
  [],
);

/**
 * The CLI client's Node permission flags, for every client route but
 * `dyfj start`: it reads its sources, `.env` and config.toml, and connects to
 * the control socket. It writes nothing and starts nothing. `dyfj start` (and
 * autostart's background start) runs with no flags instead: a client under
 * `--permission` would hand its flags to the runtime it starts, through
 * `NODE_OPTIONS`. `scripts/dyfj-launcher.sh` restates this list, and
 * `grants.test.ts` fails when the two disagree.
 */
export const CLI_NODE_PERMISSION_FLAGS: readonly string[] = Object.freeze([
  "--permission",
  "--allow-fs-read=*",
  "--allow-net",
]);

/**
 * `flags` as Node arguments. Node warns on stderr that `--allow-net` is
 * experimental, once per process; that warning is silenced so it never
 * reaches the operator's terminal or a client's output.
 */
export function nodePermissionArgs(flags: readonly string[]): string[] {
  return flags.includes("--allow-net")
    ? [...flags, "--disable-warning=ExperimentalWarning"]
    : [...flags];
}

/**
 * Variables the runtime process itself needs, forwarded beside the policy's
 * names although runtime code never reads them.
 */
export const RUNTIME_PLATFORM_ENV: readonly string[] = Object.freeze([
  // The temp directory. Without it, temp files on macOS move from the
  // per-user /var/folders directory to /tmp.
  "TMPDIR",
  // The Windows temp directory names, forwarded when present.
  "TMP",
  "TEMP",
]);

const OCTET = "(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])";
const IPV4_ADDRESS = new RegExp(`^${OCTET}(?:\\.${OCTET}){3}$`);

/**
 * `host` is a dotted-quad IPv4 address, or brackets around IPv6 address
 * characters that the WHATWG URL parser accepts as an IPv6 address.
 */
export function isAddressLiteral(host: string): boolean {
  if (BRACKETED_IPV6.test(host)) return canonicalHost(host) !== null;
  return IPV4_ADDRESS.test(host);
}

/** Brackets around IPv6 address characters only, and nothing else. */
const BRACKETED_IPV6 = /^\[[0-9A-Fa-f:.]+\]$/;

/** A bare host: no port, user info, path, query, fragment or whitespace. */
const BARE_HOST = /^[^\s/?#@\\:\[\]]+$/;

/**
 * `host` in the canonical form a URL gives it, or null when `host` is not a
 * host on its own (a port, a path or user info around it) or has no
 * canonical form.
 */
function canonicalHost(host: string): string | null {
  if (!BRACKETED_IPV6.test(host) && !BARE_HOST.test(host)) return null;
  try {
    return new URL(`http://${host}/`).hostname.replace(/\.$/, "");
  } catch {
    return null;
  }
}

const IPV4_MAPPED = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/;

/** The IPv4 address an IPv4-mapped IPv6 host carries, or null. */
function mappedIpv4(canonical: string): string | null {
  const match = IPV4_MAPPED.exec(canonical);
  if (match === null) return null;
  const high = parseInt(match[1]!, 16);
  const low = parseInt(match[2]!, 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}

function isLoopbackIpv4(address: string): boolean {
  return IPV4_ADDRESS.test(address) &&
    (address.startsWith("127.") || address === "0.0.0.0");
}

/**
 * `host` names this machine's loopback or any-address in some spelling:
 * `localhost` and its subdomains, `127.0.0.0/8` and `0.0.0.0` (also as
 * `127.1`, a decimal or an IPv4-mapped IPv6 address), and `[::1]` and `[::]`
 * (also uncompressed). Inside another network namespace or a pod such a host names
 * that environment's own loopback, so a platform compiler maps it.
 */
export function isLoopbackHost(host: string): boolean {
  const canonical = canonicalHost(host);
  if (canonical === null) return false;
  const mapped = mappedIpv4(canonical);
  return canonical === "localhost" || canonical.endsWith(".localhost") ||
    isLoopbackIpv4(canonical) ||
    canonical === "[::1]" || canonical === "[::]" ||
    (mapped !== null && isLoopbackIpv4(mapped));
}

const DNS_NAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/**
 * `host` is spelled the one way a URL spells it, and is an address literal or
 * a DNS name. `127.1`, `LOCALHOST`, `localhost.` and an uncompressed IPv6
 * address are not: two spellings of one host must not count as two hosts.
 */
export function isCanonicalHost(host: string): boolean {
  return canonicalHost(host) === host &&
    (isAddressLiteral(host) || DNS_NAME.test(host));
}

/** The fixed signaler the ACP runner's process-group contract uses. */
const KILL_BINARY = "/bin/kill";

/**
 * What one runtime may do. `net` holds `host:port` entries in the
 * permission-flag form (`[::1]:8080` for IPv6). `dolt` is the one database endpoint, as
 * `host:port`, or null when none is configured.
 */
export interface RuntimePolicy {
  readonly net: readonly string[];
  readonly run: readonly string[];
  readonly env: readonly string[];
  readonly dolt: string | null;
}

/** The operator's launch-resolved inputs. Each one is optional. */
export interface RuntimePolicyInputs {
  /** `[[mcp.servers]]` from config.toml. */
  mcpServers?: readonly McpHttpServerConfig[];
  /** `DYFJ_MEMORY_MCP_URL`. An insecure value throws. */
  memoryMcpUrl?: string;
  /** `[network] allow` from config.toml, validated by `parseNetworkAllow`. */
  networkAllow?: readonly string[];
  /** `<ip>:53` for each system nameserver, for the web tools' DNS check. */
  nameserverGrants?: readonly string[];
  /** `[secrets]`: its command binary and its `inherit_env` names. */
  secrets?: SecretsConfig | null;
  /** The validated `DYFJ_NODE_PATH`. */
  nodePath?: string | null;
  /** The configured Dolt endpoint. */
  dolt?: { host: string; port: number } | null;
  /**
   * The runtime's own executable, added to the run list; this process's own
   * (`process.execPath`) when absent. Null adds none.
   */
  runtimeExecutable?: string | null;
}

/** Where a composed net entry came from. */
export type NetGrantSource =
  | { readonly kind: "static"; readonly role: StaticNetRole }
  /** `tls`: the configured URL is https. */
  | { readonly kind: "memory-mcp"; readonly tls: boolean }
  | { readonly kind: "mcp-server"; readonly tls: boolean }
  | { readonly kind: "network-allow" }
  | { readonly kind: "nameserver" }
  | { readonly kind: "dolt-endpoint" };

/** Where a composed run entry came from. */
export type RunGrantSource =
  | { readonly kind: "static"; readonly role: StaticRunRole }
  | { readonly kind: "runtime-executable" }
  | { readonly kind: "node-path" }
  | { readonly kind: "secrets-resolver" };

export interface ComposedGrant<Source> {
  readonly entry: string;
  /**
   * The first source to add the entry. It decides the entry's place in the
   * list; the effective policy chooses the role from all of `sources`.
   */
  readonly source: Source;
  /** Every source that added the entry, in the order they added it. */
  readonly sources: readonly Source[];
}

/**
 * The composed policy with the provenance of each net and run entry, in the
 * order `composeRuntimePolicy` lists them. `composeEffectivePolicy` reads the
 * provenance; `composeRuntimePolicy` drops it.
 */
export interface ComposedRuntimeGrants {
  readonly net: readonly ComposedGrant<NetGrantSource>[];
  readonly run: readonly ComposedGrant<RunGrantSource>[];
  readonly env: readonly string[];
  readonly dolt: string | null;
}

interface Building<Source> {
  readonly entry: string;
  readonly sources: Source[];
}

/**
 * Add each new entry to `list`. An entry already there keeps its place and
 * gains `source`, so no source's provenance is lost to deduplication.
 */
function appendNew<Source>(
  list: Building<Source>[],
  entries: readonly (string | null)[],
  source: Source,
) {
  for (const entry of entries) {
    if (entry === null) continue;
    const existing = list.find((grant) => grant.entry === entry);
    if (existing === undefined) list.push({ entry, sources: [source] });
    else if (!existing.sources.includes(source)) existing.sources.push(source);
  }
}

function fromTable<Role extends string, Source>(
  table: readonly TaggedGrant<Role>[],
  source: (role: Role) => Source,
): Building<Source>[] {
  return table.map((row) => ({ entry: row.entry, sources: [source(row.role)] }));
}

function freezeGrants<Source>(
  list: readonly Building<Source>[],
): readonly ComposedGrant<Source>[] {
  return Object.freeze(list.map((grant) =>
    Object.freeze({
      entry: grant.entry,
      source: grant.sources[0]!,
      sources: Object.freeze([...grant.sources]),
    })
  ));
}

const STATIC_NET: Readonly<Record<StaticNetRole, NetGrantSource>> = {
  provider: Object.freeze({ kind: "static", role: "provider" }),
  "local-model": Object.freeze({ kind: "static", role: "local-model" }),
  dolt: Object.freeze({ kind: "static", role: "dolt" }),
};
const STATIC_RUN: Readonly<Record<StaticRunRole, RunGrantSource>> = {
  tool: Object.freeze({ kind: "static", role: "tool" }),
  runner: Object.freeze({ kind: "static", role: "runner" }),
};

const MEMORY_MCP_TLS: NetGrantSource = Object.freeze({
  kind: "memory-mcp",
  tls: true,
});
const MEMORY_MCP_PLAIN: NetGrantSource = Object.freeze({
  kind: "memory-mcp",
  tls: false,
});
const MCP_SERVER_TLS: NetGrantSource = Object.freeze({
  kind: "mcp-server",
  tls: true,
});
const MCP_SERVER_PLAIN: NetGrantSource = Object.freeze({
  kind: "mcp-server",
  tls: false,
});

function isHttps(url: string): boolean {
  return new URL(url).protocol === "https:";
}
const NETWORK_ALLOW: NetGrantSource = Object.freeze({ kind: "network-allow" });
const NAMESERVER: NetGrantSource = Object.freeze({ kind: "nameserver" });
const DOLT_ENDPOINT: NetGrantSource = Object.freeze({ kind: "dolt-endpoint" });
const RUNTIME_EXECUTABLE: RunGrantSource = Object.freeze({
  kind: "runtime-executable",
});
const NODE_PATH: RunGrantSource = Object.freeze({ kind: "node-path" });
const RESOLVER_COMMAND: RunGrantSource = Object.freeze({
  kind: "secrets-resolver",
});
const KILL: RunGrantSource = STATIC_RUN.runner;

/**
 * The static tables plus the operator's entries, each tagged with where it
 * came from. The runtime's own executable is included: the ACP fixture starts
 * it by path.
 */
export function composeRuntimeGrants(
  inputs: RuntimePolicyInputs = {},
): ComposedRuntimeGrants {
  const net = fromTable(RUNTIME_NET_GRANT_TABLE, (role) => STATIC_NET[role]);
  const memory = memoryMcpNetGrant(inputs.memoryMcpUrl);
  if (memory !== null) {
    appendNew(
      net,
      [memory],
      isHttps(inputs.memoryMcpUrl!) ? MEMORY_MCP_TLS : MEMORY_MCP_PLAIN,
    );
  }
  for (const server of inputs.mcpServers ?? []) {
    appendNew(
      net,
      mcpServerNetGrants([server]),
      isHttps(server.url) ? MCP_SERVER_TLS : MCP_SERVER_PLAIN,
    );
  }
  appendNew(net, inputs.networkAllow ?? [], NETWORK_ALLOW);
  appendNew(net, inputs.nameserverGrants ?? [], NAMESERVER);

  const run = fromTable(RUNTIME_RUN_GRANT_TABLE, (role) => STATIC_RUN[role]);
  const resolver = inputs.secrets?.command[0] ?? null;
  appendNew(run, [
    inputs.runtimeExecutable === undefined
      ? process.execPath
      : inputs.runtimeExecutable,
  ], RUNTIME_EXECUTABLE);
  appendNew(run, [inputs.nodePath ?? null], NODE_PATH);
  appendNew(run, [KILL_BINARY], KILL);
  appendNew(
    run,
    [resolver === undefined || resolver === "" ? null : resolver],
    RESOLVER_COMMAND,
  );

  const env = [...RUNTIME_ENV_GRANTS];
  for (const name of inputs.secrets?.inheritEnv ?? []) {
    if (!env.includes(name)) env.push(name);
  }

  // The Dolt endpoint is both the pool's one allowed endpoint and a net entry,
  // so the runtime's permission flag admits the connection the guard admits.
  const dolt = inputs.dolt == null
    ? null
    : `${inputs.dolt.host}:${validateDoltPort(inputs.dolt.port)}`;
  appendNew(net, [dolt], DOLT_ENDPOINT);
  return Object.freeze({
    net: freezeGrants(net),
    run: freezeGrants(run),
    env: Object.freeze(env),
    dolt,
  });
}

/**
 * The static lists plus the operator's entries. The runtime's own executable
 * is included: the ACP fixture starts it by path.
 */
export function composeRuntimePolicy(
  inputs: RuntimePolicyInputs = {},
): RuntimePolicy {
  const grants = composeRuntimeGrants(inputs);
  return Object.freeze({
    net: Object.freeze(grants.net.map((grant) => grant.entry)),
    run: Object.freeze(grants.run.map((grant) => grant.entry)),
    env: grants.env,
    dolt: grants.dolt,
  });
}

/**
 * The policy a seam uses when its caller passes none: the static lists and the
 * runtime's own executable, with no operator entries and no Dolt endpoint. A
 * caller that forgets to inject the composed policy is refused the operator's
 * hosts and binaries, never granted more.
 */
export function baseRuntimePolicy(): RuntimePolicy {
  return composeRuntimePolicy();
}

/**
 * The CLI's own policy: it starts only the runtime, on the Node executable
 * running the CLI, and reaches nothing over HTTP or Dolt.
 */
export function cliRuntimePolicy(): RuntimePolicy {
  return Object.freeze({
    net: Object.freeze([]),
    run: Object.freeze([process.execPath]),
    env: Object.freeze([]),
    dolt: null,
  });
}

/**
 * The runtime child's complete environment: each policy name and each runtime
 * platform variable that is set in `env`, and nothing else. A name `env`
 * cannot read counts as unset.
 */
export function runtimeChildEnv(
  policy: RuntimePolicy,
  env: Env,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of [...policy.env, ...RUNTIME_PLATFORM_ENV]) {
    let value: string | undefined;
    try {
      value = env.get(name);
    } catch {
      value = undefined;
    }
    if (value !== undefined) result[name] = value;
  }
  return result;
}
