/**
 * config.ts — typed configuration: the system's startup posture.
 *
 * One declared surface for the defaults the system uses when a request doesn't
 * specify. Per the configuration-system working thesis:
 *   - Secret POINTERS, never values (op:// refs / env-var names), resolved at
 *     point of use. Keys carrying credentials are declared `secret-pointer`; the
 *     config surface never stores the plaintext value.
 *   - Engine vs client DOMAINS. The engine owns runtime/data/secret config; the
 *     engine-free CLI owns its own slice (server URL, socket, routing prefs). The
 *     `CONFIG_SCHEMA` registry tags each key with its domain so the two slices
 *     stay distinct (the thin client never loads the engine's schema).
 *   - Config is startup posture, NOT session state. The model for THIS turn, the
 *     workspace, and the principal ride the request — not this file. Anything the
 *     app *writes* (last-used, learned prefs) belongs in a separate app-owned
 *     state store, never here — so config.toml stays a pristine, hand-edited file
 *     and comment-preserving writes are a non-problem.
 *   - Precedence: defaults → ~/.dyfj/config.toml → environment → per-request
 *     overrides (the last applied above this, at the turn boundary).
 *   - ONE declared surface the permission allowlist derives from. `CONFIG_SCHEMA`
 *     is the single source of truth for the engine env surface; a parity test
 *     asserts the `deno.json` permission `env` profiles against it, so the
 *     allowlist-drift class of bug (a runtime env var present in one profile and
 *     missing from another) is caught structurally, not band-aided.
 *
 * Format: TOML — hand-edited, comments, idiomatic for the future Rust core.
 * Keep the schema FLAT / SECTIONED; TOML clunks on deep nesting.
 *
 * The TOML parser (@std/toml) is imported lazily: the module must load under the
 * node-based test runner, which can't resolve Deno jsr specifiers — and the
 * parser only runs when a real config file is read under Deno. Tests inject a
 * parser, so they exercise the precedence/validation logic without it.
 *
 * `WorkbenchConfig` + `loadConfig` thread the daily-driver engine defaults that
 * carry a config-file layer today (companion model, permission level). The budget
 * defaults are declared in `CONFIG_SCHEMA` and resolved from the environment at
 * the runtime boundary (`resolveBudgetDefaultsFromEnv`); their config-FILE layer
 * and the loadConfig-everywhere wiring for the CLI/HTTP entrypoints are the next
 * config slice. Migrating the remaining env-read sites onto the declared surface
 * continues incrementally.
 */

export type PermissionLevel = "strict" | "operator";
const PERMISSION_LEVELS: readonly PermissionLevel[] = ["strict", "operator"];

// ── Declared key registry ─────────────────────────────────────────────────────

/**
 * Which slice owns a key. The engine owns runtime/data/secret config; the
 * engine-free CLI client owns its own transport/routing slice. One system, two
 * domains — so the thin client never has to load the engine's schema.
 */
export type ConfigDomain = "engine" | "client";

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
  { key: "root", envVar: "DYFJ_ROOT", domain: "engine", type: "string", kind: "value" },
  { key: "routingHint", envVar: "DYFJ_WORKBENCH_HINT", domain: "engine", type: "string", kind: "value" },
  { key: "routingTier", envVar: "DYFJ_WORKBENCH_TIER", domain: "engine", type: "string", kind: "value" },
  { key: "contextProfile", envVar: "DYFJ_WORKBENCH_CONTEXT_PROFILE", domain: "engine", type: "string", kind: "value" },
  { key: "contextTokens", envVar: "DYFJ_WORKBENCH_CONTEXT_TOKENS", domain: "engine", type: "number", kind: "value" },
  { key: "budgetTally", envVar: "DYFJ_BUDGET_TALLY", domain: "engine", type: "string", kind: "value" },
  { key: "doltHost", envVar: "DOLT_HOST", domain: "engine", type: "string", kind: "value" },
  { key: "doltPort", envVar: "DOLT_PORT", domain: "engine", type: "string", kind: "value" },
  { key: "doltUser", envVar: "DOLT_USER", domain: "engine", type: "string", kind: "value" },
  { key: "doltDatabase", envVar: "DOLT_DATABASE", domain: "engine", type: "string", kind: "value" },
  { key: "memoryMcpUrl", envVar: "DYFJ_MEMORY_MCP_URL", domain: "engine", type: "string", kind: "value" },
  { key: "memoryMcpTool", envVar: "DYFJ_MEMORY_MCP_TOOL", domain: "engine", type: "string", kind: "value" },
  // Header NAME only (the token itself stays a secret pointer below).
  { key: "memoryMcpTokenHeader", envVar: "DYFJ_MEMORY_MCP_TOKEN_HEADER", domain: "engine", type: "string", kind: "value" },
  // ── engine: HTTP-transport-specific (only the workbench-http profile) ──
  { key: "httpHost", envVar: "DYFJ_WORKBENCH_HTTP_HOST", domain: "engine", type: "string", kind: "value" },
  { key: "httpPort", envVar: "DYFJ_WORKBENCH_HTTP_PORT", domain: "engine", type: "string", kind: "value" },
  { key: "httpAllowedHosts", envVar: "DYFJ_WORKBENCH_ALLOWED_HOSTS", domain: "engine", type: "string", kind: "value" },
  // ── engine: secret POINTERS (resolved at point of use; never stored here) ──
  { key: "anthropicApiKey", envVar: "ANTHROPIC_API_KEY", domain: "engine", type: "string", kind: "secret-pointer" },
  { key: "openaiApiKey", envVar: "OPENAI_API_KEY", domain: "engine", type: "string", kind: "secret-pointer" },
  { key: "geminiApiKey", envVar: "GEMINI_API_KEY", domain: "engine", type: "string", kind: "secret-pointer" },
  { key: "doltPassword", envVar: "DOLT_PASSWORD", domain: "engine", type: "string", kind: "secret-pointer" },
  { key: "memoryMcpToken", envVar: "DYFJ_MEMORY_MCP_TOKEN", domain: "engine", type: "string", kind: "secret-pointer" },
  { key: "httpApiKey", envVar: "DYFJ_WORKBENCH_API_KEY", domain: "engine", type: "string", kind: "secret-pointer" },
  // ── engine: session/identity — declared, but NOT config (rides the connection) ──
  { key: "principalId", envVar: "DYFJ_PRINCIPAL_ID", domain: "engine", type: "string", kind: "value", sessionState: true },
  // ── client: the engine-free CLI's own slice ──
  { key: "serverUrl", envVar: "DYFJ_SERVER_URL", domain: "client", type: "string", kind: "value" },
  { key: "socket", envVar: "DYFJ_SOCKET", domain: "client", type: "string", kind: "value" },
  { key: "workspace", envVar: "DYFJ_WORKSPACE", domain: "client", type: "string", kind: "value" },
  { key: "unix", envVar: "DYFJ_UNIX", domain: "client", type: "string", kind: "value" },
  { key: "clientApiKey", envVar: "DYFJ_WORKBENCH_API_KEY", domain: "client", type: "string", kind: "secret-pointer" },
  { key: "clientModel", envVar: "DYFJ_WORKBENCH_MODEL", domain: "client", type: "string", kind: "value" },
  { key: "clientHint", envVar: "DYFJ_WORKBENCH_HINT", domain: "client", type: "string", kind: "value" },
  { key: "clientTier", envVar: "DYFJ_WORKBENCH_TIER", domain: "client", type: "string", kind: "value" },
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

function schemaSpecForKey(key: string): ConfigKeySpec {
  const spec = CONFIG_SCHEMA.find((s) => s.key === key);
  if (spec === undefined) {
    throw new Error(`config: ${key} is not declared in CONFIG_SCHEMA`);
  }
  return spec;
}

function schemaEnvVar(key: string): string {
  return schemaSpecForKey(key).envVar;
}

function schemaNumberDefault(key: string): number {
  const spec = schemaSpecForKey(key);
  if (typeof spec.default !== "number") {
    throw new Error(`config: ${key} has no numeric default in CONFIG_SCHEMA`);
  }
  return spec.default;
}

function schemaBooleanDefault(key: string): boolean {
  const spec = schemaSpecForKey(key);
  if (typeof spec.default !== "boolean") {
    throw new Error(`config: ${key} has no boolean default in CONFIG_SCHEMA`);
  }
  return spec.default;
}

export interface WorkbenchConfig {
  /**
   * Model the engine uses when a turn doesn't specify one (null → the registry's
   * local default). A frontier slug suits the companion; per-request overrides.
   */
  defaultCompanionModel: string | null;
  /**
   * Command-policy posture: "strict" = the current per-call approval gate;
   * "operator" = auto-approves contained mutating tools (local, free,
   * workspace-write) on a loopback turn; paid/networked/exec tools still prompt.
   */
  permissionLevel: PermissionLevel;
  /**
   * Standing paid-inference posture on loopback turns: when a request omits
   * approvePaidInference, the engine falls back to this default (explicit
   * per-turn opt-in/out always wins). Non-loopback transports never inherit it.
   */
  approvePaidDefault: boolean;
  /** Default max total USD spend across a session (startup posture). */
  defaultSessionBudgetUsd: number;
  /** Default max USD spend for a single API call (startup posture). */
  defaultPerCallBudgetUsd: number;
  /** Default max total USD spend across all sessions in a local day (startup posture). */
  defaultDailyBudgetUsd: number;
  /**
   * Runaway-anomaly hard-stop multiples. Unlike the envelopes (soft,
   * confirmable, scope-persistent), the anomaly gate halts on ACTUAL recorded
   * spend and its confirmations never persist. Multiples rather than dollar
   * knobs so they scale when the envelopes are retuned.
   */
  anomalyTurnMultiple: number;
  anomalyScopeMultiple: number;
}

export const CONFIG_DEFAULTS: WorkbenchConfig = {
  defaultCompanionModel: null,
  permissionLevel: "strict",
  approvePaidDefault: schemaBooleanDefault("approvePaidDefault"),
  defaultSessionBudgetUsd: schemaNumberDefault("defaultSessionBudgetUsd"),
  defaultPerCallBudgetUsd: schemaNumberDefault("defaultPerCallBudgetUsd"),
  defaultDailyBudgetUsd: schemaNumberDefault("defaultDailyBudgetUsd"),
  anomalyTurnMultiple: schemaNumberDefault("anomalyTurnMultiple"),
  anomalyScopeMultiple: schemaNumberDefault("anomalyScopeMultiple"),
};

/** Minimal env surface, so callers can inject a fake in tests. */
export interface ConfigEnv {
  get(key: string): string | undefined;
}

export type TomlParser = (
  raw: string,
) => Record<string, unknown> | Promise<Record<string, unknown>>;

export function configFilePath(env: ConfigEnv = Deno.env): string {
  // Treat an EMPTY DYFJ_ROOT as absent, not as "/" — otherwise an explicitly
  // empty value would resolve `/config.toml`. This also keeps the child in step
  // with the launcher's `readLauncherSecretsConfig`, which already treats "" as
  // absent; a divergence there would silently disable the child's resolver while
  // the launcher still grants its binary.
  const rootEnv = env.get("DYFJ_ROOT");
  const root = rootEnv !== undefined && rootEnv !== ""
    ? rootEnv
    : `${env.get("HOME") ?? "."}/.dyfj`;
  return `${root}/config.toml`;
}

/**
 * A stable, public-safe label for the config file in error messages — the
 * basename only. Config-load/validation errors reach boot stderr, and an
 * absolute path commonly carries the local account name and private filesystem
 * layout; that private-class detail must not egress there.
 */
function configLabel(path: string): string {
  // Strip both POSIX and Windows separators so a backslash path can't slip the
  // full absolute path (with account/private layout) through as the "basename".
  return path.split(/[/\\]/).pop() || "config.toml";
}

export interface LoadConfigDeps {
  env?: ConfigEnv;
  readTextFile?: (path: string) => Promise<string>;
  parseToml?: TomlParser;
}

/**
 * Resolve the engine config with precedence defaults → file → env. A missing
 * file is fine (defaults). A malformed file or an invalid value throws — fail
 * loud at startup rather than silently mis-configure the runtime.
 */
export async function loadConfig(
  deps: LoadConfigDeps = {},
): Promise<WorkbenchConfig> {
  const env = deps.env ?? Deno.env;
  const readTextFile = deps.readTextFile ?? Deno.readTextFile;
  const parseToml = deps.parseToml ?? defaultParseToml;
  const path = configFilePath(env);

  const config: WorkbenchConfig = { ...CONFIG_DEFAULTS };

  // ── file layer ──
  const table = await readConfigFile(path, readTextFile, parseToml);
  if (table) {
    const fileModel = readString(table, "companion", "default_model");
    if (fileModel !== undefined && fileModel !== "") {
      config.defaultCompanionModel = fileModel;
    }
    const fileLevel = readString(table, "permissions", "level");
    if (fileLevel !== undefined) {
      config.permissionLevel = validateLevel(fileLevel, configLabel(path));
    }
    const fileApprovePaid = readBoolean(table, "paid", "approve_paid_default");
    if (fileApprovePaid !== undefined) {
      config.approvePaidDefault = fileApprovePaid;
    }
    const fileSessionBudget = readNumber(
      table,
      "budget",
      "session_limit_usd",
    );
    if (fileSessionBudget !== undefined) {
      config.defaultSessionBudgetUsd = validatePositiveUsd(
        fileSessionBudget,
        `${configLabel(path)} [budget].session_limit_usd`,
      );
    }
    const fileDailyBudget = readNumber(
      table,
      "budget",
      "daily_limit_usd",
    );
    if (fileDailyBudget !== undefined) {
      config.defaultDailyBudgetUsd = validatePositiveUsd(
        fileDailyBudget,
        `${configLabel(path)} [budget].daily_limit_usd`,
      );
    }
    const filePerCallBudget = readNumber(
      table,
      "budget",
      "per_call_limit_usd",
    );
    if (filePerCallBudget !== undefined) {
      config.defaultPerCallBudgetUsd = validatePositiveUsd(
        filePerCallBudget,
        `${configLabel(path)} [budget].per_call_limit_usd`,
      );
    }
    const fileTurnMultiple = readNumber(table, "anomaly", "turn_multiple");
    if (fileTurnMultiple !== undefined) {
      config.anomalyTurnMultiple = validatePositiveMultiple(
        fileTurnMultiple,
        `${configLabel(path)} [anomaly].turn_multiple`,
      );
    }
    const fileScopeMultiple = readNumber(table, "anomaly", "scope_multiple");
    if (fileScopeMultiple !== undefined) {
      config.anomalyScopeMultiple = validatePositiveMultiple(
        fileScopeMultiple,
        `${configLabel(path)} [anomaly].scope_multiple`,
      );
    }
  }

  // ── env layer (overrides the file) ──
  const envModel = env.get("DYFJ_WORKBENCH_MODEL");
  if (envModel !== undefined && envModel !== "") {
    config.defaultCompanionModel = envModel;
  }
  const envLevel = env.get("DYFJ_PERMISSION_LEVEL");
  if (envLevel !== undefined && envLevel !== "") {
    config.permissionLevel = validateLevel(envLevel, "DYFJ_PERMISSION_LEVEL");
  }
  const envApprovePaid = env.get(schemaEnvVar("approvePaidDefault"));
  if (envApprovePaid !== undefined && envApprovePaid !== "") {
    config.approvePaidDefault = parseBooleanEnv(
      envApprovePaid,
      schemaEnvVar("approvePaidDefault"),
    );
  }
  config.defaultSessionBudgetUsd = readPositiveUsd(
    env,
    schemaEnvVar("defaultSessionBudgetUsd"),
    config.defaultSessionBudgetUsd,
  );
  config.defaultPerCallBudgetUsd = readPositiveUsd(
    env,
    schemaEnvVar("defaultPerCallBudgetUsd"),
    config.defaultPerCallBudgetUsd,
  );
  config.defaultDailyBudgetUsd = readPositiveUsd(
    env,
    schemaEnvVar("defaultDailyBudgetUsd"),
    config.defaultDailyBudgetUsd,
  );
  config.anomalyTurnMultiple = readPositiveMultiple(
    env,
    schemaEnvVar("anomalyTurnMultiple"),
    config.anomalyTurnMultiple,
  );
  config.anomalyScopeMultiple = readPositiveMultiple(
    env,
    schemaEnvVar("anomalyScopeMultiple"),
    config.anomalyScopeMultiple,
  );

  return config;
}

// ── Secret pointers ([secrets] — resolved at boot, values never stored here) ───

/** Default resolver timeout: a locked/unavailable pointer degrades, not hangs. */
export const DEFAULT_SECRET_TIMEOUT_MS = 10_000;

/**
 * Env names `[secrets.env]` may NOT set: overriding these would either break the
 * resolver (it needs the real PATH/HOME to find its binary and session) or be a
 * code-injection vector. A real credential (e.g. a service-account token) is not
 * on this list but must still live in the launch scope, not the config file.
 */
const SECRETS_ENV_DENYLIST: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
]);

/**
 * A literal Unix environment-variable name. `inherit_env` names are serialized
 * into the runtime's `--allow-env`, where a metacharacter like `*` is a Deno
 * WILDCARD granting the whole environment — so only exact identifiers are
 * allowed. `[secrets.env]` keys are held to the same shape for good measure.
 */
const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The `[secrets]` posture: a vendor-neutral resolver command and the pointers
 * it resolves, keyed by declared secret env var. `op read` is one choice — which
 * secret manager is a config choice, not hardcoded. But the command itself is a
 * TRUSTED EXECUTABLE: the launcher grants its binary `--allow-run` and the engine
 * runs it at boot, so `config.toml` is an executable-trust boundary (a shell
 * command runs arbitrary code). The pointer is passed as the command's final
 * argument; the command prints the secret value to stdout. Only env vars declared
 * `secret-pointer` in `CONFIG_SCHEMA` may be named.
 */
export interface SecretsConfig {
  /** Resolver command argv; the pointer is appended as the final argument. */
  command: readonly string[];
  /** Max ms to await the command before killing it (kept non-interactive). */
  timeoutMs: number;
  /** envVar → pointer string, restricted to declared secret env vars. */
  pointers: Readonly<Record<string, string>>;
  /**
   * NON-secret env vars set only on the spawned resolver command, on top of the
   * minimal isolated base. A plaintext surface — a real secret must not live
   * here; it belongs in the launch scope, forwarded via `inheritEnv`. Empty when
   * `[secrets.env]` is absent.
   */
  env: Readonly<Record<string, string>>;
  /**
   * Names of AMBIENT env vars to forward from the runtime into the resolver's
   * otherwise-isolated environment (the resolver spawns with `clearEnv`, seeing
   * only a minimal base + these + `env`). This is how a launch-scope resolver
   * secret (e.g. a service-account token) reaches the resolver without the
   * resolver also inheriting the runtime's provider keys / database password /
   * memory token. Same denylist + declared-secret rules as `[secrets.env]`.
   */
  inheritEnv: readonly string[];
}

/**
 * Parse and validate a `[secrets]` table. Returns null when the section is
 * absent (no resolution — providers read whatever env supplies). A present but
 * malformed section throws: a mis-declared secret resolver should fail the boot
 * loudly, not silently leave a provider credential-less.
 */
export function parseSecretsConfig(
  table: Record<string, unknown> | null,
  path: string,
): SecretsConfig | null {
  if (!table) return null;
  // Keep [secrets] validation errors PATH-FREE: they propagate to boot stderr,
  // and an absolute config path commonly carries the local account name and
  // private filesystem layout. Report a stable public-safe label instead.
  const where = configLabel(path);
  const sec = table["secrets"];
  if (sec === undefined) return null;
  if (typeof sec !== "object" || sec === null || Array.isArray(sec)) {
    throw new Error(`config: [secrets] must be a table in ${where}`);
  }
  const section = sec as Record<string, unknown>;

  // Reject unknown keys so a typo (e.g. `timeouts_ms`) fails loud rather than
  // silently falling back to a default — matching the fail-loud posture.
  const SECRETS_KEYS = new Set([
    "command",
    "timeout_ms",
    "pointers",
    "env",
    "inherit_env",
  ]);
  for (const key of Object.keys(section)) {
    if (!SECRETS_KEYS.has(key)) {
      throw new Error(
        `config: [secrets].${key} is not a recognized key (expected: command, ` +
          `timeout_ms, pointers, env, inherit_env) in ${where}`,
      );
    }
  }

  const rawCommand = section["command"];
  if (rawCommand === undefined) {
    throw new Error(
      `config: [secrets].command is required when [secrets] is present (${where})`,
    );
  }
  if (
    !Array.isArray(rawCommand) || rawCommand.length === 0 ||
    !rawCommand.every((c) => typeof c === "string" && c.length > 0)
  ) {
    throw new Error(
      `config: [secrets].command must be a non-empty array of non-empty strings (${where})`,
    );
  }
  const command = rawCommand as string[];

  let timeoutMs = DEFAULT_SECRET_TIMEOUT_MS;
  const rawTimeout = section["timeout_ms"];
  if (rawTimeout !== undefined) {
    if (
      typeof rawTimeout !== "number" || !Number.isFinite(rawTimeout) ||
      rawTimeout <= 0
    ) {
      throw new Error(
        `config: [secrets].timeout_ms must be a positive number (${where})`,
      );
    }
    timeoutMs = rawTimeout;
  }

  const pointers: Record<string, string> = {};
  const rawPointers = section["pointers"];
  if (rawPointers !== undefined) {
    if (
      typeof rawPointers !== "object" || rawPointers === null ||
      Array.isArray(rawPointers)
    ) {
      throw new Error(`config: [secrets.pointers] must be a table in ${where}`);
    }
    const allowed = new Set(declaredSecretEnvVars());
    for (
      const [envVar, ptr] of Object.entries(
        rawPointers as Record<string, unknown>,
      )
    ) {
      if (!allowed.has(envVar)) {
        throw new Error(
          `config: [secrets.pointers].${envVar} is not a declared secret env ` +
            `var (expected one of: ${[...allowed].join(", ")}) in ${where}`,
        );
      }
      if (typeof ptr !== "string" || ptr.length === 0) {
        throw new Error(
          `config: [secrets.pointers].${envVar} must be a non-empty string ` +
            `pointer (${where})`,
        );
      }
      pointers[envVar] = ptr;
    }
  }

  // `[secrets.env]`: NON-secret env vars set only on the spawned resolver
  // command (never the runtime env, never as a pointer). This is the declarative
  // zero-prompt path for unattended surfaces — e.g. point the resolver at a
  // service account / disable an interactive unlock — with no vendor-specific
  // code in the engine. It is a PLAINTEXT surface: a real secret must NOT live
  // here; it belongs in the launch scope, inherited by the resolver. The engine
  // can only enforce this for names it KNOWS are secret (declared secret-pointer
  // keys, rejected below) — the docs carry the rest of the contract.
  const env: Record<string, string> = {};
  const rawEnv = section["env"];
  if (rawEnv !== undefined) {
    if (
      typeof rawEnv !== "object" || rawEnv === null || Array.isArray(rawEnv)
    ) {
      throw new Error(`config: [secrets.env] must be a table in ${where}`);
    }
    const declaredSecrets = new Set(declaredSecretEnvVars());
    for (
      const [name, value] of Object.entries(rawEnv as Record<string, unknown>)
    ) {
      if (typeof value !== "string") {
        throw new Error(
          `config: [secrets.env].${name} must be a string in ${where}`,
        );
      }
      if (!ENV_VAR_NAME.test(name)) {
        throw new Error(
          `config: [secrets.env].${name} is not a valid environment variable ` +
            `name in ${where}`,
        );
      }
      if (SECRETS_ENV_DENYLIST.has(name)) {
        throw new Error(
          `config: [secrets.env].${name} is not allowed — it would override a ` +
            `security-relevant inherited variable. Set it in the launch scope, ` +
            `not the config file (${where})`,
        );
      }
      if (declaredSecrets.has(name)) {
        throw new Error(
          `config: [secrets.env].${name} is a declared secret — put it in ` +
            `[secrets.pointers] as a pointer, never as a plaintext value (${where})`,
        );
      }
      env[name] = value;
    }
  }

  // `[secrets].inherit_env`: names of ambient vars to forward into the resolver's
  // otherwise-isolated environment. Same denylist + declared-secret rules as
  // [secrets.env] — you can forward a launch-scope resolver secret by name, but
  // not a runtime provider key / DB password / memory token.
  const inheritEnv: string[] = [];
  const rawInherit = section["inherit_env"];
  if (rawInherit !== undefined) {
    if (!Array.isArray(rawInherit)) {
      throw new Error(
        `config: [secrets].inherit_env must be an array of strings in ${where}`,
      );
    }
    const declaredSecrets = new Set(declaredSecretEnvVars());
    for (const name of rawInherit) {
      if (typeof name !== "string" || name.length === 0) {
        throw new Error(
          `config: [secrets].inherit_env entries must be non-empty strings ` +
            `in ${where}`,
        );
      }
      if (!ENV_VAR_NAME.test(name)) {
        // Reject metacharacters (e.g. `*`) that Deno's --allow-env would treat
        // as a wildcard granting the whole environment.
        throw new Error(
          `config: [secrets].inherit_env entry ${JSON.stringify(name)} is not ` +
            `a valid environment variable name in ${where}`,
        );
      }
      if (SECRETS_ENV_DENYLIST.has(name)) {
        throw new Error(
          `config: [secrets].inherit_env may not name ${name} — it is part of ` +
            `the resolver's isolated base or a code-injection vector (${where})`,
        );
      }
      if (declaredSecrets.has(name)) {
        throw new Error(
          `config: [secrets].inherit_env may not name the declared secret ` +
            `${name} — the resolver resolves it, it must not receive it (${where})`,
        );
      }
      inheritEnv.push(name);
    }
  }

  return { command, timeoutMs, pointers, env, inheritEnv };
}

/**
 * Load the `[secrets]` posture from `~/.dyfj/config.toml`. Shares the file read
 * and parser with `loadConfig`; a missing file (or absent section) yields null.
 * The values are resolved later, at point of use, by the secrets resolver —
 * this returns only the declared pointers, never a secret value.
 */
export async function loadSecretsConfig(
  deps: LoadConfigDeps = {},
): Promise<SecretsConfig | null> {
  const env = deps.env ?? Deno.env;
  const readTextFile = deps.readTextFile ?? Deno.readTextFile;
  const parseToml = deps.parseToml ?? defaultParseToml;
  const path = configFilePath(env);
  const table = await readConfigFile(path, readTextFile, parseToml);
  return parseSecretsConfig(table, path);
}

/** Lazy default parser: jsr import resolves under Deno, never runs under vitest. */
async function defaultParseToml(raw: string): Promise<Record<string, unknown>> {
  const { parse } = await import("@std/toml");
  return parse(raw) as Record<string, unknown>;
}

async function readConfigFile(
  path: string,
  readTextFile: (path: string) => Promise<string>,
  parseToml: TomlParser,
): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await readTextFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null; // no file → defaults
    // Path-free: the error category, not the raw message (which repeats the path).
    throw new Error(`config: cannot read ${configLabel(path)} (${(err as Error).name})`);
  }
  try {
    return await parseToml(raw);
  } catch (err) {
    // The parser message describes the TOML syntax error, not the path; the
    // leading label is path-free.
    throw new Error(
      `config: failed to parse ${configLabel(path)}: ${(err as Error).message}`,
    );
  }
}

function readString(
  table: Record<string, unknown>,
  section: string,
  key: string,
): string | undefined {
  const sec = table[section];
  if (sec === undefined) return undefined;
  if (typeof sec !== "object" || sec === null) {
    throw new Error(`config: [${section}] must be a table`);
  }
  const val = (sec as Record<string, unknown>)[key];
  if (val === undefined) return undefined;
  if (typeof val !== "string") {
    throw new Error(`config: ${section}.${key} must be a string`);
  }
  return val;
}

function readBoolean(
  table: Record<string, unknown>,
  section: string,
  key: string,
): boolean | undefined {
  const sec = table[section];
  if (sec === undefined) return undefined;
  if (typeof sec !== "object" || sec === null) {
    throw new Error(`config: [${section}] must be a table`);
  }
  const val = (sec as Record<string, unknown>)[key];
  if (val === undefined) return undefined;
  if (typeof val !== "boolean") {
    throw new Error(`config: ${section}.${key} must be a boolean`);
  }
  return val;
}

function readNumber(
  table: Record<string, unknown>,
  section: string,
  key: string,
): number | undefined {
  const sec = table[section];
  if (sec === undefined) return undefined;
  if (typeof sec !== "object" || sec === null) {
    throw new Error(`config: [${section}] must be a table`);
  }
  const val = (sec as Record<string, unknown>)[key];
  if (val === undefined) return undefined;
  if (typeof val !== "number" || !Number.isFinite(val)) {
    throw new Error(`config: ${section}.${key} must be a number`);
  }
  return val;
}

function validatePositiveUsd(value: number, source: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `config: invalid USD value from ${source} (expected a non-negative number)`,
    );
  }
  return value;
}

// Strictly positive: a zero multiple would halt every paid call the moment any
// spend exists — if the operator wants that, they should say so with a tiny
// envelope, not a degenerate multiple. There is deliberately no disable knob.
function validatePositiveMultiple(value: number, source: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `config: invalid multiple from ${source} (expected a positive number)`,
    );
  }
  return value;
}

function parseBooleanEnv(raw: string, source: string): boolean {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no") {
    return false;
  }
  throw new Error(
    `config: invalid boolean "${raw}" from ${source} ` +
      `(expected true/false, 1/0, or yes/no)`,
  );
}

function validateLevel(value: string, source: string): PermissionLevel {
  if ((PERMISSION_LEVELS as readonly string[]).includes(value)) {
    return value as PermissionLevel;
  }
  throw new Error(
    `config: invalid permission level "${value}" from ${source} ` +
      `(expected one of: ${PERMISSION_LEVELS.join(", ")})`,
  );
}

// ── Budget defaults (declared in CONFIG_SCHEMA; env layer at the boundary) ─────

export interface BudgetDefaults {
  /** Default max total USD spend across a session. */
  sessionLimitUsd: number;
  /** Default max USD spend for a single API call (estimated from input tokens). */
  perCallLimitUsd: number;
  /** Default max total USD spend across all sessions in a local day. */
  dailyLimitUsd: number;
}

/** The declared budget defaults — the single source for the limit numbers. */
export const BUDGET_DEFAULTS: BudgetDefaults = {
  sessionLimitUsd: schemaNumberDefault("defaultSessionBudgetUsd"),
  perCallLimitUsd: schemaNumberDefault("defaultPerCallBudgetUsd"),
  dailyLimitUsd: schemaNumberDefault("defaultDailyBudgetUsd"),
};

function readPositiveUsd(
  env: ConfigEnv,
  envVar: string,
  fallback: number,
): number {
  const raw = env.get(envVar);
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `config: invalid USD value "${raw}" from ${envVar} ` +
        `(expected a non-negative number)`,
    );
  }
  return value;
}

/**
 * Resolve the budget defaults from the environment against the declared surface
 * (defaults → env). This is the boundary resolver the runtime entrypoints use so
 * the core reads no env; the config-FILE layer for budget is the next slice.
 */
export function resolveBudgetDefaultsFromEnv(
  env: ConfigEnv = Deno.env,
): BudgetDefaults {
  return {
    sessionLimitUsd: readPositiveUsd(
      env,
      schemaEnvVar("defaultSessionBudgetUsd"),
      BUDGET_DEFAULTS.sessionLimitUsd,
    ),
    perCallLimitUsd: readPositiveUsd(
      env,
      schemaEnvVar("defaultPerCallBudgetUsd"),
      BUDGET_DEFAULTS.perCallLimitUsd,
    ),
    dailyLimitUsd: readPositiveUsd(
      env,
      schemaEnvVar("defaultDailyBudgetUsd"),
      BUDGET_DEFAULTS.dailyLimitUsd,
    ),
  };
}

// ── Anomaly defaults (declared in CONFIG_SCHEMA; env layer at the boundary) ────

export interface AnomalyDefaults {
  /** Turn hard stop: halt when a turn's actual spend exceeds this × per-call limit. */
  turnMultiple: number;
  /** Scope hard stop: halt when actual session/daily spend exceeds this × the envelope. */
  scopeMultiple: number;
}

/** The declared anomaly defaults — the single source for the multiples. */
export const ANOMALY_DEFAULTS: AnomalyDefaults = {
  turnMultiple: schemaNumberDefault("anomalyTurnMultiple"),
  scopeMultiple: schemaNumberDefault("anomalyScopeMultiple"),
};

function readPositiveMultiple(
  env: ConfigEnv,
  envVar: string,
  fallback: number,
): number {
  const raw = env.get(envVar);
  if (raw === undefined || raw.trim() === "") return fallback;
  // Number(), not parseFloat(): "2x" must fail loud, not silently become 2 —
  // a mis-set hard-stop knob should never half-parse into a different stop.
  const value = Number(raw.trim());
  return validatePositiveMultiple(value, envVar);
}

/**
 * Resolve the anomaly multiples from the environment against the declared
 * surface (defaults → env), mirroring resolveBudgetDefaultsFromEnv: the
 * boundary resolves once; the core reads no env.
 */
export function resolveAnomalyDefaultsFromEnv(
  env: ConfigEnv = Deno.env,
): AnomalyDefaults {
  return {
    turnMultiple: readPositiveMultiple(
      env,
      schemaEnvVar("anomalyTurnMultiple"),
      ANOMALY_DEFAULTS.turnMultiple,
    ),
    scopeMultiple: readPositiveMultiple(
      env,
      schemaEnvVar("anomalyScopeMultiple"),
      ANOMALY_DEFAULTS.scopeMultiple,
    ),
  };
}

// ── Principal (session/identity — NOT config) ─────────────────────────────────

/**
 * Resolve the runtime principal id from the environment, in one place. Per the
 * config thesis the principal is session/connection state, not config — it is
 * resolved here only at the process boundary (and as a deep fallback) until
 * connection-derived identity replaces the static env var.
 */
export function resolvePrincipalId(env: ConfigEnv = Deno.env): string {
  return env.get("DYFJ_PRINCIPAL_ID") ?? env.get("USER") ?? "user";
}
