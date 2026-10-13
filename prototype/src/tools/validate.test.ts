// Tests for argument validation and its corrective feedback (`validate.ts`).

import assert from "node:assert/strict";
import { describe, it } from "@std/testing/bdd";
import type { EventInsert } from "../store/mod.ts";
import type { CommandCall, JsonSchemaObject } from "./definition.ts";
import { createCommandRegistry } from "./registry.ts";
import { evaluateCommandPolicy } from "./policy.ts";
import { invokeCommandWithEvent } from "./invoke.ts";
import { validateCommandArguments } from "./validate.ts";
import { defineReadFile, defineWriteFile } from "./builtin/file.ts";
import { RootAnchors } from "./builtin/root-anchors.ts";

function call(
  args: Record<string, unknown> = { slug: "project_dyfj" },
  overrides: Partial<CommandCall> = {},
): CommandCall {
  return {
    commandId: "memory.read",
    callId: "call-123",
    caller: { principalId: "operator", principalType: "human" },
    arguments: args,
    ...overrides,
  };
}

describe("invalid-arguments feedback", () => {
  // Regression for the recorded read_file failure mode: the model emitted a
  // literal `{}` and the bare verdict ("missing required argument: path")
  // produced a verbatim retry instead of a corrected one. The denial reason
  // must carry everything a model needs to self-correct on the next step.
  it("a read_file call with empty arguments gets corrective feedback", () => {
    const result = evaluateCommandPolicy(
      defineReadFile(new RootAnchors().root("/work")),
      call({}, { commandId: "read_file" }),
    ) as { decision: string; authzBasis: string; reason: string };

    assert.strictEqual(result.decision, "deny");
    assert.strictEqual(result.authzBasis, "policy:deny:invalid-arguments");
    // Names the tool and the exact validation failure…
    assert.ok(
      result.reason.includes(
        "invalid arguments for read_file: missing required argument: path",
      ),
      `expected result.reason to include "invalid arguments for read_file: missing required argument: path"`,
    );
    // …states the expected shape, with the schema's own description…
    // read_file gained optional offset/limit (ranged reads). The corrective
    // feedback advertises them, which is the point: the model learns the
    // affordance exists from the error it just caused.
    assert.ok(
      result.reason.includes(
        'expected: {"path": string (required), "offset": number (optional), ' +
          '"limit": number (optional)}',
      ),
      `expected result.reason to include 'expected: {"path": string (required), "offset": number (optional), ' +
        '"limit": number (optional)}'`,
    );
    assert.ok(
      result.reason.includes(
        "path — File path relative to the workspace root.",
      ),
      `expected result.reason to include "path — File path relative to the workspace root."`,
    );
    // …reports what actually arrived…
    assert.ok(
      result.reason.includes("received keys: (none)"),
      `expected result.reason to include "received keys: (none)"`,
    );
    // …and instructs a corrected retry.
    assert.ok(
      result.reason.includes(
        "Call read_file again with arguments matching the expected shape.",
      ),
      `expected result.reason to include "Call read_file again with arguments matching the expected shape."`,
    );
  });

  it("feedback names declared keys, never argument values", () => {
    const result = evaluateCommandPolicy(
      defineWriteFile(new RootAnchors().root("/work")),
      call(
        { path: "notes/friction.md", content: 12345 },
        { commandId: "write_file" },
      ),
    ) as { decision: string; reason: string };

    assert.strictEqual(result.decision, "deny");
    assert.ok(
      result.reason.includes("content must be a string"),
      `expected result.reason to include "content must be a string"`,
    );
    // Both keys are declared in write_file's schema, so both are named.
    assert.ok(
      result.reason.includes('received keys: "path", "content"'),
      `expected result.reason to include 'received keys: "path", "content"'`,
    );
    // Values may carry redact-marked payloads and the reason is persisted to
    // the event trail — schema vocabulary only, never values.
    assert.ok(!result.reason.includes("12345"));
    assert.ok(!result.reason.includes("notes/friction.md"));
  });

  it("an unrecognized property name is never echoed into the reason", () => {
    // A property NAME is untrusted model output and can itself carry a private
    // path, token, or personal text. The denial reason is persisted to the
    // durable event log and replayed to the provider, so an unrecognized name
    // must be summarized as a count, never echoed verbatim (CWE-532).
    // Assembled at runtime so the public-boundary scan never matches this
    // fixture as a home-directory path in tracked source.
    const untrustedName = ["", "Users", "example", "private"].join("/") +
      "/api-key-placeholder";
    const result = evaluateCommandPolicy(
      defineReadFile(new RootAnchors().root("/work")),
      call(
        { path: "README.md", [untrustedName]: "x" },
        { commandId: "read_file" },
      ),
    ) as { decision: string; reason: string };

    assert.strictEqual(result.decision, "deny");
    // The untrusted name appears nowhere in the model-visible / durable reason.
    assert.ok(!result.reason.includes(untrustedName));
    assert.ok(!result.reason.includes("placeholder"));
    // It is reported as a bare count instead, alongside the recognized key.
    assert.ok(
      result.reason.includes('received keys: "path", 1 not declared'),
      `expected result.reason to include 'received keys: "path", 1 not declared'`,
    );
  });

  it("prototype-chain property names do not read as declared or bypass validation", () => {
    // `in` walks the prototype chain, so `constructor`/`toString`/`__proto__`
    // would falsely count as declared properties — satisfying
    // additionalProperties:false and echoing a model-controlled name. Own-key
    // checks must deny and COUNT them, never name them.
    for (const inherited of ["constructor", "toString", "__proto__"]) {
      const result = evaluateCommandPolicy(
        defineReadFile(new RootAnchors().root("/work")),
        call(
          { path: "README.md", [inherited]: "x" },
          { commandId: "read_file" },
        ),
      ) as { decision: string; authzBasis: string; reason: string };

      assert.strictEqual(result.decision, "deny");
      assert.strictEqual(result.authzBasis, "policy:deny:invalid-arguments");
      assert.ok(
        result.reason.includes(
          "unexpected argument not declared in the tool's schema",
        ),
        `expected result.reason to include "unexpected argument not declared in the tool's schema"`,
      );
      assert.ok(!result.reason.includes(inherited));
      assert.ok(
        result.reason.includes('received keys: "path", 1 not declared'),
        `expected result.reason to include 'received keys: "path", 1 not declared'`,
      );
    }
  });

  it("the persisted tool_call event records the same corrective feedback", async () => {
    const registry = createCommandRegistry([
      defineReadFile(new RootAnchors().root("/work")),
    ]);
    const events: EventInsert[] = [];

    const result = await invokeCommandWithEvent(
      registry,
      call({}, { commandId: "read_file" }),
      {
        sessionId: "01TESTSESSION00000000000000",
        traceId: "0123456789abcdef0123456789abcdef",
        eventId: "01TESTEVENT0000000000000000",
        spanId: "0123456789abcdef",
        writeEvent: (event) => {
          events.push(event);
        },
      },
    );

    assert.strictEqual(result.isError, true);
    // The event trail shows the exact text the model saw, so a future
    // diagnosis of this failure mode reads the true feedback.
    const reason = result.isError ? result.reason : "";
    assert.strictEqual(events[0].tool_result, reason);
    assert.strictEqual(events[0].tool_is_error, true);
    assert.ok(
      reason.includes(
        "invalid arguments for read_file: missing required argument: path",
      ),
      `expected ${
        JSON.stringify(reason)
      } to include "invalid arguments for read_file: missing required argument: path"`,
    );
  });
});

describe("declared numeric bounds", () => {
  const schema: JsonSchemaObject = {
    type: "object",
    properties: {
      seconds: { type: "integer", minimum: 1, maximum: 600 },
      ratio: { type: "number", minimum: 0 },
    },
    additionalProperties: false,
  };

  it("accepts values on and inside the bounds", () => {
    for (const seconds of [1, 300, 600]) {
      assert.strictEqual(validateCommandArguments(schema, { seconds }), null);
    }
    assert.strictEqual(validateCommandArguments(schema, { ratio: 0 }), null);
  });

  it("names the bound a value falls outside of", () => {
    assert.strictEqual(
      validateCommandArguments(schema, { seconds: 601 }),
      "seconds must be at most 600",
    );
    assert.strictEqual(
      validateCommandArguments(schema, { seconds: 0 }),
      "seconds must be at least 1",
    );
    assert.strictEqual(
      validateCommandArguments(schema, { ratio: -0.5 }),
      "ratio must be at least 0",
    );
  });

  it("a non-integer is reported as such before its bounds", () => {
    assert.strictEqual(
      validateCommandArguments(schema, { seconds: 1.5 }),
      "seconds must be an integer",
    );
  });
});
