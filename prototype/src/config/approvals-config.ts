import { processEnv } from "./env.ts";
import { readTextFile } from "./read-text-file.ts";
import { configFilePath, configLabel, defaultParseToml, type LoadConfigDeps, readConfigFile } from "./toml.ts";

export interface ApprovalEligibility {
  id: string;
  sessionGrantModes?: readonly string[];
}
export interface ApprovalsConfig {
  readonly sessionGrantable: readonly string[];
}

export function parseApprovalsConfig(
  table: Record<string, unknown> | null,
  commands: readonly ApprovalEligibility[],
  where: string,
): ApprovalsConfig | null {
  const section = table?.approvals;
  if (section === undefined) return null;
  if (typeof section !== "object" || section === null || Array.isArray(section)) {
    throw new Error(`config: [approvals] must be a table in ${configLabel(where)}`);
  }
  const values = section as Record<string, unknown>;
  for (const key of Object.keys(values)) if (key !== "session_grantable") {
    throw new Error(`config: unknown key approvals.${key} in ${configLabel(where)}`);
  }
  const entries = values.session_grantable ?? [];
  const eligible = commands.flatMap(command => (command.sessionGrantModes ?? []).map(mode => `${command.id}:${mode}`));
  if (!Array.isArray(entries) || entries.some(entry => typeof entry !== "string")) {
    throw new Error(`config: approvals.session_grantable must be an array of strings; eligible: ${eligible.join(", ")}`);
  }
  for (const entry of entries) if (!eligible.includes(entry)) {
    throw new Error(`config: approvals.session_grantable entry ${JSON.stringify(entry)} is not eligible; eligible: ${eligible.join(", ")}`);
  }
  return Object.freeze({ sessionGrantable: Object.freeze([...new Set(entries)]) });
}

export async function loadApprovalsConfig(
  commands: readonly ApprovalEligibility[],
  deps: LoadConfigDeps = {},
): Promise<ApprovalsConfig | null> {
  const path = configFilePath(deps.env ?? processEnv);
  return parseApprovalsConfig(await readConfigFile(
    path, deps.readTextFile ?? readTextFile, deps.parseToml ?? defaultParseToml,
  ), commands, path);
}
