/**
 * Value validation shared by the file and environment layers. Every invalid
 * value fails loud at startup rather than silently mis-configuring the runtime.
 */

import { isAbsolute, resolve } from "node:path";
import type { Env } from "./env.ts";
import { PERMISSION_LEVELS, type PermissionLevel } from "./schema.ts";

/** Max UTF-8 byte length for `[context] operator_instructions`. */
export const MAX_OPERATOR_INSTRUCTIONS_PATH_BYTES = 4_096;

export function validatePositiveUsd(value: number, source: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `config: invalid USD value from ${source} (expected a non-negative number)`,
    );
  }
  return value;
}

/**
 * The bound on every tool-step setting: the default limit, the configured
 * ceiling and a session's own limit are all integers from 1 through this.
 */
export const TOOL_STEPS_BOUND = 256;

export function validateMaxToolSteps(value: number, source: string): number {
  if (!Number.isInteger(value) || value < 1 || value > TOOL_STEPS_BOUND) {
    throw new Error(
      `config: invalid max tool steps from ${source} ` +
        `(expected an integer from 1 through ${TOOL_STEPS_BOUND})`,
    );
  }
  return value;
}

/**
 * The default tool-step limit must fit under the configured ceiling, or a
 * session could never use its own default.
 */
export function validateToolStepsWithinCeiling(
  maxToolSteps: number,
  ceiling: number,
): void {
  if (maxToolSteps > ceiling) {
    throw new Error(
      `config: the default max tool steps (${maxToolSteps}) is above ` +
        `the tool-step ceiling (${ceiling})`,
    );
  }
}

export function parseBooleanEnv(raw: string, source: string): boolean {
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

export function validateLevel(value: string, source: string): PermissionLevel {
  if ((PERMISSION_LEVELS as readonly string[]).includes(value)) {
    return value as PermissionLevel;
  }
  throw new Error(
    `config: invalid permission level "${value}" from ${source} ` +
      `(expected one of: ${PERMISSION_LEVELS.join(", ")})`,
  );
}

export function readMaxToolSteps(
  env: Env,
  envVar: string,
  fallback: number,
): number {
  const raw = env.get(envVar);
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === "") return fallback;
  if (!/^[0-9]+$/.test(trimmed)) {
    throw new Error(
      `config: invalid max tool steps from ${envVar} ` +
        `(expected an integer from 1 through ${TOOL_STEPS_BOUND})`,
    );
  }
  return validateMaxToolSteps(Number(trimmed), envVar);
}

/**
 * Whether a turn making forward progress may step past its soft limit
 * (`[agent] step_extension` / `DYFJ_STEP_EXTENSION`). Unset or empty takes
 * the default; any other value must be a boolean, and a malformed one fails
 * the load like every other boolean binding.
 */
export function readStepExtension(
  env: Env,
  envVar: string,
  fallback: boolean,
): boolean {
  const raw = env.get(envVar);
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === "") return fallback;
  return parseBooleanEnv(trimmed, envVar);
}

/**
 * Read an optional integer from the environment. A value that is not a plain
 * base-10 integer throws; the caller validates its bounds.
 */
export function readIntegerEnv(raw: string, envVar: string): number {
  const trimmed = raw.trim();
  if (!/^[0-9]+$/.test(trimmed)) {
    throw new Error(
      `config: invalid number "${raw}" from ${envVar} (expected a positive integer)`,
    );
  }
  return Number(trimmed);
}

export function readPositiveUsd(
  env: Env,
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
 * The runaway-anomaly multiples were retired by BIT-785 in favour of the
 * spend check's own limits. A config file that still has an [anomaly] table
 * fails loud rather than being silently ignored.
 */
export const RETIRED_ANOMALY_REPLACEMENT =
  "use [budget] turn_limit_usd and runaway_stall_usd " +
  "(DYFJ_BUDGET_TURN_USD, DYFJ_BUDGET_RUNAWAY_STALL_USD) instead";

/**
 * Validate and expand an operator instructions file path from `[context]
 * operator_instructions` or `DYFJ_OPERATOR_INSTRUCTIONS`. Error messages stay
 * path-free so boot diagnostics never leak private filesystem layout.
 */
export function validateOperatorInstructionsPath(
  raw: string,
  source: string,
  env: Env,
): string {
  if (raw === "") {
    throw new Error(
      `config: invalid operator instructions path from ${source} ` +
        "(must not be empty)",
    );
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/u.test(raw)) {
    throw new Error(
      `config: invalid operator instructions path from ${source} ` +
        "(must not contain control characters)",
    );
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_OPERATOR_INSTRUCTIONS_PATH_BYTES) {
    throw new Error(
      `config: invalid operator instructions path from ${source} ` +
        `(exceeds ${MAX_OPERATOR_INSTRUCTIONS_PATH_BYTES} bytes)`,
    );
  }
  if (raw.split(/[\\/]/u).some((segment) => segment === "." || segment === "..")) {
    throw new Error(
      `config: invalid operator instructions path from ${source} ` +
        '(must not contain "." or ".." segments)',
    );
  }
  if (raw.endsWith("/") || raw.endsWith("\\")) {
    throw new Error(
      `config: invalid operator instructions path from ${source} ` +
        "(must name a file, not a directory)",
    );
  }
  if (raw.startsWith("~/")) {
    const home = env.get("HOME");
    if (
      home === undefined ||
      home === "" ||
      !isAbsolute(home) ||
      // eslint-disable-next-line no-control-regex
      /[\u0000-\u001f\u007f]/u.test(home) ||
      home.split(/[\\/]/u).some((segment) => segment === "." || segment === "..")
    ) {
      throw new Error(
        `config: ${source} uses "~/" but HOME is not set to a valid absolute path`,
      );
    }
    const rest = raw.slice(2);
    if (rest === "" || rest.startsWith("/") || rest.startsWith("\\")) {
      throw new Error(
        `config: invalid operator instructions path from ${source} ` +
          '(must be an absolute path or start with "~/")',
      );
    }
    const expanded = resolve(home, rest);
    if (
      Buffer.byteLength(expanded, "utf8") > MAX_OPERATOR_INSTRUCTIONS_PATH_BYTES
    ) {
      throw new Error(
        `config: invalid operator instructions path from ${source} ` +
          `(exceeds ${MAX_OPERATOR_INSTRUCTIONS_PATH_BYTES} bytes)`,
      );
    }
    return expanded;
  }
  if (!isAbsolute(raw)) {
    throw new Error(
      `config: invalid operator instructions path from ${source} ` +
        '(must be an absolute path or start with "~/")',
    );
  }
  return resolve(raw);
}
