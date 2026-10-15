import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalJson,
  MAX_CANONICAL_JSON_CHARACTERS,
  MAX_CANONICAL_JSON_DEPTH,
  MAX_CANONICAL_JSON_ENTRIES,
} from "./canonical-json.ts";

test("canonicalJson sorts object keys at every depth", () => {
  assert.deepStrictEqual(
    canonicalJson({ b: 1, a: { d: [3, { f: 1, e: 2 }], c: "x" } }),
    '{"a":{"c":"x","d":[3,{"e":2,"f":1}]},"b":1}',
  );
});

test("canonicalJson gives structurally equal values the same text", () => {
  assert.deepStrictEqual(
    canonicalJson({ path: "a.ts", limit: 10 }),
    canonicalJson({ limit: 10, path: "a.ts" }),
  );
});

test("canonicalJson serializes primitives as JSON.stringify does", () => {
  assert.deepStrictEqual(canonicalJson('a"b'), '"a\\"b"');
  assert.deepStrictEqual(canonicalJson(1.5), "1.5");
  assert.deepStrictEqual(canonicalJson(null), "null");
  assert.deepStrictEqual(canonicalJson(true), "true");
  assert.deepStrictEqual(canonicalJson(undefined), "undefined");
});

test("canonicalJson includes only own enumerable keys", () => {
  const proto = { inherited: 1 };
  const value = Object.create(proto) as Record<string, unknown>;
  value.own = 2;
  assert.deepStrictEqual(canonicalJson(value), '{"own":2}');
});

test("canonicalJson refuses a value nested past the depth budget", () => {
  let value: unknown = 0;
  for (let i = 0; i < MAX_CANONICAL_JSON_DEPTH; i++) value = [value];
  assert.deepStrictEqual(typeof canonicalJson(value), "string");
  assert.strictEqual(canonicalJson([value]), undefined);
});

test("canonicalJson refuses a value past the entry budget", () => {
  assert.strictEqual(
    canonicalJson(Array.from({ length: MAX_CANONICAL_JSON_ENTRIES }, () => 0)),
    undefined,
  );
  assert.deepStrictEqual(
    typeof canonicalJson(
      Array.from({ length: MAX_CANONICAL_JSON_ENTRIES - 1 }, () => 0),
    ),
    "string",
  );
});

test("canonicalJson refuses a value past the character budget", () => {
  assert.strictEqual(
    canonicalJson("x".repeat(MAX_CANONICAL_JSON_CHARACTERS)),
    undefined,
  );
  assert.strictEqual(
    canonicalJson({ ["k".repeat(MAX_CANONICAL_JSON_CHARACTERS)]: 1 }),
    undefined,
  );
});

test("canonicalJson gives each call a fresh budget", () => {
  const big = "x".repeat(MAX_CANONICAL_JSON_CHARACTERS / 2);
  assert.deepStrictEqual(typeof canonicalJson(big), "string");
  assert.deepStrictEqual(typeof canonicalJson(big), "string");
});
