import { schemaDifferences } from "./equivalence.ts";
import type {
  ColumnDescription,
  SchemaDescription,
  TableDescription,
} from "./introspect.ts";

function assertEquals<T>(actual: T, expected: T): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function column(
  name: string,
  options: Partial<ColumnDescription> = {},
): ColumnDescription {
  return {
    name,
    position: 1,
    columnType: "varchar(64)",
    dataType: "varchar",
    nullable: false,
    default: null,
    defaultGenerated: false,
    onUpdate: null,
    key: "",
    collation: "utf8mb4_0900_bin",
    ...options,
  };
}

function table(options: Partial<TableDescription> = {}): TableDescription {
  return {
    name: "sessions",
    type: "BASE TABLE",
    engine: "InnoDB",
    collation: "utf8mb4_0900_bin",
    columns: [column("session_id", { key: "PRI" })],
    indexes: [{
      name: "PRIMARY",
      unique: true,
      type: "BTREE",
      columns: ["session_id"],
    }],
    constraints: [{ name: "PRIMARY", type: "PRIMARY KEY" }],
    checks: [],
    ...options,
  };
}

function schema(...tables: TableDescription[]): SchemaDescription {
  return { tables };
}

Deno.test("identical structures have no differences", () => {
  assertEquals(schemaDifferences(schema(table()), schema(table())), []);
});

Deno.test("a table on one side only is a difference", () => {
  assertEquals(
    schemaDifferences(schema(table()), schema(table(), table({ name: "x" }))),
    ["x: only in history + migrations"],
  );
});

Deno.test("column type, nullability, default and ON UPDATE are compared", () => {
  const replayed = table({
    columns: [
      column("session_id", {
        key: "PRI",
        columnType: "varchar(128)",
        nullable: true,
        default: "a",
        onUpdate: "CURRENT_TIMESTAMP(6)",
      }),
    ],
  });
  assertEquals(schemaDifferences(schema(table()), schema(replayed)), [
    'sessions.columns.session_id.columnType: current + catalog "varchar(64)", history + migrations "varchar(128)"',
    "sessions.columns.session_id.nullable: current + catalog false, history + migrations true",
    'sessions.columns.session_id.default: current + catalog null, history + migrations "a"',
    'sessions.columns.session_id.onUpdate: current + catalog null, history + migrations "CURRENT_TIMESTAMP(6)"',
  ]);
});

Deno.test("enum values are compared through the column type", () => {
  const enumColumn = (values: string) =>
    table({
      columns: [
        column("status", { columnType: `enum(${values})`, dataType: "enum" }),
      ],
    });
  assertEquals(
    schemaDifferences(
      schema(enumColumn("'active','completed'")),
      schema(enumColumn("'active'")),
    ).length,
    1,
  );
});

Deno.test("indexes, constraints and checks are compared by name", () => {
  const replayed = table({
    indexes: [
      { name: "PRIMARY", unique: true, type: "BTREE", columns: ["session_id"] },
      { name: "idx_x", unique: false, type: "BTREE", columns: ["slug"] },
    ],
    constraints: [],
    checks: [{ name: "chk", clause: "(`x` > 0)" }],
  });
  assertEquals(schemaDifferences(schema(table()), schema(replayed)), [
    "sessions.indexes.idx_x: only in history + migrations",
    "sessions.constraints.PRIMARY: only in current + catalog",
    "sessions.checks.chk: only in history + migrations",
  ]);
});
