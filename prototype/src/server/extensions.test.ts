import { assertEquals, assertThrows } from "@std/assert";
import { callRpc } from "../../testing/builders/rpc.ts";
import {
  buildExtensionHandlers,
  type Extension,
  type ExtensionDeps,
} from "./extensions.ts";

const deps: ExtensionDeps = {
  fetchSessionEvents: () => Promise.resolve([]),
  fetchSessionWorkspaceRecord: () =>
    Promise.resolve({ exists: false, workspace: null }),
};

function extension(id: string, methods: string[]): Extension {
  return {
    id,
    rpc: () =>
      Object.fromEntries(
        methods.map((method) => [method, () => Promise.resolve({ method })]),
      ),
  };
}

Deno.test("buildExtensionHandlers merges every extension's methods", async () => {
  const handlers = buildExtensionHandlers([
    extension("a", ["a/one", "a/two"]),
    { id: "quiet" },
    extension("b", ["b/one"]),
  ], deps);
  assertEquals(Object.keys(handlers), ["a/one", "a/two", "b/one"]);
  assertEquals(await callRpc(handlers, "b/one", {}), { method: "b/one" });
});

Deno.test("buildExtensionHandlers hands each extension the deps", () => {
  let received: ExtensionDeps | undefined;
  buildExtensionHandlers([{
    id: "a",
    rpc: (given) => {
      received = given;
      return {};
    },
  }], deps);
  assertEquals(received, deps);
});

Deno.test("buildExtensionHandlers rejects a duplicate id or method", () => {
  assertThrows(
    () =>
      buildExtensionHandlers([extension("a", []), extension("a", [])], deps),
    Error,
    "duplicate extension id: a",
  );
  assertThrows(
    () =>
      buildExtensionHandlers([
        extension("a", ["shared/method"]),
        extension("b", ["shared/method"]),
      ], deps),
    Error,
    "extension b redefines RPC method shared/method",
  );
});
