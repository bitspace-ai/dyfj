/**
 * config.ts — typed engine configuration: the runtime's startup posture.
 *
 * One declared surface for the defaults the engine uses when a request doesn't
 * specify. Per the configuration-system working thesis:
 *   - Secret POINTERS, never values (op:// refs / env-var names), resolved at
 *     point of use. Neither field in this first slice is a secret; the pattern
 *     is established here for the follow-on slices that fold in credentials.
 *   - Config is startup posture, NOT session state. The model for THIS turn, the
 *     workspace, and the principal ride the request — not this file. Anything the
 *     app *writes* (last-used, learned prefs) belongs in a separate app-owned
 *     state store, never here — so config.toml stays a pristine, hand-edited file
 *     and comment-preserving writes are a non-problem.
 *   - Precedence: defaults → ~/.dyfj/config.toml → environment. Per-request
 *     overrides are applied above this, at the turn boundary.
 *
 * Format: TOML — hand-edited, comments, idiomatic for the future Rust core.
 * Keep the schema FLAT / SECTIONED; TOML clunks on deep nesting.
 *
 * The TOML parser (@std/toml) is imported lazily: the module must load under the
 * node-based test runner, which can't resolve Deno jsr specifiers — and the
 * parser only runs when a real config file is read under Deno. Tests inject a
 * parser, so they exercise the precedence/validation logic without it.
 *
 * First slice threads the two daily-driver defaults (companion model, permission
 * level). Migrating the other ~25 env-read sites and deriving the deno.json
 * permission allowlist from this schema are follow-on config slices.
 */

export type PermissionLevel = "strict" | "operator";
const PERMISSION_LEVELS: readonly PermissionLevel[] = ["strict", "operator"];

export interface WorkbenchConfig {
  /**
   * Model the engine uses when a turn doesn't specify one (null → the registry's
   * local default). A frontier slug suits the companion; per-request overrides.
   */
  defaultCompanionModel: string | null;
  /**
   * Command-policy posture: "strict" = the current per-call approval gate;
   * "operator" = the usable loopback profile (honored once the permission-profile
   * work lands).
   */
  permissionLevel: PermissionLevel;
}

export const CONFIG_DEFAULTS: WorkbenchConfig = {
  defaultCompanionModel: null,
  permissionLevel: "strict",
};

/** Minimal env surface, so callers can inject a fake in tests. */
export interface ConfigEnv {
  get(key: string): string | undefined;
}

export type TomlParser = (
  raw: string,
) => Record<string, unknown> | Promise<Record<string, unknown>>;

export function configFilePath(env: ConfigEnv = Deno.env): string {
  const root = env.get("DYFJ_ROOT") ?? `${env.get("HOME") ?? "."}/.dyfj`;
  return `${root}/config.toml`;
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
      config.permissionLevel = validateLevel(fileLevel, path);
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

  return config;
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
    throw new Error(`config: cannot read ${path}: ${(err as Error).message}`);
  }
  try {
    return await parseToml(raw);
  } catch (err) {
    throw new Error(`config: failed to parse ${path}: ${(err as Error).message}`);
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

function validateLevel(value: string, source: string): PermissionLevel {
  if ((PERMISSION_LEVELS as readonly string[]).includes(value)) {
    return value as PermissionLevel;
  }
  throw new Error(
    `config: invalid permission level "${value}" from ${source} ` +
      `(expected one of: ${PERMISSION_LEVELS.join(", ")})`,
  );
}
