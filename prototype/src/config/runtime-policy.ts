/**
 * The runtime's egress, spawn and env policy: one product-owned source for the
 * hosts the runtime may reach, the binaries it may start and the environment
 * names it may see.
 *
 * The static lists are the `serve-unix` and `cli` permission profiles in
 * `deno.json`, restated here; `runtime-policy.test.ts` fails when the two
 * disagree, until the profiles are removed. `composeRuntimePolicy` adds the
 * operator's launch-resolved entries with the same functions the launcher has
 * always used for its permission flags, plus `[network] allow` from
 * config.toml (`network-config.ts`), the operator's one way to add a host. The
 * launcher builds the runtime's permission flags and explicit env from the
 * composed policy, and the engine composes the same
 * policy at boot and enforces it in code at its own seams: the guarded fetch
 * and Dolt connect check (`egress.ts`) and the guarded spawn
 * (`spawn-guard.ts`). That enforcement does not depend on the runtime's
 * permission model.
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
import { mcpServerNetGrants } from "./mcp-net-grants.ts";
import type { McpHttpServerConfig } from "./mcp-servers.ts";
import { memoryMcpNetGrant } from "./memory-url.ts";
import type { SecretsConfig } from "./secrets-config.ts";

/** Hosts every runtime may reach: Dolt, local model servers, hosted providers. */
export const SERVE_UNIX_NET_GRANTS: readonly string[] = Object.freeze([
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
 * Binaries every runtime may start: the exec tools' `bash` and `git`, the
 * runtime itself by name, and the ACP runner's `/bin/kill` signaler and
 * `/bin/sleep` process-group probe.
 */
export const SERVE_UNIX_RUN_GRANTS: readonly string[] = Object.freeze([
  "bash",
  "deno",
  "git",
  "/bin/kill",
  "/bin/sleep",
]);

/** Environment names the runtime reads. */
export const SERVE_UNIX_ENV_GRANTS: readonly string[] = Object.freeze([
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

/** The one binary the CLI starts: the runtime. */
export const CLI_RUN_GRANTS: readonly string[] = Object.freeze(["deno"]);

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
  // The current runtime's module cache. Without it, a runtime on a
  // non-default cache cannot start. Remove it when the runtime moves to Node.
  "DENO_DIR",
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
   * (`process.execPath`) when absent. The launcher, composing for a runtime
   * it starts by name, passes null.
   */
  runtimeExecutable?: string | null;
}

function appendNew(list: string[], entries: readonly (string | null)[]) {
  for (const entry of entries) {
    if (entry !== null && !list.includes(entry)) list.push(entry);
  }
}

/**
 * The static lists plus the operator's entries. Inside the runtime, its own
 * executable is included: the profile grants it by name (`deno`), and the ACP
 * fixture starts it by path.
 */
export function composeRuntimePolicy(
  inputs: RuntimePolicyInputs = {},
): RuntimePolicy {
  const net = [...SERVE_UNIX_NET_GRANTS];
  appendNew(net, [memoryMcpNetGrant(inputs.memoryMcpUrl)]);
  appendNew(net, mcpServerNetGrants(inputs.mcpServers ?? []));
  appendNew(net, inputs.networkAllow ?? []);
  appendNew(net, inputs.nameserverGrants ?? []);

  const run = [...SERVE_UNIX_RUN_GRANTS];
  const resolver = inputs.secrets?.command[0] ?? null;
  appendNew(run, [
    inputs.runtimeExecutable === undefined
      ? process.execPath
      : inputs.runtimeExecutable,
    inputs.nodePath ?? null,
    KILL_BINARY,
    resolver === undefined || resolver === "" ? null : resolver,
  ]);

  const env = [...SERVE_UNIX_ENV_GRANTS];
  appendNew(env, inputs.secrets?.inheritEnv ?? []);

  const dolt = inputs.dolt == null
    ? null
    : `${inputs.dolt.host}:${inputs.dolt.port}`;
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
 * The CLI's own policy: it starts only the runtime, and reaches nothing over
 * HTTP or Dolt.
 */
export function cliRuntimePolicy(): RuntimePolicy {
  return Object.freeze({
    net: Object.freeze([]),
    run: Object.freeze([...CLI_RUN_GRANTS]),
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
