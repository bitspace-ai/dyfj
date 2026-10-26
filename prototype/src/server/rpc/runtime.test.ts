import assert from "node:assert/strict";
import { test } from "node:test";
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
    defaultTurnBudgetUsd: 4,
    defaultRunawayStallUsd: 0.5,
    maxToolSteps: 32,
    maxToolStepsCeiling: 64,
    ...overrides,
  };
}

test("runtime/status resolves the bare-turn route past a hosted configured default", async () => {
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
  assert.deepStrictEqual(runtime.defaultCompanionModel, "hosted-x");
  assert.partialDeepStrictEqual(
    runtime.defaultTurnModel as Record<string, unknown>,
    {
      slug: "hosted-x",
      tier: 2,
      local: false,
      reason: "default_config",
    },
  );
  // Locality counts use the same provider+loopback classification as the
  // per-row `local` flag, not the tier label.
  assert.deepStrictEqual(runtime.models, { total: 2, local: 1, hosted: 1 });
});

test("runtime/status reports a null bare-turn route when nothing is routable", async () => {
  const { runtime } = await callRpc(handlers(), "runtime/status") as {
    runtime: { defaultTurnModel: unknown };
  };
  assert.deepStrictEqual(runtime.defaultTurnModel, null);
});

test("runtime/status returns the local transport posture", async () => {
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
  assert.partialDeepStrictEqual(result.runtime, {
    transport: "uds",
    clearance: "loopback",
    defaultCompanionModel: "local-x",
    permissionLevel: "operator",
    approvePaidDefault: false,
    maxToolSteps: 7,
    models: { total: 1 },
  });
});

test("runtime/status falls back to the loose posture fields without an engine config", async () => {
  const { runtime } = await callRpc(
    handlers({
      defaultCompanionModel: "local-x",
      permissionLevel: "operator",
      autostarted: true,
    }),
    "runtime/status",
  ) as { runtime: Record<string, unknown> };
  assert.partialDeepStrictEqual(runtime, {
    defaultCompanionModel: "local-x",
    permissionLevel: "operator",
    defaultSessionBudgetUsd: 10,
    defaultPerCallBudgetUsd: 0.5,
    defaultDailyBudgetUsd: 25,
    defaultTurnBudgetUsd: 4,
    defaultRunawayStallUsd: 0.5,
    autostarted: true,
  });
});

// A pointer that failed at start stays failed until restart, so status names
// it; a clean start leaves the field out rather than reporting an empty list.
test("runtime/status names secret pointers that failed at start", async () => {
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
  assert.deepStrictEqual(runtime.unavailableSecrets, failed);

  const clean = await callRpc(
    handlers({ unavailableSecrets: [] }),
    "runtime/status",
  ) as { runtime: Record<string, unknown> };
  assert.ok(!("unavailableSecrets" in clean.runtime));
});

test("runtime/status reports the boot's external MCP lines", async () => {
  const lines = [
    'external MCP linear: configured tool "get_issue" not offered by the server',
    "external MCP linear: ready (2 tools, 2026-07-28)",
  ];
  const { runtime } = await callRpc(
    handlers({ externalMcp: lines }),
    "runtime/status",
  ) as { runtime: Record<string, unknown> };
  assert.deepStrictEqual(runtime.externalMcp, lines);

  const none = await callRpc(handlers(), "runtime/status") as {
    runtime: Record<string, unknown>;
  };
  assert.ok(!("externalMcp" in none.runtime));
});

test("runtime/liveness returns immediately without loading models", async () => {
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
  assert.deepStrictEqual(result, {
    status: "ok",
    transport: "uds",
    clearance: "loopback",
  });
  assert.deepStrictEqual(loadModelsCalled, false);
});

test("runtime/status exposes method catalog metadata", async () => {
  const { runtime } = await callRpc(handlers(), "runtime/status") as {
    runtime: { methods: string[]; methodCatalog: unknown[] };
  };
  assert.deepStrictEqual(runtime.methods, [
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
  assert.deepStrictEqual(runtime.methodCatalog, [
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

test("runtime/stop triggers onShutdown and returns stopping status", async () => {
  let shutdownCalled = false;
  const result = await callRpc(
    handlers({
      onShutdown: () => {
        shutdownCalled = true;
      },
    }),
    "runtime/stop",
  );
  assert.deepStrictEqual(result, { status: "stopping" });
  assert.ok(shutdownCalled);
});

test("runtime/stop is an internalError when onShutdown is absent", async () => {
  const error = await rpcFailure(handlers(), "runtime/stop");
  assert.deepStrictEqual(error.code, RpcErrorCode.internalError);
  assert.ok(
    error.message.includes("shutdown is not configured"),
    `expected error.message to include "shutdown is not configured"`,
  );
});

test("runtime/stop surfaces an onShutdown failure as internalError", async () => {
  const error = await rpcFailure(
    handlers({
      onShutdown: () => Promise.reject(new Error("ACP close failed")),
    }),
    "runtime/stop",
  );
  assert.deepStrictEqual(error.code, RpcErrorCode.internalError);
  assert.ok(
    error.message.includes("runtime shutdown failed"),
    `expected error.message to include "runtime shutdown failed"`,
  );
});

const FINGERPRINT = {
  head: "0123456789abcdef0123456789abcdef01234567",
  contentHash: `sha256:${"c".repeat(64)}`,
};

test("runtime/status reports the code fingerprint, open clients and in-flight turns", async () => {
  const { runtime } = await callRpc(
    handlers({
      fingerprint: FINGERPRINT,
      activity: () => ({ clients: 2, inFlightTurns: 1 }),
    }),
    "runtime/status",
  ) as { runtime: Record<string, unknown> };
  assert.deepStrictEqual(runtime.fingerprint, FINGERPRINT);
  assert.strictEqual(runtime.clients, 2);
  assert.strictEqual(runtime.inFlightTurns, 1);
});

test("runtime/status reads activity at call time, not at build time", async () => {
  let inFlightTurns = 0;
  const built = handlers({
    activity: () => ({ clients: 1, inFlightTurns }),
  });
  inFlightTurns = 3;
  const { runtime } = await callRpc(built, "runtime/status") as {
    runtime: Record<string, unknown>;
  };
  assert.strictEqual(runtime.inFlightTurns, 3);
});

test("runtime/stop with ifSoleClient stops when this is the only client and no turn runs", async () => {
  let shutdownCalled = false;
  const result = await callRpc(
    handlers({
      activity: () => ({ clients: 1, inFlightTurns: 0 }),
      onShutdown: () => {
        shutdownCalled = true;
      },
    }),
    "runtime/stop",
    { ifSoleClient: true },
  );
  assert.deepStrictEqual(result, { status: "stopping" });
  assert.ok(shutdownCalled);
});

test("runtime/stop with ifSoleClient is declined while another client is connected", async () => {
  let shutdownCalled = false;
  const result = await callRpc(
    handlers({
      activity: () => ({ clients: 2, inFlightTurns: 0 }),
      onShutdown: () => {
        shutdownCalled = true;
      },
    }),
    "runtime/stop",
    { ifSoleClient: true },
  ) as { status: string; reason?: string };
  assert.strictEqual(result.status, "declined");
  assert.match(result.reason ?? "", /another client/);
  assert.strictEqual(shutdownCalled, false);
});

test("runtime/stop with ifSoleClient is declined while a turn is in flight", async () => {
  let shutdownCalled = false;
  const result = await callRpc(
    handlers({
      activity: () => ({ clients: 1, inFlightTurns: 1 }),
      onShutdown: () => {
        shutdownCalled = true;
      },
    }),
    "runtime/stop",
    { ifSoleClient: true },
  ) as { status: string; reason?: string };
  assert.strictEqual(result.status, "declined");
  assert.match(result.reason ?? "", /turn/);
  assert.strictEqual(shutdownCalled, false);
});

test("runtime/stop with ifSoleClient is declined when the server cannot count its clients", async () => {
  let shutdownCalled = false;
  const result = await callRpc(
    handlers({
      onShutdown: () => {
        shutdownCalled = true;
      },
    }),
    "runtime/stop",
    { ifSoleClient: true },
  ) as { status: string };
  assert.strictEqual(result.status, "declined");
  assert.strictEqual(shutdownCalled, false);
});

test("runtime/stop with ifSoleClient calls onShutdown in the same synchronous step as its check", async () => {
  // A client could connect at any await between the check and the shutdown,
  // which begins by closing the socket to new clients. Not awaiting the call
  // and looking at once fails if an await is ever inserted between them.
  let shutdownCalled = false;
  const pending = callRpc(
    handlers({
      activity: () => ({ clients: 1, inFlightTurns: 0 }),
      onShutdown: () => {
        shutdownCalled = true;
      },
    }),
    "runtime/stop",
    { ifSoleClient: true },
  );
  assert.strictEqual(shutdownCalled, true);
  await pending;
});
