import assert from "node:assert/strict";
import { test } from "node:test";
import { workspaceRootForTransport } from "./runtime.ts";

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
