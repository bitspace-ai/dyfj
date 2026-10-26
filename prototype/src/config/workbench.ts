/**
 * `WorkbenchConfig` + `loadConfig`: the daily-driver engine defaults that carry
 * a config-file layer (companion model, permission level, paid posture, budget
 * limits, agent step limit).
 *
 * Config is startup posture, NOT session state. The model for THIS turn, the
 * workspace, and the principal ride the request — not this file. Anything the
 * app *writes* (last-used, learned prefs) belongs in a separate app-owned state
 * store, never here — so config.toml stays a pristine, hand-edited file and
 * comment-preserving writes are a non-problem.
 *
 * Precedence: defaults → ~/.dyfj/config.toml → environment → per-request
 * overrides (the last applied above this, at the turn boundary).
 */

import { processEnv } from "./env.ts";
import { readTextFile as defaultReadTextFile } from "./read-text-file.ts";
import {
  type PermissionLevel,
  schemaBooleanDefault,
  schemaEnvVar,
  schemaNumberDefault,
} from "./schema.ts";
import {
  configFilePath,
  configLabel,
  defaultParseToml,
  type LoadConfigDeps,
  readBoolean,
  readConfigFile,
  readNumber,
  readString,
} from "./toml.ts";
import {
  parseBooleanEnv,
  readMaxToolSteps,
  readPositiveUsd,
  RETIRED_ANOMALY_REPLACEMENT,
  validateLevel,
  validateMaxToolSteps,
  validatePositiveUsd,
  validateToolStepsWithinCeiling,
} from "./values.ts";

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
  /**
   * Standing elevation of workspace AGENTS.md instructions into the
   * agent-mode system prompt. Default off: selecting a workspace does NOT
   * by itself grant its instructions system-channel authority — setting
   * this is the operator's explicit trust decision ([workspace]
   * trust_instructions / DYFJ_TRUST_WORKSPACE_INSTRUCTIONS). Loopback
   * turns only; remote transports never inherit it. Process-wide once set:
   * it applies to every loopback-selected workspace, and the injected
   * content rides the system prompt to whatever model the session selects —
   * including hosted providers, under the existing paid/hosted consent.
   */
  trustWorkspaceInstructions: boolean;
  /** Default max total USD spend across a session (startup posture). */
  defaultSessionBudgetUsd: number;
  /** Default max USD spend for a single API call (startup posture). */
  defaultPerCallBudgetUsd: number;
  /** Default max total USD spend across all sessions in a local day (startup posture). */
  defaultDailyBudgetUsd: number;
  /** Default max total USD spend in one turn (startup posture). */
  defaultTurnBudgetUsd: number;
  /** Default runaway limit: USD spend with no tool progress (startup posture). */
  defaultRunawayStallUsd: number;
  /** Maximum model↔tool loop steps in one turn (startup posture). */
  maxToolSteps: number;
  /** The highest tool-step limit a session may set for itself. */
  maxToolStepsCeiling: number;
}

export const CONFIG_DEFAULTS: WorkbenchConfig = {
  defaultCompanionModel: null,
  permissionLevel: "strict",
  approvePaidDefault: schemaBooleanDefault("approvePaidDefault"),
  trustWorkspaceInstructions: schemaBooleanDefault(
    "trustWorkspaceInstructions",
  ),
  defaultSessionBudgetUsd: schemaNumberDefault("defaultSessionBudgetUsd"),
  defaultPerCallBudgetUsd: schemaNumberDefault("defaultPerCallBudgetUsd"),
  defaultDailyBudgetUsd: schemaNumberDefault("defaultDailyBudgetUsd"),
  defaultTurnBudgetUsd: schemaNumberDefault("defaultTurnBudgetUsd"),
  defaultRunawayStallUsd: schemaNumberDefault("defaultRunawayStallUsd"),
  maxToolSteps: schemaNumberDefault("maxToolSteps"),
  maxToolStepsCeiling: schemaNumberDefault("maxToolStepsCeiling"),
};

/**
 * Resolve the engine config with precedence defaults → file → env. A missing
 * file is fine (defaults). A malformed file or an invalid value throws — fail
 * loud at startup rather than silently mis-configure the runtime.
 */
export async function loadConfig(
  deps: LoadConfigDeps = {},
): Promise<WorkbenchConfig> {
  const env = deps.env ?? processEnv;
  const readTextFile = deps.readTextFile ?? defaultReadTextFile;
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
    const fileTrustInstructions = readBoolean(
      table,
      "workspace",
      "trust_instructions",
    );
    if (fileTrustInstructions !== undefined) {
      config.trustWorkspaceInstructions = fileTrustInstructions;
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
    const fileTurnBudget = readNumber(table, "budget", "turn_limit_usd");
    if (fileTurnBudget !== undefined) {
      config.defaultTurnBudgetUsd = validatePositiveUsd(
        fileTurnBudget,
        `${configLabel(path)} [budget].turn_limit_usd`,
      );
    }
    const fileStallBudget = readNumber(table, "budget", "runaway_stall_usd");
    if (fileStallBudget !== undefined) {
      config.defaultRunawayStallUsd = validatePositiveUsd(
        fileStallBudget,
        `${configLabel(path)} [budget].runaway_stall_usd`,
      );
    }
    if (table.anomaly !== undefined) {
      throw new Error(
        `config: ${
          configLabel(path)
        } [anomaly] is no longer supported; ${RETIRED_ANOMALY_REPLACEMENT}`,
      );
    }
    const fileMaxToolSteps = readNumber(table, "agent", "max_tool_steps");
    if (fileMaxToolSteps !== undefined) {
      config.maxToolSteps = validateMaxToolSteps(
        fileMaxToolSteps,
        `${configLabel(path)} [agent].max_tool_steps`,
      );
    }
    const fileCeiling = readNumber(table, "agent", "max_tool_steps_ceiling");
    if (fileCeiling !== undefined) {
      config.maxToolStepsCeiling = validateMaxToolSteps(
        fileCeiling,
        `${configLabel(path)} [agent].max_tool_steps_ceiling`,
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
  const envTrustInstructions = env.get(
    schemaEnvVar("trustWorkspaceInstructions"),
  );
  if (envTrustInstructions !== undefined && envTrustInstructions !== "") {
    config.trustWorkspaceInstructions = parseBooleanEnv(
      envTrustInstructions,
      schemaEnvVar("trustWorkspaceInstructions"),
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
  config.defaultTurnBudgetUsd = readPositiveUsd(
    env,
    schemaEnvVar("defaultTurnBudgetUsd"),
    config.defaultTurnBudgetUsd,
  );
  config.defaultRunawayStallUsd = readPositiveUsd(
    env,
    schemaEnvVar("defaultRunawayStallUsd"),
    config.defaultRunawayStallUsd,
  );
  config.maxToolSteps = readMaxToolSteps(
    env,
    schemaEnvVar("maxToolSteps"),
    config.maxToolSteps,
  );
  config.maxToolStepsCeiling = readMaxToolSteps(
    env,
    schemaEnvVar("maxToolStepsCeiling"),
    config.maxToolStepsCeiling,
  );
  validateToolStepsWithinCeiling(
    config.maxToolSteps,
    config.maxToolStepsCeiling,
  );

  return config;
}
