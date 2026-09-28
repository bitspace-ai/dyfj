import {
  assert,
  assertEquals,
  assertObjectMatch,
  assertRejects,
} from "@std/assert";
import type { TurnStreamFrame } from "../../contract/mod.ts";
import {
  SessionOwners,
  type TurnRuntime,
  type WorkbenchRuntimeResult,
} from "../../engine/mod.ts";
import type { CommandDefinition } from "../../tools/mod.ts";
import { type RpcContext, RpcErrorCode } from "../../transport/mod.ts";
import { callRpc, rpcFailure } from "../../../testing/builders/rpc.ts";
import { MapEnv } from "../../../testing/fakes/map-env.ts";
import { buildTurnHandlers, type TurnHandlerDeps } from "./turn.ts";

// The runtime fakes return receipt-shaped stubs, not full results.
const result = (value: unknown) => value as WorkbenchRuntimeResult;

function handlers(
  runRuntime: TurnRuntime,
  overrides: Partial<TurnHandlerDeps> = {},
) {
  return buildTurnHandlers({
    owners: new SessionOwners(),
    runRuntime,
    fetchSessionEvents: () => Promise.resolve([]),
    env: new MapEnv(),
    ...overrides,
  });
}

/**
 * A connected client: records `stream` notifications in order and answers
 * `approval` requests with `approval`. Without it, an approval request fails
 * as it does for a client that registered no approval handler.
 */
function client(
  approval?: (request: unknown) => unknown,
): RpcContext & { streamed: unknown[]; asked: unknown[] } {
  const streamed: unknown[] = [];
  const asked: unknown[] = [];
  return {
    streamed,
    asked,
    notify: (method, params) => {
      assertEquals(method, "stream");
      streamed.push(params);
      return Promise.resolve();
    },
    request: (method, params) => {
      assertEquals(method, "approval");
      asked.push(params);
      return approval === undefined
        ? Promise.reject(new Error("method not found: approval"))
        : Promise.resolve(approval(params));
    },
  };
}

const noApprover = (): RpcContext => ({
  notify: () => Promise.resolve(),
  request: () => Promise.reject(new Error("no peer approver")),
});

const externalReadCommand: CommandDefinition<string> = {
  id: "mcp.linear.get_issue",
  title: "External MCP: linear/get_issue",
  description: "Configured external MCP read.",
  inputSchema: { type: "object", additionalProperties: true },
  permission: {
    effects: ["read.external", "emit.event"],
    defaultDecision: "allow",
    resources: ["mcp:linear/get_issue"],
    network: "configured-external",
    filesystem: "none",
    cost: "none",
  },
  minimumClearance: "loopback",
  executor: () => "result",
};

// --- turn ---

Deno.test("turn streams deltas + events and returns the receipt", async () => {
  const runRuntime: TurnRuntime = (input) => {
    input.frames?.onTextDelta?.("hello ");
    input.frames?.onTextDelta?.("world");
    input.frames?.onRuntimeEvent?.(
      { kind: "tool-call", name: "noop" } as never,
    );
    return Promise.resolve(result({ receiptId: "r1" }));
  };
  const ctx = client();
  assertEquals(
    await callRpc(handlers(runRuntime), "turn", { prompt: "hi" }, ctx),
    {
      receiptId: "r1",
    },
  );
  // Stream frames carry the shared TurnStreamFrame union.
  assertEquals(ctx.streamed, [
    { t: "delta", text: "hello " },
    { t: "delta", text: "world" },
    { t: "event", event: { kind: "tool-call", name: "noop" } },
  ]);
});

Deno.test("turn threads the configured agent-step limit and returns the receipt field", async () => {
  let seenMaxToolSteps: number | undefined;
  const rpc = handlers((input) => {
    seenMaxToolSteps = input.maxToolSteps;
    return Promise.resolve(result({
      agent: { toolStepsUsed: 3, maxToolSteps: 7, limitReached: false },
    }));
  }, {
    engineConfig: {
      defaultCompanionModel: null,
      permissionLevel: "strict",
      approvePaidDefault: false,
      trustWorkspaceInstructions: false,
      defaultSessionBudgetUsd: 1,
      defaultPerCallBudgetUsd: 0.1,
      defaultDailyBudgetUsd: 25,
      anomalyTurnMultiple: 3,
      anomalyScopeMultiple: 2,
      maxToolSteps: 7,
    },
  });
  assertEquals(await callRpc(rpc, "turn", { prompt: "hi" }, client()), {
    agent: { toolStepsUsed: 3, maxToolSteps: 7, limitReached: false },
  });
  assertEquals(seenMaxToolSteps, 7);
});

Deno.test("turn threads boot-discovered external MCP commands into the runtime", async () => {
  let received: unknown;
  const rpc = handlers((input) => {
    received = input.externalMcpCommands;
    return Promise.resolve(result({ receiptId: "r1" }));
  }, { externalMcpCommands: [externalReadCommand] });
  await rpc.turn({ prompt: "inspect issue" }, {
    notify: () => Promise.resolve(),
    request: () => Promise.reject(new Error("no approval expected")),
  });
  assertEquals(received, [externalReadCommand]);
});

Deno.test("a turn without a prompt -> invalidParams", async () => {
  const error = await rpcFailure(
    handlers(() => Promise.resolve(result({}))),
    "turn",
    {},
    client(),
  );
  assertEquals(error.code, RpcErrorCode.invalidParams);
});

Deno.test("turn keeps the superseding-retry signal ordered between stale and replacement deltas", async () => {
  // The reset contract only works if the seam preserves emission order: a
  // consumer resets exactly at the signal, keeping everything after it.
  const supersede = {
    type: "supersedingRetryStarted",
    sessionId: "01UDSSESSION0000000000000000",
    modelSlug: "gemma4:e2b",
    reason: "context_overflow_recovery",
  };
  const runRuntime: TurnRuntime = async (input) => {
    input.frames?.onTextDelta?.("stale partial");
    await input.frames?.onRuntimeEvent?.(supersede as never);
    input.frames?.onTextDelta?.("replacement answer");
    return result({ receiptId: "r1" });
  };
  const ctx = client();
  await callRpc(handlers(runRuntime), "turn", { prompt: "hi" }, ctx);
  assertEquals(ctx.streamed, [
    { t: "delta", text: "stale partial" },
    { t: "event", event: supersede },
    { t: "delta", text: "replacement answer" },
  ]);
});

Deno.test("a rejected supersede notification prevents the replacement provider call", async () => {
  // The seam must not merely await a handler that discards the notification:
  // if the signal never reaches the client, the replacement text would be
  // glued onto the stale text the client still has rendered. The runtime here
  // mirrors the real one's fail-closed shape — await the signal, and only then
  // run the replacement call.
  const supersede = {
    type: "supersedingRetryStarted",
    sessionId: "01UDSSESSION0000000000000000",
    modelSlug: "gemma4:e2b",
    reason: "context_overflow_recovery",
  };
  let replacementProviderCalled = false;
  const runRuntime: TurnRuntime = async (input) => {
    input.frames?.onTextDelta?.("stale partial");
    await input.frames?.onRuntimeEvent?.(supersede as never);
    replacementProviderCalled = true;
    input.frames?.onTextDelta?.("replacement answer");
    return result({ receiptId: "r1" });
  };

  const sent: unknown[] = [];
  const ctx: RpcContext = {
    notify: (_method, params) => {
      const frame = params as TurnStreamFrame;
      if (frame.t === "event") {
        // The client's stream channel died between the stale and replacement
        // deltas — exactly when the reset signal must land.
        return Promise.reject(new Error("stream channel lost"));
      }
      sent.push(params);
      return Promise.resolve();
    },
    request: () => Promise.reject(new Error("no peer approver")),
  };

  await assertRejects(
    async () => await handlers(runRuntime).turn({ prompt: "hi" }, ctx),
    Error,
    "stream channel lost",
  );
  assertEquals(replacementProviderCalled, false);
  assertEquals(sent, [{ t: "delta", text: "stale partial" }]);
});

Deno.test("a rejected unparsed-markup notification fails the turn", async () => {
  const warning = {
    type: "unparsedToolCallMarkupDetected",
    sessionId: "01UDSSESSION0000000000000000",
    count: 2,
    countIsLowerBound: false,
  };
  let completed = false;
  const runRuntime: TurnRuntime = async (input) => {
    await input.frames?.onRuntimeEvent?.(warning as never);
    completed = true;
    return result({ receiptId: "r1" });
  };
  const ctx: RpcContext = {
    notify: (_method, params) =>
      (params as TurnStreamFrame).t === "event"
        ? Promise.reject(new Error("stream channel lost"))
        : Promise.resolve(),
    request: () => Promise.reject(new Error("no peer approver")),
  };
  await assertRejects(
    async () => await handlers(runRuntime).turn({ prompt: "hi" }, ctx),
    Error,
    "stream channel lost",
  );
  assertEquals(completed, false);
});

Deno.test("a rejected plain status notification does not abort the turn", async () => {
  // The asymmetry: safety signals are fail-closed. This plain status event's
  // failed send (client gone) must stay best-effort — swallowed, not
  // surfaced — so the turn runs to completion instead of failing on a dropped
  // notification, and no per-event rejection floods back to the runtime.
  let afterEventReached = false;
  const runRuntime: TurnRuntime = async (input) => {
    // A plain status event, not either fail-closed safety signal.
    await input.frames?.onRuntimeEvent?.({ type: "toolCallStarted" } as never);
    afterEventReached = true;
    return result({ receiptId: "r1" });
  };
  const ctx: RpcContext = {
    notify: (_method, params) =>
      (params as TurnStreamFrame).t === "event"
        ? Promise.reject(new Error("client gone"))
        : Promise.resolve(),
    request: () => Promise.reject(new Error("no peer approver")),
  };
  const warn = console.warn;
  const warnings: unknown[] = [];
  console.warn = (...args: unknown[]) => warnings.push(args);
  try {
    // Resolves (does not reject), and execution continued past the failed send.
    assertEquals(await handlers(runRuntime).turn({ prompt: "hi" }, ctx), {
      receiptId: "r1",
    });
  } finally {
    console.warn = warn;
  }
  assert(afterEventReached);
  assertEquals(warnings.length, 1);
});

// The security-critical property: UDS is the canonical loopback transport, so
// paid inference is available — but only with the explicit per-turn opt-in,
// decided by the shared turn core. Same gate as the HTTP loopback path.
const paidProbe: TurnRuntime = async (input) =>
  result({ verdict: await input.approver?.confirmPaidEscalation?.("test") });

Deno.test("loopback clearance: paid approved with the per-turn opt-in", async () => {
  assertEquals(
    await callRpc(handlers(paidProbe), "turn", {
      prompt: "hi",
      approvePaidInference: true,
    }, client()),
    { verdict: { decision: "approve" } },
  );
});

Deno.test("paid denied without the per-turn opt-in", async () => {
  const { verdict } = await callRpc(handlers(paidProbe), "turn", {
    prompt: "hi",
  }, client()) as { verdict: { decision: string } };
  assertEquals(verdict.decision, "deny");
});

Deno.test("loopback inherits approvePaidDefault when the request omits opt-in", async () => {
  const rpc = handlers(paidProbe, {
    engineConfig: {
      defaultCompanionModel: null,
      permissionLevel: "strict",
      approvePaidDefault: true,
      trustWorkspaceInstructions: false,
      defaultSessionBudgetUsd: 1,
      defaultPerCallBudgetUsd: 0.1,
      defaultDailyBudgetUsd: 25,
      anomalyTurnMultiple: 3,
      anomalyScopeMultiple: 2,
      maxToolSteps: 32,
    },
  });
  assertEquals(await callRpc(rpc, "turn", { prompt: "hi" }, client()), {
    verdict: { decision: "approve" },
  });
});

Deno.test("turn applies a loopback budget override", async () => {
  const rpc = handlers((input) =>
    Promise.resolve(result({ sessionLimitUsd: input.sessionLimitUsd ?? null }))
  );
  assertEquals(
    await callRpc(rpc, "turn", {
      prompt: "hi",
      budget: { sessionLimitUsd: 5 },
    }, client()),
    { sessionLimitUsd: 5 },
  );
});

// --- turn/cancel and per-connection turns ---

Deno.test("turn/cancel aborts the matching active turn and is otherwise a no-op", async () => {
  const turnId = "123e4567-e89b-42d3-a456-426614174000";
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const runRuntime: TurnRuntime = (input) =>
    new Promise((resolve) => {
      markStarted();
      input.abortSignal?.addEventListener("abort", () => {
        resolve(result({ stopReason: "aborted", text: "partial" }));
      }, { once: true });
    });
  const ctx = noApprover();
  const rpc = handlers(runRuntime);
  const turn = rpc.turn({ prompt: "hi", turnId }, ctx);

  await started;
  assertEquals(await rpc["turn/cancel"]({ turnId }, noApprover()), {
    cancelled: false,
    reason: "no_active_turn",
  });
  assertEquals(await rpc["turn/cancel"]({ turnId }, ctx), { cancelled: true });
  assertObjectMatch(await turn as Record<string, unknown>, {
    stopReason: "aborted",
    text: "partial",
  });
  assertEquals(await rpc["turn/cancel"]({ turnId }, ctx), {
    cancelled: false,
    reason: "no_active_turn",
  });
});

Deno.test("turn/cancel requires a UUID turn id", async () => {
  const error = await rpcFailure(
    handlers(() => Promise.resolve(result({}))),
    "turn/cancel",
    { turnId: "not-a-uuid" },
    client(),
  );
  assertEquals(error, {
    code: RpcErrorCode.invalidParams,
    message: "turnId must be a UUID",
  });
});

Deno.test("an approval arriving after acknowledged cancellation cannot start work", async () => {
  const turnId = "123e4567-e89b-42d3-a456-426614174000";
  let markApprovalRequested!: () => void;
  const approvalRequested = new Promise<void>((resolve) => {
    markApprovalRequested = resolve;
  });
  let resolveApproval!: (value: unknown) => void;
  const approvalResponse = new Promise<unknown>((resolve) => {
    resolveApproval = resolve;
  });
  let executorStarted = false;
  let runtimeCalls = 0;
  const runRuntime: TurnRuntime = async (input) => {
    runtimeCalls++;
    if (runtimeCalls > 1) return result({ text: "next turn" });
    let matchedSignalReason = false;
    try {
      const verdict = await input.approver?.confirmToolApproval?.({
        commandId: "write_file",
        callId: "c1",
        title: "Write File",
        arguments: { path: "notes.md" },
      });
      executorStarted = verdict?.decision === "approve";
    } catch (error) {
      matchedSignalReason = error === input.abortSignal?.reason;
    }
    return result({
      aborted: input.abortSignal?.aborted,
      matchedSignalReason,
    });
  };
  const ctx: RpcContext = {
    notify: () => Promise.resolve(),
    request: (_method, _params, signal) => {
      markApprovalRequested();
      return new Promise((resolve, reject) => {
        const onAbort = () => reject(signal?.reason);
        signal?.addEventListener("abort", onAbort, { once: true });
        approvalResponse.then(resolve, reject).finally(() => {
          signal?.removeEventListener("abort", onAbort);
        });
      });
    },
  };
  const rpc = handlers(runRuntime);
  const turn = rpc.turn({ prompt: "edit notes", turnId }, ctx);

  await approvalRequested;
  assertEquals(await rpc["turn/cancel"]({ turnId }, ctx), { cancelled: true });
  assertObjectMatch(await turn as Record<string, unknown>, {
    aborted: true,
    matchedSignalReason: true,
  });
  assertEquals(executorStarted, false);
  assertObjectMatch(
    await rpc.turn({ prompt: "next" }, ctx) as Record<string, unknown>,
    { text: "next turn" },
  );
  resolveApproval({ decision: "approve" });
});

Deno.test("turn/cancel declines after the runtime closes its cancellation window", async () => {
  const turnId = "123e4567-e89b-42d3-a456-426614174000";
  let markFinalizing!: () => void;
  const finalizing = new Promise<void>((resolve) => {
    markFinalizing = resolve;
  });
  let finish!: () => void;
  const finalized = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const runRuntime: TurnRuntime = async (input) => {
    input.cancellationWindow?.closeCancellation();
    markFinalizing();
    await finalized;
    return result({ stopReason: "stop", text: "done" });
  };
  const ctx = noApprover();
  const rpc = handlers(runRuntime);
  const turn = rpc.turn({ prompt: "hi", turnId }, ctx);

  await finalizing;
  assertEquals(await rpc["turn/cancel"]({ turnId }, ctx), {
    cancelled: false,
    reason: "no_active_turn",
  });
  finish();
  assertObjectMatch(await turn as Record<string, unknown>, {
    stopReason: "stop",
    text: "done",
  });
});

Deno.test("different connections may use the same active turn id", async () => {
  const turnId = "123e4567-e89b-42d3-a456-426614174000";
  let startedCount = 0;
  let markBothStarted!: () => void;
  const bothStarted = new Promise<void>((resolve) => {
    markBothStarted = resolve;
  });
  const runRuntime: TurnRuntime = (input) =>
    new Promise((resolve) => {
      startedCount++;
      if (startedCount === 2) markBothStarted();
      input.abortSignal?.addEventListener("abort", () => {
        resolve(result({ stopReason: "aborted", text: "" }));
      }, { once: true });
    });
  const firstContext = noApprover();
  const secondContext = noApprover();
  const rpc = handlers(runRuntime);
  const first = rpc.turn({ prompt: "first", turnId }, firstContext);
  const second = rpc.turn({ prompt: "second", turnId }, secondContext);

  await bothStarted;
  assertEquals(await rpc["turn/cancel"]({ turnId }, firstContext), {
    cancelled: true,
  });
  assertEquals(await rpc["turn/cancel"]({ turnId }, secondContext), {
    cancelled: true,
  });
  assertObjectMatch(await first as Record<string, unknown>, {
    stopReason: "aborted",
  });
  assertObjectMatch(await second as Record<string, unknown>, {
    stopReason: "aborted",
  });
});

Deno.test("one connection cannot accumulate concurrent active turns", async () => {
  const firstTurnId = "123e4567-e89b-42d3-a456-426614174000";
  const secondTurnId = "123e4567-e89b-42d3-a456-426614174001";
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const runRuntime: TurnRuntime = (input) =>
    new Promise((resolve) => {
      markStarted();
      input.abortSignal?.addEventListener("abort", () => {
        resolve(result({ stopReason: "aborted", text: "" }));
      }, { once: true });
    });
  const ctx = noApprover();
  const rpc = handlers(runRuntime);
  const first = rpc.turn({ prompt: "first", turnId: firstTurnId }, ctx);

  await started;
  assertEquals(
    await rpcFailure(
      rpc,
      "turn",
      { prompt: "second", turnId: secondTurnId },
      ctx,
    ),
    {
      code: RpcErrorCode.invalidParams,
      message: "connection already has an active turn",
    },
  );
  assertEquals(await rpc["turn/cancel"]({ turnId: firstTurnId }, ctx), {
    cancelled: true,
  });
  assertObjectMatch(await first as Record<string, unknown>, {
    stopReason: "aborted",
  });
});

// --- the approval round trip ---

// A runtime that asks to approve one mutating tool and reports the verdict.
const toolApprovalProbe: TurnRuntime = async (input) =>
  result({
    verdict: await input.approver?.confirmToolApproval?.({
      commandId: "write_file",
      callId: "c1",
      title: "Write File",
      arguments: { path: "notes.md" },
    }),
  });

const acpPermissionProbe: TurnRuntime = async (input) =>
  result({
    selection: await input.approver?.confirmExternalAgentPermission?.({
      sessionId: "external-session",
      toolCallId: "permission-1",
      toolCall: {
        title: "Run shell command?",
        name: "terminal",
        kind: "execute\u001b[31mforged",
        inputSummary: "git status",
      },
      options: [{
        optionId: "allow-once-id",
        name: "Allow Once",
        kind: "allow_once",
      }, {
        optionId: "remember-command-id",
        name: "Always allow `git status`",
        kind: "allow_always",
      }, {
        optionId: "reject-id",
        name: "Reject",
        kind: "reject_once",
      }],
    }, input.abortSignal ?? new AbortController().signal),
  });

const emptyAllowOnlyPermissionProbe: TurnRuntime = async (input) =>
  result({
    selection: await input.approver?.confirmExternalAgentPermission?.({
      sessionId: "external-session",
      toolCallId: "permission-1",
      toolCall: {
        title: "Run shell command?",
        inputSummary: "git status",
      },
      options: [{
        optionId: "",
        name: "Allow Once",
        kind: "allow_once",
      }],
    }, input.abortSignal ?? new AbortController().signal),
  });

Deno.test("preserves the exact selected ACP option id across the duplex seam", async () => {
  const ctx = client(() => ({
    decision: "select",
    optionId: "remember-command-id",
  }));
  assertObjectMatch(
    await callRpc(handlers(acpPermissionProbe), "turn", {
      prompt: "run it",
    }, ctx) as Record<string, unknown>,
    { selection: { optionId: "remember-command-id", source: "operator" } },
  );
  assertEquals(ctx.asked.length, 1);
  const asked = ctx.asked[0] as {
    kind: string;
    arguments: Record<string, unknown>;
    options: Array<{ optionId: string; name: string }>;
  };
  assertEquals(asked.kind, "external_agent_permission");
  assertEquals(asked.arguments["ACP kind"], "(not supplied)");
  assert(
    asked.options.some((option) =>
      option.optionId === "remember-command-id" &&
      option.name === "Always allow `git status`"
    ),
  );
});

Deno.test("a client policy denial selects the request rejection as policy", async () => {
  const ctx = client(() => ({
    decision: "deny",
    reason: "ACP permission selection unavailable",
  }));
  assertObjectMatch(
    await callRpc(handlers(acpPermissionProbe), "turn", {
      prompt: "run it",
    }, ctx) as Record<string, unknown>,
    { selection: { optionId: "reject-id", source: "policy" } },
  );
});

Deno.test("a missing ACP approver selects the request rejection", async () => {
  assertObjectMatch(
    await callRpc(handlers(acpPermissionProbe), "turn", {
      prompt: "run it",
    }, client()) as Record<string, unknown>,
    { selection: { optionId: "reject-id", source: "policy" } },
  );
});

Deno.test("a missing approver cannot select an empty allow id when rejection is absent", async () => {
  assertObjectMatch(
    await callRpc(handlers(emptyAllowOnlyPermissionProbe), "turn", {
      prompt: "run it",
    }, client()) as Record<string, unknown>,
    { selection: { optionId: null, source: "policy" } },
  );
});

Deno.test("server asks the client to approve a mutating tool mid-turn; approve flows back", async () => {
  const ctx = client(() => ({ decision: "approve" }));
  const { verdict } = await callRpc(handlers(toolApprovalProbe), "turn", {
    prompt: "edit notes",
  }, ctx) as { verdict: unknown };
  assertEquals(verdict, { decision: "approve" });
  assertObjectMatch(ctx.asked[0] as Record<string, unknown>, {
    commandId: "write_file",
    arguments: { path: "notes.md" },
  });
});

Deno.test("a client denial flows back as a deny verdict", async () => {
  const { verdict } = await callRpc(handlers(toolApprovalProbe), "turn", {
    prompt: "edit notes",
  }, client(() => ({ decision: "deny", reason: "not now" }))) as {
    verdict: unknown;
  };
  assertEquals(verdict, { decision: "deny", reason: "not now" });
});

Deno.test("an interrupted approval aborts the server-side turn signal", async () => {
  const runRuntime: TurnRuntime = async (input) => {
    let matchedSignalReason = false;
    try {
      await input.approver?.confirmToolApproval?.({
        commandId: "write_file",
        callId: "c1",
        title: "Write File",
        arguments: { path: "notes.md" },
      });
    } catch (error) {
      matchedSignalReason = error === input.abortSignal?.reason;
    }
    return result({
      aborted: input.abortSignal?.aborted,
      matchedSignalReason,
    });
  };
  assertObjectMatch(
    await callRpc(handlers(runRuntime), "turn", {
      prompt: "edit notes",
    }, client(() => ({ decision: "abort" }))) as Record<string, unknown>,
    { aborted: true, matchedSignalReason: true },
  );
});

Deno.test("no client approver -> fail-closed deny", async () => {
  const { verdict } = await callRpc(handlers(toolApprovalProbe), "turn", {
    prompt: "edit notes",
  }, client()) as { verdict: { decision: string } };
  assertEquals(verdict.decision, "deny");
});

Deno.test("a reasonless anomaly-halt denial names the anomaly gate, not the budget ceiling", async () => {
  const runRuntime: TurnRuntime = async (input) =>
    result({
      verdict: await input.approver?.confirmRunawayAnomaly?.({
        kind: "runaway_anomaly",
        trigger: "turn_spend",
        spentUsd: 0.35,
        haltUsd: 0.30,
        turnSpentUsd: 0.35,
        turnHaltUsd: 0.30,
        sessionSpentUsd: 0.35,
        sessionHaltUsd: 2,
        dailySpentUsd: 0.35,
        dailyHaltUsd: 50,
        turnMultiple: 3,
        scopeMultiple: 2,
        authzBasis: "policy:halt:runaway-anomaly",
        approvalAuthzBasis: "policy:allow:operator-confirmed-anomaly",
      }),
    });
  const { verdict } = await callRpc(handlers(runRuntime), "turn", {
    prompt: "spend",
  }, client(() => ({ decision: "deny" }))) as { verdict: unknown };
  assertEquals(verdict, {
    decision: "deny",
    reason: "operator declined the anomaly halt",
  });
});
