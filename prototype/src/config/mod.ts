/**
 * config/ (L1): the declared configuration surface.
 *
 * Responsibility: the env-key schema (every `DYFJ_*` key declared), the `Env`
 * port and its process adapter, the shared `.env` parser, TOML loading, and
 * secrets/MCP/budget/agent/anomaly config parsing. Nothing else in the runtime
 * reads the process environment directly.
 *
 * Allowed dependencies: none outside this directory (and `@std/toml`, loaded
 * lazily).
 */

export { type Env, type MutableEnv, processEnv } from "./env.ts";
export { envFileVar, readLauncherEnvVar } from "./env-file.ts";
export { type DoltConnectionConfig, resolveDoltConnection } from "./dolt.ts";
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
