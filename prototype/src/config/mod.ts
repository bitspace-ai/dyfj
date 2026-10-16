/**
 * config/ (L1): the declared configuration surface.
 *
 * Responsibility: the env-key schema (every `DYFJ_*` key declared), the `Env`
 * port and its process adapter, the shared `.env` parser, TOML loading, and
 * secrets/MCP/budget/agent/anomaly config parsing, secret-pointer resolution
 * into the environment (`secrets.ts`), the launch-resolved
 * nameserver net grants, and the runtime's egress, spawn and env policy with
 * the guards that enforce it at the product's seams (`runtime-policy.ts`,
 * `egress.ts`, `spawn-guard.ts`). Nothing else in the runtime
 * reads the process environment directly.
 *
 * Allowed dependencies: none outside this directory (and `smol-toml`, loaded
 * lazily).
 */

export { type Env, type MutableEnv, processEnv } from "./env.ts";
export { readTextFile } from "./read-text-file.ts";
export { envFileVar, readLauncherEnvVar } from "./env-file.ts";
export { type DoltConnectionConfig, resolveDoltConnection } from "./dolt.ts";
export {
  nameserverNetGrants,
  readNameserverNetGrants,
  RESOLV_CONF_PATH,
} from "./nameservers.ts";
export {
  CONFIG_SCHEMA,
  type ConfigDomain,
  type ConfigKeySpec,
  type ConfigKind,
  type ConfigValueType,
  declaredEnvVars,
  declaredSecretEnvVars,
  type PermissionLevel,
} from "./schema.ts";
export {
  configFilePath,
  type LoadConfigDeps,
  type TomlParser,
} from "./toml.ts";
export {
  CONFIG_DEFAULTS,
  loadConfig,
  type WorkbenchConfig,
} from "./workbench.ts";
export {
  DEFAULT_SECRET_TIMEOUT_MS,
  loadSecretsConfig,
  parseSecretsConfig,
  type SecretsConfig,
} from "./secrets-config.ts";
export {
  type LinearIssueCreationBinding,
  loadMcpServersConfig,
  type McpConfiguredTool,
  type McpConfiguredToolApproval,
  type McpConfiguredToolEffect,
  type McpHttpServerConfig,
  type McpMinimumClearance,
  type McpServerCapabilities,
  parseMcpServersConfig,
} from "./mcp-servers.ts";
export {
  AGENT_DEFAULTS,
  type AgentDefaults,
  ANOMALY_DEFAULTS,
  type AnomalyDefaults,
  BUDGET_DEFAULTS,
  type BudgetDefaults,
  type BudgetTallyMode,
  parseBudgetTallyMode,
  resolveAgentDefaultsFromEnv,
  resolveAnomalyDefaultsFromEnv,
  resolveBudgetDefaultsFromEnv,
  resolvePrincipalId,
  resolveRuntimeEnvDefaults,
  resolveTrustWorkspaceInstructionsFromEnv,
  type RuntimeEnvDefaults,
} from "./defaults.ts";
export {
  buildDoltAllowNetGrant,
  mcpServerNetGrants,
  validateDoltPort,
} from "./mcp-net-grants.ts";
export { assertSecureMemoryUrl, memoryMcpNetGrant } from "./memory-url.ts";
export { loadNetworkAllow, parseNetworkAllow } from "./network-config.ts";
export {
  baseRuntimePolicy,
  CLI_RUN_GRANTS,
  cliRuntimePolicy,
  composeRuntimePolicy,
  RUNTIME_PLATFORM_ENV,
  runtimeChildEnv,
  type RuntimePolicy,
  type RuntimePolicyInputs,
  SERVE_UNIX_ENV_GRANTS,
  SERVE_UNIX_NET_GRANTS,
  SERVE_UNIX_RUN_GRANTS,
} from "./runtime-policy.ts";
export {
  assertConnectAllowed,
  assertEgressAllowed,
  EgressRefusedError,
  egressTarget,
  type FetchTransport,
  findEgressRefusal,
  guardedFetch,
} from "./egress.ts";
export {
  assertSpawnAllowed,
  guardedSpawn,
  SpawnRefusedError,
} from "./spawn-guard.ts";
export {
  resolveSecrets,
  secretsRunGrant,
  unavailableSecretPointers,
} from "./secrets.ts";
