/**
 * The Dolt connection pool. `mysql2` over TCP to `dolt sql-server` (avoids
 * file-lock conflicts with a running server). The composition root builds one
 * pool with `createDoltPool` and hands it to `DoltStore`; nothing holds a
 * module-level pool.
 */

import mysql from "mysql2/promise";
import {
  assertConnectAllowed,
  type DoltConnectionConfig,
  type RuntimePolicy,
} from "../config/mod.ts";
import { sanitizeBoundaryText } from "../kernel/mod.ts";
import { DomainError, MAX_REASON_FIELD_BYTES } from "../contract/mod.ts";

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
 * A handle that can only read. The readers get this, never the pool: only
 * the journal holds the write-capable handle (`dolt-journal.ts`).
 */
export interface DoltSelect {
  select(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
}

/**
 * One statement, and a plain SELECT: no second statement, no `INTO` target,
 * and no Dolt stored procedure called as a function (`SELECT DOLT_COMMIT()`
 * writes). Checked on every call, so a reader cannot write whatever SQL it
 * assembles.
 */
export function isReadOnlySelect(sql: string): boolean {
  return /^\s*SELECT\s/i.test(sql) &&
    !/;\s*\S/.test(sql) &&
    !/\bINTO\s+(?:OUTFILE|DUMPFILE|@)/i.test(sql) &&
    !/\bDOLT_[A-Z_]+\s*\(/i.test(sql);
}

/** Wrap a pool or connection so it can only run `isReadOnlySelect` SQL. */
export function selectOnly(target: DoltQueryable): DoltSelect {
  return {
    async select(sql, params = []) {
      if (!isReadOnlySelect(sql)) {
        throw new Error("store readers may run only a single SELECT");
      }
      const [rows] = await target.execute(sql, params);
      return rows as Record<string, unknown>[];
    },
  };
}

/**
 * The Dolt server refused the credential. Thrown by the store's pool and
 * connections in place of the driver's own error, whose message repeats the
 * account name and whatever else the server chose to say. The message here is
 * built from the runtime's own resolved configuration: the user it names is
 * the one this process asked to log in as, and neither the password field
 * nor the driver's text is included.
 *
 * The rejection is recognized by the driver's error code, never by matching
 * message text. Anything else — a refused connection, an unknown database, a
 * failed query — is passed through unchanged and stays a masked foreign error
 * at the turn boundary.
 */
export class DoltLoginRefusedError extends DomainError {
  /** The Dolt user the login was refused for, when the pool knew it. */
  readonly user?: string;

  constructor(user?: string) {
    const named = user === undefined ? undefined : sanitizeBoundaryText(
      user,
      MAX_REASON_FIELD_BYTES,
    );
    super(
      named === undefined || named.length === 0
        ? "Dolt refused the login for the configured user; check DOLT_USER " +
          "and DOLT_PASSWORD (or the 1Password pointer that supplies them) in " +
          "prototype/.env or the environment"
        : `Dolt refused the login for user "${named}"; check DOLT_USER and ` +
          "DOLT_PASSWORD (or the 1Password pointer that supplies them) in " +
          "prototype/.env or the environment",
    );
    this.user = named === undefined || named.length === 0 ? undefined : named;
    this.name = "DoltLoginRefusedError";
  }
}

/** `mysql2`'s refused-login code and legacy errno, either of which identifies it. */
const ER_ACCESS_DENIED_ERROR = "ER_ACCESS_DENIED_ERROR";
const ER_ACCESS_DENIED_ERRNO = 1045;

/**
 * The refused-login error this driver error reports, or `undefined` when it
 * reports any other failure. Reads only the code and errno fields; the message
 * is never inspected.
 */
export function refusedLoginError(
  error: unknown,
  user: string | undefined,
): DoltLoginRefusedError | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { code, errno } = error as { code?: unknown; errno?: unknown };
  const refused = code === ER_ACCESS_DENIED_ERROR ||
    errno === ER_ACCESS_DENIED_ERRNO;
  return refused ? new DoltLoginRefusedError(user) : undefined;
}

/** Rethrow a refused login as `DoltLoginRefusedError`; anything else as itself. */
function rethrowRefusedLogin(
  error: unknown,
  user: string | undefined,
): never {
  throw refusedLoginError(error, user) ?? error;
}

/**
 * Build the pool. Connections open lazily, on the first query, so building it
 * at boot needs no running server. The endpoint must be the policy's one Dolt
 * endpoint (`assertConnectAllowed`); a pool for any other host or port is
 * refused here, before a connection can open. There is no default policy:
 * a caller that cannot name the configured endpoint gets no pool.
 */
export function createDoltPool(
  config: DoltConnectionConfig,
  policy: RuntimePolicy,
): DoltPool {
  assertConnectAllowed(policy, config.host, config.port);
  // The runtime's npm declaration bridge drops mysql2's mixed-in promise methods.
  const pool = mysql.createPool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    waitForConnections: true,
    connectionLimit: 5,
  }) as unknown as DoltPool;
  return guardDoltLogins(pool, config.user);
}

/**
 * Wrap a pool so a refused login surfaces as `DoltLoginRefusedError` rather
 * than the driver's own error, whose message restates the account name. The
 * pool names the user it was built with, so the error names the same account
 * this process asked to log in as — never one parsed out of the server's
 * reply. A connection handed out by `getConnection` is guarded the same way,
 * because the journal acquires one to run a transaction. Every other failure
 * propagates unchanged.
 *
 * Applied to a driver pool of any provenance: `createDoltPool` guards the pool
 * it builds, and a test drives the same guard over a stand-in.
 */
export function guardDoltLogins(
  pool: DoltPool,
  user: string | undefined,
): DoltPool {
  return {
    async execute(sql, params) {
      try {
        return await pool.execute(sql, params);
      } catch (error) {
        rethrowRefusedLogin(error, user);
      }
    },
    async getConnection() {
      let connection: DoltConnection;
      try {
        connection = await pool.getConnection();
      } catch (error) {
        rethrowRefusedLogin(error, user);
      }
      return guardedDoltConnection(connection, user);
    },
    end: () => pool.end(),
  };
}

/** A pooled connection whose statements report a refused login as such. */
function guardedDoltConnection(
  connection: DoltConnection,
  user: string | undefined,
): DoltConnection {
  return {
    async execute(sql, params) {
      try {
        return await connection.execute(sql, params);
      } catch (error) {
        rethrowRefusedLogin(error, user);
      }
    },
    beginTransaction: () => connection.beginTransaction(),
    commit: () => connection.commit(),
    rollback: () => connection.rollback(),
    release: () => connection.release(),
    destroy: () => connection.destroy(),
  };
}
