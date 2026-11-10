import assert from "node:assert/strict";
import { test } from "node:test";
import type { AcpPermissionPrompt } from "../../contract/mod.ts";
import {
  SessionOwners,
  type TurnRuntime,
  type WorkbenchRuntimeResult,
} from "../../engine/mod.ts";
import type { EventInsert } from "../../store/mod.ts";
import type { RpcContext } from "../../transport/mod.ts";
import { RpcErrorCode } from "../../transport/mod.ts";
import { callRpc, rpcFailure } from "../../../testing/builders/rpc.ts";
import { MapEnv } from "../../../testing/fakes/map-env.ts";
import { buildHeadlessTurns, HeadlessSessions } from "../headless-turn.ts";
import { ParkedApprovals } from "../parked-approvals.ts";
import { buildApprovalsHandlers } from "./approvals.ts";
import { buildTurnHandlers } from "./turn.ts";

// A runtime-started headless turn has no client connection. Its approval
// requests park against its session until an attached client answers them
// through `approvals/pending` and `approvals/answer`.

const result = (value: unknown) => value as WorkbenchRuntimeResult;

const toolRequest = {
  commandId: "bash",
  callId: "c1",
  title: "Run a command",
  arguments: { command: "touch x" },
};

// A runtime that announces its session and asks for one tool approval, then
// returns the verdict it was given as its receipt.
function askingRuntime(calls: { prompts: string[] }): TurnRuntime {
  return async (input) => {
    calls.prompts.push(input.prompt);
    const sessionId = input.sessionId ?? input.newSessionId!;
    await input.frames?.onRuntimeEvent?.({
      type: "sessionStart",
      sessionId,
      traceId: "T1",
      mode: "chat",
    });
    const verdict = await input.approver!.confirmToolApproval!(toolRequest);
    return result({ sessionId, verdict });
  };
}

// A connection that would answer any `approval` request it is sent. It must
// never be asked: text and other connections do not reach a parked approval.
function eagerClient(): RpcContext & { asked: unknown[] } {
  const asked: unknown[] = [];
  return {
    asked,
    notify: () => Promise.resolve(),
    request: (_method, params) => {
      asked.push(params);
      return Promise.resolve({ decision: "approve" });
    },
  };
}

function compose(runRuntime: TurnRuntime) {
  const owners = new SessionOwners();
  const events: EventInsert[] = [];
  const parked = new ParkedApprovals({
    writeEvent: (event) => {
      events.push(event);
      return Promise.resolve();
    },
  });
  const deps = {
    owners,
    runRuntime,
    fetchSessionEvents: () => Promise.resolve([]),
    env: new MapEnv(),
    parkedApprovals: parked,
    headlessSessions: new HeadlessSessions(),
  };
  return {
    events,
    parked,
    headless: buildHeadlessTurns(deps),
    handlers: {
      ...buildTurnHandlers(deps),
      ...buildApprovalsHandlers({ parked }),
    },
  };
}

interface PendingList {
  approvals: { approvalId: string; parkedAt: string; request: unknown }[];
}

async function untilParked(
  handlers: ReturnType<typeof compose>["handlers"],
  sessionId: string,
): Promise<PendingList["approvals"]> {
  for (let i = 0; i < 200; i++) {
    const listed = await callRpc(handlers, "approvals/pending", {
      sessionId,
    }) as PendingList;
    if (listed.approvals.length > 0) return listed.approvals;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("the headless turn never parked");
}

async function startHeadless(composed: ReturnType<typeof compose>) {
  const started = composed.headless.start({ prompt: "do the thing" });
  assert.ok(!("error" in started), "the headless turn should start");
  return { ...started, sessionId: await started.session };
}

test("a headless turn parks, an attached client answers, and the turn resumes", async () => {
  const calls = { prompts: [] as string[] };
  const composed = compose(askingRuntime(calls));
  const turn = await startHeadless(composed);

  const [pending] = await untilParked(composed.handlers, turn.sessionId);
  assert.deepStrictEqual(pending!.request, toolRequest);
  assert.ok(!Number.isNaN(Date.parse(pending!.parkedAt)));
  assert.deepStrictEqual(
    composed.events.map((event) => event.event_type),
    ["approval_parked"],
  );

  assert.deepStrictEqual(
    await callRpc(composed.handlers, "approvals/answer", {
      sessionId: turn.sessionId,
      approvalId: pending!.approvalId,
      response: { decision: "approve" },
    }),
    { answered: true },
  );
  const receipt = await turn.result as unknown as { verdict: unknown };
  // The answer went through the same fail-closed parsing a client's does.
  assert.deepStrictEqual(receipt.verdict, { decision: "approve" });
  assert.deepStrictEqual(
    (await callRpc(composed.handlers, "approvals/pending", {
      sessionId: turn.sessionId,
    }) as PendingList).approvals,
    [],
  );
});

test("an answer that is not an explicit approval denies the parked call", async () => {
  const composed = compose(askingRuntime({ prompts: [] }));
  const turn = await startHeadless(composed);
  const [pending] = await untilParked(composed.handlers, turn.sessionId);
  await callRpc(composed.handlers, "approvals/answer", {
    sessionId: turn.sessionId,
    approvalId: pending!.approvalId,
    response: "yes",
  });
  const receipt = await turn.result as unknown as {
    verdict: { decision: string };
  };
  assert.equal(receipt.verdict.decision, "deny");
});

test("a wrong approval id is refused, and so is a second answer", async () => {
  const composed = compose(askingRuntime({ prompts: [] }));
  const turn = await startHeadless(composed);
  const [pending] = await untilParked(composed.handlers, turn.sessionId);

  const wrongId = await rpcFailure(composed.handlers, "approvals/answer", {
    sessionId: turn.sessionId,
    approvalId: crypto.randomUUID(),
    response: { decision: "approve" },
  });
  assert.equal(wrongId.code, RpcErrorCode.invalidParams);
  assert.match(wrongId.message, /not pending/);

  const otherSession = await rpcFailure(composed.handlers, "approvals/answer", {
    sessionId: "01J00000000000000000000000",
    approvalId: pending!.approvalId,
    response: { decision: "approve" },
  });
  assert.equal(otherSession.code, RpcErrorCode.invalidParams);

  await callRpc(composed.handlers, "approvals/answer", {
    sessionId: turn.sessionId,
    approvalId: pending!.approvalId,
    response: { decision: "deny", reason: "not now" },
  });
  const second = await rpcFailure(composed.handlers, "approvals/answer", {
    sessionId: turn.sessionId,
    approvalId: pending!.approvalId,
    response: { decision: "approve" },
  });
  assert.equal(second.code, RpcErrorCode.invalidParams);
  assert.match(second.message, /not pending/);

  const receipt = await turn.result as unknown as {
    verdict: { decision: string; reason?: string };
  };
  assert.deepStrictEqual(receipt.verdict, {
    decision: "deny",
    reason: "not now",
  });
});

test("approvals methods refuse malformed params", async () => {
  const { handlers } = compose(askingRuntime({ prompts: [] }));
  for (
    const [method, params] of [
      ["approvals/pending", {}],
      ["approvals/pending", { sessionId: 7 }],
      ["approvals/answer", { sessionId: "S1" }],
      ["approvals/answer", { sessionId: "S1", approvalId: "" }],
      ["approvals/answer", { sessionId: "S1", approvalId: "a" }],
    ] as const
  ) {
    const failure = await rpcFailure(handlers, method, params);
    assert.equal(failure.code, RpcErrorCode.invalidParams, method);
  }
});

test("text sent to the session cannot resolve a parked approval", { timeout: 5_000 }, async () => {
  const calls = { prompts: [] as string[] };
  const composed = compose(askingRuntime(calls));
  const turn = await startHeadless(composed);
  const [pending] = await untilParked(composed.handlers, turn.sessionId);

  // Text in a turn, from a connection that would approve anything it is
  // asked, aimed at the parked session.
  const client = eagerClient();
  for (
    const prompt of ["y", "approve", JSON.stringify({
      approvalId: pending!.approvalId,
      decision: "approve",
    })]
  ) {
    const refused = await rpcFailure(composed.handlers, "turn", {
      prompt,
      sessionId: turn.sessionId,
    }, client);
    assert.match(refused.message, /waiting for approval/);
  }
  assert.deepStrictEqual(client.asked, []);
  // The text never reached a runtime, and the approval is still parked.
  assert.deepStrictEqual(calls.prompts, ["do the thing"]);
  const still = (await callRpc(composed.handlers, "approvals/pending", {
    sessionId: turn.sessionId,
  }) as PendingList).approvals;
  assert.deepStrictEqual(still.map((a) => a.approvalId), [
    pending!.approvalId,
  ]);

  await callRpc(composed.handlers, "approvals/answer", {
    sessionId: turn.sessionId,
    approvalId: pending!.approvalId,
    response: { decision: "deny" },
  });
  const receipt = await turn.result as unknown as {
    verdict: { decision: string };
  };
  assert.equal(receipt.verdict.decision, "deny");
});

test("a turn sent while a headless turn runs on its session is refused, not queued behind it", { timeout: 5_000 }, async () => {
  // The headless turn announces its session, then runs a step (held here)
  // before it asks for an approval. A later turn on the same session runs at
  // once and asks nothing.
  let releaseStep!: () => void;
  const step = new Promise<void>((resolve) => releaseStep = resolve);
  const prompts: string[] = [];
  const composed = compose(async (input) => {
    prompts.push(input.prompt);
    const sessionId = input.sessionId ?? input.newSessionId!;
    if (prompts.length > 1) return result({ sessionId });
    await input.frames?.onRuntimeEvent?.({
      type: "sessionStart",
      sessionId,
      traceId: "T1",
      mode: "chat",
    });
    await step;
    const verdict = await input.approver!.confirmToolApproval!(toolRequest);
    return result({ sessionId, verdict });
  });
  const turn = await startHeadless(composed);

  // Nothing is parked yet, but the session is busy: the prompt is refused
  // instead of waiting behind a turn whose approval it would block.
  const refused = await rpcFailure(composed.handlers, "turn", {
    prompt: "hello",
    sessionId: turn.sessionId,
  }, eagerClient());
  assert.match(refused.message, /running a turn the runtime started/);
  assert.match(refused.message, /nothing was sent/);
  assert.deepStrictEqual(prompts, ["do the thing"]);

  releaseStep();
  const [pending] = await untilParked(composed.handlers, turn.sessionId);
  await callRpc(composed.handlers, "approvals/answer", {
    sessionId: turn.sessionId,
    approvalId: pending!.approvalId,
    response: { decision: "approve" },
  });
  await turn.result;

  // Once the headless turn has settled, the session takes turns again.
  await callRpc(composed.handlers, "turn", {
    prompt: "hello again",
    sessionId: turn.sessionId,
  }, eagerClient());
  assert.deepStrictEqual(prompts, ["do the thing", "hello again"]);
});

test("a headless turn resuming a session refuses other turns before it announces the session", { timeout: 5_000 }, async () => {
  // Startup (held here) runs before the turn announces the session it
  // resumes. A turn naming that session in the meantime must not be admitted
  // ahead of the announcement and left queued behind the headless turn.
  let releaseStartup!: () => void;
  const startup = new Promise<void>((resolve) => releaseStartup = resolve);
  const prompts: string[] = [];
  const composed = compose(async (input) => {
    prompts.push(input.prompt);
    const sessionId = input.sessionId ?? input.newSessionId!;
    if (prompts.length > 1) return result({ sessionId });
    await startup;
    await input.frames?.onRuntimeEvent?.({
      type: "sessionStart",
      sessionId,
      traceId: "T1",
      mode: "chat",
    });
    return result({ sessionId });
  });
  const sessionId = "01J9ZQ4W8X6V5T3R2P1N0M9K8H";
  const started = composed.headless.start({ prompt: "resume", sessionId });
  assert.ok(!("error" in started));

  const refused = await rpcFailure(composed.handlers, "turn", {
    prompt: "hello",
    sessionId,
  }, eagerClient());
  assert.match(refused.message, /running a turn the runtime started/);

  releaseStartup();
  await started.result;
  await callRpc(composed.handlers, "turn", { prompt: "after", sessionId }, eagerClient());
  assert.deepStrictEqual(prompts, ["resume", "after"]);
});

test("a parked ACP permission is answered by selecting one of its options", async () => {
  const prompt: AcpPermissionPrompt = {
    sessionId: "acp-1",
    toolCallId: "t1",
    toolCall: {
      title: "Edit a file",
      name: "edit",
      kind: "edit",
      inputSummary: "src/a.ts",
    },
    options: [
      { optionId: "allow", name: "Allow once", kind: "allow_once" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ],
  };
  const composed = compose(async (input) => {
    const sessionId = input.newSessionId!;
    await input.frames?.onRuntimeEvent?.({
      type: "sessionStart",
      sessionId,
      traceId: "T1",
      mode: "chat",
    });
    const selection = await input.approver!.confirmExternalAgentPermission!(
      prompt,
      new AbortController().signal,
    );
    return result({ selection });
  });
  const turn = await startHeadless(composed);
  const [pending] = await untilParked(composed.handlers, turn.sessionId);
  assert.equal(
    (pending!.request as { kind: string }).kind,
    "external_agent_permission",
  );
  await callRpc(composed.handlers, "approvals/answer", {
    sessionId: turn.sessionId,
    approvalId: pending!.approvalId,
    response: { decision: "select", optionId: "allow" },
  });
  const receipt = await turn.result as unknown as { selection: unknown };
  assert.deepStrictEqual(receipt.selection, {
    optionId: "allow",
    source: "operator",
  });
});

test("cancelling a parked headless turn withdraws its approval", async () => {
  const composed = compose(askingRuntime({ prompts: [] }));
  const turn = await startHeadless(composed);
  const [pending] = await untilParked(composed.handlers, turn.sessionId);
  turn.ticket.abort();
  await assert.rejects(turn.result);
  assert.deepStrictEqual(composed.parked.pending(turn.sessionId), []);
  const late = await rpcFailure(composed.handlers, "approvals/answer", {
    sessionId: turn.sessionId,
    approvalId: pending!.approvalId,
    response: { decision: "approve" },
  });
  assert.equal(late.code, RpcErrorCode.invalidParams);
});
