import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MASKING_WITHHELD_REASON,
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

test("a short string or a number is masked where it stands as a whole token", () => {
  assert.equal(
    maskArgumentEchoes("Unknown person Alice", { name: "Alice" }),
    "Unknown person <arg:name>",
  );
  assert.equal(
    maskArgumentEchoes("record 12345 not found (12345)", { id: 12345 }),
    "record <arg:id> not found (<arg:id>)",
  );
  assert.equal(
    maskArgumentEchoes('Could not find issue "BIT-1"', { issueId: "BIT-1" }),
    'Could not find issue "<arg:issueId>"',
  );
});

test("token masking never cuts into a longer word", () => {
  // "BIT" is a token of "BIT-697" only up to the hyphen, a non-alphanumeric
  // boundary, so it is masked there; inside "BITS" or "XBIT" it is not.
  assert.equal(
    maskArgumentEchoes("BITS and XBIT stay; BIT-697 does not", { team: "BIT" }),
    "BITS and XBIT stay; <arg:team>-697 does not",
  );
  assert.equal(
    maskArgumentEchoes("Alicea and Alice", { name: "Alice" }),
    "Alicea and <arg:name>",
  );
});

test("a one-character value over-masks standalone tokens, never under-masks", () => {
  assert.equal(
    maskArgumentEchoes("page 1 of 10, item 1", { page: 1 }),
    "page <arg:page> of 10, item <arg:page>",
  );
  // Booleans and null are not masked.
  assert.equal(
    maskArgumentEchoes("flag true is null", { flag: true, other: null }),
    "flag true is null",
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

test("a walk that cannot finish fails closed instead of masking part-way", () => {
  let deep: Record<string, unknown> = { leaf: "deeply-nested-value" };
  for (let i = 0; i < 100; i++) deep = { next: deep };
  // Past the depth limit, the leaf is never visited: unmasked, it would leak.
  assert.equal(maskArgumentEchoes("saw deeply-nested-value", { deep }), undefined);
  // Wide with leaves, and wide with no eligible leaves at all: both cost
  // visits, and both stop at the visit budget.
  const wide = Object.fromEntries(
    Array.from({ length: 10_000 }, (_, i) => [`k${i}`, `value-number-${i}`]),
  );
  assert.equal(maskArgumentEchoes("value-number-9999", { wide }), undefined);
  const empties = Array.from({ length: 5_000 }, () => ({}));
  assert.equal(maskArgumentEchoes("anything at all", { empties }), undefined);
  // The operator line then withholds the text, with the default line or the
  // one the caller supplies.
  assert.equal(
    operatorFailureReason("saw deeply-nested-value", { deep }),
    MASKING_WITHHELD_REASON,
  );
  assert.equal(
    operatorFailureReason("saw deeply-nested-value", { deep }, "upstream error (withheld)"),
    "upstream error (withheld)",
  );
  // Within the limits, nothing is withheld.
  assert.equal(
    maskArgumentEchoes("saw shallow-value-here", { a: { b: "shallow-value-here" } }),
    "saw <arg:a.b>",
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
  // Accessors are skipped, never invoked; model arguments come from JSON and
  // carry none.
  assert.equal(
    maskArgumentEchoes("saw a-plain-array-value and an-accessor-value", {
      items,
      object,
    }),
    "saw <arg:items[0]> and an-accessor-value",
  );
  // A trap that throws means the walk did not finish: fail closed.
  assert.equal(
    maskArgumentEchoes("saw a-plain-array-value", { items, hostile }),
    undefined,
  );
  assert.equal(read.count, 0);
});

test("enumeration stops at the visit budget, for keys, inherited keys and late arrays", () => {
  // Per-key reads on a huge object stop at the budget instead of covering
  // every key. (for…in still asks a Proxy's ownKeys trap once: that is how
  // the language enumerates.)
  let descriptorReads = 0;
  const target = Object.fromEntries(
    Array.from({ length: 100_000 }, (_, i) => [`k${i}`, i]),
  );
  const counting = new Proxy(target, {
    getOwnPropertyDescriptor(t, key) {
      descriptorReads++;
      return Reflect.getOwnPropertyDescriptor(t, key);
    },
  });
  assert.equal(maskArgumentEchoes("anything", { counting }), undefined);
  // About three reads per key yielded (the engine's enumerability check,
  // `Object.hasOwn`, the descriptor read): proportional to the 1,024 budget,
  // not to the 100,000 keys.
  assert.ok(descriptorReads <= 3 * 1_100, `${descriptorReads} descriptor reads`);
  // Inherited enumerable keys count too: this fixture checks that many
  // inherited keys on one prototype are rejected.
  const inherited = Object.create(
    Object.fromEntries(Array.from({ length: 5_000 }, (_, i) => [`p${i}`, i])),
  );
  inherited.own = "an-own-string-value";
  assert.equal(maskArgumentEchoes("an-own-string-value", { inherited }), undefined);
  // An array met late in the walk is refused against the remaining budget,
  // not the full one.
  const early = Array.from({ length: 900 }, (_, i) => i);
  const late = Array.from({ length: 200 }, (_, i) => i);
  assert.equal(maskArgumentEchoes("x", { early, late }), undefined);
});

test("every yielded key draws on one shared budget, across sibling objects", () => {
  // 100 siblings sharing a 500-key prototype: each alone is under the
  // budget, together they yield 50,000 keys.
  const prototype = Object.fromEntries(
    Array.from({ length: 500 }, (_, i) => [`p${i}`, i]),
  );
  const siblings = Array.from({ length: 100 }, () => Object.create(prototype));
  assert.equal(maskArgumentEchoes("anything", { siblings }), undefined);
});

test("every array index read spends the budget, holes included", () => {
  // 500 sparse arrays of length 1,000: each passes the length check alone,
  // and holes are not elements, so only charging each read bounds the work.
  let reads = 0;
  const sparse = () => {
    const array: unknown[] = [];
    array.length = 1_000;
    return new Proxy(array, {
      getOwnPropertyDescriptor(target, key) {
        reads++;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
  };
  const siblings = Array.from({ length: 500 }, sparse);
  assert.equal(maskArgumentEchoes("anything", { siblings }), undefined);
  assert.ok(reads <= 1_100, `${reads} descriptor reads`);
});

test("masking a short value in a large text stays fast", () => {
  const text = "e ".repeat(100_000);
  const started = performance.now();
  const masked = maskArgumentEchoes(text, { letter: "e", other: "f" });
  assert.ok(masked?.startsWith("<arg:letter> <arg:letter>"));
  assert.ok(performance.now() - started < 2_000, "masking took too long");
});
