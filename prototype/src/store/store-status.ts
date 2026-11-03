/**
 * The store's health, as `runtime/status` reports it.
 *
 * A refused Dolt login or an unreachable server used to surface only when a
 * turn failed: `dyfj status` looked healthy until the first turn. The probe
 * runs one `SELECT 1` through the runtime's guarded pool, so the same
 * `DoltLoginRefusedError` the pool raises is what the probe reports.
 */

import {
  DoltDatabaseMissingError,
  DoltLoginRefusedError,
  type DoltQueryable,
} from "./dolt-pool.ts";

/**
 * What the probe learned. It carries no driver text and no error message: the
 * state, plus the configured user a refused login named (and whether it was
 * the `root` fallback) or the configured database a server lacked, is all it
 * returns.
 */
export type StoreStatus =
  | { state: "ok" }
  | { state: "refused"; user?: string; userDefaulted?: true }
  | { state: "no_database"; database: string }
  | { state: "unreachable" };

/** How long the probe waits for `SELECT 1` before calling the store unreachable. */
export const STORE_PROBE_TIMEOUT_MS = 1500;

/**
 * A probe over `pool`: each call races one `SELECT 1` against a `timeoutMs`
 * timer and resolves `ok` when the query answers, `refused` (with the user the
 * pool named) on a `DoltLoginRefusedError`, `no_database` on a
 * `DoltDatabaseMissingError`, and `unreachable` on any other
 * failure or when the timer fires first. It never rejects.
 *
 * At most one query is outstanding. A query the timer outran is not cancelled
 * (the driver offers no cancel for it), so a call made while it is still
 * pending races that same query again instead of starting another: a hung
 * server costs the pool one connection, however often status is asked.
 */
export function createStoreProbe(
  pool: DoltQueryable,
  timeoutMs = STORE_PROBE_TIMEOUT_MS,
): () => Promise<StoreStatus> {
  let inFlight: Promise<StoreStatus> | undefined;
  return async () => {
    if (inFlight === undefined) {
      const query = queryStatus(pool);
      inFlight = query;
      void query.finally(() => {
        if (inFlight === query) inFlight = undefined;
      });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<StoreStatus>((resolve) => {
      timer = setTimeout(() => resolve({ state: "unreachable" }), timeoutMs);
    });
    try {
      return await Promise.race([inFlight, expired]);
    } finally {
      clearTimeout(timer);
    }
  };
}

async function queryStatus(pool: DoltQueryable): Promise<StoreStatus> {
  try {
    await pool.execute("SELECT 1");
    return { state: "ok" };
  } catch (error) {
    if (error instanceof DoltLoginRefusedError) {
      return {
        state: "refused",
        ...(error.user === undefined ? {} : { user: error.user }),
        ...(error.userDefaulted ? { userDefaulted: true as const } : {}),
      };
    }
    if (error instanceof DoltDatabaseMissingError) {
      return { state: "no_database", database: error.database };
    }
    return { state: "unreachable" };
  }
}
