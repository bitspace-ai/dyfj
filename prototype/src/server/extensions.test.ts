import assert from "node:assert/strict";
import { test } from "node:test";
import { callRpc } from "../../testing/builders/rpc.ts";
import { createLinearExtension } from "../extensions/linear/mod.ts";
import {
  buildExtensionHandlers,
  type Extension,
  type ExtensionDeps,
  rpcToolApprover,
} from "./extensions.ts";

const deps: ExtensionDeps = {
  fetchSessionEvents: () => Promise.resolve([]),
  fetchSessionWorkspaceRecord: () =>
    Promise.resolve({ exists: false, workspace: null }),
  linear: createLinearExtension([]).linear,
  toolApprover: rpcToolApprover,
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

test("buildExtensionHandlers merges every extension's methods", async () => {
  const handlers = buildExtensionHandlers([
    extension("a", ["a/one", "a/two"]),
    { id: "quiet" },
    extension("b", ["b/one"]),
  ], deps);
  assert.deepStrictEqual(Object.keys(handlers), ["a/one", "a/two", "b/one"]);
  assert.deepStrictEqual(await callRpc(handlers, "b/one", {}), {
    method: "b/one",
  });
});

test("buildExtensionHandlers hands each extension the deps", () => {
  let received: ExtensionDeps | undefined;
  buildExtensionHandlers([{
    id: "a",
    rpc: (given) => {
      received = given;
      return {};
    },
  }], deps);
  assert.deepStrictEqual(received, deps);
});

test("buildExtensionHandlers rejects a duplicate id or method", () => {
  assert.throws(
    () =>
      buildExtensionHandlers([extension("a", []), extension("a", [])], deps),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("duplicate extension id: a"),
  );
  assert.throws(
    () =>
      buildExtensionHandlers([
        extension("a", ["shared/method"]),
        extension("b", ["shared/method"]),
      ], deps),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("extension b redefines RPC method shared/method"),
  );
});

test("rpcToolApprover approves only an explicit approval", async () => {
  const ask = (answer: Promise<unknown>) =>
    rpcToolApprover({
      notify: () => Promise.resolve(),
      request: (method) => {
        assert.deepStrictEqual(method, "approval");
        return answer;
      },
    })({} as Parameters<ReturnType<typeof rpcToolApprover>>[0]);
  assert.deepStrictEqual(await ask(Promise.resolve({ decision: "approve" })), {
    decision: "approve",
  });
  assert.deepStrictEqual(await ask(Promise.resolve({ decision: "deny" })), {
    decision: "deny",
    reason: "operator denied the tool call",
  });
  assert.deepStrictEqual(await ask(Promise.reject(new Error("no client"))), {
    decision: "deny",
    reason: "approval request failed (no client approver?)",
  });
});
