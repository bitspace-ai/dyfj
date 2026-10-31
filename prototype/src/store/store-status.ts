/**
 * The store's health, as `runtime/status` reports it.
 *
 * A refused Dolt login or an unreachable server used to surface only when a
 * turn failed: `dyfj status` looked healthy until the first turn. The probe
 * runs one `SELECT 1` through the runtime's guarded pool, so the same
 * `DoltLoginRefusedError` the pool raises is what the probe reports.
 */

import { DoltLoginRefusedError, type DoltQueryable } from "./dolt-pool.ts";

/**
 * What the probe learned. It carries no driver text and no error message: the
 * state, plus the user a refused login named, is all it returns.
 */
export type StoreStatus =
  | { state: "ok" }
  | { state: "refused"; user?: string }
  | { state: "unreachable" };

/** How long the probe waits for `SELECT 1` before calling the store unreachable. */
export const STORE_PROBE_TIMEOUT_MS = 1500;

/**
 * Probe the store behind `pool` with one `SELECT 1`, bounded by `timeoutMs`.
 * Resolves `ok` when the query answers, `refused` (with the user the pool
 * named) on a `DoltLoginRefusedError`, and `unreachable` on any other failure
 * or when the bound expires. Never rejects, and never keeps a caller waiting
 * past the bound: a query still running when it expires is left to settle
 * unobserved.
 */
export async function probeStoreStatus(
  pool: DoltQueryable,
  timeoutMs = STORE_PROBE_TIMEOUT_MS,
): Promise<StoreStatus> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<StoreStatus>((resolve) => {
    timer = setTimeout(() => resolve({ state: "unreachable" }), timeoutMs);
  });
  try {
    return await Promise.race([queryStatus(pool), expired]);
  } finally {
    clearTimeout(timer);
  }
}

async function queryStatus(pool: DoltQueryable): Promise<StoreStatus> {
  try {
    await pool.execute("SELECT 1");
    return { state: "ok" };
  } catch (error) {
    if (error instanceof DoltLoginRefusedError) {
      return error.user === undefined
        ? { state: "refused" }
        : { state: "refused", user: error.user };
    }
    return { state: "unreachable" };
  }
}
