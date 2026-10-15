import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clipToUtf8Bytes,
  utf8ByteLengthWithinLimit,
  utf8SafePrefix,
} from "./utf8.ts";

const encode = (text: string) => new TextEncoder().encode(text);
const byteLength = (text: string) => encode(text).byteLength;

test("utf8SafePrefix returns the whole array when it fits", () => {
  const bytes = encode("abc");
  assert.deepStrictEqual(utf8SafePrefix(bytes, 10), bytes);
  assert.deepStrictEqual(utf8SafePrefix(bytes, 3), bytes);
});

test("utf8SafePrefix backs a mid-character cut off to the character start", () => {
  // "é" is two bytes; a 3-byte ceiling would cut the second "é" in half.
  const bytes = encode("éé");
  assert.deepStrictEqual(utf8SafePrefix(bytes, 3), encode("é"));
  // A four-byte character with a ceiling inside it yields nothing.
  assert.deepStrictEqual(utf8SafePrefix(encode("😀"), 3).byteLength, 0);
});

test("utf8SafePrefix treats a zero or negative ceiling as empty", () => {
  assert.deepStrictEqual(utf8SafePrefix(encode("abc"), 0).byteLength, 0);
  assert.deepStrictEqual(utf8SafePrefix(encode("abcdef"), -2).byteLength, 0);
});

test("clipToUtf8Bytes returns null when the text already fits", () => {
  assert.strictEqual(clipToUtf8Bytes("abc", 10), null);
  assert.strictEqual(clipToUtf8Bytes("abc", 3), null);
});

test("clipToUtf8Bytes cuts to empty under a negative ceiling", () => {
  assert.deepStrictEqual(clipToUtf8Bytes("abcdef", -2), "");
});

test("clipToUtf8Bytes measures bytes, not UTF-16 code units", () => {
  // 10 three-byte characters: 10 code units, 30 bytes.
  const text = "中".repeat(10);
  assert.deepStrictEqual(text.length, 10);
  assert.ok(clipToUtf8Bytes(text, 12) !== null);
});

test("clipToUtf8Bytes cuts on a character boundary, never mid-sequence", () => {
  const clipped = clipToUtf8Bytes("中".repeat(10), 10);
  assert.deepStrictEqual(clipped, "中".repeat(3));
  assert.ok(!clipped!.includes("�"));
  assert.ok(byteLength(clipped!) <= 10);
});

test("clipToUtf8Bytes keeps a surrogate pair whole or drops it", () => {
  assert.deepStrictEqual(clipToUtf8Bytes("a😀b", 4), "a");
  assert.deepStrictEqual(clipToUtf8Bytes("a😀b", 5), "a😀");
});

test("utf8ByteLengthWithinLimit returns the UTF-8 length within the limit", () => {
  assert.deepStrictEqual(utf8ByteLengthWithinLimit("", 0), 0);
  assert.deepStrictEqual(utf8ByteLengthWithinLimit("abc", 3), 3);
  assert.deepStrictEqual(utf8ByteLengthWithinLimit("é😀", 6), 6);
});

test("utf8ByteLengthWithinLimit reports overflow as undefined", () => {
  assert.strictEqual(utf8ByteLengthWithinLimit("abcd", 3), undefined);
  assert.strictEqual(utf8ByteLengthWithinLimit("é", 1), undefined);
});

test("utf8ByteLengthWithinLimit adds to a running total", () => {
  assert.deepStrictEqual(utf8ByteLengthWithinLimit("ab", 5, 3), 5);
  assert.strictEqual(utf8ByteLengthWithinLimit("abc", 5, 3), undefined);
  // An empty value adds nothing and never overflows, even past the limit.
  assert.deepStrictEqual(utf8ByteLengthWithinLimit("", 5, 9), 9);
});

test("utf8ByteLengthWithinLimit counts a surrogate pair on a chunk boundary as four bytes", () => {
  // 4,095 ASCII code units put the pair across the 4,096-unit chunk edge.
  const value = `${"a".repeat(4_095)}😀${"b".repeat(10)}`;
  assert.deepStrictEqual(
    utf8ByteLengthWithinLimit(value, 1_000_000),
    byteLength(value),
  );
  assert.deepStrictEqual(byteLength(value), 4_095 + 4 + 10);
});

test("utf8ByteLengthWithinLimit counts a lone surrogate as U+FFFD", () => {
  assert.deepStrictEqual(utf8ByteLengthWithinLimit("\ud800", 10), 3);
});

test("utf8ByteLengthWithinLimit agrees with TextEncoder across many chunks", () => {
  const value = "é中😀a".repeat(5_000);
  assert.deepStrictEqual(
    utf8ByteLengthWithinLimit(value, 1_000_000),
    byteLength(value),
  );
  assert.strictEqual(
    utf8ByteLengthWithinLimit(value, byteLength(value) - 1),
    undefined,
  );
});
