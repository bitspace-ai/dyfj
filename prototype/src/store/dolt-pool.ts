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
 * Where the pool connects, as the operator configured it: the values a
 * store-failure message may name. `userDefaulted` is set when `DOLT_USER` was
 * not set and the runtime fell back to `root`.
 */
export interface DoltFailureContext {
  host: string;
  port: number;
  database: string;
  userDefaulted?: boolean;
}

/** A configured value, made safe to place inside a message. */
function field(value: string): string {
  return sanitizeBoundaryText(value, MAX_REASON_FIELD_BYTES);
}

/**
 * The Dolt server refused the credential. Thrown by the store's pool and
 * connections in place of the driver's own error, whose message repeats the
 * account name and whatever else the server chose to say. The message here is
 * built from the runtime's own resolved configuration: the user it names is
 * the one this process asked to log in as, and neither the password field
 * nor the driver's text is included.
 *
 * Each store-failure class here is recognized by the driver's error code or
 * errno, with one exception: Dolt reports a read of a table the user has no
 * grant on as the generic ER_UNKNOWN_ERROR, recognized by its message's fixed
 * shape (`GENERIC_GRANT_DENIED`). Any other failure (a failed query, say)
 * propagates unchanged and keeps its existing treatment at the turn boundary;
 * a failure that is already a `DomainError` stays visible.
 */
export class DoltLoginRefusedError extends DomainError {
  /** The Dolt user the login was refused for, when the pool knew it. */
  readonly user?: string;
  /** Set when `user` is the `root` fallback for an unset `DOLT_USER`. */
  readonly userDefaulted: boolean;

  constructor(user?: string, options: { userDefaulted?: boolean } = {}) {
    const named = user === undefined ? undefined : field(user);
    const fix = "check DOLT_USER and DOLT_PASSWORD (or the 1Password " +
      "pointer that supplies them) in prototype/.env or the environment";
    super(
      named === undefined || named.length === 0
        ? `Dolt refused the login for the configured user; ${fix}`
        : options.userDefaulted
        ? `Dolt refused the login for user "${named}": DOLT_USER is not ` +
          `set, so the runtime tried to log in as "${named}". Set DOLT_USER and ` +
          "DOLT_PASSWORD in prototype/.env or the environment (the Dolt " +
          "users section of schema/README.md lists them), then restart " +
          "the runtime"
        : `Dolt refused the login for user "${named}"; ${fix}`,
    );
    this.user = named === undefined || named.length === 0 ? undefined : named;
    this.userDefaulted = options.userDefaulted === true;
    this.name = "DoltLoginRefusedError";
  }
}

/** Why the Dolt server could not be reached. */
export type DoltUnreachableReason =
  | "refused"
  | "dns"
  | "timeout"
  | "noroute"
  | "lost";

const UNREACHABLE_REASON_TEXT: Record<DoltUnreachableReason, string> = {
  refused: "connection refused",
  dns: "the host name did not resolve",
  timeout: "the connection timed out",
  noroute: "no route to the host",
  lost: "the connection was lost",
};

/** Nothing answered at the configured Dolt endpoint. */
export class DoltUnreachableError extends DomainError {
  readonly reason: DoltUnreachableReason;

  constructor(
    endpoint: Pick<DoltFailureContext, "host" | "port">,
    reason: DoltUnreachableReason,
  ) {
    super(
      `Dolt is not answering at ${field(endpoint.host)}:${endpoint.port} ` +
        `(${UNREACHABLE_REASON_TEXT[reason]}). Start the Dolt SQL server ` +
        "(dolt sql-server), or check DOLT_HOST and DOLT_PORT in " +
        "prototype/.env or the environment, then retry",
    );
    this.reason = reason;
    this.name = "DoltUnreachableError";
  }
}

/** The Dolt server answered but has no database by the configured name. */
export class DoltDatabaseMissingError extends DomainError {
  /** The configured database name, made safe for a message. */
  readonly database: string;

  constructor(database: string) {
    const named = field(database);
    super(
      `The Dolt server has no database "${named}". Check ` +
        "DOLT_DATABASE in prototype/.env or the environment, or create the " +
        "database and apply the schema as schema/README.md describes",
    );
    this.database = named;
    this.name = "DoltDatabaseMissingError";
  }
}

/** The Dolt user lacks a privilege a statement needed. */
export class DoltGrantMissingError extends DomainError {
  constructor(user: string | undefined) {
    const named = user === undefined ? "" : field(user);
    super(
      `Dolt refused a statement for ${
        named.length === 0 ? "the configured user" : `user "${named}"`
      }: it lacks a grant this runtime needs. Grant it the privileges the ` +
        "Dolt users section of schema/README.md lists (or set DOLT_USER to a " +
        "user that has them), then retry",
    );
    this.name = "DoltGrantMissingError";
  }
}

/** `mysql2`'s refused-login code and legacy errno, either of which identifies it. */
const ER_ACCESS_DENIED_ERROR = "ER_ACCESS_DENIED_ERROR";
const ER_ACCESS_DENIED_ERRNO = 1045;
const ER_BAD_DB_ERRNO = 1049;

/** Codes for a statement refused for want of a privilege. */
const GRANT_DENIED_CODES: ReadonlySet<string> = new Set([
  "ER_DBACCESS_DENIED_ERROR",
  "ER_TABLEACCESS_DENIED_ERROR",
  "ER_COLUMNACCESS_DENIED_ERROR",
  "ER_SPECIFIC_ACCESS_DENIED_ERROR",
]);

// Dolt reports a read of a table the user has no grant on as the generic
// ER_UNKNOWN_ERROR, so that one case is recognized by the message's fixed
// shape. The message is matched, never relayed.
const GENERIC_GRANT_DENIED =
  /^Access denied for user '[^']{0,200}'@'[^']{0,200}' to (?:table|database)\b/;

/** Driver and socket codes meaning the endpoint did not answer. */
const UNREACHABLE_CODES: Readonly<Record<string, DoltUnreachableReason>> = {
  ECONNREFUSED: "refused",
  ENOTFOUND: "dns",
  EAI_AGAIN: "dns",
  ETIMEDOUT: "timeout",
  EHOSTUNREACH: "noroute",
  ENETUNREACH: "noroute",
  ECONNRESET: "lost",
  PROTOCOL_CONNECTION_LOST: "lost",
};

/**
 * The refused-login error this driver error reports, or `undefined` when it
 * reports any other failure. Reads only the code and errno fields; the message
 * is never inspected.
 */
export function refusedLoginError(
  error: unknown,
  user: string | undefined,
  options: { userDefaulted?: boolean } = {},
): DoltLoginRefusedError | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { code, errno } = error as { code?: unknown; errno?: unknown };
  const refused = code === ER_ACCESS_DENIED_ERROR ||
    errno === ER_ACCESS_DENIED_ERRNO;
  return refused ? new DoltLoginRefusedError(user, options) : undefined;
}

/**
 * The store-failure error this driver error reports, or `undefined` when it
 * is not one. Without a `context` only a refused login is recognized.
 */
export function storeFailureError(
  error: unknown,
  user: string | undefined,
  context?: DoltFailureContext,
): DomainError | undefined {
  const refused = refusedLoginError(error, user, {
    userDefaulted: context?.userDefaulted,
  });
  if (refused !== undefined || context === undefined) return refused;
  if (typeof error !== "object" || error === null) return undefined;
  const { code, errno } = error as { code?: unknown; errno?: unknown };
  if (code === "ER_BAD_DB_ERROR" || errno === ER_BAD_DB_ERRNO) {
    return new DoltDatabaseMissingError(context.database);
  }
  if (typeof code === "string" && GRANT_DENIED_CODES.has(code)) {
    return new DoltGrantMissingError(user);
  }
  if (code === "ER_UNKNOWN_ERROR" && error instanceof Error) {
    const message = error.message.slice(0, 1_024);
    if (GENERIC_GRANT_DENIED.test(message)) {
      return new DoltGrantMissingError(user);
    }
  }
  if (typeof code === "string" && Object.hasOwn(UNREACHABLE_CODES, code)) {
    return new DoltUnreachableError(context, UNREACHABLE_CODES[code]);
  }
  return undefined;
}

/** Rethrow a store failure as its `DomainError`; anything else as itself. */
function rethrowStoreFailure(
  error: unknown,
  user: string | undefined,
  context: DoltFailureContext | undefined,
): never {
  throw storeFailureError(error, user, context) ?? error;
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
  return guardDoltLogins(pool, config.user, {
    host: config.host,
    port: config.port,
    database: config.database,
    userDefaulted: config.userDefaulted,
  });
}

/**
 * Wrap a pool so a refused login surfaces as `DoltLoginRefusedError` rather
 * than the driver's own error, whose message restates the account name. The
 * pool names the user it was built with, so the error names the same account
 * this process asked to log in as — never one parsed out of the server's
 * reply. Given the endpoint `context`, an unreachable server and an unknown
 * database surface the same way, as `DoltUnreachableError` and
 * `DoltDatabaseMissingError`, and a missing grant as `DoltGrantMissingError`.
 * A connection handed out by `getConnection` is guarded the same way,
 * transaction steps included, because the journal acquires one to run a
 * transaction. Every other failure propagates unchanged.
 *
 * Applied to a driver pool of any provenance: `createDoltPool` guards the pool
 * it builds, and a test drives the same guard over a stand-in.
 */
export function guardDoltLogins(
  pool: DoltPool,
  user: string | undefined,
  context?: DoltFailureContext,
): DoltPool {
  return {
    async execute(sql, params) {
      try {
        return await pool.execute(sql, params);
      } catch (error) {
        rethrowStoreFailure(error, user, context);
      }
    },
    async getConnection() {
      let connection: DoltConnection;
      try {
        connection = await pool.getConnection();
      } catch (error) {
        rethrowStoreFailure(error, user, context);
      }
      return guardedDoltConnection(connection, user, context);
    },
    end: () => pool.end(),
  };
}

/** Run `step`, reporting a store failure it raises as its `DomainError`. */
async function guarded(
  step: () => Promise<void>,
  user: string | undefined,
  context: DoltFailureContext | undefined,
): Promise<void> {
  try {
    await step();
  } catch (error) {
    rethrowStoreFailure(error, user, context);
  }
}

/** A pooled connection whose statements report a store failure as such. */
function guardedDoltConnection(
  connection: DoltConnection,
  user: string | undefined,
  context: DoltFailureContext | undefined,
): DoltConnection {
  return {
    async execute(sql, params) {
      try {
        return await connection.execute(sql, params);
      } catch (error) {
        rethrowStoreFailure(error, user, context);
      }
    },
    beginTransaction: () =>
      guarded(() => connection.beginTransaction(), user, context),
    commit: () => guarded(() => connection.commit(), user, context),
    rollback: () => guarded(() => connection.rollback(), user, context),
    release: () => connection.release(),
    destroy: () => connection.destroy(),
  };
}
