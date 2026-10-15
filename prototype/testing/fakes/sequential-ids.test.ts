import assert from "node:assert/strict";
import { test } from "node:test";
import { SequentialIds } from "./sequential-ids.ts";

const ULID_SHAPE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

test("SequentialIds issues ULID-shaped IDs in lexical issue order", () => {
  const ids = new SequentialIds();
  const issued = Array.from({ length: 12 }, () => ids.next());
  for (const id of issued) assert.match(id, ULID_SHAPE);
  assert.deepStrictEqual(issued[0], "00000000000000000000000001");
  assert.deepStrictEqual(issued[11], "00000000000000000000000012");
  assert.deepStrictEqual([...issued].sort(), issued);
  assert.deepStrictEqual(ids.issued, issued);
});

test("SequentialIds honours a start value", () => {
  assert.deepStrictEqual(
    new SequentialIds({ start: 0 }).next(),
    "00000000000000000000000000",
  );
});

test("SequentialIds.next is bound for injection", () => {
  const next: () => string = new SequentialIds({ start: 7 }).next;
  assert.deepStrictEqual(next(), "00000000000000000000000007");
  assert.deepStrictEqual(next(), "00000000000000000000000008");
});

test("SequentialIds instances are independent", () => {
  const a = new SequentialIds();
  const b = new SequentialIds();
  a.next();
  assert.deepStrictEqual(b.next(), "00000000000000000000000001");
});

test("SequentialIds rejects an invalid start", () => {
  assert.throws(() => new SequentialIds({ start: -1 }), RangeError);
  assert.throws(() => new SequentialIds({ start: 1.5 }), RangeError);
});

test("SequentialIds.issued is a copy", () => {
  const ids = new SequentialIds();
  ids.next();
  (ids.issued as string[]).push("tampered");
  assert.deepStrictEqual(ids.issued.length, 1);
});

test("SequentialIds fails once the safe-integer range is exhausted", () => {
  const ids = new SequentialIds({ start: Number.MAX_SAFE_INTEGER });
  assert.deepStrictEqual(
    ids.next(),
    String(Number.MAX_SAFE_INTEGER).padStart(26, "0"),
  );
  assert.throws(() => ids.next(), RangeError);
  assert.deepStrictEqual(ids.issued.length, 1);
});
