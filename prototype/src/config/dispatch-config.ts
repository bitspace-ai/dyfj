/**
 * The `[dispatch]` table: bounds and workspace roots for coordinator sessions
 * starting child sessions through `dispatch/*` (`BIT-907`).
 *
 *   [dispatch]
 *   max_children = 3
 *   max_wait_seconds = 50
 *   roots = ["~/projects/dyfj-worktrees"]
 *
 * Depth is fixed at 1 with no config key. Absent `[dispatch]`, none of the four
 * `dispatch/*` tools is registered: this repository ships no default root path.
 */

import { isAbsolute, resolve } from "node:path";
import { type Env, processEnv } from "./env.ts";
import { readTextFile as defaultReadTextFile } from "./read-text-file.ts";
import {
  configFilePath,
  configLabel,
  defaultParseToml,
  type LoadConfigDeps,
  readConfigFile,
} from "./toml.ts";

export interface DispatchConfig {
  /** Maximum live children (`running`, `awaiting_approval` or `idle`) per coordinator session. */
  readonly maxChildren: number;
  /** Upper bound (inclusive), in seconds, for `dispatch/wait` `timeoutSeconds`. */
  readonly maxWaitSeconds: number;
  /** Expanded absolute directory prefixes a child's `workspace` and `roots` must resolve inside. */
  readonly roots: readonly string[];
}

export const DEFAULT_DISPATCH_MAX_CHILDREN = 3;
export const DEFAULT_DISPATCH_MAX_WAIT_SECONDS = 50;

export const MIN_DISPATCH_MAX_CHILDREN = 1;
export const MAX_DISPATCH_MAX_CHILDREN = 64;
export const MIN_DISPATCH_MAX_WAIT_SECONDS = 1;
export const MAX_DISPATCH_MAX_WAIT_SECONDS = 3_600;
export const MAX_DISPATCH_CONFIG_ROOTS = 32;
const MAX_ROOT_BYTES = 4_096;

const DISPATCH_KEYS: ReadonlySet<string> = new Set([
  "max_children",
  "max_wait_seconds",
  "roots",
]);

function readBoundedInteger(
  value: unknown,
  key: string,
  fallback: number,
  min: number,
  max: number,
  where: string,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(
      `config: dispatch.${key} must be an integer in ${configLabel(where)}`,
    );
  }
  if (value < min || value > max) {
    throw new Error(
      `config: dispatch.${key} must be between ${min} and ${max} in ${configLabel(where)}`,
    );
  }
  return value;
}

function expandHomeRoot(raw: string, at: string, env: Env, where: string): string {
  if (raw === "~" || raw.startsWith("~/")) {
    const home = env.get("HOME");
    if (home === undefined || home === "" || !isAbsolute(home)) {
      throw new Error(
        `config: ${at} uses "~" but HOME is not set to an absolute path (${configLabel(where)})`,
      );
    }
    return raw === "~" ? resolve(home) : resolve(home, raw.slice(2));
  }
  return raw;
}

function parseDispatchRoots(
  value: unknown,
  env: Env,
  where: string,
): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error(
      `config: dispatch.roots must be an array of paths in ${configLabel(where)}`,
    );
  }
  if (value.length === 0) {
    throw new Error(
      `config: dispatch.roots must not be empty in ${configLabel(where)}`,
    );
  }
  if (value.length > MAX_DISPATCH_CONFIG_ROOTS) {
    throw new Error(
      `config: dispatch.roots has ${value.length} entries; the limit is ${MAX_DISPATCH_CONFIG_ROOTS} in ${configLabel(where)}`,
    );
  }
  const roots: string[] = [];
  for (const [index, entry] of value.entries()) {
    const at = `dispatch.roots[${index}]`;
    if (typeof entry !== "string" || entry === "") {
      throw new Error(
        `config: ${at} must be a non-empty string in ${configLabel(where)}`,
      );
    }
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/u.test(entry)) {
      throw new Error(
        `config: ${at} must not contain a control character in ${configLabel(where)}`,
      );
    }
    if (Buffer.byteLength(entry, "utf8") > MAX_ROOT_BYTES) {
      throw new Error(
        `config: ${at} is longer than ${MAX_ROOT_BYTES} bytes in ${configLabel(where)}`,
      );
    }
    if (entry.split(/[\\/]/u).includes("..")) {
      throw new Error(
        `config: ${at} must not contain a ".." segment in ${configLabel(where)}`,
      );
    }
    const expanded = expandHomeRoot(entry, at, env, where);
    if (!isAbsolute(expanded)) {
      throw new Error(
        `config: ${at} must be an absolute path or start with "~/" in ${configLabel(where)}`,
      );
    }
    roots.push(resolve(expanded));
  }
  return Object.freeze(roots);
}

/**
 * Parse the `[dispatch]` table. Returns null when the table is absent, leaving
 * the `dispatch/*` tools unregistered.
 */
export function parseDispatchConfig(
  table: Record<string, unknown> | null,
  where: string,
  env: Env = processEnv,
): DispatchConfig | null {
  if (table === null) return null;
  const section = table["dispatch"];
  if (section === undefined) return null;
  if (typeof section !== "object" || section === null || Array.isArray(section)) {
    throw new Error(`config: [dispatch] must be a table in ${configLabel(where)}`);
  }
  const values = section as Record<string, unknown>;
  for (const key of Object.keys(values)) {
    if (!DISPATCH_KEYS.has(key)) {
      throw new Error(
        `config: unknown key dispatch.${key} in ${configLabel(where)}`,
      );
    }
  }
  if (values["roots"] === undefined) {
    throw new Error(
      `config: dispatch.roots is required in ${configLabel(where)}`,
    );
  }
  return Object.freeze({
    maxChildren: readBoundedInteger(
      values["max_children"],
      "max_children",
      DEFAULT_DISPATCH_MAX_CHILDREN,
      MIN_DISPATCH_MAX_CHILDREN,
      MAX_DISPATCH_MAX_CHILDREN,
      where,
    ),
    maxWaitSeconds: readBoundedInteger(
      values["max_wait_seconds"],
      "max_wait_seconds",
      DEFAULT_DISPATCH_MAX_WAIT_SECONDS,
      MIN_DISPATCH_MAX_WAIT_SECONDS,
      MAX_DISPATCH_MAX_WAIT_SECONDS,
      where,
    ),
    roots: parseDispatchRoots(values["roots"], env, where),
  });
}

/** Load `[dispatch]` from the config file the environment names. */
export async function loadDispatchConfig(
  deps: LoadConfigDeps = {},
): Promise<DispatchConfig | null> {
  const env = deps.env ?? processEnv;
  const path = configFilePath(env);
  const table = await readConfigFile(
    path,
    deps.readTextFile ?? defaultReadTextFile,
    deps.parseToml ?? defaultParseToml,
  );
  return parseDispatchConfig(table, path, env);
}
