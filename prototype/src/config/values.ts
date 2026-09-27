/**
 * Value validation shared by the file and environment layers. Every invalid
 * value fails loud at startup rather than silently mis-configuring the runtime.
 */

import type { Env } from "./env.ts";
import { PERMISSION_LEVELS, type PermissionLevel } from "./schema.ts";

export function validatePositiveUsd(value: number, source: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `config: invalid USD value from ${source} (expected a non-negative number)`,
    );
  }
  return value;
}

// Strictly positive: a zero multiple would halt every paid call the moment any
// spend exists — if the operator wants that, they should say so with a tiny
// envelope, not a degenerate multiple. There is deliberately no disable knob.
export function validatePositiveMultiple(
  value: number,
  source: string,
): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `config: invalid multiple from ${source} (expected a positive number)`,
    );
  }
  return value;
}

export function validateMaxToolSteps(value: number, source: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 64) {
    throw new Error(
      `config: invalid max tool steps from ${source} ` +
        `(expected an integer from 1 through 64)`,
    );
  }
  return value;
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
        `(expected an integer from 1 through 64)`,
    );
  }
  return validateMaxToolSteps(Number(trimmed), envVar);
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

export function readPositiveMultiple(
  env: Env,
  envVar: string,
  fallback: number,
): number {
  const raw = env.get(envVar);
  if (raw === undefined || raw.trim() === "") return fallback;
  // Number(), not parseFloat(): "2x" must fail loud, not silently become 2 —
  // a mis-set hard-stop knob should never half-parse into a different stop.
  const value = Number(raw.trim());
  return validatePositiveMultiple(value, envVar);
}
