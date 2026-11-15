import { hasDotPathComponent } from "../kernel/mod.ts";

export function codexPathSyntax(value: string): boolean {
  return value.startsWith("/") && !value.includes(",") && !value.includes(":") && !hasDotPathComponent(value);
}

export function codexEnvironmentNameAllowed(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
    !/^(?:CODEX_|DYFJ_)/.test(name) &&
    !/^(?:HOME|CARGO_HOME|RUSTUP_HOME|PATH|NO_BROWSER|INITIAL_AGENT_MODE|USER)$/.test(name) &&
    !/KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH/i.test(name) &&
    !/^(?:NODE_OPTIONS$|BASH_ENV$|ENV$|LD_|DYLD_)/i.test(name);
}

export function readCodexEnvironmentConfig(table: Record<string, unknown>): {
  codexPath: "operator" | "minimal";
  codexExtraPath: string[];
  codexEnvAllow: string[];
} {
  const section = table.codex ?? {};
  if (typeof section !== "object" || section === null || Array.isArray(section)) throw new Error("config: [codex] must be a table");
  const fields = section as Record<string, unknown>;
  const path = fields.path ?? "operator";
  if (path !== "operator" && path !== "minimal") throw new Error("config: codex.path must be operator or minimal");
  const readArray = (key: string, max: number, valid: (value: string) => boolean): string[] => {
    const value = fields[key] ?? [];
    if (!Array.isArray(value) || value.length > max) throw new Error(`config: codex.${key} must be an array of at most ${max} strings`);
    return value.map((entry, index) => {
      if (typeof entry !== "string" || !valid(entry)) {
        const label = key === "env_allow" && typeof entry === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry) ? ` ${JSON.stringify(entry)}` : "";
        throw new Error(`config: codex.${key} entry ${index + 1}${label} is invalid`);
      }
      return entry;
    });
  };
  return { codexPath: path, codexExtraPath: readArray("extra_path",16,codexPathSyntax), codexEnvAllow: readArray("env_allow",32,codexEnvironmentNameAllowed) };
}
