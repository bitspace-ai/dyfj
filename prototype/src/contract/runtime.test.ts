import assert from "node:assert/strict";
import { workspaceRootForTransport } from "./runtime.ts";

Deno.test("workspaceRootForTransport honors a loopback operator's requested workspace root", () => {
  assert.deepStrictEqual(
    workspaceRootForTransport("/workspace/example-project", "loopback"),
    "/workspace/example-project",
  );
});

Deno.test("workspaceRootForTransport returns undefined for a loopback caller that sent no root", () => {
  assert.deepStrictEqual(workspaceRootForTransport(undefined, "loopback"), undefined);
});

Deno.test("workspaceRootForTransport ignores a remote caller's requested root (pinned to server default)", () => {
  // A crafted cwd from a remote/shared consumer must not steer the file tools.
  assert.deepStrictEqual(workspaceRootForTransport("/etc", "remote"), undefined);
  assert.deepStrictEqual(workspaceRootForTransport("/", "remote"), undefined);
});
