import assert from "node:assert/strict";
import { test } from "node:test";
import { hasOperatorClearance, workspaceRootForTransport } from "./runtime.ts";

test("workspaceRootForTransport honors a loopback operator's requested workspace root", () => {
  assert.deepStrictEqual(
    workspaceRootForTransport("/workspace/example-project", "loopback"),
    "/workspace/example-project",
  );
});

test("workspaceRootForTransport returns undefined for a loopback caller that sent no root", () => {
  assert.deepStrictEqual(
    workspaceRootForTransport(undefined, "loopback"),
    undefined,
  );
});

test("workspaceRootForTransport ignores a remote caller's requested root (pinned to server default)", () => {
  // A crafted cwd from a remote/shared consumer must not steer the file tools.
  assert.deepStrictEqual(
    workspaceRootForTransport("/etc", "remote"),
    undefined,
  );
  assert.deepStrictEqual(workspaceRootForTransport("/", "remote"), undefined);
});

test("hasOperatorClearance: only loopback has it; a missing or unknown transport fails closed", () => {
  assert.strictEqual(hasOperatorClearance("loopback"), true);
  for (const transport of ["remote", undefined, null, "", "LOOPBACK", "local_stdio", 1]) {
    assert.strictEqual(hasOperatorClearance(transport), false, String(transport));
  }
});
