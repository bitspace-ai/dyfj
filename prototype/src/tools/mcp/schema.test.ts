import assert from "node:assert/strict";
import { test } from "node:test";
import { standardInputSchema } from "../standard-schema.ts";
import { validateCommandArguments } from "../validate.ts";
import { McpSchemaRejectedError, sanitizeMcpInputSchema } from "./schema.ts";

test("nullable numeric bounds survive discovery and publication", () => {
  for (const type of ["integer", "number"]) {
    const schema = sanitizeMcpInputSchema({
      type: "object",
      properties: { limit: { type: [type, "null"], minimum: 1, maximum: 10 } },
    });
    assert.deepEqual(standardInputSchema(schema).properties?.limit, {
      type: [type, "null"], minimum: 1, maximum: 10,
    });
    for (const limit of [null, 1, 10]) {
      assert.equal(validateCommandArguments(schema, { limit }), null);
    }
    for (const limit of [0, 11, "1"]) {
      assert.notEqual(validateCommandArguments(schema, { limit }), null);
    }
  }
});

test("nullable schemas refuse unsupported sibling constraints", () => {
  for (const constraint of [
    { pattern: "^a" }, { minLength: 1 }, { maxLength: 10 },
    { exclusiveMinimum: 0 }, { exclusiveMaximum: 10 }, { multipleOf: 2 },
    { const: "all" }, { allOf: [{ type: "string" }] },
    { anyOf: [{ type: "string" }] }, { not: { enum: ["all"] } },
    { format: "email" }, { unknownConstraint: true },
  ]) {
    assert.throws(() => sanitizeMcpInputSchema({
      type: "object",
      properties: { filter: { type: ["string", "null"], ...constraint } },
    }), McpSchemaRejectedError);
  }
});

test("nullable numeric bounds must be finite numbers", () => {
  for (const bound of ["minimum", "maximum"]) {
    for (const value of ["1", null, false, Infinity, NaN]) {
      assert.throws(() => sanitizeMcpInputSchema({
        type: "object",
        properties: { limit: { type: ["integer", "null"], [bound]: value } },
      }), McpSchemaRejectedError);
    }
  }
});

test("null type arrays with anyOf are rejected before legacy collapse", () => {
  for (const type of [
    ["string", "null"], ["object", "null"], ["string", "number", "null"],
  ]) {
    assert.throws(() => sanitizeMcpInputSchema({
      type: "object",
      properties: { value: { type, anyOf: [{ type: "string" }] } },
    }), McpSchemaRejectedError);
  }
});

test("legacy anyOf collapse remains for type arrays without null", () => {
  const schema = sanitizeMcpInputSchema({
    type: "object",
    properties: {
      value: { type: ["string", "number"], anyOf: [{ type: "integer" }] },
    },
  });
  assert.equal(schema.properties?.value?.type, "string");
  assert.equal(validateCommandArguments(schema, { value: "text" }), null);
  assert.notEqual(validateCommandArguments(schema, { value: 1 }), null);
});

test("nullable schemas refuse malformed enums rather than dropping them", () => {
  for (const value of [null, "all", {}, []]) {
    assert.throws(() => sanitizeMcpInputSchema({
      type: "object",
      properties: { filter: { type: ["string", "null"], enum: value } },
    }), McpSchemaRejectedError);
  }
});

test("nullable scalar annotations do not withhold the tool", () => {
  assert.doesNotThrow(() => sanitizeMcpInputSchema({
    type: "object",
    properties: {
      filter: {
        type: ["string", "null"], title: "Filter", description: "A filter",
        default: null, examples: ["all"], deprecated: false, readOnly: false,
        writeOnly: false, $comment: "An annotation",
      },
    },
  }));
});
