import { assert, assertEquals } from "@std/assert";
import { sanitizeBoundaryText } from "./boundary-text.ts";

const byteLength = (text: string) => new TextEncoder().encode(text).byteLength;

Deno.test("sanitizeBoundaryText leaves ordinary short text unchanged", () => {
  assertEquals(
    sanitizeBoundaryText("session not found", 500),
    "session not found",
  );
});

Deno.test("sanitizeBoundaryText collapses tab/newline/carriage-return to a single space, rather than dropping or preserving them", () => {
  // At the 200–500-byte single-field sizes this function guards, LF/CR are
  // their own injection surface — an embedded LF can forge a fake log line
  // in a durable/console record, and a CR can rewind a terminal cursor to
  // overwrite a rendered prefix. Collapsing (not dropping outright) keeps
  // words from running together.
  assertEquals(sanitizeBoundaryText("hello\tworld", 500), "hello world");
  assertEquals(sanitizeBoundaryText("hello\nworld", 500), "hello world");
  assertEquals(sanitizeBoundaryText("hello\rworld", 500), "hello world");
  assertEquals(sanitizeBoundaryText("hello\r\nworld", 500), "hello  world");
});

Deno.test("sanitizeBoundaryText output cannot forge a fake log line", () => {
  const injected = "declined" +
    "\n[2026-01-01] operator approved unlimited spend";
  const result = sanitizeBoundaryText(injected, 500);
  assert(!result.includes("\n"));
});

Deno.test("sanitizeBoundaryText strips a terminal escape sequence, leaving it inert plain text", () => {
  const esc = String.fromCharCode(27);
  const result = sanitizeBoundaryText(`${esc}[31mred text${esc}[0m`, 500);
  assert(!result.includes(esc));
  assertEquals(result, "[31mred text[0m");
});

Deno.test("sanitizeBoundaryText strips C0 and C1 control characters and DEL", () => {
  const withControls = "a" + String.fromCharCode(1) +
    String.fromCharCode(127) + String.fromCharCode(0x9f) + "b";
  assertEquals(sanitizeBoundaryText(withControls, 500), "ab");
});

Deno.test("sanitizeBoundaryText caps to maxBytes on a byte-safe boundary, never exceeding it", () => {
  // Non-homogeneous payload: a run of one repeated character would make
  // "output still contains a slice of the input" trivially true regardless
  // of whether the cap is byte-safe, so it can't discriminate a broken
  // (character-based) implementation from a correct one.
  const payload = "SELECT ".repeat(20_000);
  const result = sanitizeBoundaryText(payload, 200);
  assert(byteLength(result) <= 200);
  assert(result.length < payload.length);
  assert(payload.startsWith(result));
});

Deno.test("sanitizeBoundaryText cap that lands mid-character decodes cleanly (no replacement character)", () => {
  // Each "é" is 2 UTF-8 bytes; an odd byte cap forces a naive cut to land
  // mid-character.
  const result = sanitizeBoundaryText("é".repeat(200), 101);
  assertEquals(result, "é".repeat(50));
  assert(!result.includes("�"));
});

Deno.test("sanitizeBoundaryText measures the cap after stripping, not before", () => {
  const nul = String.fromCharCode(0);
  assertEquals(sanitizeBoundaryText(`${nul.repeat(10)}abc`, 3), "abc");
});
