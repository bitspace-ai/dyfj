import assert from "node:assert/strict";
import { hasDotPathComponent } from "./lexical-path.ts";

Deno.test("hasDotPathComponent finds a whole `.` or `..` component", () => {
  assert.deepStrictEqual(hasDotPathComponent("/a/./b"), true);
  assert.deepStrictEqual(hasDotPathComponent("/a/../b"), true);
  assert.deepStrictEqual(hasDotPathComponent("/a/b/.."), true);
  assert.deepStrictEqual(hasDotPathComponent("/a/b/."), true);
  assert.deepStrictEqual(hasDotPathComponent("/.."), true);
});

Deno.test("hasDotPathComponent ignores dots inside a component", () => {
  assert.deepStrictEqual(hasDotPathComponent("/a/.b/c"), false);
  assert.deepStrictEqual(hasDotPathComponent("/a/b../c"), false);
  assert.deepStrictEqual(hasDotPathComponent("/a/.../c"), false);
  assert.deepStrictEqual(hasDotPathComponent("/a/b.txt"), false);
  assert.deepStrictEqual(hasDotPathComponent("/"), false);
});
