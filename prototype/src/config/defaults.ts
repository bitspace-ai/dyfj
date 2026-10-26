/**
 * Env-layer resolvers for the budget and agent defaults, the
 * principal, and the runtime env defaults an entrypoint spreads into a runtime
 * input. The runtime boundary resolves these once so the core reads no env.
 */

import { type Env, processEnv } from "./env.ts";
import {
  schemaBooleanDefault,
  schemaEnvVar,
  schemaNumberDefault,
} from "./schema.ts";
import {
  parseBooleanEnv,
  readMaxToolSteps,
  readPositiveUsd,
  validateToolStepsWithinCeiling,
} from "./values.ts";

// ── Budget defaults (declared in CONFIG_SCHEMA; env layer at the boundary) ─────

export interface BudgetDefaults {
  /** Default max total USD spend across a session. */
  sessionLimitUsd: number;
  /** Default max USD spend for a single API call (estimated from input tokens). */
  perCallLimitUsd: number;
  /** Default max total USD spend across all sessions in a local day. */
  dailyLimitUsd: number;
  /** Default max total USD spend in one turn. */
  turnLimitUsd: number;
  /** Default runaway limit: USD spend in a turn with no tool progress. */
  runawayStallUsd: number;
}

/** The declared budget defaults — the single source for the limit numbers. */
export const BUDGET_DEFAULTS: BudgetDefaults = {
  sessionLimitUsd: schemaNumberDefault("defaultSessionBudgetUsd"),
  perCallLimitUsd: schemaNumberDefault("defaultPerCallBudgetUsd"),
  dailyLimitUsd: schemaNumberDefault("defaultDailyBudgetUsd"),
  turnLimitUsd: schemaNumberDefault("defaultTurnBudgetUsd"),
  runawayStallUsd: schemaNumberDefault("defaultRunawayStallUsd"),
};

export interface AgentDefaults {
  /** Maximum model↔tool loop steps in one turn. */
  maxToolSteps: number;
  /** The highest tool-step limit a session may set for itself. */
  maxToolStepsCeiling: number;
}

export const AGENT_DEFAULTS: AgentDefaults = {
  maxToolSteps: schemaNumberDefault("maxToolSteps"),
  maxToolStepsCeiling: schemaNumberDefault("maxToolStepsCeiling"),
};

export function resolveAgentDefaultsFromEnv(
  env: Env = processEnv,
): AgentDefaults {
  const maxToolSteps = readMaxToolSteps(
    env,
    schemaEnvVar("maxToolSteps"),
    AGENT_DEFAULTS.maxToolSteps,
  );
  const maxToolStepsCeiling = readMaxToolSteps(
    env,
    schemaEnvVar("maxToolStepsCeiling"),
    AGENT_DEFAULTS.maxToolStepsCeiling,
  );
  validateToolStepsWithinCeiling(maxToolSteps, maxToolStepsCeiling);
  return { maxToolSteps, maxToolStepsCeiling };
}

/**
 * Strict env-only resolver for the standing workspace-instructions trust
 * posture, for boundaries that resolve config from the environment rather
 * than the TOML file (the standalone in-process entrypoint). Unset or empty
 * means default off; a malformed value fails loud like every other boolean
 * env binding.
 */
export function resolveTrustWorkspaceInstructionsFromEnv(
  env: Env,
): boolean {
  const raw = env.get(schemaEnvVar("trustWorkspaceInstructions"));
  if (raw === undefined || raw === "") {
    return schemaBooleanDefault("trustWorkspaceInstructions");
  }
  return parseBooleanEnv(raw, schemaEnvVar("trustWorkspaceInstructions"));
}

/**
 * Resolve the budget defaults from the environment against the declared surface
 * (defaults → env). This is the boundary resolver the runtime entrypoints use so
 * the core reads no env; the config-FILE layer for budget is the next slice.
 */
export function resolveBudgetDefaultsFromEnv(
  env: Env = processEnv,
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
    turnLimitUsd: readPositiveUsd(
      env,
      schemaEnvVar("defaultTurnBudgetUsd"),
      BUDGET_DEFAULTS.turnLimitUsd,
    ),
    runawayStallUsd: readPositiveUsd(
      env,
      schemaEnvVar("defaultRunawayStallUsd"),
      BUDGET_DEFAULTS.runawayStallUsd,
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
export function resolvePrincipalId(env: Env = processEnv): string {
  return env.get("DYFJ_PRINCIPAL_ID") ?? env.get("USER") ?? "user";
}

// ── Runtime env defaults (process boundary) ──────────────────────────────────

export type BudgetTallyMode = "on" | "paid" | "off";

export function parseBudgetTallyMode(
  value: string | undefined,
): BudgetTallyMode {
  if (value === "on" || value === "off" || value === "paid") return value;
  return "paid";
}

/** The env-derived runtime defaults an entrypoint spreads into a runtime input. */
export interface RuntimeEnvDefaults {
  principalId: string;
  rootOverride: string | undefined;
  budgetTallyMode: BudgetTallyMode;
  defaultSessionBudgetUsd: number;
  defaultPerCallBudgetUsd: number;
  defaultDailyBudgetUsd: number;
  defaultTurnBudgetUsd: number;
  defaultRunawayStallUsd: number;
  trustWorkspaceInstructions: boolean;
  maxToolSteps: number;
  maxToolStepsCeiling: number;
}

/**
 * Resolve the env-derived runtime defaults at the process boundary,
 * so the core runtime reads no environment variables. Entrypoints (the UDS
 * server and the in-process verify-workbench-events check) spread this into the
 * runtime input; a headless
 * driver supplies these explicitly instead. `rootOverride` stays undefined when
 * DYFJ_ROOT is unset, so the core falls back to the process cwd.
 */
export function resolveRuntimeEnvDefaults(
  env: Env = processEnv,
): RuntimeEnvDefaults {
  const budget = resolveBudgetDefaultsFromEnv(env);
  const agent = resolveAgentDefaultsFromEnv(env);
  return {
    principalId: resolvePrincipalId(env),
    // The standalone in-process entrypoint is the operator's own process
    // (loopback-equivalent), so the standing trust posture is honored here
    // via its environment binding; served sessions resolve it from engine
    // config at their transport boundary.
    trustWorkspaceInstructions: resolveTrustWorkspaceInstructionsFromEnv(env),
    rootOverride: env.get("DYFJ_ROOT") ?? undefined,
    budgetTallyMode: parseBudgetTallyMode(env.get("DYFJ_BUDGET_TALLY")),
    defaultSessionBudgetUsd: budget.sessionLimitUsd,
    defaultPerCallBudgetUsd: budget.perCallLimitUsd,
    defaultDailyBudgetUsd: budget.dailyLimitUsd,
    defaultTurnBudgetUsd: budget.turnLimitUsd,
    defaultRunawayStallUsd: budget.runawayStallUsd,
    maxToolSteps: agent.maxToolSteps,
    maxToolStepsCeiling: agent.maxToolStepsCeiling,
  };
}
