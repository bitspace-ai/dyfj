/**
 * The declared configuration surface: every environment key the system reads.
 *
 * Per the configuration-system working thesis:
 *   - Secret POINTERS, never values (op:// refs / env-var names), resolved at
 *     point of use. Keys carrying credentials are declared `secret-pointer`; the
 *     config surface never stores the plaintext value.
 *   - Engine vs client DOMAINS. The engine owns runtime/data/secret config; the
 *     engine-free CLI owns its own slice (server URL, socket, routing prefs). The
 *     `CONFIG_SCHEMA` registry tags each key with its domain so the two slices
 *     stay distinct (the thin client never loads the engine's schema).
 *   - ONE declared surface the permission allowlist derives from. `CONFIG_SCHEMA`
 *     is the single source of truth for the engine env surface; a parity test
 *     asserts the `deno.json` permission `env` profiles against it, so the
 *     allowlist-drift class of bug (a runtime env var present in one profile and
 *     missing from another) is caught structurally, not band-aided.
 *   - Every `DYFJ_*` key named anywhere under `prototype/` (runtime, `mcp/` and
 *     the `scripts/` tooling) is declared here; the `arch.imports` lane fails
 *     on an undeclared one.
 */

export type PermissionLevel = "strict" | "operator";
export const PERMISSION_LEVELS: readonly PermissionLevel[] = [
  "strict",
  "operator",
];

// ── Declared key registry ─────────────────────────────────────────────────────

/**
 * Which slice owns a key. The engine owns runtime/data/secret config; the
 * engine-free CLI client owns its own transport/routing slice. One system, two
 * domains — so the thin client never has to load the engine's schema. `test`
 * keys are set only by test harnesses; no runtime permission profile grants
 * them, and a read of one outside a test treats the ungranted key as absent.
 * `tooling` keys are read only by the test and gate programs under
 * `prototype/scripts`; no runtime permission profile grants them either.
 */
export type ConfigDomain = "engine" | "client" | "test" | "tooling";

/**
 * `value` is an ordinary config value. `secret-pointer` holds a POINTER to a
 * credential (an `op://` ref, a keychain item, or — today — an env-var name),
 * resolved at point of use. The config surface NEVER stores the plaintext value
 * of a secret-pointer key; it is a first-class type distinction, not a
 * convention.
 */
export type ConfigKind = "value" | "secret-pointer";

export type ConfigValueType = "string" | "number" | "boolean" | "enum";

/**
 * One declared configuration key. The registry is metadata: it names the key,
 * its env-var binding, its domain, its type, and whether it is a secret pointer.
 * Both the loaders and the permission-parity test consume it, so the env
 * allowlist derives from one source of truth.
 */
export interface ConfigKeySpec {
  /** Logical config key (camelCase). */
  key: string;
  /** Env var this key binds to. */
  envVar: string;
  domain: ConfigDomain;
  type: ConfigValueType;
  kind: ConfigKind;
  /** Allowed values for an `enum` type. */
  enumValues?: readonly string[];
  /**
   * Declared session/connection state, NOT config. Per the config thesis the
   * principal rides the connection (the UDS peer's OS identity locally, the
   * tailnet identity remotely), so it is deliberately not a config
   * value. It is declared here only so the permission-allowlist parity check can
   * account for its env var.
   */
  sessionState?: boolean;
  /** Default for a non-secret value key (secrets have no default — absence = off). */
  default?: string | number | boolean | null;
}

/**
 * The single declared surface. Engine keys' env vars must appear in the engine
 * `deno.json` permission profiles (asserted by the parity test); client keys
 * belong to the engine-free CLI slice. Secret-pointer keys are declared so the
 * allowlist covers them — their values are resolved at point of use, never
 * stored here.
 */
export const CONFIG_SCHEMA: readonly ConfigKeySpec[] = [
  // ── engine: values with a config-file layer (WorkbenchConfig) ──
  {
    key: "defaultCompanionModel",
    envVar: "DYFJ_WORKBENCH_MODEL",
    domain: "engine",
    type: "string",
    kind: "value",
    default: null,
  },
  {
    key: "permissionLevel",
    envVar: "DYFJ_PERMISSION_LEVEL",
    domain: "engine",
    type: "enum",
    kind: "value",
    enumValues: PERMISSION_LEVELS,
    default: "strict",
  },
  {
    key: "maxToolSteps",
    envVar: "DYFJ_MAX_TOOL_STEPS",
    domain: "engine",
    type: "number",
    kind: "value",
    default: 32,
  },
  // ── engine: budget defaults (env layer today; file layer is the next slice) ──
  {
    key: "defaultSessionBudgetUsd",
    envVar: "DYFJ_BUDGET_SESSION_USD",
    domain: "engine",
    type: "number",
    kind: "value",
    default: 1.0,
  },
  {
    key: "defaultPerCallBudgetUsd",
    envVar: "DYFJ_BUDGET_PER_CALL_USD",
    domain: "engine",
    type: "number",
    kind: "value",
    default: 0.1,
  },
  {
    key: "defaultDailyBudgetUsd",
    envVar: "DYFJ_BUDGET_DAILY_USD",
    domain: "engine",
    type: "number",
    kind: "value",
    default: 25.0,
  },
  {
    key: "approvePaidDefault",
    envVar: "DYFJ_APPROVE_PAID_DEFAULT",
    domain: "engine",
    type: "boolean",
    kind: "value",
    default: false,
  },
  {
    key: "trustWorkspaceInstructions",
    envVar: "DYFJ_TRUST_WORKSPACE_INSTRUCTIONS",
    domain: "engine",
    type: "boolean",
    kind: "value",
    default: false,
  },
  // ── engine: runaway-anomaly hard-stop multiples (applied to ACTUAL spend) ──
  {
    key: "anomalyTurnMultiple",
    envVar: "DYFJ_ANOMALY_TURN_MULTIPLE",
    domain: "engine",
    type: "number",
    kind: "value",
    default: 3.0,
  },
  {
    key: "anomalyScopeMultiple",
    envVar: "DYFJ_ANOMALY_SCOPE_MULTIPLE",
    domain: "engine",
    type: "number",
    kind: "value",
    default: 2.0,
  },
  // ── engine: other runtime knobs (declared so the allowlist derives here) ──
  {
    key: "root",
    envVar: "DYFJ_ROOT",
    domain: "engine",
    type: "string",
    kind: "value",
  },
  {
    key: "routingHint",
    envVar: "DYFJ_WORKBENCH_HINT",
    domain: "engine",
    type: "string",
    kind: "value",
  },
  {
    key: "routingTier",
    envVar: "DYFJ_WORKBENCH_TIER",
    domain: "engine",
    type: "string",
    kind: "value",
  },
  {
    key: "contextProfile",
    envVar: "DYFJ_WORKBENCH_CONTEXT_PROFILE",
    domain: "engine",
    type: "string",
    kind: "value",
  },
  {
    key: "contextTokens",
    envVar: "DYFJ_WORKBENCH_CONTEXT_TOKENS",
    domain: "engine",
    type: "number",
    kind: "value",
  },
  {
    key: "budgetTally",
    envVar: "DYFJ_BUDGET_TALLY",
    domain: "engine",
    type: "string",
    kind: "value",
  },
  {
    key: "doltHost",
    envVar: "DOLT_HOST",
    domain: "engine",
    type: "string",
    kind: "value",
  },
  {
    key: "doltPort",
    envVar: "DOLT_PORT",
    domain: "engine",
    type: "string",
    kind: "value",
  },
  {
    key: "doltUser",
    envVar: "DOLT_USER",
    domain: "engine",
    type: "string",
    kind: "value",
  },
  {
    key: "doltDatabase",
    envVar: "DOLT_DATABASE",
    domain: "engine",
    type: "string",
    kind: "value",
  },
  {
    key: "memoryMcpUrl",
    envVar: "DYFJ_MEMORY_MCP_URL",
    domain: "engine",
    type: "string",
    kind: "value",
  },
  {
    key: "memoryMcpTool",
    envVar: "DYFJ_MEMORY_MCP_TOOL",
    domain: "engine",
    type: "string",
    kind: "value",
  },
  {
    key: "frictionIssueId",
    envVar: "DYFJ_FRICTION_ISSUE_ID",
    domain: "engine",
    type: "string",
    kind: "value",
  },
  // Header NAME only (the token itself stays a secret pointer below).
  {
    key: "memoryMcpTokenHeader",
    envVar: "DYFJ_MEMORY_MCP_TOKEN_HEADER",
    domain: "engine",
    type: "string",
    kind: "value",
  },
  // ── engine: secret POINTERS (resolved at point of use; never stored here) ──
  {
    key: "anthropicApiKey",
    envVar: "ANTHROPIC_API_KEY",
    domain: "engine",
    type: "string",
    kind: "secret-pointer",
  },
  {
    key: "openaiApiKey",
    envVar: "OPENAI_API_KEY",
    domain: "engine",
    type: "string",
    kind: "secret-pointer",
  },
  {
    key: "openrouterApiKey",
    envVar: "OPENROUTER_API_KEY",
    domain: "engine",
    type: "string",
    kind: "secret-pointer",
  },
  {
    key: "geminiApiKey",
    envVar: "GEMINI_API_KEY",
    domain: "engine",
    type: "string",
    kind: "secret-pointer",
  },
  {
    key: "xaiApiKey",
    envVar: "XAI_API_KEY",
    domain: "engine",
    type: "string",
    kind: "secret-pointer",
  },
  {
    key: "doltPassword",
    envVar: "DOLT_PASSWORD",
    domain: "engine",
    type: "string",
    kind: "secret-pointer",
  },
  {
    key: "memoryMcpToken",
    envVar: "DYFJ_MEMORY_MCP_TOKEN",
    domain: "engine",
    type: "string",
    kind: "secret-pointer",
  },
  // ── engine: external-agent (ACP) runner executables and toolchain ──
  {
    key: "nodePath",
    envVar: "DYFJ_NODE_PATH",
    domain: "engine",
    type: "string",
    kind: "value",
  },
  {
    key: "codexToolchainPath",
    envVar: "DYFJ_CODEX_TOOLCHAIN_PATH",
    domain: "engine",
    type: "string",
    kind: "value",
  },
  {
    key: "codexRustupHome",
    envVar: "DYFJ_CODEX_RUSTUP_HOME",
    domain: "engine",
    type: "string",
    kind: "value",
  },
  // ── engine: session/identity — declared, but NOT config (rides the connection) ──
  {
    key: "principalId",
    envVar: "DYFJ_PRINCIPAL_ID",
    domain: "engine",
    type: "string",
    kind: "value",
    sessionState: true,
  },
  // ── client: the engine-free CLI's own slice ──
  {
    key: "socket",
    envVar: "DYFJ_SOCKET",
    domain: "client",
    type: "string",
    kind: "value",
  },
  {
    key: "workspace",
    envVar: "DYFJ_WORKSPACE",
    domain: "client",
    type: "string",
    kind: "value",
  },
  {
    key: "clientModel",
    envVar: "DYFJ_WORKBENCH_MODEL",
    domain: "client",
    type: "string",
    kind: "value",
  },
  {
    key: "clientHint",
    envVar: "DYFJ_WORKBENCH_HINT",
    domain: "client",
    type: "string",
    kind: "value",
  },
  {
    key: "clientTier",
    envVar: "DYFJ_WORKBENCH_TIER",
    domain: "client",
    type: "string",
    kind: "value",
  },
  // The trusted install root whose deno.json and .env the launched runtime uses.
  {
    key: "prototypeRoot",
    envVar: "DYFJ_PROTOTYPE_ROOT",
    domain: "client",
    type: "string",
    kind: "value",
  },
  // Launch-time grants the CLI derives for the external-agent runner.
  {
    key: "clientNodePath",
    envVar: "DYFJ_NODE_PATH",
    domain: "client",
    type: "string",
    kind: "value",
  },
  {
    key: "clientCodexToolchainPath",
    envVar: "DYFJ_CODEX_TOOLCHAIN_PATH",
    domain: "client",
    type: "string",
    kind: "value",
  },
  {
    key: "clientCodexRustupHome",
    envVar: "DYFJ_CODEX_RUSTUP_HOME",
    domain: "client",
    type: "string",
    kind: "value",
  },
  // ── test: set only by test harnesses ──
  // Per-run temp directory the test supervisor passes to test processes.
  {
    key: "testRunDir",
    envVar: "DYFJ_TEST_RUN_DIR",
    domain: "test",
    type: "string",
    kind: "value",
  },
  // Temp directory the isolated Dolt integration lane hands to the MCP tests.
  {
    key: "mcpTestTempDir",
    envVar: "DYFJ_MCP_TEST_TEMP_DIR",
    domain: "test",
    type: "string",
    kind: "value",
  },
  // ── tooling: read only by prototype/scripts (test-process-harness.ts) ──
  // Wall-clock bound, in seconds, for a supervised Vitest run.
  {
    key: "testBoundSec",
    envVar: "DYFJ_TEST_BOUND_SEC",
    domain: "tooling",
    type: "number",
    kind: "value",
  },
  // The acquire-hold helper's temp directory, lock file and result path.
  {
    key: "lockTmp",
    envVar: "DYFJ_LOCK_TMP",
    domain: "tooling",
    type: "string",
    kind: "value",
  },
  {
    key: "lockFile",
    envVar: "DYFJ_LOCK_FILE",
    domain: "tooling",
    type: "string",
    kind: "value",
  },
  {
    key: "lockResult",
    envVar: "DYFJ_LOCK_RESULT",
    domain: "tooling",
    type: "string",
    kind: "value",
  },
];

/** The env vars a given domain declares (deduped). */
export function declaredEnvVars(domain: ConfigDomain): readonly string[] {
  return [
    ...new Set(
      CONFIG_SCHEMA.filter((spec) => spec.domain === domain).map((spec) =>
        spec.envVar
      ),
    ),
  ];
}

/**
 * The env vars declared as secret POINTERS in a domain (deduped) — the only
 * keys a `[secrets.pointers]` table may name. The resolver resolves these from
 * their configured pointer at point of use; the config surface never holds the
 * value.
 */
export function declaredSecretEnvVars(
  domain: ConfigDomain = "engine",
): readonly string[] {
  return [
    ...new Set(
      CONFIG_SCHEMA.filter((spec) =>
        spec.domain === domain && spec.kind === "secret-pointer"
      ).map((spec) => spec.envVar),
    ),
  ];
}

export function schemaSpecForKey(key: string): ConfigKeySpec {
  const spec = CONFIG_SCHEMA.find((s) => s.key === key);
  if (spec === undefined) {
    throw new Error(`config: ${key} is not declared in CONFIG_SCHEMA`);
  }
  return spec;
}

export function schemaEnvVar(key: string): string {
  return schemaSpecForKey(key).envVar;
}

export function schemaNumberDefault(key: string): number {
  const spec = schemaSpecForKey(key);
  if (typeof spec.default !== "number") {
    throw new Error(`config: ${key} has no numeric default in CONFIG_SCHEMA`);
  }
  return spec.default;
}

export function schemaBooleanDefault(key: string): boolean {
  const spec = schemaSpecForKey(key);
  if (typeof spec.default !== "boolean") {
    throw new Error(`config: ${key} has no boolean default in CONFIG_SCHEMA`);
  }
  return spec.default;
}
