/**
 * config/ (L1): the declared configuration surface.
 *
 * Responsibility: the env-key schema (every `DYFJ_*` key declared), the `Env`
 * port and its process adapter, the shared `.env` parser, TOML loading, and
 * secrets/MCP/budget/agent/anomaly config parsing, secret-pointer resolution
 * into the environment (`secrets.ts`), the launch-resolved
 * nameserver net grants, and the runtime's egress, spawn and env policy with
 * the guards that enforce it at the product's seams (`runtime-policy.ts`,
 * `egress.ts`, `spawn-guard.ts`), the effective policy built from that same
 * composition, with its digest, session-within-run check and pure Kubernetes
 * and Linux compilers (`effective-policy*.ts`; nothing enforces it yet), and the code fingerprint the runtime records
 * and its clients compare (`code-fingerprint.ts`). Nothing else in the runtime
 * reads the process environment directly.
 *
 * Allowed dependencies: none outside this directory (and `smol-toml`, loaded
 * lazily).
 */

export { type Env, type MutableEnv, processEnv } from "./env.ts";
export {
  type CodeFingerprint,
  codeFingerprint,
  compareFreshness,
  FINGERPRINT_UNKNOWN,
  type Freshness,
  prototypeSourceDir,
  sourceTreeHash,
} from "./code-fingerprint.ts";
export { readTextFile } from "./read-text-file.ts";
export {
  envFileVar,
  readLauncherEnv,
  readLauncherEnvVar,
} from "./env-file.ts";
export {
  type DoltConnectionConfig,
  type DoltEndpoint,
  resolveDoltConnection,
  resolveDoltEndpoint,
} from "./dolt.ts";
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
  CLI_NODE_PERMISSION_FLAGS,
  cliRuntimePolicy,
  type ComposedRuntimeGrants,
  composeRuntimeGrants,
  composeRuntimePolicy,
  isAddressLiteral,
  isLoopbackHost,
  type NetGrantSource,
  nodePermissionArgs,
  RUNTIME_ENV_GRANTS,
  RUNTIME_NET_GRANT_TABLE,
  RUNTIME_NET_GRANTS,
  RUNTIME_NODE_PERMISSION_FLAGS,
  RUNTIME_PLATFORM_ENV,
  RUNTIME_RUN_GRANT_TABLE,
  RUNTIME_RUN_GRANTS,
  type RunGrantSource,
  runtimeChildEnv,
  type RuntimePolicy,
  type RuntimePolicyInputs,
} from "./runtime-policy.ts";
export {
  composeEffectivePolicy,
  EFFECTIVE_POLICY_VERSION,
  type EffectivePolicy,
  type EffectivePolicyEnvelope,
  parseEffectivePolicy,
  projectRuntimePolicy,
} from "./effective-policy.ts";
export {
  canonicalPolicyJson,
  policyDigest,
  verifyDigest,
} from "./effective-policy-digest.ts";
export {
  assertSessionWithinRun,
  checkSessionWithinRun,
  PolicyEnvelopeError,
  type PolicyViolation,
} from "./effective-policy-subset.ts";
export {
  compileKubernetes,
  compileLinux,
  type KubernetesTarget,
  type LinuxTarget,
  type PlatformCapabilities,
  UnsupportedRightError,
} from "./effective-policy-compile.ts";
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
  type ResolvedSecrets,
  resolveSecrets,
  type RunSecretCommand,
  secretsRunGrant,
  unavailableSecretPointers,
} from "./secrets.ts";
