/**
 * The boot-time column check (`specs/02-data-layer.md` section 5). The readers
 * and the journal name columns from the current baseline and have no
 * fallback for a database that predates a migration, so the engine compares
 * the live database's columns for the canonical tables against the generated
 * column tuples before it serves, and refuses to start when any are missing.
 */

import { DomainError } from "../contract/mod.ts";
import {
  DoltDatabaseMissingError,
  DoltLoginRefusedError,
  DoltUnreachableError,
} from "./dolt-pool.ts";
import {
  CANONICAL_TABLE_COLUMNS,
  type CanonicalTable,
} from "./generated/rows.ts";

export interface MissingColumn {
  table: CanonicalTable;
  column: string;
}

/** Thrown at boot when the live database lacks canonical columns. */
export class MissingSchemaColumnsError extends DomainError {
  readonly missing: readonly MissingColumn[];

  constructor(missing: readonly MissingColumn[]) {
    // A table with every canonical column missing is reported as the table:
    // information_schema hides a table the user has no grant on, so it may
    // exist and be unreadable, and its columns would only crowd the message.
    const tables = (Object.keys(CANONICAL_TABLE_COLUMNS) as CanonicalTable[])
      .filter((table) =>
        CANONICAL_TABLE_COLUMNS[table].every((column) =>
          missing.some((m) => m.table === table && m.column === column)
        )
      );
    const columns = missing.filter(({ table }) => !tables.includes(table));
    const parts: string[] = [];
    if (columns.length > 0) {
      const names = columns.map(({ table, column }) => `${table}.${column}`);
      parts.push(
        `The Dolt database is missing ${columns.length} column(s) this ` +
          `runtime needs: ${names.join(", ")}. Apply the forward migrations ` +
          "in schema/migrations/ to bring it to the current baseline (see " +
          "schema/README.md), then start the runtime again.",
      );
    }
    if (tables.length > 0) {
      parts.push(
        `The Dolt database shows this runtime no table named ` +
          `${tables.join(", ")}. Either the schema was never applied to it ` +
          "(schema/README.md), or the DOLT_USER it logs in as has no grant " +
          "on those tables (the Dolt users section of schema/README.md); " +
          "fix that, then start the runtime again.",
      );
    }
    super(parts.join(" "));
    this.name = "MissingSchemaColumnsError";
    this.missing = missing;
  }
}

/** How long the boot waits for the column check before booting without it. */
export const BOOT_COLUMN_CHECK_TIMEOUT_MS = 5_000;

/** The column check did not answer in time: treated as an unavailable database. */
export class ColumnCheckTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`the boot-time column check did not answer within ${timeoutMs}ms`);
    this.name = "ColumnCheckTimeoutError";
  }
}

/**
 * Run the boot-time column check, bounded by `timeoutMs`. Resolves when the
 * check passes, or when the database could not be reached or used in time
 * (`isDatabaseUnavailableError`), so the engine boots as it did before the
 * check existed and the error surfaces on first use. Rejects with any other
 * failure, `MissingSchemaColumnsError` included. A check still running when
 * the bound expires is left to settle unobserved.
 */
export async function checkColumnsAtBoot(
  store: { assertCanonicalColumns(): Promise<void> },
  timeoutMs = BOOT_COLUMN_CHECK_TIMEOUT_MS,
): Promise<"checked" | "unavailable"> {
  const check = store.assertCanonicalColumns();
  check.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new ColumnCheckTimeoutError(timeoutMs)),
      timeoutMs,
    );
  });
  try {
    await Promise.race([check, expired]);
    return "checked";
  } catch (error) {
    if (isDatabaseUnavailableError(error)) return "unavailable";
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `mysql2` error codes meaning the database could not be reached or used at
 * all, as opposed to a query that ran and failed.
 */
const UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "PROTOCOL_CONNECTION_LOST",
  "ER_ACCESS_DENIED_ERROR",
  "ER_BAD_DB_ERROR",
]);

/**
 * Whether the boot-time column check failed because the database was not
 * reachable or usable (connection, authentication, unknown database, raw or
 * as the pool's own error for it), in
 * which case the engine boots as it did before the check existed and the
 * error surfaces on first use. Any other failure is not recognized here, so
 * the boot fails rather than serving with a check that never completed.
 */
export function isDatabaseUnavailableError(error: unknown): boolean {
  if (
    error instanceof ColumnCheckTimeoutError ||
    error instanceof DoltLoginRefusedError ||
    error instanceof DoltUnreachableError ||
    error instanceof DoltDatabaseMissingError
  ) return true;
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && UNAVAILABLE_CODES.has(code);
}

/**
 * Canonical columns absent from `live` (table name to its column names), in
 * table then declaration order. A missing table reports every column.
 * Columns the live database has beyond the canonical set are not reported.
 */
export function missingCanonicalColumns(
  live: ReadonlyMap<string, ReadonlySet<string>>,
): MissingColumn[] {
  const missing: MissingColumn[] = [];
  for (
    const [table, columns] of Object.entries(CANONICAL_TABLE_COLUMNS) as [
      CanonicalTable,
      readonly string[],
    ][]
  ) {
    const present = live.get(table);
    for (const column of columns) {
      if (!present?.has(column)) missing.push({ table, column });
    }
  }
  return missing;
}
