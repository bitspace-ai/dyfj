import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeBoundaryText } from "./boundary-text.ts";

const byteLength = (text: string) => new TextEncoder().encode(text).byteLength;

test("sanitizeBoundaryText leaves ordinary short text unchanged", () => {
  assert.deepStrictEqual(
    sanitizeBoundaryText("session not found", 500),
    "session not found",
  );
});

test("sanitizeBoundaryText collapses tab/newline/carriage-return to a single space, rather than dropping or preserving them", () => {
  // At the 200–500-byte single-field sizes this function guards, LF/CR are
  // their own injection surface — an embedded LF can forge a fake log line
  // in a durable/console record, and a CR can rewind a terminal cursor to
  // overwrite a rendered prefix. Collapsing (not dropping outright) keeps
  // words from running together.
  assert.deepStrictEqual(
    sanitizeBoundaryText("hello\tworld", 500),
    "hello world",
  );
  assert.deepStrictEqual(
    sanitizeBoundaryText("hello\nworld", 500),
    "hello world",
  );
  assert.deepStrictEqual(
    sanitizeBoundaryText("hello\rworld", 500),
    "hello world",
  );
  assert.deepStrictEqual(
    sanitizeBoundaryText("hello\r\nworld", 500),
    "hello  world",
  );
});

test("sanitizeBoundaryText output cannot forge a fake log line", () => {
  const injected = "declined" +
    "\n[2026-01-01] operator approved unlimited spend";
  const result = sanitizeBoundaryText(injected, 500);
  assert.ok(!result.includes("\n"));
});

test("sanitizeBoundaryText strips a terminal escape sequence, leaving it inert plain text", () => {
  const esc = String.fromCharCode(27);
  const result = sanitizeBoundaryText(`${esc}[31mred text${esc}[0m`, 500);
  assert.ok(!result.includes(esc));
  assert.deepStrictEqual(result, "[31mred text[0m");
});

test("sanitizeBoundaryText strips C0 and C1 control characters and DEL", () => {
  const withControls = "a" + String.fromCharCode(1) +
    String.fromCharCode(127) + String.fromCharCode(0x9f) + "b";
  assert.deepStrictEqual(sanitizeBoundaryText(withControls, 500), "ab");
});

test("sanitizeBoundaryText caps to maxBytes on a byte-safe boundary, never exceeding it", () => {
  // Non-homogeneous payload: a run of one repeated character would make
  // "output still contains a slice of the input" trivially true regardless
  // of whether the cap is byte-safe, so it can't discriminate a broken
  // (character-based) implementation from a correct one.
  const payload = "SELECT ".repeat(20_000);
  const result = sanitizeBoundaryText(payload, 200);
  assert.ok(byteLength(result) <= 200);
  assert.ok(result.length < payload.length);
  assert.ok(payload.startsWith(result));
});

test("sanitizeBoundaryText cap that lands mid-character decodes cleanly (no replacement character)", () => {
  // Each "é" is 2 UTF-8 bytes; an odd byte cap forces a naive cut to land
  // mid-character.
  const result = sanitizeBoundaryText("é".repeat(200), 101);
  assert.deepStrictEqual(result, "é".repeat(50));
  assert.ok(!result.includes("�"));
});

test("sanitizeBoundaryText measures the cap after stripping, not before", () => {
  const nul = String.fromCharCode(0);
  assert.deepStrictEqual(
    sanitizeBoundaryText(`${nul.repeat(10)}abc`, 3),
    "abc",
  );
});
