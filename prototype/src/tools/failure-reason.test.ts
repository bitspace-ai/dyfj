import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ECHO_WINDOW_CHARS,
  findArgumentEchoes,
  fixedOperatorReason,
  OPERATOR_REASON_MAX_BYTES,
  operatorFailureReason,
} from "./failure-reason.ts";

const withheld = (label: string, names: string) =>
  `${label} (text withheld: it echoes argument ${names})`;

test("an echoed long string is withheld, naming the argument, never the value", () => {
  const body = "## Figures\n\nThe price is $3 per million tokens.";
  const line = operatorFailureReason(
    `upstream error: Error: body rejected: ${body}`,
    { issueId: "BIT-697", body },
    "upstream error",
  );
  assert.equal(line, withheld("upstream error", "body"));
  assert.ok(!line.includes("price"), line);
});

test("a nested echo is named by its path", () => {
  assert.deepStrictEqual(
    findArgumentEchoes('Could not find "secret-project-name" in team', {
      filter: { project: { name: "secret-project-name" } },
      labels: ["first-label-value"],
    }),
    ["filter.project.name"],
  );
  assert.deepStrictEqual(
    findArgumentEchoes("unknown label first-label-value", {
      labels: ["first-label-value"],
    }),
    ["labels[0]"],
  );
});

test("a short string or a number is an echo where it stands as a whole token", () => {
  assert.equal(
    operatorFailureReason("Unknown person Alice", { name: "Alice" }),
    withheld("error", "name"),
  );
  assert.equal(
    operatorFailureReason("record 12345 not found", { id: 12345 }),
    withheld("error", "id"),
  );
  assert.equal(
    operatorFailureReason(
      'upstream error: Error: Could not find issue "BIT-99999"',
      { issueId: "BIT-99999", body: "a short body" },
      "upstream error",
    ),
    withheld("upstream error", "issueId"),
  );
  // Inside a longer word it is not a token, so nothing is withheld.
  assert.deepStrictEqual(
    findArgumentEchoes("BITS and XBIT and 10", { team: "BIT", page: 1 }),
    [],
  );
  // Booleans and null are never echoes.
  assert.deepStrictEqual(
    findArgumentEchoes("flag true is null", { flag: true, other: null }),
    [],
  );
});

test("overlapping echoes are both found", () => {
  assert.deepStrictEqual(
    findArgumentEchoes("saw abcdefghijklm here", {
      a: "abcdefgh",
      b: "fghijklm",
    })?.sort(),
    ["a", "b"],
  );
});

test("a long value cut at the window edge is an echo", () => {
  const value = "a-long-argument-value-cut-by-the-window";
  const text = `${"x ".repeat((ECHO_WINDOW_CHARS - 10) / 2)}${value} and more`;
  assert.equal(text.indexOf(value) < ECHO_WINDOW_CHARS, true);
  assert.equal(text.indexOf(value) + value.length > ECHO_WINDOW_CHARS, true);
  assert.equal(
    operatorFailureReason(text, { value }),
    withheld("error", "value"),
  );
});

test("several echoed arguments are named, capped", () => {
  const args = Object.fromEntries(
    Array.from({ length: 6 }, (_, i) => [`arg${i}`, `value-number-${i}`]),
  );
  const text = Object.values(args).join(" ");
  const line = operatorFailureReason(text, args);
  assert.equal(line, withheld("error", "arg0, arg1, arg2 and 3 more"));
});

test("a message that echoes no argument passes through, scrubbed and capped", () => {
  const line = operatorFailureReason(
    "upstream error: Error: Provide exactly one of issueId, projectId, initiativeId",
    { body: "a comment body", issueId: "BIT-697" },
    "upstream error",
  );
  assert.equal(
    line,
    "upstream error: Error: Provide exactly one of issueId, projectId, initiativeId",
  );
  const long = operatorFailureReason(
    `failed:\nline two sk-${"z".repeat(24)} ${"x".repeat(400)}`,
    { body: "unrelated body text" },
  );
  assert.ok(!long.includes("\n"), long);
  assert.ok(long.includes("[scrubbed]"), long);
  assert.ok(
    new TextEncoder().encode(long).byteLength <= OPERATOR_REASON_MAX_BYTES,
    `${long.length}`,
  );
});

test("an echo past the window does not withhold a line that cannot show it", () => {
  const value = "a-value-far-beyond-the-window";
  const text = `${"y ".repeat(ECHO_WINDOW_CHARS)}${value}`;
  assert.deepStrictEqual(findArgumentEchoes(text, { value }), []);
});

test("a large text with many matches costs bounded work", () => {
  const text = "e ".repeat(1_000_000);
  const args = { letter: "e", long: "e ".repeat(100_000) };
  const started = performance.now();
  const line = operatorFailureReason(text, args);
  assert.equal(line, withheld("error", "letter, long"));
  assert.ok(performance.now() - started < 500, "detection took too long");
});

test("a fixed reason is scrubbed and capped but never withheld", () => {
  assert.equal(
    fixedOperatorReason("timed out after 30 s waiting for the server"),
    "timed out after 30 s waiting for the server",
  );
});

test("a walk that cannot finish withholds the text", () => {
  let deep: Record<string, unknown> = { leaf: "deeply-nested-value" };
  for (let i = 0; i < 100; i++) deep = { next: deep };
  assert.equal(findArgumentEchoes("saw deeply-nested-value", { deep }), undefined);
  assert.equal(
    operatorFailureReason("saw deeply-nested-value", { deep }),
    "error (text withheld: arguments too large to check)",
  );
  const wide = Object.fromEntries(
    Array.from({ length: 10_000 }, (_, i) => [`k${i}`, `value-number-${i}`]),
  );
  assert.equal(findArgumentEchoes("value-number-9999", { wide }), undefined);
  const empties = Array.from({ length: 5_000 }, () => ({}));
  assert.equal(findArgumentEchoes("anything at all", { empties }), undefined);
  assert.deepStrictEqual(
    findArgumentEchoes("saw shallow-value-here", { a: { b: "shallow-value-here" } }),
    ["a.b"],
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
  assert.deepStrictEqual(
    findArgumentEchoes("saw a-plain-array-value and an-accessor-value", {
      items,
      object,
    }),
    ["items[0]"],
  );
  assert.equal(
    findArgumentEchoes("saw a-plain-array-value", { items, hostile }),
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
  assert.equal(findArgumentEchoes("anything", { counting }), undefined);
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
  assert.equal(findArgumentEchoes("an-own-string-value", { inherited }), undefined);
  const early = Array.from({ length: 900 }, (_, i) => i);
  const late = Array.from({ length: 200 }, (_, i) => i);
  assert.equal(findArgumentEchoes("x", { early, late }), undefined);
});

test("every yielded key draws on one shared budget, across sibling objects", () => {
  const prototype = Object.fromEntries(
    Array.from({ length: 500 }, (_, i) => [`p${i}`, i]),
  );
  const siblings = Array.from({ length: 100 }, () => Object.create(prototype));
  assert.equal(findArgumentEchoes("anything", { siblings }), undefined);
});

test("every array index read spends the budget, holes included", () => {
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
  assert.equal(findArgumentEchoes("anything", { siblings }), undefined);
  assert.ok(reads <= 1_100, `${reads} descriptor reads`);
});
