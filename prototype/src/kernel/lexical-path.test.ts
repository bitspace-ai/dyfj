import assert from "node:assert/strict";
import { test } from "node:test";
import { hasDotPathComponent } from "./lexical-path.ts";

test("hasDotPathComponent finds a whole `.` or `..` component", () => {
  assert.deepStrictEqual(hasDotPathComponent("/a/./b"), true);
  assert.deepStrictEqual(hasDotPathComponent("/a/../b"), true);
  assert.deepStrictEqual(hasDotPathComponent("/a/b/.."), true);
  assert.deepStrictEqual(hasDotPathComponent("/a/b/."), true);
  assert.deepStrictEqual(hasDotPathComponent("/.."), true);
});

test("hasDotPathComponent ignores dots inside a component", () => {
  assert.deepStrictEqual(hasDotPathComponent("/a/.b/c"), false);
  assert.deepStrictEqual(hasDotPathComponent("/a/b../c"), false);
  assert.deepStrictEqual(hasDotPathComponent("/a/.../c"), false);
  assert.deepStrictEqual(hasDotPathComponent("/a/b.txt"), false);
  assert.deepStrictEqual(hasDotPathComponent("/"), false);
});
