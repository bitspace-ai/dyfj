import { assertEquals, assertMatch, assertThrows } from "@std/assert";
import { SequentialIds } from "./sequential-ids.ts";

const ULID_SHAPE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

Deno.test("SequentialIds issues ULID-shaped IDs in lexical issue order", () => {
  const ids = new SequentialIds();
  const issued = Array.from({ length: 12 }, () => ids.next());
  for (const id of issued) assertMatch(id, ULID_SHAPE);
  assertEquals(issued[0], "00000000000000000000000001");
  assertEquals(issued[11], "00000000000000000000000012");
  assertEquals([...issued].sort(), issued);
  assertEquals(ids.issued, issued);
});

Deno.test("SequentialIds honours a start value", () => {
  assertEquals(
    new SequentialIds({ start: 0 }).next(),
    "00000000000000000000000000",
  );
});

Deno.test("SequentialIds.next is bound for injection", () => {
  const next: () => string = new SequentialIds({ start: 7 }).next;
  assertEquals(next(), "00000000000000000000000007");
  assertEquals(next(), "00000000000000000000000008");
});

Deno.test("SequentialIds instances are independent", () => {
  const a = new SequentialIds();
  const b = new SequentialIds();
  a.next();
  assertEquals(b.next(), "00000000000000000000000001");
});

Deno.test("SequentialIds rejects an invalid start", () => {
  assertThrows(() => new SequentialIds({ start: -1 }), RangeError);
  assertThrows(() => new SequentialIds({ start: 1.5 }), RangeError);
});

Deno.test("SequentialIds.issued is a copy", () => {
  const ids = new SequentialIds();
  ids.next();
  (ids.issued as string[]).push("tampered");
  assertEquals(ids.issued.length, 1);
});

Deno.test("SequentialIds fails once the safe-integer range is exhausted", () => {
  const ids = new SequentialIds({ start: Number.MAX_SAFE_INTEGER });
  assertEquals(ids.next(), String(Number.MAX_SAFE_INTEGER).padStart(26, "0"));
  assertThrows(() => ids.next(), RangeError);
  assertEquals(ids.issued.length, 1);
});
