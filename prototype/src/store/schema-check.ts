/**
 * The boot-time column check (`specs/02-data-layer.md` section 5). The readers
 * and the journal name columns from the current baseline and have no
 * fallback for a database that predates a migration, so the engine compares
 * the live database's columns for the canonical tables against the generated
 * column tuples before it serves, and refuses to start when any are missing.
 */

import {
  CANONICAL_TABLE_COLUMNS,
  type CanonicalTable,
} from "./generated/rows.ts";

export interface MissingColumn {
  table: CanonicalTable;
  column: string;
}

/** Thrown at boot when the live database lacks canonical columns. */
export class MissingSchemaColumnsError extends Error {
  readonly missing: readonly MissingColumn[];

  constructor(missing: readonly MissingColumn[]) {
    const names = missing.map(({ table, column }) => `${table}.${column}`);
    super(
      `The Dolt database is missing ${missing.length} column(s) this ` +
        `runtime needs: ${names.join(", ")}. Apply the forward migrations ` +
        "in schema/migrations/ to bring it to the current baseline (see " +
        "schema/README.md), then start the runtime again.",
    );
    this.name = "MissingSchemaColumnsError";
    this.missing = missing;
  }
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
