// The runtime's input-schema shape published as standard JSON Schema, and the
// standards validator in the installed MCP SDK that rejects the runtime's own
// `nullable` keyword (BIT-998). Every output boundary goes through
// `standardInputSchema`, because a consumer that validates the schema it is
// handed must see the standard null union, never the internal flag.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/client/validators/cf-worker";
import type { CommandDefinition, JsonSchemaObject } from "./definition.ts";
import { createCommandRegistry } from "./registry.ts";
import { standardInputSchema } from "./standard-schema.ts";
import { callToolDefinition } from "./mcp/adapter.ts";
import { sanitizeMcpInputSchema } from "./mcp/schema.ts";
import { validateCommandArguments } from "./validate.ts";

const validator = new CfWorkerJsonSchemaValidator();

/** Whether the SDK's standards validator admits `value` for `schema`. */
function valid(schema: unknown, value: unknown): boolean {
  const validate = validator.getValidator(schema as never);
  return (validate as (input: unknown) => { valid: boolean })(value).valid;
}

const UPSTREAM = {
  type: "object",
  properties: { assignee: { type: ["string", "null"] } },
  additionalProperties: false,
};

describe("standardInputSchema", () => {
  it("publishes null alongside nullable anyOf while preserving enum restrictions", () => {
    for (const type of [undefined, "string"] as const) {
      for (const values of [undefined, ["all", null], ["all"]]) {
        const schema: JsonSchemaObject = {
          type: "object",
          properties: {
            value: {
              ...(type === undefined ? {} : { type }),
              nullable: true,
              anyOf: [{ type: "string", pattern: "^all$" }, { type: "integer" }],
              ...(values === undefined ? {} : { enum: values }),
            },
          },
        };
        const original = JSON.stringify(schema);
        const published = standardInputSchema(schema);
        for (const value of [null, "all", "other", 1, false, {}]) {
          assert.equal(
            valid(published, { value }),
            validateCommandArguments(schema, { value }) === null,
            JSON.stringify({ type, values, value }),
          );
        }
        assert.equal(JSON.stringify(published).includes('"nullable"'), false);
        assert.equal(JSON.stringify(schema), original);
      }
    }
  });

  it("strips nullable false at nested output boundaries without changing types", () => {
    const schema: JsonSchemaObject = {
      type: "object",
      properties: {
        direct: { type: "string", nullable: false },
        nested: {
          type: "object",
          properties: { value: { type: "integer", nullable: false } },
        },
        list: { type: "array", items: { type: "string", nullable: false } },
        either: { anyOf: [{ type: "string", nullable: false }] },
      },
    };
    const original = JSON.stringify(schema);
    const output = standardInputSchema(schema);
    assert.equal(JSON.stringify(output).includes('"nullable"'), false);
    assert.equal(output.properties?.direct?.type, "string");
    assert.equal(valid(output, { direct: null }), false);
    assert.equal(valid(output, { direct: "value" }), true);
    assert.equal(JSON.stringify(schema), original);
  });

  it("publishes a nullable property as the standard null union", () => {
    const internal = sanitizeMcpInputSchema(UPSTREAM);
    assert.deepEqual(JSON.parse(JSON.stringify(internal)), {
      type: "object",
      properties: { assignee: { type: "string", nullable: true } },
      additionalProperties: false,
    });
    assert.deepEqual(JSON.parse(JSON.stringify(standardInputSchema(internal))), {
      type: "object",
      properties: { assignee: { type: ["string", "null"] } },
      additionalProperties: false,
    });
  });

  it("carries sibling constraints through the conversion", () => {
    const internal = sanitizeMcpInputSchema({
      type: "object",
      properties: {
        state: { type: ["string", "null"], enum: ["all", "onlyBusinessDays"] },
      },
    });
    const published = standardInputSchema(internal) as {
      properties: Record<string, Record<string, unknown>>;
    };
    assert.deepEqual(JSON.parse(JSON.stringify(published.properties.state)), {
      type: ["string", "null"],
      enum: ["all", "onlyBusinessDays"],
    });
  });

  it("converts nested properties, array items and anyOf branches", () => {
    const schema: JsonSchemaObject = {
      type: "object",
      properties: {
        filter: {
          type: "object",
          properties: { state: { type: "string", nullable: true } },
        },
        labels: {
          type: "array",
          items: { type: "string", nullable: true },
        },
        either: {
          anyOf: [
            { type: "string", nullable: true },
            { type: "integer" },
          ],
        },
      },
    };
    assert.deepEqual(JSON.parse(JSON.stringify(standardInputSchema(schema))), {
      type: "object",
      properties: {
        filter: {
          type: "object",
          properties: { state: { type: ["string", "null"] } },
        },
        labels: {
          type: "array",
          items: { type: ["string", "null"] },
        },
        either: {
          anyOf: [
            { type: ["string", "null"] },
            { type: "integer" },
          ],
        },
      },
    });
  });

  it("leaves a schema without the keyword byte-identical", () => {
    const plain: JsonSchemaObject = {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string", pattern: "^[A-Z]+-\\d+$" } },
      additionalProperties: false,
    };
    assert.deepEqual(
      JSON.parse(JSON.stringify(standardInputSchema(plain))),
      plain,
    );
  });
});

describe("the standards validator at the boundary", () => {
  it("rejects the internal keyword and admits the published union", () => {
    const internal = sanitizeMcpInputSchema(UPSTREAM);
    // The reason the conversion exists: `nullable` is not JSON Schema, so an
    // engine reads the property as string-only.
    assert.equal(valid(internal, { assignee: null }), false);
    assert.equal(valid(internal, { assignee: "me" }), true);
    // Published, the same value set the upstream server declared holds.
    const published = standardInputSchema(internal);
    assert.equal(valid(published, { assignee: null }), true);
    assert.equal(valid(published, { assignee: "me" }), true);
    assert.equal(valid(published, { assignee: 5 }), false);
    // And it matches the schema the server advertised, before normalization.
    assert.equal(valid(UPSTREAM, { assignee: null }), true);
  });

  // The MCP call boundary: `callMcpTool` hands the SDK a `toolDefinition`,
  // and the SDK compiles it with the same standards validator. Built through
  // the exported seam so the assertion is on what the call actually sends.
  it("the MCP call's toolDefinition carries the standard form", () => {
    const internal = sanitizeMcpInputSchema(UPSTREAM);
    const definition = callToolDefinition("list_issues", internal);
    assert.equal(definition.name, "list_issues");
    assert.deepEqual(JSON.parse(JSON.stringify(definition.inputSchema)), {
      type: "object",
      properties: { assignee: { type: ["string", "null"] } },
      additionalProperties: false,
    });
    assert.equal(valid(definition.inputSchema, { assignee: null }), true);
    assert.equal(valid(definition.inputSchema, { assignee: "me" }), true);
    assert.equal(valid(definition.inputSchema, { assignee: 5 }), false);
    // Unconverted, the same schema is what the validator rejects.
    assert.equal(valid(internal, { assignee: null }), false);
  });

  it("the provider projection publishes the standard form", () => {
    const command: CommandDefinition = {
      id: "mcp.linear.query_issues",
      title: "query",
      description: "query issues",
      inputSchema: sanitizeMcpInputSchema(UPSTREAM),
      permission: {
        effects: ["read.external", "emit.event"],
        defaultDecision: "allow",
        resources: ["mcp:linear/query_issues"],
        network: "configured-external",
        filesystem: "none",
        cost: "none",
      },
      executor: () => Promise.resolve("ok"),
    };
    const [projected] = createCommandRegistry([command]).projectTools();
    assert.deepEqual(JSON.parse(JSON.stringify(projected!.parameters)), {
      type: "object",
      properties: { assignee: { type: ["string", "null"] } },
      additionalProperties: false,
    });
    assert.equal(valid(projected!.parameters, { assignee: null }), true);
  });
});
