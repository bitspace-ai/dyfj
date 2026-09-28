/**
 * Component tests for the `agentLoop` stage: whole native turns over the
 * engine fakes, where the scripted provider requests tools and the real tool
 * catalog runs them on a temp workspace. Approval-gated tools (`write_file`
 * under the default `strict` posture) give the tests a hook inside a running
 * tool through the `Approver` port — no module is mocked.
 */
import {
  assert,
  assertEquals,
  assertMatch,
  assertObjectMatch,
  assertStringIncludes,
} from "@std/assert";
import { stub } from "@std/testing/mock";
import {
  chatReply,
  conversation,
  type EngineRun,
  engineServices,
  eventRows,
  LOCAL_MODEL,
  patchStore,
  requestBody,
  runTurn,
  systemMessage,
} from "../../testing/builders/engine.ts";
import type { ScriptedExchange } from "../../testing/fakes/scripted-http-transport.ts";
import { AGENT_DEFAULTS } from "../config/mod.ts";
import type { WorkbenchRuntimeEvent } from "../contract/mod.ts";
import type { ModelSeed } from "../store/mod.ts";
import type { ConfirmToolApproval } from "../tools/mod.ts";
import type {
  NativeWorkbenchRuntimeResult,
  WorkbenchRuntimeInput,
} from "./runtime-types.ts";

type ToolCall = { id: string; name: string; arguments: unknown };

function toolReply(calls: ToolCall[], text = ""): ScriptedExchange {
  return chatReply({ content: text, toolCalls: calls });
}

const LIST = (id: string, path = "."): ToolCall => ({
  id,
  name: "list_files",
  arguments: { path },
});
const WRITE = (id: string, path: string): ToolCall => ({
  id,
  name: "write_file",
  arguments: { path, content: "text" },
});

interface LoopRun {
  run: EngineRun;
  frames: WorkbenchRuntimeEvent[];
  result?: NativeWorkbenchRuntimeResult;
  error: unknown;
  root: string;
}

/** Run a turn in a fresh workspace, returning what it produced or threw. */
async function loopTurn(
  exchanges: ScriptedExchange[],
  input: Partial<WorkbenchRuntimeInput> = {},
  patch?: (run: EngineRun) => void,
  models?: ModelSeed[],
): Promise<LoopRun> {
  const root = await Deno.makeTempDir({ prefix: "engine-loop-" });
  await Deno.writeTextFile(`${root}/README.md`, "# readme\n");
  const run = engineServices(exchanges, models ? { models } : {});
  patch?.(run);
  const frames: WorkbenchRuntimeEvent[] = [];
  try {
    const result = await runTurn(run, {
      prompt: "explore",
      rootOverride: root,
      onRuntimeEvent: (event) => void frames.push(event),
      ...input,
    });
    return { run, frames, result, error: null, root };
  } catch (error) {
    return { run, frames, error, root };
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

async function rows(loop: LoopRun) {
  const sessionId = loop.frames.find((f) => f.type === "sessionStart")
    ?.sessionId;
  return await eventRows(loop.run, sessionId!);
}

/** Run with console.log/warn/error stubbed; returns the warn lines. */
async function quietly<T>(
  run: () => Promise<T>,
): Promise<{ value: T; warnings: string[] }> {
  const log = stub(console, "log");
  const warn = stub(console, "warn");
  const error = stub(console, "error");
  try {
    const value = await run();
    return {
      value,
      warnings: warn.calls.map((call) => String(call.args[0])),
    };
  } finally {
    log.restore();
    warn.restore();
    error.restore();
  }
}

// ─── iteration and step limits ───────────────────────────────────────────────

Deno.test("agent loop iterates model<->tools until the model stops requesting tools", async () => {
  const { run, result } = await loopTurn([
    toolReply([LIST("c1")]),
    toolReply([LIST("c2", "src")]),
    chatReply({ content: "done exploring" }),
  ], { prompt: "explore the repo" });
  assertEquals(result?.text, "done exploring");
  // step 0 (initial) + two follow-up gather calls = three model calls
  assertEquals(run.transport.requests.length, 3);
});

Deno.test("agent loop honors a configured small step limit and forces a no-tools conclusion", async () => {
  // The model never stops requesting tools; the loop must bound it.
  const loop = toolReply([LIST("c")], "forced conclusion");
  const { run, frames, result } = await loopTurn([loop, loop, loop], {
    prompt: "loop without stopping",
    maxToolSteps: 2,
  });
  assertEquals(result?.text, "forced conclusion");
  // Step 0 plus one gather call, then one forced no-tools call.
  assertEquals(run.transport.requests.length, 3);
  assertEquals(result?.agent, {
    toolStepsUsed: 2,
    maxToolSteps: 2,
    limitReached: true,
  });
  // The final forced call dropped tools to make the model conclude.
  const last = run.transport.requests.at(-1)!;
  assertEquals(requestBody(last).tools, undefined);
  assertStringIncludes(
    systemMessage(last),
    "Workbench instruction: tool use ended because the configured Workbench tool-step limit was reached.",
  );
  assertEquals(
    conversation(last).filter((m) => m.role === "user").map((m) => m.content),
    ["loop without stopping"],
  );
  // An earlier gather call still offered tools, so the model could continue.
  assert(Array.isArray(requestBody(run.transport.requests[1]).tools));
  const limitAt = frames.findIndex((f) => f.type === "toolStepLimitReached");
  assertObjectMatch(frames[limitAt], {
    type: "toolStepLimitReached",
    maxSteps: 2,
  });
  assertEquals(frames[limitAt + 1].type, "beforeProviderRequest");
});

for (
  const [provided, expected] of [
    [-2, 1],
    [65, 64],
    [1.5, AGENT_DEFAULTS.maxToolSteps],
  ] as const
) {
  Deno.test(`direct maxToolSteps ${provided} resolves to ${expected}`, async () => {
    const { result } = await loopTurn([chatReply({ content: "done" })], {
      prompt: "answer without tools",
      maxToolSteps: provided,
    });
    assertEquals(result?.agent, {
      toolStepsUsed: 0,
      maxToolSteps: expected,
      limitReached: false,
    });
  });
}

Deno.test("agent loop forces a conclusion when the model repeats prior tool calls", async () => {
  const repeat = toolReply([LIST("c")]);
  const { run, frames, result } = await loopTurn([
    repeat, // step 0
    repeat, // step 1 gather — identical call
    chatReply({ content: "done" }),
  ]);
  assertEquals(result?.text, "done");
  assertEquals(result?.agent, {
    toolStepsUsed: 2,
    maxToolSteps: AGENT_DEFAULTS.maxToolSteps,
    limitReached: false,
  });
  // step 0 + one gather + the forced conclusion — not the full step cap
  assertEquals(run.transport.requests.length, 3);
  const forced = run.transport.requests[2];
  assertEquals(requestBody(forced).tools, undefined);
  assertStringIncludes(
    systemMessage(forced),
    "Workbench instruction: tool use ended because the model repeated prior tool calls.",
  );
  assertEquals(frames.some((f) => f.type === "toolStepLimitReached"), false);
});

const CONCLUSION_FAILED =
  "The no-tools conclusion after the tool-step limit could not be completed.";

/** A distinct tool call per step, so the loop runs to the step cap. */
function toolSteps(
  count: number,
  usage = { prompt_tokens: 10, completion_tokens: 2 },
) {
  return Array.from(
    { length: count },
    (_, i) => chatReply({ toolCalls: [LIST(`c-${i}`, `${i}`)], usage }),
  );
}

Deno.test("contains a failed capped conclusion without losing prior-call accounting", async () => {
  const sentinel = "PROVIDER_RESPONSE_BODY_MUST_NOT_SURFACE";
  const loop = await quietly(() =>
    loopTurn([
      ...toolSteps(AGENT_DEFAULTS.maxToolSteps),
      { respond: { status: 500, body: sentinel } },
    ], { prompt: "loop until the limit" })
  );
  const { error, frames } = loop.value;
  assert(error instanceof Error);
  assertEquals(error.message, CONCLUSION_FAILED);
  const calls = (await rows(loop.value)).filter((row) =>
    row.event_type === "provider_call"
  );
  assertEquals(calls.length, AGENT_DEFAULTS.maxToolSteps + 1);
  for (const call of calls.slice(0, AGENT_DEFAULTS.maxToolSteps)) {
    assertObjectMatch(call, { stop_reason: "tool_use", tokens_input: "10" });
  }
  assertObjectMatch(calls.at(-1)!, {
    provider_call_purpose: "forced_conclusion",
    provider_error_class: "ToolStepLimitConclusionError",
    stop_reason: "error",
  });
  assertObjectMatch(frames.find((f) => f.type === "turnFailed")!, {
    errorName: "ToolStepLimitConclusionError",
    errorMessage: CONCLUSION_FAILED,
  });
  assertEquals(JSON.stringify({ calls, frames }).includes(sentinel), false);
});

Deno.test("contains a failed overflow-recovery call after the tool-step limit", async () => {
  const sentinel = "RECOVERY_PROVIDER_BODY_MUST_NOT_SURFACE";
  const loop = await quietly(() =>
    loopTurn(
      [
        ...toolSteps(AGENT_DEFAULTS.maxToolSteps),
        chatReply({
          content: "partial conclusion",
          finishReason: "length",
          usage: { prompt_tokens: 99, completion_tokens: 0 },
        }),
        { respond: { status: 500, body: sentinel } },
      ],
      {
        prompt: "loop until the limit",
        recoverContextOverflow: () =>
          Promise.resolve({
            messages: [{ role: "user", content: "compressed history" }],
          }),
      },
      undefined,
      [{ ...LOCAL_MODEL, context_window: 100 }],
    )
  );
  const { error, frames } = loop.value;
  assert(error instanceof Error);
  assertEquals(error.message, CONCLUSION_FAILED);
  const calls = (await rows(loop.value)).filter((row) =>
    row.event_type === "provider_call"
  );
  assertEquals(calls.length, AGENT_DEFAULTS.maxToolSteps + 2);
  assertObjectMatch(calls.at(-1)!, {
    provider_call_purpose: "recovery",
    provider_error_class: "ToolStepLimitConclusionError",
    stop_reason: "error",
  });
  assertObjectMatch(frames.find((f) => f.type === "turnFailed")!, {
    errorName: "ToolStepLimitConclusionError",
    errorMessage: CONCLUSION_FAILED,
  });
  assertEquals(JSON.stringify({ calls, frames }).includes(sentinel), false);
});

// ─── the provider-call trace ─────────────────────────────────────────────────

Deno.test("persists an ordered provider-call trace with requested tools beneath their provider span", async () => {
  const loop = await loopTurn([
    chatReply({
      toolCalls: [{
        id: "read-1",
        name: "read_file",
        arguments: { path: "README.md" },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    }),
    chatReply({
      content: "complete",
      usage: { prompt_tokens: 14, completion_tokens: 3 },
    }),
  ], { prompt: "read the README" });
  const all = await rows(loop);
  const root = all.find((row) => row.event_type === "session_start")!;
  const calls = all.filter((row) => row.event_type === "provider_call");
  assertEquals(calls.length, 2);
  assertObjectMatch(calls[0], {
    parent_span_id: root.span_id,
    provider_call_order: "1",
    provider_call_purpose: "initial",
    tokens_input: "10",
    tokens_output: "2",
  });
  assertObjectMatch(calls[1], {
    parent_span_id: root.span_id,
    provider_call_order: "2",
    provider_call_purpose: "tool_followup",
    tokens_input: "14",
    tokens_output: "3",
  });
  const toolCall = all.find((row) =>
    row.event_type === "tool_call" && row.tool_call_id === "read-1"
  );
  assertEquals(toolCall?.parent_span_id, calls[0].span_id);
  assert(calls[0].span_id !== root.span_id);
  const selected = all.find((row) => row.event_type === "model_selected");
  assertEquals(selected?.parent_span_id, root.span_id);
  assertObjectMatch(
    all.find((row) => row.event_type === "model_response")!,
    { parent_span_id: root.span_id, tokens_input: "24", tokens_output: "5" },
  );
  const summary = all.find((row) => row.event_type === "budget_summary");
  assertEquals(summary?.parent_span_id, root.span_id);
});

Deno.test("a skipped provider_call span leaves its requested tool attached to the turn root", async () => {
  const { value: loop, warnings } = await quietly(() =>
    loopTurn(
      [
        toolReply([LIST("c1")]),
        chatReply({ content: "complete despite skipped provider spans" }),
      ],
      { prompt: "list the repository" },
      (run) => {
        const store = run.store;
        run.services.store = patchStore(store, {
          journal: {
            commit: (batch, options) =>
              batch.events.some((e) => e.event_type === "provider_call")
                ? Promise.reject(new Error("simulated write failure"))
                : store.journal.commit(batch, options),
          },
        });
      },
    )
  );
  const all = await rows(loop);
  const root = all.find((row) => row.event_type === "session_start")!;
  assertEquals(all.some((row) => row.event_type === "provider_call"), false);
  const toolCall = all.find((row) =>
    row.event_type === "tool_call" && row.tool_call_id === "c1"
  );
  assertEquals(toolCall?.parent_span_id, root.span_id);
  assertObjectMatch(loop.result!, {
    text: "complete despite skipped provider spans",
    tokens: { input: 84, output: 14, totalCalls: 2 },
  });
  assertStringIncludes(loop.result!.receipt, "audit log has gaps");
  assert(warnings.some((line) => line.includes("Event write skipped")));
});

// A tool_call row is best-effort: an INSERT failure (for example an oversized
// tool result the column rejects) must not fail the turn or surface raw
// driver text.
Deno.test("tool_call event write failure does not fail the tool step or turn (best-effort containment)", async () => {
  const { value: loop, warnings } = await quietly(() =>
    loopTurn(
      [
        toolReply([LIST("c1")]),
        chatReply({ content: "done despite event-write failure" }),
      ],
      { prompt: "list the repo" },
      (run) => {
        const store = run.store;
        run.services.store = patchStore(store, {
          journal: {
            commit: (batch, options) =>
              batch.events.some((e) => e.event_type === "tool_call")
                ? Promise.reject(
                  new Error("simulated write failure: tool_call"),
                )
                : store.journal.commit(batch, options),
          },
        });
      },
    )
  );
  // The tool step ran, and the turn concluded normally.
  assertEquals(loop.result?.text, "done despite event-write failure");
  // The skip is on record, by class only: the console line never carries the
  // driver error's message.
  const skipped = warnings.filter((line) =>
    line.includes("Event write skipped")
  );
  assert(skipped.length > 0);
  for (const line of skipped) {
    assertEquals(line.includes("simulated write failure"), false);
    assertStringIncludes(line, "Error");
  }
  // Best-effort never means silent: the receipt carries the skip count.
  assertStringIncludes(loop.result!.receipt, "event write(s) failed");
  assertStringIncludes(loop.result!.receipt, "audit log has gaps");
});

// ─── unparsed tool-call markup ───────────────────────────────────────────────

Deno.test("emits and persists content-free unparsed-markup metadata before completion", async () => {
  const modelText = "<tool_call>\nedit_file\n<tool_call>\nread_file\n";
  const loop = await loopTurn([chatReply({ content: modelText })], {
    prompt: "make the change",
  });
  const warning = loop.frames.find((f) =>
    f.type === "unparsedToolCallMarkupDetected"
  );
  assert(warning?.type === "unparsedToolCallMarkupDetected");
  assertEquals(warning, {
    type: "unparsedToolCallMarkupDetected",
    sessionId: loop.result!.sessionId,
    count: warning.count,
    countIsLowerBound: warning.countIsLowerBound,
  });
  assert(warning.count >= 1);
  assertEquals(
    /edit_file|read_file|<tool_call>/.test(JSON.stringify(warning)),
    false,
  );
  assert(
    loop.frames.indexOf(warning) <
      loop.frames.findIndex((f) => f.type === "turnCompleted"),
  );
  const all = await rows(loop);
  assertEquals(all.some((row) => row.event_type === "tool_call"), false);
  const call = all.find((row) => row.event_type === "provider_call")!;
  assertEquals(call.unparsed_tool_call_count, String(warning.count));
  assertEquals(
    /edit_file|read_file|<tool_call>/.test(JSON.stringify(call)),
    false,
  );
  assertEquals(
    all.find((row) => row.event_type === "model_response")?.content,
    loop.result!.text,
  );
});

Deno.test("fails instead of completing when the unparsed-markup warning cannot be delivered", async () => {
  const seen: string[] = [];
  const loop = await quietly(() =>
    loopTurn([chatReply({ content: "<tool_call><tool_call>" })], {
      prompt: "make the change",
      onRuntimeEvent: (event) => {
        seen.push(event.type);
        if (event.type === "unparsedToolCallMarkupDetected") {
          throw new Error("client disconnected");
        }
      },
    })
  );
  assert(loop.value.error instanceof Error);
  assertEquals(loop.value.error.message, "client disconnected");
  assert(seen.includes("turnFailed"));
  assertEquals(seen.includes("turnCompleted"), false);
});

// ─── provider and tool failures ──────────────────────────────────────────────

Deno.test("records a content-free provider-call failure with a safe classification", async () => {
  const body = "provider-controlled response body must not persist";
  const loop = await quietly(() =>
    loopTurn([{ respond: { status: 500, body } }], { prompt: "fail safely" })
  );
  assert(loop.value.error instanceof Error);
  const call = (await rows(loop.value)).find((row) =>
    row.event_type === "provider_call"
  );
  assertObjectMatch(call!, {
    provider_call_order: "1",
    provider_call_purpose: "initial",
    stop_reason: "error",
  });
  assert((call?.provider_error_class ?? "") !== "");
  assertEquals(JSON.stringify(call).includes(body), false);
});

Deno.test("a denied tool call's reason reaches the model verbatim on the next step, marked as an error", async () => {
  const loop = await loopTurn([
    toolReply([{ id: "bad-1", name: "read_file", arguments: {} }]),
    chatReply({ content: "recovered" }),
  ], { prompt: "read the friction log" });
  // The next call's transcript carries the denial as a tool message: the
  // full corrective text, linked to the failed call.
  const toolMessage = conversation(loop.run.transport.requests[1]).find((m) =>
    m.role === "tool"
  );
  assert(toolMessage !== undefined);
  assertEquals(toolMessage.tool_call_id, "bad-1");
  assertStringIncludes(
    toolMessage.content,
    "invalid arguments for read_file: missing required argument: path",
  );
  assertStringIncludes(
    toolMessage.content,
    "Call read_file again with arguments matching the expected shape.",
  );
  const event = (await rows(loop)).find((row) =>
    row.event_type === "tool_call" && row.tool_call_id === "bad-1"
  );
  assertEquals(event?.tool_is_error, "1");
});

Deno.test("a tool call that throws sanitizes toolCallCompleted's errorMessage", async () => {
  const hugePayload = "SELECT ".repeat(20_000);
  const loop = await quietly(() =>
    loopTurn([toolReply([WRITE("c1", "note.txt")])], {
      prompt: "write a note",
      confirmToolApproval: () => Promise.reject(new Error(hugePayload)),
    })
  );
  assert(loop.value.error instanceof Error);
  const completed = loop.value.frames.find((f) =>
    f.type === "toolCallCompleted" && f.isError
  );
  assert(completed?.type === "toolCallCompleted");
  const message = String(completed.errorMessage);
  assertEquals(message.includes(hugePayload), false);
  assertStringIncludes(message, "Error");
  assertStringIncludes(
    message,
    `${new TextEncoder().encode(hugePayload).byteLength} bytes`,
  );
});

// ─── cancellation inside a tool step ─────────────────────────────────────────

Deno.test("an abort during a running tool lets it settle and starts no queued tool", async () => {
  const abortController = new AbortController();
  let markToolStarted!: () => void;
  const toolStarted = new Promise<void>((resolve) => markToolStarted = resolve);
  let releaseTool!: () => void;
  const toolReleased = new Promise<void>((resolve) => releaseTool = resolve);
  const approvals: string[] = [];
  const confirmToolApproval: ConfirmToolApproval = async (request) => {
    approvals.push(request.callId);
    abortController.abort();
    markToolStarted();
    await toolReleased;
    return { decision: "deny", reason: "cancelled" };
  };
  let turnSettled = false;
  const pending = loopTurn([
    toolReply([WRITE("c1", "a.txt"), WRITE("c2", "b.txt")]),
  ], {
    prompt: "inspect",
    abortSignal: abortController.signal,
    confirmToolApproval,
    onRuntimeEvent: (event) => {
      if (event.type === "toolCallStarted") throw new Error("observer failed");
    },
  });
  void pending.finally(() => turnSettled = true);
  await toolStarted;
  await Promise.resolve();
  assertEquals(turnSettled, false);
  releaseTool();
  const { result, run } = await quietly(() => pending).then((r) => r.value);
  assertEquals(result?.stopReason, "aborted");
  assertEquals(approvals, ["c1"]);
  assertEquals(run.transport.requests.length, 1);
});

Deno.test("an approval cancellation does not report a tool failure", async () => {
  const abortController = new AbortController();
  const turnId = "123e4567-e89b-42d3-a456-426614174000";
  const { result, frames } = await loopTurn([
    toolReply([WRITE("c1", "note.txt")]),
  ], {
    prompt: "write a note",
    turnId,
    abortSignal: abortController.signal,
    confirmToolApproval: () => {
      abortController.abort();
      throw abortController.signal.reason;
    },
  });
  assertEquals(result?.stopReason, "aborted");
  assertEquals(frames.some((f) => f.type === "toolCallCompleted"), false);
  assert(
    frames.some((f) =>
      f.type === "turnAborted" && f.turnId === turnId &&
      f.sessionId === result?.sessionId && f.traceId === result?.traceId
    ),
  );
});

Deno.test("tool invocation crosses the boundary in the same turn that start-event emission begins", async () => {
  const abortController = new AbortController();
  let markStartEmission!: () => void;
  const startEmission = new Promise<void>((resolve) =>
    markStartEmission = resolve
  );
  let releaseStartEvent!: () => void;
  const startEventReleased = new Promise<void>((resolve) =>
    releaseStartEvent = resolve
  );
  const approvals: string[] = [];
  const pending = loopTurn([
    toolReply([WRITE("c1", "a.txt"), WRITE("c2", "b.txt")]),
  ], {
    prompt: "inspect",
    abortSignal: abortController.signal,
    confirmToolApproval: (request) => {
      approvals.push(request.callId);
      return Promise.resolve({ decision: "deny", reason: "not now" });
    },
    onRuntimeEvent: (event) => {
      if (event.type !== "toolCallStarted") return;
      markStartEmission();
      return startEventReleased;
    },
  });
  await startEmission;
  // The first call's invocation started in the same event-loop turn as its
  // start frame, so its approval was already requested.
  assertEquals(approvals, ["c1"]);
  abortController.abort();
  releaseStartEvent();
  const { result } = await pending;
  assertEquals(result?.stopReason, "aborted");
  assertEquals(approvals, ["c1"]);
});

// ─── transcript shape ────────────────────────────────────────────────────────

Deno.test("each step replays the assistant's tool-call turn and its linked results", async () => {
  const loop = await loopTurn([
    toolReply([LIST("c1"), {
      id: "r1",
      name: "read_file",
      arguments: { path: "README.md" },
    }], "looking"),
    chatReply({ content: "done" }),
  ]);
  const followUp = conversation(loop.run.transport.requests[1]);
  const assistant = followUp.find((m) => m.role === "assistant");
  assert(assistant !== undefined);
  assertEquals(assistant.content, "looking");
  assertEquals(assistant.tool_calls?.length, 2);
  const tools = followUp.filter((m) => m.role === "tool");
  assertEquals(tools.map((m) => m.tool_call_id), ["c1", "r1"]);
  assertMatch(tools[1].content, /# readme/);
});
