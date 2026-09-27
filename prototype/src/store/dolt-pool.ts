/**
 * The Dolt connection pool. `mysql2` over TCP to `dolt sql-server` (avoids
 * file-lock conflicts with a running server). The composition root builds one
 * pool with `createDoltPool` and hands it to `DoltStore`; nothing holds a
 * module-level pool.
 */

import mysql from "mysql2/promise";
import type { DoltConnectionConfig } from "../config/mod.ts";

/** What the readers need: one statement, auto-committed. */
export interface DoltQueryable {
  execute(sql: string, params?: unknown[]): Promise<[unknown, unknown]>;
}

/** A pooled connection, for a multi-statement or cancellable transaction. */
export interface DoltConnection extends DoltQueryable {
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
  /** Close the socket; the pool replaces the connection. */
  destroy(): void;
}

/** The subset of a `mysql2/promise` pool the store uses. */
export interface DoltPool extends DoltQueryable {
  getConnection(): Promise<DoltConnection>;
  end(): Promise<void>;
}

/**
 * Build the pool. Connections open lazily, on the first query, so building it
 * at boot needs no running server.
 */
export function createDoltPool(config: DoltConnectionConfig): DoltPool {
  // Deno's npm declaration bridge drops mysql2's mixed-in promise methods.
  return mysql.createPool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    waitForConnections: true,
    connectionLimit: 5,
  }) as unknown as DoltPool;
}
