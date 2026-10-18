import assert from "node:assert/strict";
import { test } from "node:test";
import {
  maskArgumentEchoes,
  OPERATOR_REASON_MAX_BYTES,
  operatorFailureReason,
} from "./failure-reason.ts";

test("an echoed argument value is replaced by its name", () => {
  const body = "## Figures\n\nThe Sonnet price is $3 per million.";
  assert.equal(
    maskArgumentEchoes(`Error: body rejected: ${body}`, {
      issueId: "BIT-697",
      body,
    }),
    "Error: body rejected: <arg:body>",
  );
});

test("a nested argument value is masked by its path", () => {
  assert.equal(
    maskArgumentEchoes('Could not find "secret-project-name" in team', {
      filter: { project: { name: "secret-project-name" } },
      labels: ["first-label-value"],
    }),
    'Could not find "<arg:filter.project.name>" in team',
  );
  assert.equal(
    maskArgumentEchoes("unknown label first-label-value", {
      labels: ["first-label-value"],
    }),
    "unknown label <arg:labels[0]>",
  );
});

test("values shorter than eight characters are left alone", () => {
  assert.equal(
    maskArgumentEchoes('Could not find issue "BIT-1"', { issueId: "BIT-1" }),
    'Could not find issue "BIT-1"',
  );
});

test("the longer of two overlapping values is masked first", () => {
  assert.equal(
    maskArgumentEchoes("saw alpha-beta-gamma", {
      a: "alpha-beta",
      b: "alpha-beta-gamma",
    }),
    "saw <arg:b>",
  );
});

test("the operator reason is masked, scrubbed, single-lined and capped", () => {
  const body = "a private markdown body that must not be echoed";
  const reason = operatorFailureReason(
    `External MCP tool call failed: upstream said:\n${body} with sk-${
      "z".repeat(24)
    } ${"x".repeat(400)}`,
    { body },
  );
  assert.ok(!reason.includes(body), reason);
  assert.ok(reason.includes("<arg:body>"), reason);
  assert.ok(!reason.includes("zzzz"), reason);
  assert.ok(reason.includes("[scrubbed]"), reason);
  assert.ok(!reason.includes("\n"), reason);
  assert.ok(
    new TextEncoder().encode(reason).byteLength <= OPERATOR_REASON_MAX_BYTES,
    `${reason.length}`,
  );
});

test("argument walking is bounded on hostile shapes", () => {
  let deep: Record<string, unknown> = { leaf: "deeply-nested-value" };
  for (let i = 0; i < 100; i++) deep = { next: deep };
  const wide = Object.fromEntries(
    Array.from({ length: 10_000 }, (_, i) => [`k${i}`, `value-number-${i}`]),
  );
  assert.equal(
    typeof maskArgumentEchoes("deeply-nested-value", { deep, wide }),
    "string",
  );
});

test("argument walking never invokes a getter and survives a hostile object", () => {
  const read = { count: 0 };
  const items = ["a-plain-array-value"];
  Object.defineProperty(items, "1", {
    get() {
      read.count++;
      return "an-accessor-value";
    },
    enumerable: true,
  });
  const object = {};
  Object.defineProperty(object, "secretish", {
    get() {
      read.count++;
      return "another-accessor-value";
    },
    enumerable: true,
  });
  const hostile = new Proxy({}, {
    ownKeys() {
      throw new Error("trap");
    },
  });
  assert.equal(
    maskArgumentEchoes("saw a-plain-array-value and an-accessor-value", {
      items,
      object,
      hostile,
    }),
    "saw <arg:items[0]> and an-accessor-value",
  );
  assert.equal(read.count, 0);
});
