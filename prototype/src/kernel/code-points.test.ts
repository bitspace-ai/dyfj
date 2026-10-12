import assert from "node:assert/strict";
import { takeCodePointPrefix } from "./code-points.ts";

Deno.test("takeCodePointPrefix stops the iterator at the configured code-point budget", () => {
  let yielded = 0;
  function* gated(): Generator<string> {
    while (true) {
      yielded += 1;
      yield "A";
    }
  }
  assert.deepStrictEqual(
    takeCodePointPrefix(gated(), 256).join(""),
    "A".repeat(256),
  );
  assert.deepStrictEqual(yielded, 256);
});

Deno.test("takeCodePointPrefix counts code points, not UTF-16 code units", () => {
  assert.deepStrictEqual(takeCodePointPrefix("😀😀😀", 2), ["😀", "😀"]);
});

Deno.test("takeCodePointPrefix returns everything when the source is shorter", () => {
  assert.deepStrictEqual(takeCodePointPrefix("ab", 5), ["a", "b"]);
});

Deno.test("takeCodePointPrefix returns nothing for a non-positive limit", () => {
  let pulled = false;
  function* source(): Generator<string> {
    pulled = true;
    yield "A";
  }
  assert.deepStrictEqual(takeCodePointPrefix(source(), 0), []);
  assert.deepStrictEqual(takeCodePointPrefix("abc", -1), []);
  assert.deepStrictEqual(pulled, false);
});
