import { assertEquals, assertStrictEquals } from "@std/assert";
import {
  canonicalJson,
  MAX_CANONICAL_JSON_CHARACTERS,
  MAX_CANONICAL_JSON_DEPTH,
  MAX_CANONICAL_JSON_ENTRIES,
} from "./canonical-json.ts";

Deno.test("canonicalJson sorts object keys at every depth", () => {
  assertEquals(
    canonicalJson({ b: 1, a: { d: [3, { f: 1, e: 2 }], c: "x" } }),
    '{"a":{"c":"x","d":[3,{"e":2,"f":1}]},"b":1}',
  );
});

Deno.test("canonicalJson gives structurally equal values the same text", () => {
  assertEquals(
    canonicalJson({ path: "a.ts", limit: 10 }),
    canonicalJson({ limit: 10, path: "a.ts" }),
  );
});

Deno.test("canonicalJson serializes primitives as JSON.stringify does", () => {
  assertEquals(canonicalJson('a"b'), '"a\\"b"');
  assertEquals(canonicalJson(1.5), "1.5");
  assertEquals(canonicalJson(null), "null");
  assertEquals(canonicalJson(true), "true");
  assertEquals(canonicalJson(undefined), "undefined");
});

Deno.test("canonicalJson includes only own enumerable keys", () => {
  const proto = { inherited: 1 };
  const value = Object.create(proto) as Record<string, unknown>;
  value.own = 2;
  assertEquals(canonicalJson(value), '{"own":2}');
});

Deno.test("canonicalJson refuses a value nested past the depth budget", () => {
  let value: unknown = 0;
  for (let i = 0; i < MAX_CANONICAL_JSON_DEPTH; i++) value = [value];
  assertEquals(typeof canonicalJson(value), "string");
  assertStrictEquals(canonicalJson([value]), undefined);
});

Deno.test("canonicalJson refuses a value past the entry budget", () => {
  assertStrictEquals(
    canonicalJson(Array.from({ length: MAX_CANONICAL_JSON_ENTRIES }, () => 0)),
    undefined,
  );
  assertEquals(
    typeof canonicalJson(
      Array.from({ length: MAX_CANONICAL_JSON_ENTRIES - 1 }, () => 0),
    ),
    "string",
  );
});

Deno.test("canonicalJson refuses a value past the character budget", () => {
  assertStrictEquals(
    canonicalJson("x".repeat(MAX_CANONICAL_JSON_CHARACTERS)),
    undefined,
  );
  assertStrictEquals(
    canonicalJson({ ["k".repeat(MAX_CANONICAL_JSON_CHARACTERS)]: 1 }),
    undefined,
  );
});

Deno.test("canonicalJson gives each call a fresh budget", () => {
  const big = "x".repeat(MAX_CANONICAL_JSON_CHARACTERS / 2);
  assertEquals(typeof canonicalJson(big), "string");
  assertEquals(typeof canonicalJson(big), "string");
});
