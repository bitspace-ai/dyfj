/**
 * Read a database's structure from `information_schema` into a normalized,
 * sorted description: tables, columns (type, nullability, default, ON UPDATE),
 * indexes, constraints (with their key columns and, for foreign keys, the
 * referenced table, columns and rules) and check constraints. `codegen.ts` renders row types
 * from it and `equivalence.ts` compares two of them. Catalog data is not read.
 */

import { queryRows } from "./dolt-apply.ts";

export interface ColumnDescription {
  name: string;
  position: number;
  /** Full declared type, e.g. `varchar(64)`, `enum('a','b')`. */
  columnType: string;
  /** Base type, e.g. `varchar`, `enum`, `tinyint`. */
  dataType: string;
  nullable: boolean;
  /** The default as `information_schema` reports it; null when none. */
  default: string | null;
  /** The default is an expression evaluated at insert time. */
  defaultGenerated: boolean;
  /** `ON UPDATE` expression, from `SHOW CREATE TABLE`; null when none. */
  onUpdate: string | null;
  key: string;
  collation: string | null;
}

export interface IndexDescription {
  name: string;
  unique: boolean;
  type: string;
  /** Columns in index order; a prefix length appears as `column(n)`. */
  columns: string[];
}

export interface ConstraintDescription {
  name: string;
  type: string;
  /** Constrained columns, in key order. */
  columns: string[];
  /** For a foreign key: the referenced table and columns, in key order. */
  referencedTable: string | null;
  referencedColumns: string[];
  /** For a foreign key: its ON UPDATE / ON DELETE rules. */
  updateRule: string | null;
  deleteRule: string | null;
}

export interface CheckDescription {
  name: string;
  clause: string;
}

export interface TableDescription {
  name: string;
  type: string;
  engine: string | null;
  collation: string | null;
  columns: ColumnDescription[];
  indexes: IndexDescription[];
  constraints: ConstraintDescription[];
  checks: CheckDescription[];
}

export interface SchemaDescription {
  tables: TableDescription[];
}

function text(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return value === undefined || value === null ? null : String(value);
}

function required(row: Record<string, unknown>, key: string): string {
  const value = text(row, key);
  if (value === null) {
    throw new Error(`information_schema row is missing ${key}`);
  }
  return value;
}

function byName<T extends { name: string }>(a: T, b: T): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Column name to `ON UPDATE` expression, from a `SHOW CREATE TABLE` body. */
export function onUpdateClauses(createTable: string): Map<string, string> {
  const clauses = new Map<string, string>();
  for (const line of createTable.split("\n")) {
    const match = /^\s*`([^`]+)`\s.*\bON UPDATE\s+([^\s,]+)/.exec(line);
    if (match) clauses.set(match[1]!, match[2]!);
  }
  return clauses;
}

/** Values of an `enum('a','b')` column type, in declaration order. */
export function enumValues(columnType: string): string[] {
  const match = /^enum\((.*)\)$/s.exec(columnType);
  if (!match) throw new Error(`not an enum column type: ${columnType}`);
  const values: string[] = [];
  const pattern = /'((?:[^']|'')*)'/g;
  for (const value of match[1]!.matchAll(pattern)) {
    values.push(value[1]!.replaceAll("''", "'"));
  }
  return values;
}

export async function describeSchema(
  repository: string,
  signal: AbortSignal | undefined,
): Promise<SchemaDescription> {
  const query = (sql: string) => queryRows(repository, sql, signal);
  const tableRows = await query(
    "SELECT table_name, table_type, engine, table_collation " +
      "FROM information_schema.tables WHERE table_schema = database()",
  );
  const columnRows = await query(
    "SELECT table_name, column_name, ordinal_position, column_default, " +
      "is_nullable, data_type, column_type, column_key, extra, " +
      "collation_name FROM information_schema.columns " +
      "WHERE table_schema = database()",
  );
  const indexRows = await query(
    "SELECT table_name, index_name, seq_in_index, column_name, non_unique, " +
      "sub_part, index_type FROM information_schema.statistics " +
      "WHERE table_schema = database()",
  );
  const constraintRows = await query(
    "SELECT table_name, constraint_name, constraint_type " +
      "FROM information_schema.table_constraints " +
      "WHERE table_schema = database()",
  );
  const keyColumnRows = await query(
    "SELECT table_name, constraint_name, column_name, ordinal_position, " +
      "referenced_table_name, referenced_column_name " +
      "FROM information_schema.key_column_usage " +
      "WHERE table_schema = database()",
  );
  const referentialRows = await query(
    "SELECT table_name, constraint_name, update_rule, delete_rule " +
      "FROM information_schema.referential_constraints " +
      "WHERE constraint_schema = database()",
  );
  const checkRows = await query(
    "SELECT tc.table_name, cc.constraint_name, cc.check_clause " +
      "FROM information_schema.check_constraints cc " +
      "JOIN information_schema.table_constraints tc " +
      "ON tc.constraint_schema = cc.constraint_schema " +
      "AND tc.constraint_name = cc.constraint_name " +
      "AND tc.constraint_type = 'CHECK' " +
      "WHERE cc.constraint_schema = database()",
  );

  const tables: TableDescription[] = [];
  for (const row of tableRows) {
    const name = required(row, "TABLE_NAME");
    const inTable = (r: Record<string, unknown>) => r.TABLE_NAME === name;
    const created = await query(`SHOW CREATE TABLE \`${name}\``);
    const onUpdate = onUpdateClauses(
      created.length === 0 ? "" : required(created[0]!, "Create Table"),
    );
    const columns = columnRows.filter(inTable).map((r) => {
      const columnName = required(r, "COLUMN_NAME");
      return {
        name: columnName,
        position: Number(required(r, "ORDINAL_POSITION")),
        columnType: required(r, "COLUMN_TYPE"),
        dataType: required(r, "DATA_TYPE"),
        nullable: required(r, "IS_NULLABLE") === "YES",
        default: text(r, "COLUMN_DEFAULT"),
        defaultGenerated: /DEFAULT_GENERATED/i.test(text(r, "EXTRA") ?? ""),
        onUpdate: onUpdate.get(columnName) ?? null,
        key: text(r, "COLUMN_KEY") ?? "",
        collation: text(r, "COLLATION_NAME"),
      };
    }).sort((a, b) => a.position - b.position);
    const indexes = new Map<string, IndexDescription & { seq: number[] }>();
    for (const r of indexRows.filter(inTable)) {
      const indexName = required(r, "INDEX_NAME");
      const subPart = text(r, "SUB_PART");
      const column = required(r, "COLUMN_NAME") +
        (subPart === null ? "" : `(${subPart})`);
      const index = indexes.get(indexName) ?? {
        name: indexName,
        unique: Number(required(r, "NON_UNIQUE")) === 0,
        type: text(r, "INDEX_TYPE") ?? "",
        columns: [],
        seq: [],
      };
      index.seq.push(Number(required(r, "SEQ_IN_INDEX")));
      index.columns.push(column);
      indexes.set(indexName, index);
    }
    tables.push({
      name,
      type: required(row, "TABLE_TYPE"),
      engine: text(row, "ENGINE"),
      collation: text(row, "TABLE_COLLATION"),
      columns,
      indexes: [...indexes.values()].map(({ seq, ...index }) => ({
        ...index,
        columns: index.columns
          .map((column, i) => ({ column, seq: seq[i]! }))
          .sort((a, b) => a.seq - b.seq)
          .map(({ column }) => column),
      })).sort(byName),
      constraints: constraintRows.filter(inTable).map((r) => {
        const constraintName = required(r, "CONSTRAINT_NAME");
        const ofConstraint = (k: Record<string, unknown>) =>
          inTable(k) && k.CONSTRAINT_NAME === constraintName;
        const keyColumns = keyColumnRows.filter(ofConstraint).sort((a, b) =>
          Number(required(a, "ORDINAL_POSITION")) -
          Number(required(b, "ORDINAL_POSITION"))
        );
        const referential = referentialRows.find(ofConstraint);
        return {
          name: constraintName,
          type: required(r, "CONSTRAINT_TYPE"),
          columns: keyColumns.map((k) => required(k, "COLUMN_NAME")),
          referencedTable: keyColumns.length === 0
            ? null
            : text(keyColumns[0]!, "REFERENCED_TABLE_NAME"),
          referencedColumns: keyColumns.flatMap((k) => {
            const column = text(k, "REFERENCED_COLUMN_NAME");
            return column === null ? [] : [column];
          }),
          updateRule: referential ? text(referential, "UPDATE_RULE") : null,
          deleteRule: referential ? text(referential, "DELETE_RULE") : null,
        };
      }).sort(byName),
      checks: checkRows.filter(inTable).map((r) => ({
        name: required(r, "CONSTRAINT_NAME"),
        clause: required(r, "CHECK_CLAUSE"),
      })).sort(byName),
    });
  }
  return { tables: tables.sort(byName) };
}
