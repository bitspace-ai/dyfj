/**
 * Projectors: how an appended event updates a projected table, inside the
 * same `journal.commit` transaction as the append (`specs/02-data-layer.md`
 * section 2).
 *
 * A projector is pure. It reads only the event and the row it projects onto,
 * never the clock, IDs or config, so replaying the same events gives the same
 * rows. It returns the new row, or null to remove the row.
 */

import {
  type ColumnSpec,
  type EventInsert,
  MEMORY_COLUMN_SPECS,
  MEMORY_COLUMNS,
  SESSION_COLUMN_SPECS,
  SESSION_COLUMNS,
} from "./generated/rows.ts";
import type { TextRow } from "./port.ts";

export type ProjectedTable = "sessions" | "memories";

/** Values a projector may write: text, numbers, or SQL NULL. */
export type ProjectionRow = Readonly<Record<string, string | number | null>>;

export interface Projector {
  name: string;
  table: ProjectedTable;
  /**
   * Primary key of the row this event projects onto, or null when the event
   * does not touch this table.
   */
  key(event: EventInsert): string | null;
  /**
   * The row after the event. `current` is the row as the readers render it
   * (NULL as ""), or null when there is none. Must not throw for an event its
   * `key` selected unless the commit should fail.
   */
  project(current: TextRow | null, event: EventInsert): ProjectionRow | null;
}

/** Every column except those stamped at insert time (`created_at`, ...). */
function writable<C extends string>(
  columns: readonly C[],
  specs: Readonly<Record<C, ColumnSpec>>,
): readonly string[] {
  return columns.filter((column) => !specs[column].generated);
}

/** Primary-key column and the columns a projector may write, per table. */
export const PROJECTED_TABLES: Readonly<
  Record<ProjectedTable, { key: string; columns: readonly string[] }>
> = {
  sessions: {
    key: "session_id",
    columns: writable(SESSION_COLUMNS, SESSION_COLUMN_SPECS),
  },
  memories: {
    key: "memory_id",
    columns: writable(MEMORY_COLUMNS, MEMORY_COLUMN_SPECS),
  },
};

/**
 * The projectors `journal.commit` applies by default. Empty in phase 1: no
 * event written today reproduces a projected row exactly (the session row
 * carries workspace and context-source content that no event carries, and
 * memories have no event at all), so those writes are declared unjournaled
 * mutations instead (`unjournaled.ts`).
 */
export const PHASE1_PROJECTORS: readonly Projector[] = [];

/** Reject a projected row that names a column the table does not project. */
export function assertProjectableRow(
  table: ProjectedTable,
  key: string,
  row: ProjectionRow,
): void {
  const spec = PROJECTED_TABLES[table];
  for (const column of Object.keys(row)) {
    if (!spec.columns.includes(column)) {
      throw new Error(`projector wrote an unknown ${table} column: ${column}`);
    }
  }
  if (row[spec.key] !== key) {
    throw new Error(`projector changed the ${table} primary key`);
  }
}
