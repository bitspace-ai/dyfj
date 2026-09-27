// Test-only access to the isolated Dolt fixture that the integration lane
// starts (`scripts/isolated-dolt-integration.ts`), for rows a test seeds or
// removes around the runtime under test and for Dolt-only statements
// (`DOLT_COMMIT`, `SLEEP`). Runtime code never uses this: it reaches Dolt only
// through the store port. Each test file opens its own handle and closes it.

import mysql from "mysql2/promise";
import { processEnv, resolveDoltConnection } from "../../src/config/mod.ts";
import { createDoltPool, DoltStore } from "../../src/store/mod.ts";

export interface FixtureSql {
  /** Run a statement; rows rendered as text, NULL as "". */
  query(sql: string, params?: unknown[]): Promise<Record<string, string>[]>;
  close(): Promise<void>;
}

interface RawPool {
  query(sql: string, params?: unknown[]): Promise<[unknown, unknown]>;
  end(): Promise<void>;
}

export function openFixtureSql(): FixtureSql {
  // Deno's npm declaration bridge drops mysql2's mixed-in promise methods.
  const pool = mysql.createPool({
    ...resolveDoltConnection(processEnv),
    connectionLimit: 1,
  }) as unknown as RawPool;
  return {
    async query(sql, params = []) {
      const [rows] = await pool.query(sql, params);
      if (!Array.isArray(rows)) return [];
      return (rows as Record<string, unknown>[]).map((row) => {
        const out: Record<string, string> = {};
        for (const k of Object.keys(row)) {
          out[k] = row[k] == null ? "" : String(row[k]);
        }
        return out;
      });
    },
    close: () => pool.end(),
  };
}

/** A `DoltStore` over the fixture database, as the composition root builds it. */
export function openFixtureStore(): DoltStore {
  return new DoltStore(createDoltPool(resolveDoltConnection(processEnv)));
}
