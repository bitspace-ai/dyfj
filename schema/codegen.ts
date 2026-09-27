/**
 * `schema.codegen`: generate the TypeScript row types from the DDL
 * (`specs/02-data-layer.md` section 3). Applies `current/` then `catalog/` to
 * a disposable Dolt repository, reads `information_schema`, and emits
 * `prototype/src/store/generated/rows.ts`. Output is deterministic: tables
 * sorted by name, columns in declaration order.
 *
 *   deno task schema:codegen          write the file
 *   deno task schema:codegen --check  fail if the committed file is stale
 */

import {
  assertSchemaApplyPlan,
  readSchemaApplyPlan,
  withSchemaRepository,
} from "./dolt-apply.ts";
import {
  type ColumnDescription,
  describeSchema,
  enumValues,
  type SchemaDescription,
  type TableDescription,
} from "./introspect.ts";

export const GENERATED_ROWS_PATH = "prototype/src/store/generated/rows.ts";

/**
 * Type and constant stems per canonical table. A table missing here fails
 * generation: naming a new table is a deliberate edit, not a guess.
 */
const TABLE_NAMES: Readonly<
  Record<string, { type: string; constant: string }>
> = {
  events: { type: "Event", constant: "EVENT" },
  memories: { type: "Memory", constant: "MEMORY" },
  models: { type: "Model", constant: "MODEL" },
  prompts: { type: "Prompt", constant: "PROMPT" },
  sessions: { type: "Session", constant: "SESSION" },
};

type ColumnKind =
  | "text"
  | "enum"
  | "int"
  | "boolean"
  | "decimal"
  | "timestamp"
  | "json";

function columnKind(column: ColumnDescription): ColumnKind {
  const type = column.columnType.toLowerCase();
  if (type === "tinyint(1)") return "boolean";
  switch (column.dataType.toLowerCase()) {
    case "char":
    case "varchar":
    case "tinytext":
    case "text":
    case "mediumtext":
    case "longtext":
      return "text";
    case "enum":
      return "enum";
    case "tinyint":
    case "smallint":
    case "mediumint":
    case "int":
      return "int";
    case "decimal":
      return "decimal";
    case "timestamp":
    case "datetime":
      return "timestamp";
    case "json":
      return "json";
  }
  throw new Error(
    `codegen has no mapping for ${column.name} ${column.columnType}`,
  );
}

function decimalScale(column: ColumnDescription): number {
  const match = /^decimal\(\d+,\s*(\d+)\)/i.exec(column.columnType);
  if (!match) throw new Error(`no scale in ${column.columnType}`);
  return Number(match[1]);
}

function pascal(snake: string): string {
  return snake.split("_").map((part) =>
    part.length === 0 ? "" : part[0]!.toUpperCase() + part.slice(1)
  ).join("");
}

/** `event_type` on `events` is `type`; `visibility` on `memories` stays. */
function enumStem(table: string, column: string): string {
  const singular = TABLE_NAMES[table]!.type.toLowerCase();
  return column.startsWith(`${singular}_`)
    ? column.slice(singular.length + 1)
    : column;
}

function enumTypeName(table: string, column: string): string {
  return TABLE_NAMES[table]!.type + pascal(enumStem(table, column));
}

function enumConstantName(table: string, column: string): string {
  return `${TABLE_NAMES[table]!.constant}_${
    enumStem(table, column).toUpperCase()
  }_VALUES`;
}

/** The value type as the `mysql2` driver decodes a selected column. */
function rowType(table: string, column: ColumnDescription): string {
  switch (columnKind(column)) {
    case "text":
      return "string";
    case "enum":
      return enumTypeName(table, column.name);
    case "int":
    case "boolean":
      return "number";
    case "decimal":
      return "string";
    case "timestamp":
      return "Date";
    case "json":
      return "unknown";
  }
}

/** The value type an insert binds (the journal stores booleans as 0/1). */
function insertType(table: string, column: ColumnDescription): string {
  switch (columnKind(column)) {
    case "text":
    case "json":
      return "string";
    case "enum":
      return enumTypeName(table, column.name);
    case "int":
    case "decimal":
      return "number";
    case "boolean":
      return "boolean";
    case "timestamp":
      return "string | Date";
  }
}

/** Required on insert: NOT NULL with no default. */
function insertRequired(column: ColumnDescription): boolean {
  return !column.nullable && column.default === null &&
    !column.defaultGenerated;
}

/** One entry of an object literal, wrapped the way `deno fmt` wraps it. */
function objectEntry(
  indent: string,
  key: string,
  fields: [string, string][],
): string[] {
  const inline = `${indent}${key}: { ${
    fields.map(([k, v]) => `${k}: ${v}`).join(", ")
  } },`;
  if (inline.length <= 80) return [inline];
  return [
    `${indent}${key}: {`,
    ...fields.map(([k, v]) => `${indent}  ${k}: ${v},`),
    `${indent}},`,
  ];
}

function renderTable(table: TableDescription): string[] {
  const names = TABLE_NAMES[table.name]!;
  const lines: string[] = [];
  lines.push(
    `// ─── ${table.name} ${"─".repeat(Math.max(3, 73 - table.name.length))}`,
  );
  lines.push("");
  for (const column of table.columns) {
    if (columnKind(column) !== "enum") continue;
    const constant = enumConstantName(table.name, column.name);
    const type = enumTypeName(table.name, column.name);
    lines.push(
      `/** \`${table.name}.${column.name}\`, in declaration order. */`,
    );
    lines.push(`export const ${constant} = [`);
    for (const value of enumValues(column.columnType)) {
      lines.push(`  ${JSON.stringify(value)},`);
    }
    lines.push("] as const;");
    const alias = `export type ${type} = (typeof ${constant})[number];`;
    if (alias.length <= 80) {
      lines.push(alias);
    } else {
      lines.push(`export type ${type} =`, `  (typeof ${constant})[number];`);
    }
    lines.push("");
  }

  lines.push(`/** \`${table.name}\` columns, in declaration order. */`);
  lines.push(`export const ${names.constant}_COLUMNS = [`);
  for (const column of table.columns) {
    lines.push(`  ${JSON.stringify(column.name)},`);
  }
  lines.push("] as const;");
  lines.push(
    `export type ${names.type}Column = (typeof ${names.constant}_COLUMNS)[number];`,
  );
  lines.push("");

  lines.push(`/** How each \`${table.name}\` column is declared. */`);
  lines.push(
    `export const ${names.constant}_COLUMN_SPECS: Readonly<`,
    `  Record<${names.type}Column, ColumnSpec>`,
    "> = {",
  );
  for (const column of table.columns) {
    const kind = columnKind(column);
    const fields: [string, string][] = [
      ["kind", JSON.stringify(kind)],
      ["nullable", String(column.nullable)],
    ];
    if (column.default !== null) {
      fields.push(["default", JSON.stringify(column.default)]);
    }
    if (column.defaultGenerated) fields.push(["generated", "true"]);
    if (kind === "decimal") {
      fields.push(["scale", String(decimalScale(column))]);
    }
    lines.push(...objectEntry("  ", column.name, fields));
  }
  lines.push("};");
  lines.push("");

  lines.push(
    `/** A selected \`${table.name}\` row, as the Dolt driver decodes it. */`,
  );
  lines.push(`export interface ${names.type}Row {`);
  for (const column of table.columns) {
    const type = rowType(table.name, column);
    const nullable = column.nullable && type !== "unknown";
    lines.push(`  ${column.name}: ${type}${nullable ? " | null" : ""};`);
  }
  lines.push("}");
  lines.push("");

  lines.push(
    `/**`,
    ` * One \`${table.name}\` row to insert. NOT NULL columns without a default are`,
    ` * required; a null or omitted column takes its DDL default.`,
    ` */`,
  );
  lines.push(`export interface ${names.type}Insert {`);
  for (const column of table.columns) {
    const type = insertType(table.name, column);
    lines.push(
      insertRequired(column)
        ? `  ${column.name}: ${type};`
        : `  ${column.name}?: ${type} | null;`,
    );
  }
  lines.push("}");
  lines.push("");
  return lines;
}

export function renderRows(schema: SchemaDescription): string {
  for (const table of schema.tables) {
    if (TABLE_NAMES[table.name] === undefined) {
      throw new Error(
        `codegen has no type name for table ${table.name}; add it to ` +
          "TABLE_NAMES in schema/codegen.ts",
      );
    }
  }
  const lines = [
    "// generated from schema/ — do not edit",
    "//",
    "// Emitted by schema/codegen.ts from schema/current/ + schema/catalog/.",
    "// Regenerate with `deno task schema:codegen`; the schema.codegen gate lane",
    "// fails when this file is stale.",
    "",
    "/** A column's declared shape, as `information_schema` reports it. */",
    "export interface ColumnSpec {",
    "  /** `boolean` is `tinyint(1)`; `text` covers CHAR, VARCHAR and TEXT. */",
    "  readonly kind:",
    '    | "text"',
    '    | "enum"',
    '    | "int"',
    '    | "boolean"',
    '    | "decimal"',
    '    | "timestamp"',
    '    | "json";',
    "  readonly nullable: boolean;",
    "  /** The DDL default as text; absent when the column has none. */",
    "  readonly default?: string;",
    "  /** The default is an expression evaluated at insert time. */",
    "  readonly generated?: true;",
    "  /** Digits after the decimal point, for `decimal`. */",
    "  readonly scale?: number;",
    "}",
    "",
  ];
  for (const table of schema.tables) lines.push(...renderTable(table));
  lines.push(
    "/** Every canonical table's columns, for the boot-time column check. */",
    "export const CANONICAL_TABLE_COLUMNS = {",
    ...schema.tables.map((table) =>
      `  ${table.name}: ${TABLE_NAMES[table.name]!.constant}_COLUMNS,`
    ),
    "} as const;",
    "export type CanonicalTable = keyof typeof CANONICAL_TABLE_COLUMNS;",
  );
  return lines.join("\n") + "\n";
}

export async function generateRows(signal?: AbortSignal): Promise<string> {
  const schemaDir = new URL("./", import.meta.url);
  const plan = await readSchemaApplyPlan(schemaDir);
  assertSchemaApplyPlan(plan);
  const schema = await withSchemaRepository(
    schemaDir,
    [...plan.current, ...plan.catalog],
    "current + catalog",
    signal,
    (repository) => describeSchema(repository, signal),
  );
  return renderRows(schema);
}

if (import.meta.main) {
  const check = Deno.args.includes("--check");
  if (Deno.args.some((arg) => arg !== "--check")) {
    console.error("usage: codegen.ts [--check]");
    Deno.exit(2);
  }
  const target = new URL(`../${GENERATED_ROWS_PATH}`, import.meta.url);
  const generated = await generateRows();
  if (check) {
    let committed: string | null = null;
    try {
      committed = await Deno.readTextFile(target);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    if (committed !== generated) {
      console.error(
        `schema.codegen: ${GENERATED_ROWS_PATH} is stale against schema/. ` +
          "Regenerate it with `deno task schema:codegen` and commit the result.",
      );
      Deno.exit(1);
    }
    console.log(`schema.codegen: ${GENERATED_ROWS_PATH} is current.`);
  } else {
    await Deno.mkdir(new URL("./", target), { recursive: true });
    await Deno.writeTextFile(target, generated);
    console.log(`schema.codegen: wrote ${GENERATED_ROWS_PATH}.`);
  }
}
