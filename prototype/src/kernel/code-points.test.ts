import { assertEquals } from "@std/assert";
import { takeCodePointPrefix } from "./code-points.ts";

Deno.test("takeCodePointPrefix stops the iterator at the configured code-point budget", () => {
  let yielded = 0;
  function* gated(): Generator<string> {
    while (true) {
      yielded += 1;
      yield "A";
    }
  }
  assertEquals(takeCodePointPrefix(gated(), 256).join(""), "A".repeat(256));
  assertEquals(yielded, 256);
});

Deno.test("takeCodePointPrefix counts code points, not UTF-16 code units", () => {
  assertEquals(takeCodePointPrefix("😀😀😀", 2), ["😀", "😀"]);
});

Deno.test("takeCodePointPrefix returns everything when the source is shorter", () => {
  assertEquals(takeCodePointPrefix("ab", 5), ["a", "b"]);
});

Deno.test("takeCodePointPrefix returns nothing for a non-positive limit", () => {
  let pulled = false;
  function* source(): Generator<string> {
    pulled = true;
    yield "A";
  }
  assertEquals(takeCodePointPrefix(source(), 0), []);
  assertEquals(takeCodePointPrefix("abc", -1), []);
  assertEquals(pulled, false);
});
