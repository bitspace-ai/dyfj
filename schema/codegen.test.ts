import { renderRows } from "./codegen.ts";
import {
  type ColumnDescription,
  enumValues,
  onUpdateClauses,
  type SchemaDescription,
} from "./introspect.ts";

function assertEquals<T>(actual: T, expected: T): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assertIncludes(text: string, expected: string): void {
  if (!text.includes(expected)) {
    throw new Error(`Expected output to include ${JSON.stringify(expected)}`);
  }
}

function column(
  name: string,
  position: number,
  columnType: string,
  options: Partial<ColumnDescription> = {},
): ColumnDescription {
  return {
    name,
    position,
    columnType,
    dataType: columnType.replace(/\(.*$/s, "").replace(/ unsigned$/, ""),
    nullable: false,
    default: null,
    defaultGenerated: false,
    onUpdate: null,
    key: "",
    collation: null,
    ...options,
  };
}

function schema(columns: ColumnDescription[]): SchemaDescription {
  return {
    tables: [{
      name: "sessions",
      type: "BASE TABLE",
      engine: "InnoDB",
      collation: "utf8mb4_0900_bin",
      columns,
      indexes: [],
      constraints: [],
      checks: [],
    }],
  };
}

Deno.test("enumValues reads declaration order and unescapes quotes", () => {
  assertEquals(enumValues("enum('active','completed')"), [
    "active",
    "completed",
  ]);
  assertEquals(enumValues("enum('it''s','a,b')"), ["it's", "a,b"]);
});

Deno.test("onUpdateClauses maps columns to their ON UPDATE expression", () => {
  const clauses = onUpdateClauses(
    "CREATE TABLE `t` (\n" +
      "  `created_at` timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),\n" +
      "  `updated_at` timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) " +
      "ON UPDATE CURRENT_TIMESTAMP(6),\n" +
      "  PRIMARY KEY (`id`)\n)",
  );
  assertEquals([...clauses], [["updated_at", "CURRENT_TIMESTAMP(6)"]]);
});

Deno.test("renderRows makes NOT NULL columns without a default required", () => {
  const output = renderRows(schema([
    column("session_id", 1, "varchar(64)"),
    column("status", 2, "enum('active','completed')", { default: "active" }),
    column("iteration", 3, "int unsigned", { nullable: true }),
    column("created_at", 4, "timestamp(6)", {
      default: "CURRENT_TIMESTAMP(6)",
      defaultGenerated: true,
    }),
  ]));
  assertIncludes(output, "// generated from schema/ — do not edit\n");
  assertIncludes(output, "  session_id: string;\n");
  assertIncludes(output, "  status?: SessionStatus | null;\n");
  assertIncludes(output, "  iteration?: number | null;\n");
  assertIncludes(output, "  created_at?: string | Date | null;\n");
  assertIncludes(
    output,
    'export const SESSION_STATUS_VALUES = [\n  "active",\n  "completed",\n] as const;',
  );
  assertIncludes(output, "  iteration: number | null;\n");
  assertIncludes(output, "  created_at: Date;\n");
  assertIncludes(
    output,
    '  status: { kind: "enum", nullable: false, default: "active" },\n',
  );
  assertIncludes(output, "  sessions: SESSION_COLUMNS,\n");
});

Deno.test("renderRows is deterministic", () => {
  const columns = [
    column("session_id", 1, "varchar(64)"),
    column("cost", 2, "decimal(10,6)", { nullable: true }),
  ];
  assertEquals(renderRows(schema(columns)), renderRows(schema(columns)));
  assertIncludes(
    renderRows(schema(columns)),
    '  cost: { kind: "decimal", nullable: true, scale: 6 },\n',
  );
});

Deno.test("renderRows refuses a table it has no type name for", () => {
  const described = schema([column("id", 1, "varchar(64)")]);
  described.tables[0]!.name = "widgets";
  let message = "";
  try {
    renderRows(described);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assertIncludes(message, "no type name for table widgets");
});

Deno.test("renderRows refuses a column type it has no mapping for", () => {
  let message = "";
  try {
    renderRows(schema([column("blob", 1, "blob")]));
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assertIncludes(message, "no mapping for blob blob");
});
