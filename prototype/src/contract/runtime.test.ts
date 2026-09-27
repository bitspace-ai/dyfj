import { assertEquals } from "@std/assert";
import { workspaceRootForTransport } from "./runtime.ts";

Deno.test("workspaceRootForTransport honors a loopback operator's requested workspace root", () => {
  assertEquals(
    workspaceRootForTransport("/workspace/example-project", "loopback"),
    "/workspace/example-project",
  );
});

Deno.test("workspaceRootForTransport returns undefined for a loopback caller that sent no root", () => {
  assertEquals(workspaceRootForTransport(undefined, "loopback"), undefined);
});

Deno.test("workspaceRootForTransport ignores a remote caller's requested root (pinned to server default)", () => {
  // A crafted cwd from a remote/shared consumer must not steer the file tools.
  assertEquals(workspaceRootForTransport("/etc", "remote"), undefined);
  assertEquals(workspaceRootForTransport("/", "remote"), undefined);
});
