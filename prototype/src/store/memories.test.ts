import assert from "node:assert/strict";
import {
  MCP_STDIO_MEMORY_CLEARANCE,
  MEMORY_VISIBILITY_ALL,
  memoryClearanceFor,
} from "./memories.ts";

Deno.test("memoryClearanceFor: loopback (local operator) is cleared for every visibility class", () => {
  assert.deepStrictEqual(memoryClearanceFor("loopback"), [...MEMORY_VISIBILITY_ALL]);
  assert.ok(memoryClearanceFor("loopback").includes("private"));
});

Deno.test("memoryClearanceFor: remote consumers get only client-safe + public (no private corpus)", () => {
  const remote = memoryClearanceFor("remote");
  assert.deepStrictEqual(remote, ["client_safe", "public"]);
  assert.ok(!remote.includes("private"));
  assert.ok(!remote.includes("shareable"));
});

Deno.test("a standalone MCP stdio consumer gets the remote clearance", () => {
  assert.deepStrictEqual([...MCP_STDIO_MEMORY_CLEARANCE], memoryClearanceFor("remote"));
});
