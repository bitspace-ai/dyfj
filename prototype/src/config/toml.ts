/**
 * The config file: `$DYFJ_ROOT/config.toml` (else `$HOME/.dyfj/config.toml`).
 *
 * Format: TOML — hand-edited, comments, idiomatic for the future Rust core.
 * Keep the schema FLAT / SECTIONED; TOML clunks on deep nesting.
 *
 * The TOML parser (@std/toml) is imported lazily: the module must load under the
 * node-based test runner, which can't resolve Deno jsr specifiers — and the
 * parser only runs when a real config file is read under Deno. Node-runner
 * tests inject a parser; a Deno integration test covers the real TOML parser.
 */

import { type Env, processEnv } from "./env.ts";

export type TomlParser = (
  raw: string,
) => Record<string, unknown> | Promise<Record<string, unknown>>;

export function configFilePath(env: Env = processEnv): string {
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
export function configLabel(path: string): string {
  // Strip both POSIX and Windows separators so a backslash path can't slip the
  // full absolute path (with account/private layout) through as the "basename".
  return path.split(/[/\\]/).pop() || "config.toml";
}

export interface LoadConfigDeps {
  env?: Env;
  readTextFile?: (path: string) => Promise<string>;
  parseToml?: TomlParser;
}

/** Lazy default parser: jsr import resolves under Deno, never runs under vitest. */
export async function defaultParseToml(
  raw: string,
): Promise<Record<string, unknown>> {
  const { parse } = await import("@std/toml");
  return parse(raw) as Record<string, unknown>;
}

export async function readConfigFile(
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
    throw new Error(
      `config: cannot read ${configLabel(path)} (${(err as Error).name})`,
    );
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

export function readString(
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

export function readBoolean(
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

export function readNumber(
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
