import assert from "node:assert/strict";
import { generateSpanId, generateTraceId, generateULID } from "./ids.ts";

Deno.test("generateULID returns a 26-character Crockford Base32 ULID", () => {
  const id = generateULID();
  assert.match(id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.notStrictEqual(generateULID(), id);
});

Deno.test("generateTraceId returns a 32-character lowercase hex string", () => {
  assert.match(generateTraceId(), /^[0-9a-f]{32}$/);
});

Deno.test("generateSpanId returns a 16-character lowercase hex string", () => {
  assert.match(generateSpanId(), /^[0-9a-f]{16}$/);
});
