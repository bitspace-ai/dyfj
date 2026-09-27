import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  MCP_STDIO_MEMORY_CLEARANCE,
  MEMORY_VISIBILITY_ALL,
  memoryClearanceFor,
} from "./memories.ts";

Deno.test("memoryClearanceFor: loopback (local operator) is cleared for every visibility class", () => {
  assertEquals(memoryClearanceFor("loopback"), [...MEMORY_VISIBILITY_ALL]);
  assert(memoryClearanceFor("loopback").includes("private"));
});

Deno.test("memoryClearanceFor: remote consumers get only client-safe + public (no private corpus)", () => {
  const remote = memoryClearanceFor("remote");
  assertEquals(remote, ["client_safe", "public"]);
  assertFalse(remote.includes("private"));
  assertFalse(remote.includes("shareable"));
});

Deno.test("a standalone MCP stdio consumer gets the remote clearance", () => {
  assertEquals([...MCP_STDIO_MEMORY_CLEARANCE], memoryClearanceFor("remote"));
});
