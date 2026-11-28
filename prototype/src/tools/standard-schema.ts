/**
 * The wire form of a command's input schema.
 *
 * `CommandDefinition.inputSchema` is the runtime's own shape, and it is what
 * the shared validator reads (`validate.ts`). One keyword in it is not JSON
 * Schema: `nullable`, which marks a property that also accepts `null`
 * (`tools/mcp/schema.ts` normalizes an upstream `["string","null"]` union to
 * one scalar type plus that flag, so the runtime never holds a property with
 * two types).
 *
 * The installed MCP SDK validator ignores the internal flag and rejects null
 * for `{"type":"string","nullable":true}`. The provider tool projection
 * (`registry.ts`), the call's
 * `toolDefinition` schema (`tools/mcp/adapter.ts`) and the Workbench bridge's
 * `tools/list` (`workbench-tool-bridge.ts`) convert through `standardInputSchema`.
 * The conversion publishes the scalar union as `{"type":["string","null"]}`;
 * an `anyOf` with the flag gains a null alternative, subject to a sibling enum.
 *
 * The two shapes are named apart (`JsonSchemaProperty` and
 * `StandardJsonSchemaProperty` in `definition.ts`), so the published one says
 * what it carries: one type, or that type and `"null"`.
 */

import type {
  JsonSchemaObject,
  JsonSchemaProperty,
  StandardJsonSchemaObject,
  StandardJsonSchemaProperty,
  StandardTypeName,
} from "./definition.ts";

/** A schema in standard JSON Schema, for an output boundary. */
export type StandardInputSchema = StandardJsonSchemaObject;

/** Whether `property` or anything nested in it carries the internal keyword. */
function hasNullable(property: JsonSchemaProperty): boolean {
  if (Object.hasOwn(property, "nullable")) return true;
  for (const child of Object.values(property.properties ?? {})) {
    if (hasNullable(child)) return true;
  }
  if (property.items !== undefined && hasNullable(property.items)) return true;
  for (const branch of property.anyOf ?? []) {
    if (hasNullable(branch)) return true;
  }
  return false;
}

/**
 * An own enumerable data property, so a property named `__proto__` is stored
 * as one here, as it is in the sanitizer's own null-prototype maps.
 */
function own<T extends object>(target: T, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/**
 * `property` with its nullable flag converted to a type union or a null
 * alternative around `anyOf`. Nested shapes are converted recursively. The nested
 * containers are rebuilt rather than mutated, so nothing here writes to the
 * command's own schema.
 */
function standardProperty(
  property: JsonSchemaProperty,
): StandardJsonSchemaProperty {
  const output: StandardJsonSchemaProperty = {};
  for (const [key, value] of Object.entries(property)) {
    switch (key) {
      case "nullable":
        // Folded into `type` below, and never published.
        break;
      case "properties": {
        const properties: Record<string, StandardJsonSchemaProperty> = {};
        for (
          const [name, child] of Object.entries(
            value as Record<string, JsonSchemaProperty>,
          )
        ) {
          own(properties, name, standardProperty(child));
        }
        own(output, key, properties);
        break;
      }
      case "items":
        own(output, key, standardProperty(value as JsonSchemaProperty));
        break;
      case "anyOf":
        own(
          output,
          key,
          (value as JsonSchemaProperty[]).map((branch) =>
            standardProperty(branch)
          ),
        );
        break;
      default:
        own(output, key, value);
    }
  }
  if (property.nullable === true && (property.anyOf?.length ?? 0) > 0) {
    // Runtime null admission bypasses the non-null constraints except enum.
    const widened: StandardJsonSchemaProperty = {
      anyOf: [output, { type: "null" }],
    };
    if (property.enum !== undefined) widened.enum = property.enum;
    return widened;
  }
  if (property.nullable === true && property.type !== undefined) {
    // `type` is the keyword the flag widened, so the union replaces it.
    own(output, "type", [
      property.type satisfies StandardTypeName,
      "null",
    ]);
  }
  return output;
}

/**
 * `schema` with nullable flags removed and null admission expressed through
 * type unions or `anyOf` alternatives. A schema with no flag is returned by
 * reference after traversal, without rebuilding it.
 */
export function standardInputSchema(
  schema: JsonSchemaObject,
): StandardInputSchema {
  if (!hasNullable(schema)) return schema;
  // Built key by key rather than converted wholesale: an input schema's root is
  // always an object schema, and this keeps that fact typed instead of asserted.
  const output: StandardInputSchema = { type: "object" };
  if (schema.required !== undefined) output.required = [...schema.required];
  if (schema.additionalProperties !== undefined) {
    output.additionalProperties = schema.additionalProperties;
  }
  if (schema.properties !== undefined) {
    const properties: Record<string, StandardJsonSchemaProperty> = {};
    for (const [name, child] of Object.entries(schema.properties)) {
      own(properties, name, standardProperty(child));
    }
    output.properties = properties;
  }
  return output;
}
