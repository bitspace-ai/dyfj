/**
 * The runtime's egress, spawn and env policy: one product-owned source for the
 * hosts the runtime may reach, the binaries it may start and the environment
 * names it may see.
 *
 * The static lists below are the only source of the runtime's fixed entries.
 * `composeRuntimePolicy` adds the operator's launch-resolved entries, plus
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

/** Hosts every runtime may reach: Dolt, local model servers, hosted providers. */
export const RUNTIME_NET_GRANTS: readonly string[] = Object.freeze([
  "127.0.0.1:3306",
  "127.0.0.1:8080",
  "localhost:8080",
  "127.0.0.1:18080",
  "localhost:18080",
  "127.0.0.1:11434",
  "localhost:11434",
  "api.anthropic.com:443",
  "api.openai.com:443",
  "openrouter.ai:443",
  "generativelanguage.googleapis.com:443",
  "api.x.ai:443",
]);

/**
 * Binaries every runtime may start: the exec tools' `bash` and `git`, and the
 * ACP runner's `/bin/kill` signaler and `/bin/sleep` process-group probe. The
 * runtime's own Node executable is granted by path in the base policy.
 */
export const RUNTIME_RUN_GRANTS: readonly string[] = Object.freeze([
  "bash",
  "git",
  "/bin/kill",
  "/bin/sleep",
]);

/** Environment names the runtime reads. */
export const RUNTIME_ENV_GRANTS: readonly string[] = Object.freeze([
  "PATH",
  "DYFJ_NODE_PATH",
  "DYFJ_CODEX_TOOLCHAIN_PATH",
  "DYFJ_CODEX_RUSTUP_HOME",
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

function appendNew(list: string[], entries: readonly (string | null)[]) {
  for (const entry of entries) {
    if (entry !== null && !list.includes(entry)) list.push(entry);
  }
}

/**
 * The static lists plus the operator's entries. The runtime's own executable
 * is included: the ACP fixture starts it by path.
 */
export function composeRuntimePolicy(
  inputs: RuntimePolicyInputs = {},
): RuntimePolicy {
  const net = [...RUNTIME_NET_GRANTS];
  appendNew(net, [memoryMcpNetGrant(inputs.memoryMcpUrl)]);
  appendNew(net, mcpServerNetGrants(inputs.mcpServers ?? []));
  appendNew(net, inputs.networkAllow ?? []);
  appendNew(net, inputs.nameserverGrants ?? []);

  const run = [...RUNTIME_RUN_GRANTS];
  const resolver = inputs.secrets?.command[0] ?? null;
  appendNew(run, [
    inputs.runtimeExecutable === undefined
      ? process.execPath
      : inputs.runtimeExecutable,
    inputs.nodePath ?? null,
    KILL_BINARY,
    resolver === undefined || resolver === "" ? null : resolver,
  ]);

  const env = [...RUNTIME_ENV_GRANTS];
  appendNew(env, inputs.secrets?.inheritEnv ?? []);

  // The Dolt endpoint is both the pool's one allowed endpoint and a net entry,
  // so the runtime's permission flag admits the connection the guard admits.
  const dolt = inputs.dolt == null
    ? null
    : `${inputs.dolt.host}:${validateDoltPort(inputs.dolt.port)}`;
  appendNew(net, [dolt]);
  return Object.freeze({
    net: Object.freeze(net),
    run: Object.freeze(run),
    env: Object.freeze(env),
    dolt,
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
