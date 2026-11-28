/**
 * The schema a configured external MCP tool is allowed to publish.
 *
 * A discovered input schema is untrusted data, so it is re-built against fixed
 * limits before the model ever sees it: bounded size, nesting, property count
 * and enum values; only the JSON Schema vocabulary the runtime can honour; and
 * argument names that cannot collide with a prototype. A schema that breaks a
 * rule is refused with a reason naming the rule, and discovery reports that
 * reason at boot (`adapter.ts`).
 *
 * One upstream form is *normalized* rather than refused: a `type` array naming
 * one scalar type and `"null"` becomes that scalar type plus the runtime's own
 * `nullable` flag, so the runtime holds one type per property. Every output
 * boundary converts the flag back to the standard union
 * (`tools/standard-schema.ts`); `validate.ts` admits `null` for a flagged
 * property.
 */

import type { JsonSchemaObject } from "../definition.ts";
import type { DiscoveredMcpTool } from "./transport.ts";

const MAX_SCHEMA_BYTES = 64_000;
const MAX_SCHEMA_DEPTH = 12;
const MAX_SCHEMA_PROPERTIES = 64;
// Linear's get_issue offers a 45-value `fields` enum; the byte limit above
// still bounds the schema as a whole.
const MAX_SCHEMA_ENUM_VALUES = 64;
const TOOL_ARGUMENT_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;

/**
 * A schema the sanitizer refuses. `reason` names the rule or limit it broke;
 * it carries counts and JSON Schema type names, never other schema content.
 */
export class McpSchemaRejectedError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`external MCP tool schema rejected: ${reason}`);
    this.name = "McpSchemaRejectedError";
    this.reason = reason;
  }
}

function rejectSchema(reason: string): never {
  throw new McpSchemaRejectedError(reason);
}

const JSON_SCHEMA_TYPES = new Set([
  "object",
  "string",
  "number",
  "integer",
  "boolean",
  "array",
  "null",
]);

/**
 * The scalar types a nullable `type` array may carry beside `"null"`. Only a
 * scalar is admitted: an object or array schema has structure of its own
 * (`properties`, `items`) that a null union does not describe, so those forms
 * stay refused rather than be reinterpreted here.
 */
const NULLABLE_SCALAR_TYPES = new Set([
  "string",
  "number",
  "integer",
  "boolean",
]);

const NULLABLE_SCALAR_KEYWORDS = new Set([
  "type", "enum", "minimum", "maximum",
  "title", "description", "default", "examples", "deprecated", "readOnly",
  "writeOnly", "$comment",
]);

/**
 * The one upstream spelling this sanitizer admits for a nullable property: a
 * `type` array naming one scalar type and `"null"`. It becomes that scalar type
 * plus `nullable`, so the runtime holds one type per property; every output
 * boundary converts the flag back to the standard union
 * (`tools/standard-schema.ts`). Every other spelling keeps the verdict it had:
 * a union of two or more types is refused with its names, and an `anyOf` is
 * left to the collapse below, which never admits null. The supported `enum`
 * keyword is carried through untouched, so a nullable property
 * whose `enum` excludes null still rejects null in argument validation.
 */
function nullableShape(
  input: Record<string, unknown>,
): { type: string; node: Record<string, unknown> } | undefined {
  if (!Array.isArray(input.type)) return undefined;
  const names = [...new Set(input.type)];
  if (!names.includes("null")) return undefined;
  const typed = names.filter((name) => name !== "null");
  if (typed.length !== 1 || !NULLABLE_SCALAR_TYPES.has(typed[0] as string)) {
    rejectSchema(`type ${describeType(input.type)} is not supported`);
  }
  if (Object.keys(input).some((key) => !NULLABLE_SCALAR_KEYWORDS.has(key))) {
    rejectSchema("a nullable scalar has an unsupported keyword");
  }
  if (
    Object.hasOwn(input, "enum") &&
    (!Array.isArray(input.enum) || input.enum.length === 0)
  ) {
    rejectSchema("a nullable scalar enum is not a non-empty array");
  }
  for (const bound of ["minimum", "maximum"]) {
    if (!Object.hasOwn(input, bound)) continue;
    if (
      (typed[0] !== "number" && typed[0] !== "integer") ||
      typeof input[bound] !== "number" || !Number.isFinite(input[bound])
    ) {
      rejectSchema("a nullable numeric bound is not a finite number on a numeric type");
    }
  }
  return {
    type: typed[0] as string,
    node: { ...input, type: typed[0] as string },
  };
}

/** Names an unsupported type only from JSON Schema's own vocabulary. */
function describeType(type: unknown): string {
  const names = Array.isArray(type) ? type : [type];
  return names.length > 0 && names.length <= 7 &&
      names.every((name) => JSON_SCHEMA_TYPES.has(name as string))
    ? JSON.stringify(type)
    : "of an unrecognized form";
}

function sanitizeSchemaNode(
  value: unknown,
  depth: number,
): Record<string, unknown> {
  if (depth > MAX_SCHEMA_DEPTH) {
    rejectSchema(`nesting deeper than ${MAX_SCHEMA_DEPTH} levels`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    rejectSchema("a schema node is not an object");
  }
  const raw = value as Record<string, unknown>;
  if (Object.hasOwn(raw, "$ref")) {
    rejectSchema("$ref is not supported");
  }
  // A `type` array naming one scalar type and `"null"` becomes that scalar
  // type plus `nullable`, so the runtime holds one type per property and
  // validation still treats null as a legal value. Any other spelling is left
  // exactly as it was.
  const nullable = nullableShape(raw);
  const input = nullable === undefined ? raw : nullable.node;
  let type = input.type;
  const isNullable = nullable !== undefined;
  if (
    type !== "object" && type !== "string" && type !== "number" &&
    type !== "integer" && type !== "boolean" && type !== "array"
  ) {
    if (Array.isArray(input.anyOf)) {
      type = "string";
    } else if (type === undefined) {
      rejectSchema("a schema node has no type");
    } else {
      rejectSchema(`type ${describeType(type)} is not supported`);
    }
  }
  const output: Record<string, unknown> = { type };
  if (isNullable) {
    output.nullable = true;
    for (const bound of ["minimum", "maximum"]) {
      if (Object.hasOwn(input, bound)) output[bound] = input[bound];
    }
  }
  if (type === "object") {
    const rawProperties = input.properties ?? {};
    if (
      typeof rawProperties !== "object" || rawProperties === null ||
      Array.isArray(rawProperties)
    ) {
      rejectSchema("properties is not an object");
    }
    const entries = Object.entries(rawProperties as Record<string, unknown>);
    if (entries.length > MAX_SCHEMA_PROPERTIES) {
      rejectSchema(
        `${entries.length} properties exceeds ${MAX_SCHEMA_PROPERTIES}`,
      );
    }
    const properties: Record<string, unknown> = Object.create(null);
    for (const [name, property] of entries) {
      if (!TOOL_ARGUMENT_NAME.test(name)) {
        rejectSchema("a property name is not a valid argument name");
      }
      properties[name] = sanitizeSchemaNode(property, depth + 1);
    }
    output.properties = properties;
    if (input.required !== undefined) {
      if (
        !Array.isArray(input.required) ||
        !input.required.every((name) =>
          typeof name === "string" && Object.hasOwn(properties, name)
        )
      ) {
        rejectSchema("required is not a list of declared property names");
      }
      output.required = [...new Set(input.required)];
    }
    if (input.additionalProperties !== undefined) {
      if (typeof input.additionalProperties !== "boolean") {
        rejectSchema("additionalProperties is not a boolean");
      }
      output.additionalProperties = input.additionalProperties;
    }
  }
  if (type === "array") {
    if (input.items === undefined) {
      rejectSchema("array schema has no items");
    }
    output.items = sanitizeSchemaNode(input.items, depth + 1);
  }
  if (Array.isArray(input.enum)) {
    if (input.enum.length > MAX_SCHEMA_ENUM_VALUES) {
      rejectSchema(
        `enum of ${input.enum.length} values exceeds ${MAX_SCHEMA_ENUM_VALUES}`,
      );
    }
    if (
      !input.enum.every((entry) =>
        typeof entry === "string" || typeof entry === "number" ||
        typeof entry === "boolean" || entry === null
      )
    ) {
      rejectSchema("enum value is not a string, number, boolean or null");
    }
    output.enum = input.enum;
  }
  return output;
}

export function sanitizeMcpInputSchema(value: unknown): JsonSchemaObject {
  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (bytes > MAX_SCHEMA_BYTES) {
    rejectSchema(`${bytes} bytes exceeds ${MAX_SCHEMA_BYTES}`);
  }
  const schema = sanitizeSchemaNode(value, 0);
  if (schema.type !== "object") {
    rejectSchema("input schema root is not an object");
  }
  return schema as JsonSchemaObject;
}

export function retainConfiguredMcpTools(
  configured: readonly { name: string }[],
  discovered: readonly DiscoveredMcpTool[],
): DiscoveredMcpTool[] {
  const wanted = new Set(configured.map((tool) => tool.name));
  const retained: DiscoveredMcpTool[] = [];
  const seen = new Set<string>();
  for (const tool of discovered) {
    if (!wanted.has(tool.name) || seen.has(tool.name)) continue;
    retained.push(tool);
    seen.add(tool.name);
    if (seen.size === wanted.size) break;
  }
  return retained;
}
