import {
  assert,
  assertEquals,
  assertObjectMatch,
  assertStringIncludes,
} from "@std/assert";
import type { WorkbenchModel } from "../../providers/mod.ts";
import { RpcErrorCode } from "../../transport/mod.ts";
import { callRpc, rpcFailure } from "../../../testing/builders/rpc.ts";
import { buildRuntimeHandlers, type RuntimeHandlerDeps } from "./runtime.ts";

const models = (rows: unknown[]) => async () => rows as WorkbenchModel[];

function handlers(overrides: Partial<RuntimeHandlerDeps> = {}) {
  return buildRuntimeHandlers({
    loadModels: models([{ slug: "local-x" }]),
    ...overrides,
  });
}

type EngineConfig = NonNullable<RuntimeHandlerDeps["engineConfig"]>;
function engineConfig(overrides: Partial<EngineConfig> = {}): EngineConfig {
  return {
    defaultCompanionModel: null,
    permissionLevel: "strict",
    approvePaidDefault: false,
    trustWorkspaceInstructions: false,
    defaultSessionBudgetUsd: 1,
    defaultPerCallBudgetUsd: 0.1,
    defaultDailyBudgetUsd: 25,
    maxToolSteps: 32,
    ...overrides,
  };
}

Deno.test("runtime/status resolves the bare-turn route past a hosted configured default", async () => {
  const { runtime } = await callRpc(
    handlers({
      loadModels: models([
        {
          slug: "local-x",
          displayName: "Local X",
          provider: "ollama",
          baseUrl: "http://127.0.0.1:11434/v1",
          tier: 0,
          costInput: 0,
          costOutput: 0,
        },
        {
          slug: "hosted-x",
          displayName: "Hosted X",
          provider: "anthropic",
          baseUrl: "https://api.anthropic.com",
          tier: 2,
          costInput: 15,
          costOutput: 75,
        },
      ]),
      engineConfig: engineConfig({
        defaultCompanionModel: "hosted-x",
        permissionLevel: "operator",
      }),
    }),
    "runtime/status",
  ) as { runtime: Record<string, unknown> };
  // The configured default is reported and resolved as defaultTurnModel
  // when present in the catalog with pricing.
  assertEquals(runtime.defaultCompanionModel, "hosted-x");
  assertObjectMatch(runtime.defaultTurnModel as Record<string, unknown>, {
    slug: "hosted-x",
    tier: 2,
    local: false,
    reason: "default_config",
  });
  // Locality counts use the same provider+loopback classification as the
  // per-row `local` flag, not the tier label.
  assertEquals(runtime.models, { total: 2, local: 1, hosted: 1 });
});

Deno.test("runtime/status reports a null bare-turn route when nothing is routable", async () => {
  const { runtime } = await callRpc(handlers(), "runtime/status") as {
    runtime: { defaultTurnModel: unknown };
  };
  assertEquals(runtime.defaultTurnModel, null);
});

Deno.test("runtime/status returns the local transport posture", async () => {
  const result = await callRpc(
    handlers({
      engineConfig: engineConfig({
        defaultCompanionModel: "local-x",
        permissionLevel: "operator",
        defaultSessionBudgetUsd: 2,
        defaultPerCallBudgetUsd: 0.2,
        maxToolSteps: 7,
      }),
    }),
    "runtime/status",
  ) as { runtime: Record<string, unknown> };
  assertObjectMatch(result.runtime, {
    transport: "uds",
    clearance: "loopback",
    defaultCompanionModel: "local-x",
    permissionLevel: "operator",
    approvePaidDefault: false,
    maxToolSteps: 7,
    models: { total: 1 },
  });
});

Deno.test("runtime/status falls back to the loose posture fields without an engine config", async () => {
  const { runtime } = await callRpc(
    handlers({
      defaultCompanionModel: "local-x",
      permissionLevel: "operator",
      autostarted: true,
    }),
    "runtime/status",
  ) as { runtime: Record<string, unknown> };
  assertObjectMatch(runtime, {
    defaultCompanionModel: "local-x",
    permissionLevel: "operator",
    defaultSessionBudgetUsd: 1,
    defaultPerCallBudgetUsd: 0.1,
    defaultDailyBudgetUsd: 25,
    autostarted: true,
  });
});

// A pointer that failed at start stays failed until restart, so status names
// it; a clean start leaves the field out rather than reporting an empty list.
Deno.test("runtime/status names secret pointers that failed at start", async () => {
  const failed = [{
    envVar: "OPENROUTER_API_KEY",
    reason:
      "session probe failed: timed out after 10000ms (locked or unavailable)",
  }, {
    name: "linear",
    reason: "skipped: session probe OPENROUTER_API_KEY did not resolve",
  }];
  const { runtime } = await callRpc(
    handlers({ unavailableSecrets: failed }),
    "runtime/status",
  ) as { runtime: Record<string, unknown> };
  assertEquals(runtime.unavailableSecrets, failed);

  const clean = await callRpc(
    handlers({ unavailableSecrets: [] }),
    "runtime/status",
  ) as { runtime: Record<string, unknown> };
  assert(!("unavailableSecrets" in clean.runtime));
});

Deno.test("runtime/liveness returns immediately without loading models", async () => {
  let loadModelsCalled = false;
  const result = await callRpc(
    handlers({
      loadModels: () => {
        loadModelsCalled = true;
        return Promise.resolve([]);
      },
    }),
    "runtime/liveness",
  );
  assertEquals(result, {
    status: "ok",
    transport: "uds",
    clearance: "loopback",
  });
  assertEquals(loadModelsCalled, false);
});

Deno.test("runtime/status exposes method catalog metadata", async () => {
  const { runtime } = await callRpc(handlers(), "runtime/status") as {
    runtime: { methods: string[]; methodCatalog: unknown[] };
  };
  assertEquals(runtime.methods, [
    "runtime/liveness",
    "runtime/status",
    "runtime/stop",
    "surface/snapshot",
    "models/list",
    "sessions/list",
    "sessions/inspect",
    "events/query",
    "friction/post",
    "ideas/mark",
    "ideas/list",
    "ideas/get",
    "packets/draft",
    "packets/list",
    "packets/get",
    "tools/list",
    "tools/inspect",
    "turn",
    "turn/cancel",
  ]);
  assertEquals(runtime.methodCatalog, [
    { id: "runtime/liveness", namespace: "runtime", kind: "read" },
    { id: "runtime/status", namespace: "runtime", kind: "read" },
    { id: "runtime/stop", namespace: "runtime", kind: "interactive" },
    { id: "surface/snapshot", namespace: "surface", kind: "read" },
    { id: "models/list", namespace: "models", kind: "read" },
    { id: "sessions/list", namespace: "sessions", kind: "read" },
    { id: "sessions/inspect", namespace: "sessions", kind: "read" },
    { id: "events/query", namespace: "events", kind: "read" },
    { id: "friction/post", namespace: "friction", kind: "interactive" },
    { id: "ideas/mark", namespace: "ideas", kind: "interactive" },
    { id: "ideas/list", namespace: "ideas", kind: "read" },
    { id: "ideas/get", namespace: "ideas", kind: "read" },
    { id: "packets/draft", namespace: "packets", kind: "interactive" },
    { id: "packets/list", namespace: "packets", kind: "read" },
    { id: "packets/get", namespace: "packets", kind: "read" },
    { id: "tools/list", namespace: "tools", kind: "read" },
    { id: "tools/inspect", namespace: "tools", kind: "read" },
    { id: "turn", namespace: "turn", kind: "interactive" },
    { id: "turn/cancel", namespace: "turn", kind: "interactive" },
  ]);
});

Deno.test("runtime/stop triggers onShutdown and returns stopping status", async () => {
  let shutdownCalled = false;
  const result = await callRpc(
    handlers({
      onShutdown: () => {
        shutdownCalled = true;
      },
    }),
    "runtime/stop",
  );
  assertEquals(result, { status: "stopping" });
  assert(shutdownCalled);
});

Deno.test("runtime/stop is an internalError when onShutdown is absent", async () => {
  const error = await rpcFailure(handlers(), "runtime/stop");
  assertEquals(error.code, RpcErrorCode.internalError);
  assertStringIncludes(error.message, "shutdown is not configured");
});

Deno.test("runtime/stop surfaces an onShutdown failure as internalError", async () => {
  const error = await rpcFailure(
    handlers({
      onShutdown: () => Promise.reject(new Error("ACP close failed")),
    }),
    "runtime/stop",
  );
  assertEquals(error.code, RpcErrorCode.internalError);
  assertStringIncludes(error.message, "runtime shutdown failed");
});
