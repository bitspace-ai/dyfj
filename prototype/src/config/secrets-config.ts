/**
 * The `[secrets]` posture: secret pointers resolved at boot. The config surface
 * holds pointers only; values never live here.
 */

import { processEnv } from "./env.ts";
import { declaredSecretEnvVars } from "./schema.ts";
import {
  configFilePath,
  configLabel,
  defaultParseToml,
  type LoadConfigDeps,
  readConfigFile,
} from "./toml.ts";

// ── Secret pointers ([secrets] — resolved at boot, values never stored here) ───

/** Default resolver timeout: a locked/unavailable pointer degrades, not hangs. */
export const DEFAULT_SECRET_TIMEOUT_MS = 10_000;
const MAX_NAMED_SECRETS = 64;

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
  /** Logical secret id → pointer, resolved into a private in-memory map. */
  named?: Readonly<Record<string, string>>;
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
    "named",
    "env",
    "inherit_env",
  ]);
  for (const key of Object.keys(section)) {
    if (!SECRETS_KEYS.has(key)) {
      throw new Error(
        `config: [secrets].${key} is not a recognized key (expected: command, ` +
          `timeout_ms, pointers, named, env, inherit_env) in ${where}`,
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

  const named: Record<string, string> = {};
  const rawNamed = section["named"];
  if (rawNamed !== undefined) {
    if (
      typeof rawNamed !== "object" || rawNamed === null ||
      Array.isArray(rawNamed)
    ) {
      throw new Error(`config: [secrets.named] must be a table in ${where}`);
    }
    const entries = Object.entries(rawNamed as Record<string, unknown>);
    if (entries.length > MAX_NAMED_SECRETS) {
      throw new Error(
        `config: [secrets.named] exceeds ${MAX_NAMED_SECRETS} entries in ${where}`,
      );
    }
    for (const [name, pointer] of entries) {
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(name)) {
        throw new Error(
          `config: [secrets.named] contains an invalid logical secret name in ${where}`,
        );
      }
      if (typeof pointer !== "string" || pointer.length === 0) {
        throw new Error(
          `config: [secrets.named].${name} must be a non-empty string pointer (${where})`,
        );
      }
      named[name] = pointer;
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
          `config: [secrets].inherit_env entry ${
            JSON.stringify(name)
          } is not ` +
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

  return { command, timeoutMs, pointers, named, env, inheritEnv };
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
  const env = deps.env ?? processEnv;
  const readTextFile = deps.readTextFile ?? Deno.readTextFile;
  const parseToml = deps.parseToml ?? defaultParseToml;
  const path = configFilePath(env);
  const table = await readConfigFile(path, readTextFile, parseToml);
  return parseSecretsConfig(table, path);
}
