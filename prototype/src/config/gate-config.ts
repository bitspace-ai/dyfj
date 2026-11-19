import { type Env, processEnv } from "./env.ts";
import { readTextFile } from "./read-text-file.ts";
import {
  configFilePath,
  configLabel,
  defaultParseToml,
  type LoadConfigDeps,
  readConfigFile,
} from "./toml.ts";

const MODE_KEYS = { full: "command", files: "files_command", fast: "fast_command" } as const;
export type GateMode = keyof typeof MODE_KEYS;

export interface GateConfig {
  readonly commands: Readonly<Partial<Record<GateMode, readonly string[]>>>;
  readonly timeoutSeconds: number;
}

/** Missing command disables the tools; present malformed settings still fail boot. */
export function parseGateConfig(
  table: Record<string, unknown> | null,
  where: string,
): GateConfig | null {
  const section = table?.gate;
  if (section === undefined) return null;
  if (typeof section !== "object" || section === null || Array.isArray(section)) {
    throw new Error(`config: [gate] must be a table in ${configLabel(where)}`);
  }
  const values = section as Record<string, unknown>;
  const keys: readonly string[] = [...Object.values(MODE_KEYS), "timeout_seconds"];
  for (const key of Object.keys(values)) {
    if (!keys.includes(key)) {
      throw new Error(`config: unknown key gate.${key} in ${configLabel(where)}`);
    }
  }
  const commands: Partial<Record<GateMode, readonly string[]>> = {};
  for (const mode of Object.keys(MODE_KEYS) as GateMode[]) {
    const key = MODE_KEYS[mode];
    const value = values[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.length === 0 ||
        value.some((word) => typeof word !== "string" || word.includes("\0")) ||
        typeof value[0] !== "string" || value[0].trim() === "") {
      throw new Error(`config: gate.${key} must be a non-empty argv array in ${configLabel(where)}`);
    }
    commands[mode] = Object.freeze([...value]);
  }
  const timeout = values.timeout_seconds ?? 1800;
  // Node timers above a signed 32-bit millisecond value fire immediately.
  if (typeof timeout !== "number" || !Number.isSafeInteger(timeout) ||
      timeout < 1 || timeout > Math.floor(0x7fffffff / 1000)) {
    throw new Error(`config: gate.timeout_seconds must be an integer from 1 to 2147483 in ${configLabel(where)}`);
  }
  if (commands.full === undefined) return null;
  return Object.freeze({ commands: Object.freeze(commands), timeoutSeconds: timeout });
}

export async function loadGateConfig(deps: LoadConfigDeps = {}): Promise<GateConfig | null> {
  const env: Env = deps.env ?? processEnv;
  const path = configFilePath(env);
  return parseGateConfig(await readConfigFile(
    path, deps.readTextFile ?? readTextFile, deps.parseToml ?? defaultParseToml,
  ), path);
}
