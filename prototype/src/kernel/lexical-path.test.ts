import { assertEquals } from "@std/assert";
import { hasDotPathComponent } from "./lexical-path.ts";

Deno.test("hasDotPathComponent finds a whole `.` or `..` component", () => {
  assertEquals(hasDotPathComponent("/a/./b"), true);
  assertEquals(hasDotPathComponent("/a/../b"), true);
  assertEquals(hasDotPathComponent("/a/b/.."), true);
  assertEquals(hasDotPathComponent("/a/b/."), true);
  assertEquals(hasDotPathComponent("/.."), true);
});

Deno.test("hasDotPathComponent ignores dots inside a component", () => {
  assertEquals(hasDotPathComponent("/a/.b/c"), false);
  assertEquals(hasDotPathComponent("/a/b../c"), false);
  assertEquals(hasDotPathComponent("/a/.../c"), false);
  assertEquals(hasDotPathComponent("/a/b.txt"), false);
  assertEquals(hasDotPathComponent("/"), false);
});
