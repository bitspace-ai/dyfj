/**
 * The workspace sections a Codex (ACP) turn's bridged tools come from
 * (BIT-982). The runtime owns one gate-run registry and one dispatch service
 * for its lifetime; which of their commands a turn may reach is the section
 * that covers ITS workspace, exactly as on the native route.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkspaceConfigResolver } from "../../config/mod.ts";
import type {
  DispatchConfig,
  GateConfig,
  PublishConfig,
} from "../../config/mod.ts";
import type { WorkbenchAuthContext } from "../../contract/mod.ts";
import { MemoryStore } from "../../store/mod.ts";
import type { GateRuntimePorts } from "../../tools/mod.ts";
import { GateRuns } from "../../tools/builtin/gate-runs.ts";
import type {
  BridgeTurn,
  ExternalAgentToolBridge,
} from "../../workbench-tool-bridge.ts";
import { bindExternalAgentTools } from "./dispatch-lineage.ts";

const GATE: GateConfig = {
  commands: { full: ["npm", "test"] },
  timeoutSeconds: 1_800,
};

const PROFILE_DISPATCH: DispatchConfig = {
  maxChildren: 2,
  maxWaitSeconds: 20,
  roots: ["/work/repo-worktrees"],
};

const GLOBAL_DISPATCH: DispatchConfig = {
  maxChildren: 3,
  maxWaitSeconds: 50,
  roots: ["/work/global-worktrees"],
};

const LOOPBACK: WorkbenchAuthContext = {
  transport: "loopback",
  authnStatus: "authenticated",
  authnMechanism: "local_user",
  authnIssuerRef: "local_os",
  authzBasis: "user_consent",
};

/**
 * A resolver covering `/work/profiled`: it declares the gate and the narrow
 * dispatch roots, and leaves publish unset. Every other root resolves to the
 * globals handed in.
 */
function profiles(
  covered: string,
  declared: { gate?: GateConfig | null; dispatch?: DispatchConfig | null },
  globals: { gate?: GateConfig | null; dispatch?: DispatchConfig | null },
): WorkspaceConfigResolver {
  const answer = (value: {
    gate?: GateConfig | null;
    dispatch?: DispatchConfig | null;
  }) => ({
    trustInstructions: false,
    gate: value.gate ?? null,
    publish: null as PublishConfig | null,
    sandbox: { allowDomains: [], denyRead: [] },
    requireWorktree: false,
    dispatch: value.dispatch ?? null,
    profile: null,
  });
  return {
    resolve: (root: string) =>
      answer(root === covered ? declared : globals),
  };
}

/** A bridge port that records the commands the turn was given. */
function recordingBridge() {
  const turns: BridgeTurn[] = [];
  const dependency: ExternalAgentToolBridge = {
    toolTimeoutSeconds: 20,
    bridge: () =>
      Promise.resolve({
        socketPath: "/unused",
        bind: () => "token",
        activate: (_sessionId, turn) => {
          turns.push(turn);
          return () => {};
        },
      }),
  };
  return { dependency, turns };
}

/**
 * A dispatch factory recording each `forSession` context it was asked for. It
 * answers with ports bound to the context it was given, as the real service
 * does, because the factory's answer is what decides whether any dispatch
 * tool exists at all.
 */
function recordingDispatch(fallback: DispatchConfig = GLOBAL_DISPATCH) {
  const contexts: {
    depth: number;
    config?: DispatchConfig | null;
  }[] = [];
  return {
    contexts,
    factory: {
      forSession: (
        context: {
          depth: number;
          config?: DispatchConfig | null;
        },
      ) => {
        contexts.push(context);
        const config = context.config ?? fallback;
        return {
          config,
          depth: context.depth,
          checkStart: () => Promise.resolve({ refusal: "not run" }),
          start: () => Promise.reject(new Error("not run")),
          wait: () => Promise.reject(new Error("not run")),
          read: () => Promise.reject(new Error("not run")),
          checkSend: () => Promise.resolve("not run"),
          send: () => Promise.reject(new Error("not run")),
        };
      },
    },
  };
}

function gate(): GateRuntimePorts {
  return { config: null, runs: new GateRuns() };
}

const STORE = new MemoryStore({ models: [], prompts: [], memories: [] });

/** Bind one Codex turn and list the command ids it was offered. */
async function bridgedCommands(input: {
  workspaceRoot: string;
  gate: GateRuntimePorts;
  workspaceConfig?: WorkspaceConfigResolver;
  dispatchConfig?: DispatchConfig;
}) {
  const bridge = recordingBridge();
  const dispatch = recordingDispatch();
  const bound = await bindExternalAgentTools(
    {
      runner: { profile: "codex-chatgpt" },
      workspaceRoot: input.workspaceRoot,
      sessionId: "01SESSION000000000000000001",
    },
    {
      store: STORE,
      gate: input.gate,
      toolBridge: bridge.dependency,
      dispatch: dispatch.factory,
      ...(input.workspaceConfig === undefined
        ? {}
        : { workspaceConfig: input.workspaceConfig }),
    },
    {
      parentSessionId: "01SESSION000000000000000001",
      traceId: "0123456789abcdef0123456789abcdef",
      turnRootSpanId: "0123456789abcdef",
      principalId: "user",
      authContext: LOOPBACK,
    },
  );
  // The runtime activates the returned binding for the turn; that is where the
  // bridge records the commands it was offered.
  bound?.activate(
    "0123456789abcdef0123456789abcdef",
    "0123456789abcdef",
    () => Promise.resolve(),
  );
  return {
    ids: (bridge.turns[0]?.commands ?? []).map((command) => command.id),
    dispatchContexts: dispatch.contexts,
  };
}

function gateIds(ids: readonly string[]): string[] {
  return ids.filter((id) => id.startsWith("gate/"));
}

function dispatchIds(ids: readonly string[]): string[] {
  return ids.filter((id) => id.startsWith("dispatch/"));
}

test("a profile's gate reaches the Codex bridge, and only where it applies", async () => {
  const resolver = profiles(
    "/work/profiled",
    { gate: GATE },
    { gate: null },
  );
  const matched = await bridgedCommands({
    workspaceRoot: "/work/profiled",
    gate: gate(),
    workspaceConfig: resolver,
  });
  assert.deepStrictEqual(gateIds(matched.ids), [
    "gate/start",
    "gate/wait",
    "gate/cancel",
  ]);
  const unmatched = await bridgedCommands({
    workspaceRoot: "/work/elsewhere",
    gate: gate(),
    workspaceConfig: resolver,
  });
  assert.deepStrictEqual(
    gateIds(unmatched.ids),
    [],
    "a workspace no section covers gets no gate tools",
  );
});

test("an unmatched workspace keeps the global gate on the Codex bridge", async () => {
  const resolver = profiles(
    "/work/profiled",
    { gate: null },
    { gate: GATE },
  );
  const bridged = await bridgedCommands({
    workspaceRoot: "/work/elsewhere",
    gate: gate(),
    workspaceConfig: resolver,
  });
  assert.deepStrictEqual(gateIds(bridged.ids), [
    "gate/start",
    "gate/wait",
    "gate/cancel",
  ]);
});

test("a profile's dispatch section narrows the Codex coordinator, and its absence removes dispatch", async () => {
  const resolver = profiles(
    "/work/profiled",
    { dispatch: PROFILE_DISPATCH },
    { dispatch: GLOBAL_DISPATCH },
  );
  const matched = await bridgedCommands({
    workspaceRoot: "/work/profiled",
    gate: gate(),
    workspaceConfig: resolver,
    dispatchConfig: GLOBAL_DISPATCH,
  });
  assert.deepStrictEqual(
    matched.dispatchContexts.map((context) => context.config?.roots),
    [["/work/repo-worktrees"]],
    "the profile's roots, never the boot-time global ones",
  );
  assert.deepStrictEqual(dispatchIds(matched.ids), [
    "dispatch/start",
    "dispatch/wait",
    "dispatch/read",
    "dispatch/send",
  ]);
});

test("a profiled workspace that declares no dispatch section starts no children", async () => {
  const resolver = profiles(
    "/work/profiled",
    {},
    { dispatch: GLOBAL_DISPATCH },
  );
  const bridged = await bridgedCommands({
    workspaceRoot: "/work/profiled",
    gate: gate(),
    workspaceConfig: resolver,
    dispatchConfig: GLOBAL_DISPATCH,
  });
  assert.deepStrictEqual(bridged.dispatchContexts, []);
  assert.deepStrictEqual(dispatchIds(bridged.ids), []);
});

test("without a resolver the boot-time global sections apply, as before profiles existed", async () => {
  const bridged = await bridgedCommands({
    workspaceRoot: "/work/anywhere",
    gate: { config: GATE, runs: new GateRuns() },
    dispatchConfig: GLOBAL_DISPATCH,
  });
  assert.deepStrictEqual(gateIds(bridged.ids), [
    "gate/start",
    "gate/wait",
    "gate/cancel",
  ]);
  assert.deepStrictEqual(
    bridged.dispatchContexts.map((context) => context.config),
    [undefined],
    "the service's own boot-time config is left in force",
  );
});
