import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import {
  clipToUtf8Bytes,
  utf8ByteLengthWithinLimit,
  utf8SafePrefix,
} from "./utf8.ts";

const encode = (text: string) => new TextEncoder().encode(text);
const byteLength = (text: string) => encode(text).byteLength;

Deno.test("utf8SafePrefix returns the whole array when it fits", () => {
  const bytes = encode("abc");
  assertEquals(utf8SafePrefix(bytes, 10), bytes);
  assertEquals(utf8SafePrefix(bytes, 3), bytes);
});

Deno.test("utf8SafePrefix backs a mid-character cut off to the character start", () => {
  // "é" is two bytes; a 3-byte ceiling would cut the second "é" in half.
  const bytes = encode("éé");
  assertEquals(utf8SafePrefix(bytes, 3), encode("é"));
  // A four-byte character with a ceiling inside it yields nothing.
  assertEquals(utf8SafePrefix(encode("😀"), 3).byteLength, 0);
});

Deno.test("utf8SafePrefix treats a zero or negative ceiling as empty", () => {
  assertEquals(utf8SafePrefix(encode("abc"), 0).byteLength, 0);
  assertEquals(utf8SafePrefix(encode("abcdef"), -2).byteLength, 0);
});

Deno.test("clipToUtf8Bytes returns null when the text already fits", () => {
  assertStrictEquals(clipToUtf8Bytes("abc", 10), null);
  assertStrictEquals(clipToUtf8Bytes("abc", 3), null);
});

Deno.test("clipToUtf8Bytes cuts to empty under a negative ceiling", () => {
  assertEquals(clipToUtf8Bytes("abcdef", -2), "");
});

Deno.test("clipToUtf8Bytes measures bytes, not UTF-16 code units", () => {
  // 10 three-byte characters: 10 code units, 30 bytes.
  const text = "中".repeat(10);
  assertEquals(text.length, 10);
  assert(clipToUtf8Bytes(text, 12) !== null);
});

Deno.test("clipToUtf8Bytes cuts on a character boundary, never mid-sequence", () => {
  const clipped = clipToUtf8Bytes("中".repeat(10), 10);
  assertEquals(clipped, "中".repeat(3));
  assert(!clipped!.includes("�"));
  assert(byteLength(clipped!) <= 10);
});

Deno.test("clipToUtf8Bytes keeps a surrogate pair whole or drops it", () => {
  assertEquals(clipToUtf8Bytes("a😀b", 4), "a");
  assertEquals(clipToUtf8Bytes("a😀b", 5), "a😀");
});

Deno.test("utf8ByteLengthWithinLimit returns the UTF-8 length within the limit", () => {
  assertEquals(utf8ByteLengthWithinLimit("", 0), 0);
  assertEquals(utf8ByteLengthWithinLimit("abc", 3), 3);
  assertEquals(utf8ByteLengthWithinLimit("é😀", 6), 6);
});

Deno.test("utf8ByteLengthWithinLimit reports overflow as undefined", () => {
  assertStrictEquals(utf8ByteLengthWithinLimit("abcd", 3), undefined);
  assertStrictEquals(utf8ByteLengthWithinLimit("é", 1), undefined);
});

Deno.test("utf8ByteLengthWithinLimit adds to a running total", () => {
  assertEquals(utf8ByteLengthWithinLimit("ab", 5, 3), 5);
  assertStrictEquals(utf8ByteLengthWithinLimit("abc", 5, 3), undefined);
  // An empty value adds nothing and never overflows, even past the limit.
  assertEquals(utf8ByteLengthWithinLimit("", 5, 9), 9);
});

Deno.test("utf8ByteLengthWithinLimit counts a surrogate pair on a chunk boundary as four bytes", () => {
  // 4,095 ASCII code units put the pair across the 4,096-unit chunk edge.
  const value = `${"a".repeat(4_095)}😀${"b".repeat(10)}`;
  assertEquals(utf8ByteLengthWithinLimit(value, 1_000_000), byteLength(value));
  assertEquals(byteLength(value), 4_095 + 4 + 10);
});

Deno.test("utf8ByteLengthWithinLimit counts a lone surrogate as U+FFFD", () => {
  assertEquals(utf8ByteLengthWithinLimit("\ud800", 10), 3);
});

Deno.test("utf8ByteLengthWithinLimit agrees with TextEncoder across many chunks", () => {
  const value = "é中😀a".repeat(5_000);
  assertEquals(utf8ByteLengthWithinLimit(value, 1_000_000), byteLength(value));
  assertStrictEquals(
    utf8ByteLengthWithinLimit(value, byteLength(value) - 1),
    undefined,
  );
});
