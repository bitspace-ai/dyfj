/**
 * Argument validation against a command's declared input schema, and the
 * model-visible reason an invalid call is denied with. Validation runs before
 * the policy verdict and before the executor, so an invalid call never runs.
 */

import type { JsonSchemaObject, JsonSchemaProperty } from "./definition.ts";

/**
 * Render the argument shape a command expects, from its input schema: a
 * one-line JSON-ish shape (`{"path": string (required)}`) followed by one
 * description line per documented property. Deterministic and value-free, so
 * it is safe for both model context and the durable event log.
 */
function describeExpectedArguments(schema: JsonSchemaObject): string {
  const properties = Object.entries(schema.properties ?? {});
  if (properties.length === 0) return "{} (no arguments)";
  const required = new Set(schema.required ?? []);
  const shape = properties
    .map(([name, property]) =>
      `"${name}": ${property.type} (${
        [required.has(name) ? "required" : "optional", describeBounds(property)]
          .filter((part) => part !== "").join(", ")
      })`
    )
    .join(", ");
  const descriptions = properties
    .filter(([, property]) => property.description)
    .map(([name, property]) => `  ${name} — ${property.description}`);
  return [`{${shape}}`, ...descriptions].join("\n");
}

/** The declared numeric range, as `1 to 600`, `at least 1` or `at most 600`. */
function describeBounds(property: JsonSchemaProperty): string {
  const { minimum, maximum } = property;
  if (minimum !== undefined && maximum !== undefined) {
    return `${minimum} to ${maximum}`;
  }
  if (minimum !== undefined) return `at least ${minimum}`;
  if (maximum !== undefined) return `at most ${maximum}`;
  return "";
}

/**
 * The model-visible reason for an invalid-arguments denial. The bare
 * validation verdict ("missing required argument: path") gives the model
 * nothing to correct with — observed in the field as a verbatim retry of the
 * same malformed call, which the loop's repeat guard then turns into a forced
 * conclusion. Wrap the verdict with the tool name, the expected argument
 * shape, a summary of what was received, and an explicit corrected-retry
 * instruction.
 *
 * The received summary names only keys DECLARED in the tool's schema and
 * reports any others as a bare count. Both argument values AND unrecognized
 * property names are untrusted model output that can carry a path, token, or
 * personal text, and this string is persisted to the durable event log and
 * replayed to the provider — so nothing model-controlled is echoed verbatim
 * (CWE-532); only the tool's own schema vocabulary appears.
 */
export function formatInvalidArgumentsReason(
  commandId: string,
  schema: JsonSchemaObject,
  args: Record<string, unknown>,
  validationError: string,
): string {
  const declared = schema.properties ?? {};
  const received = Object.keys(args);
  // Own-property test, not `in`: `in` walks the prototype chain, so a
  // model-sent key like `constructor` or `__proto__` would otherwise count as
  // a declared property and be echoed verbatim.
  const recognized = received.filter((key) => Object.hasOwn(declared, key));
  const unrecognized = received.length - recognized.length;
  let receivedText: string;
  if (received.length === 0) {
    receivedText = "(none)";
  } else {
    const parts = recognized.map((key) => `"${key}"`);
    if (unrecognized > 0) {
      parts.push(`${unrecognized} not declared in the schema`);
    }
    receivedText = parts.join(", ");
  }
  return [
    `invalid arguments for ${commandId}: ${validationError}`,
    `expected: ${describeExpectedArguments(schema)}`,
    `received keys: ${receivedText}`,
    `The call was rejected before execution. Call ${commandId} again with ` +
    `arguments matching the expected shape.`,
  ].join("\n");
}

export function validateCommandArguments(
  schema: JsonSchemaObject,
  args: Record<string, unknown>,
): string | null {
  const properties = schema.properties ?? {};
  const required = schema.required ?? [];

  // Membership on the model-controlled `args` and against `properties` uses an
  // own-property test, never `in`: `in` walks the prototype chain, so a key
  // like `constructor`, `toString`, or `__proto__` would spuriously satisfy
  // `additionalProperties: false` (bypassing validation) or read as declared.
  for (const field of required) {
    if (!Object.hasOwn(args, field)) {
      return `missing required argument: ${field}`;
    }
  }

  if (schema.additionalProperties === false) {
    for (const field of Object.keys(args)) {
      // Do not echo the raw name: a property name is untrusted model output and
      // could itself carry a path, token, or personal text, and this string is
      // persisted to the durable event log and replayed to the provider.
      if (!Object.hasOwn(properties, field)) {
        return "unexpected argument not declared in the tool's schema";
      }
    }
  }

  for (const [field, property] of Object.entries(properties)) {
    if (!Object.hasOwn(args, field)) continue;
    const error = validateCommandArgumentValue(property, args[field], field);
    if (error !== null) return error;
  }

  return null;
}

function validateCommandArgumentValue(
  property: JsonSchemaProperty,
  value: unknown,
  field: string,
): string | null {
  const actualType = Array.isArray(value)
    ? "array"
    : value === null
    ? "null"
    : typeof value;
  if (property.type === "integer") {
    if (actualType !== "number" || !Number.isInteger(value)) {
      return `${field} must be an integer`;
    }
  } else if (actualType !== property.type) {
    return `${field} must be a ${property.type}`;
  }
  if (
    property.enum !== undefined &&
    !property.enum.some((candidate) => Object.is(candidate, value))
  ) {
    return `${field} must be one of the declared values`;
  }
  if (property.type === "integer" || property.type === "number") {
    // The bounds are the schema's own, so naming them tells the model the
    // accepted range without echoing the value it sent.
    if (
      property.minimum !== undefined && (value as number) < property.minimum
    ) {
      return `${field} must be at least ${property.minimum}`;
    }
    if (
      property.maximum !== undefined && (value as number) > property.maximum
    ) {
      return `${field} must be at most ${property.maximum}`;
    }
  }
  if (
    property.type === "string" &&
    property.pattern &&
    !new RegExp(property.pattern).test(String(value))
  ) {
    return `${field} does not match required pattern`;
  }
  if (
    property.type === "array" && property.maxItems !== undefined &&
    (value as unknown[]).length > property.maxItems
  ) {
    return `${field} exceeds the declared item limit`;
  }
  if (property.type === "array" && property.items !== undefined) {
    for (let index = 0; index < (value as unknown[]).length; index++) {
      const error = validateCommandArgumentValue(
        property.items,
        (value as unknown[])[index],
        `${field}[${index}]`,
      );
      if (error !== null) return error;
    }
  }
  if (property.type === "object") {
    const object = value as Record<string, unknown>;
    const properties = property.properties ?? {};
    for (const required of property.required ?? []) {
      if (!Object.hasOwn(object, required)) {
        return `${field}.${required} is required`;
      }
    }
    if (property.additionalProperties === false) {
      for (const key of Object.keys(object)) {
        if (!Object.hasOwn(properties, key)) {
          return `${field} has an unexpected property`;
        }
      }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (!Object.hasOwn(object, key)) continue;
      const error = validateCommandArgumentValue(
        child,
        object[key],
        `${field}.${key}`,
      );
      if (error !== null) return error;
    }
  }
  return null;
}
