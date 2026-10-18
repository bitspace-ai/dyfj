/**
 * Component tests for the `agentLoop` stage: whole native turns over the
 * engine fakes, where the scripted provider requests tools and the real tool
 * catalog runs them on a temp workspace. Approval-gated tools (`write_file`
 * under the default `strict` posture) give the tests a hook inside a running
 * tool through the `Approver` port — no module is mocked.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, mock, test } from "node:test";
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
import {
  SONNET_55_FINAL,
  SONNET_55_STEP_1,
  SONNET_55_STEP_2,
} from "../../testing/fixtures/anthropic-thinking.ts";
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
  const root = await mkdtemp(join(tmpdir(), "engine-loop-"));
  await writeFile(`${root}/README.md`, "# readme\n");
  const run = engineServices(exchanges, models ? { models } : {});
  patch?.(run);
  const frames: WorkbenchRuntimeEvent[] = [];
  try {
    const result = await runTurn(run, {
      prompt: "explore",
      rootOverride: root,
      ...input,
      frames: {
        onRuntimeEvent: (event) => void frames.push(event),
        ...input.frames,
      },
    });
    return { run, frames, result, error: null, root };
  } catch (error) {
    return { run, frames, error, root };
  } finally {
    await rm(root, { recursive: true });
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
  const log = mock.method(console, "log", () => {});
  const warn = mock.method(console, "warn", () => {});
  const error = mock.method(console, "error", () => {});
  try {
    const value = await run();
    return {
      value,
      warnings: warn.mock.calls.map((call) => String(call.arguments[0])),
    };
  } finally {
    log.mock.restore();
    warn.mock.restore();
    error.mock.restore();
  }
}

// ─── iteration and step limits ───────────────────────────────────────────────

test("agent loop iterates model<->tools until the model stops requesting tools", async () => {
  const { run, result } = await loopTurn([
    toolReply([LIST("c1")]),
    toolReply([LIST("c2", "src")]),
    chatReply({ content: "done exploring" }),
  ], { prompt: "explore the repo" });
  assert.deepStrictEqual(result?.text, "done exploring");
  // step 0 (initial) + two follow-up gather calls = three model calls
  assert.deepStrictEqual(run.transport.requests.length, 3);
});

test("agent loop honors a configured small step limit and forces a no-tools conclusion", async () => {
  // The model never stops requesting tools; the loop must bound it.
  const loop = toolReply([LIST("c")], "forced conclusion");
  const { run, frames, result } = await loopTurn([loop, loop, loop], {
    prompt: "loop without stopping",
    maxToolSteps: 2,
  });
  assert.deepStrictEqual(result?.text, "forced conclusion");
  // Step 0 plus one gather call, then one forced no-tools call.
  assert.deepStrictEqual(run.transport.requests.length, 3);
  assert.deepStrictEqual(result?.agent, {
    toolStepsUsed: 2,
    maxToolSteps: 2,
    limitReached: true,
  });
  // The final forced call dropped tools to make the model conclude.
  const last = run.transport.requests.at(-1)!;
  assert.deepStrictEqual(requestBody(last).tools, undefined);
  assert.ok(
    systemMessage(last).includes(
      "Workbench instruction: tool use ended because the configured Workbench tool-step limit was reached.",
    ),
    `expected systemMessage(last) to include "Workbench instruction: tool use ended because the configured Workbench tool-step limit was reached."`,
  );
  assert.deepStrictEqual(
    conversation(last).filter((m) => m.role === "user").map((m) => m.content),
    ["loop without stopping"],
  );
  // An earlier gather call still offered tools, so the model could continue.
  assert.ok(Array.isArray(requestBody(run.transport.requests[1]).tools));
  const limitAt = frames.findIndex((f) => f.type === "toolStepLimitReached");
  assert.partialDeepStrictEqual(frames[limitAt], {
    type: "toolStepLimitReached",
    maxSteps: 2,
  });
  assert.deepStrictEqual(frames[limitAt + 1].type, "beforeProviderRequest");
});

for (
  const [provided, expected] of [
    [-2, 1],
    [65, 64],
    [1.5, AGENT_DEFAULTS.maxToolSteps],
  ] as const
) {
  test(`direct maxToolSteps ${provided} resolves to ${expected}`, async () => {
    const { result } = await loopTurn([chatReply({ content: "done" })], {
      prompt: "answer without tools",
      maxToolSteps: provided,
    });
    assert.deepStrictEqual(result?.agent, {
      toolStepsUsed: 0,
      maxToolSteps: expected,
      limitReached: false,
    });
  });
}

test("agent loop forces a conclusion when the model repeats prior tool calls", async () => {
  const repeat = toolReply([LIST("c")]);
  const { run, frames, result } = await loopTurn([
    repeat, // step 0
    repeat, // step 1 gather — identical call
    chatReply({ content: "done" }),
  ]);
  assert.deepStrictEqual(result?.text, "done");
  assert.deepStrictEqual(result?.agent, {
    toolStepsUsed: 2,
    maxToolSteps: AGENT_DEFAULTS.maxToolSteps,
    limitReached: false,
  });
  // step 0 + one gather + the forced conclusion — not the full step cap
  assert.deepStrictEqual(run.transport.requests.length, 3);
  const forced = run.transport.requests[2];
  assert.deepStrictEqual(requestBody(forced).tools, undefined);
  assert.ok(
    systemMessage(forced).includes(
      "Workbench instruction: tool use ended because the model repeated prior tool calls.",
    ),
    `expected systemMessage(forced) to include "Workbench instruction: tool use ended because the model repeated prior tool calls."`,
  );
  assert.deepStrictEqual(
    frames.some((f) => f.type === "toolStepLimitReached"),
    false,
  );
});

// ─── a denied approval ends tool use for the turn ────────────────────────────

/**
 * A model that behaves as a real one would: while tools are offered it asks
 * for another `write_file` (a variant of the refused call), and once none are
 * offered it answers in text.
 */
function variantSeeking(): ScriptedExchange {
  return {
    respond: (request) => {
      const reply = requestBody(request).tools !== undefined
        ? toolReply([WRITE("c2", "b.txt")])
        : chatReply({ content: "Understood; I will ask you instead." });
      return new Response((reply.respond as { body: string }).body, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
}

describe("a denied approval", () => {
  it("reaches the model as a refusal and ends tool use for the turn", async () => {
    const approvals: string[] = [];
    const loop = await loopTurn([
      toolReply([WRITE("c1", "a.txt")]),
      variantSeeking(),
      variantSeeking(),
      variantSeeking(),
    ], {
      prompt: "write a file",
      approver: {
        confirmToolApproval: (request) => {
          approvals.push(request.callId);
          return Promise.resolve({
            decision: "deny",
            reason: "operator declined",
          });
        },
      },
    });
    assert.strictEqual(loop.error, null);
    // One approval was raised, the denial ended tool use, and the model was
    // asked once more, with no tools: two provider requests in all.
    assert.deepStrictEqual(approvals, ["c1"]);
    assert.deepStrictEqual(loop.run.transport.requests.length, 2);
    const concluding = loop.run.transport.requests[1];
    assert.deepStrictEqual(requestBody(concluding).tools, undefined);
    assert.ok(
      systemMessage(concluding).includes(
        "Workbench instruction: tool use ended because a tool call was not approved.",
      ),
      `expected systemMessage(concluding) to include "Workbench instruction: tool use ended because a tool call was not approved."`,
    );
    // The tool message is a refusal the model cannot mistake for output.
    const toolMessage = conversation(concluding).find((m) => m.role === "tool");
    assert.match(
      toolMessage?.content ?? "",
      /^approval_denied: this write_file call was not approved, so it did not run; this is not its output\. /,
    );
    assert.ok(
      (toolMessage?.content ?? "").includes("Reason given: operator declined"),
      `expected toolMessage?.content ?? "" to include "Reason given: operator declined"`,
    );
    // The frame carries the verdict; the stop reason is the ordinary one.
    const completed = loop.frames.filter((f) => f.type === "toolCallCompleted");
    assert.deepStrictEqual(completed.length, 1);
    assert.partialDeepStrictEqual(completed[0], {
      isError: true,
      verdict: "approval_denied",
    });
    assert.deepStrictEqual(loop.result?.stopReason, "stop");
    // The durable event holds the refusal, not stdout. Its `action` and
    // `authz_basis` columns (golden scenario 13) are unchanged.
    const toolRow = (await rows(loop)).find((row) =>
      row.event_type === "tool_call"
    );
    assert.partialDeepStrictEqual(toolRow!, {
      tool_name: "write_file",
      tool_is_error: "1",
    });
    assert.match(String(toolRow!.tool_result), /^approval_denied: /);
    assert.match(
      String(toolRow!.content),
      /^write_file denied: approval_denied: /,
    );
  });
});

describe("after a denied approval", () => {
  it("a no-tools conclusion that still asks for a tool call runs nothing and raises no approval", async () => {
    const approvals: string[] = [];
    const loop = await loopTurn([
      toolReply([WRITE("c1", "a.txt")]),
      // The model ignores the instruction and asks for another call anyway.
      toolReply([WRITE("c2", "b.txt")], "I will try again."),
      chatReply({ content: "unused: the loop must not ask a third time" }),
    ], {
      prompt: "write a file",
      approver: {
        confirmToolApproval: (request) => {
          approvals.push(request.callId);
          return Promise.resolve({
            decision: "deny",
            reason: "operator declined",
          });
        },
      },
    });
    assert.strictEqual(loop.error, null);
    assert.deepStrictEqual(approvals, ["c1"]);
    assert.deepStrictEqual(loop.run.transport.requests.length, 2);
    assert.deepStrictEqual(
      loop.frames.filter((f) => f.type === "toolCallCompleted").length,
      1,
    );
    assert.deepStrictEqual(loop.result?.stopReason, "stop");
    assert.deepStrictEqual(loop.result?.text, "I will try again.");
  });
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

test("contains a failed capped conclusion without losing prior-call accounting", async () => {
  const sentinel = "PROVIDER_RESPONSE_BODY_MUST_NOT_SURFACE";
  const loop = await quietly(() =>
    loopTurn([
      ...toolSteps(AGENT_DEFAULTS.maxToolSteps),
      { respond: { status: 500, body: sentinel } },
    ], { prompt: "loop until the limit" })
  );
  const { error, frames } = loop.value;
  assert.ok(error instanceof Error);
  assert.deepStrictEqual(error.message, CONCLUSION_FAILED);
  const calls = (await rows(loop.value)).filter((row) =>
    row.event_type === "provider_call"
  );
  assert.deepStrictEqual(calls.length, AGENT_DEFAULTS.maxToolSteps + 1);
  for (const call of calls.slice(0, AGENT_DEFAULTS.maxToolSteps)) {
    assert.partialDeepStrictEqual(call, {
      stop_reason: "tool_use",
      tokens_input: "10",
    });
  }
  assert.partialDeepStrictEqual(calls.at(-1)!, {
    provider_call_purpose: "forced_conclusion",
    provider_error_class: "ToolStepLimitConclusionError",
    stop_reason: "error",
  });
  assert.partialDeepStrictEqual(frames.find((f) => f.type === "turnFailed")!, {
    errorName: "ToolStepLimitConclusionError",
    errorMessage: CONCLUSION_FAILED,
  });
  assert.deepStrictEqual(
    JSON.stringify({ calls, frames }).includes(sentinel),
    false,
  );
});

test("contains a failed overflow-recovery call after the tool-step limit", async () => {
  const sentinel = "RECOVERY_PROVIDER_BODY_MUST_NOT_SURFACE";
  const loop = await quietly(() =>
    loopTurn(
      [
        ...toolSteps(AGENT_DEFAULTS.maxToolSteps),
        chatReply({
          content: "partial conclusion",
          finishReason: "length",
          usage: { prompt_tokens: 9_900, completion_tokens: 0 },
        }),
        { respond: { status: 500, body: sentinel } },
      ],
      { prompt: "loop until the limit" },
      (run) => {
        run.services.recoverContextOverflow = () =>
          Promise.resolve({
            messages: [{ role: "user", content: "compressed history" }],
          });
      },
      [{ ...LOCAL_MODEL, context_window: 10_000 }],
    )
  );
  const { error, frames } = loop.value;
  assert.ok(error instanceof Error);
  assert.deepStrictEqual(error.message, CONCLUSION_FAILED);
  const calls = (await rows(loop.value)).filter((row) =>
    row.event_type === "provider_call"
  );
  assert.deepStrictEqual(calls.length, AGENT_DEFAULTS.maxToolSteps + 2);
  assert.partialDeepStrictEqual(calls.at(-1)!, {
    provider_call_purpose: "recovery",
    provider_error_class: "ToolStepLimitConclusionError",
    stop_reason: "error",
  });
  assert.partialDeepStrictEqual(frames.find((f) => f.type === "turnFailed")!, {
    errorName: "ToolStepLimitConclusionError",
    errorMessage: CONCLUSION_FAILED,
  });
  assert.deepStrictEqual(
    JSON.stringify({ calls, frames }).includes(sentinel),
    false,
  );
});

// ─── the provider-call trace ─────────────────────────────────────────────────

test("persists an ordered provider-call trace with requested tools beneath their provider span", async () => {
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
  assert.deepStrictEqual(calls.length, 2);
  assert.partialDeepStrictEqual(calls[0], {
    parent_span_id: root.span_id,
    provider_call_order: "1",
    provider_call_purpose: "initial",
    tokens_input: "10",
    tokens_output: "2",
  });
  assert.partialDeepStrictEqual(calls[1], {
    parent_span_id: root.span_id,
    provider_call_order: "2",
    provider_call_purpose: "tool_followup",
    tokens_input: "14",
    tokens_output: "3",
  });
  const toolCall = all.find((row) =>
    row.event_type === "tool_call" && row.tool_call_id === "read-1"
  );
  assert.deepStrictEqual(toolCall?.parent_span_id, calls[0].span_id);
  assert.ok(calls[0].span_id !== root.span_id);
  const selected = all.find((row) => row.event_type === "model_selected");
  assert.deepStrictEqual(selected?.parent_span_id, root.span_id);
  assert.partialDeepStrictEqual(
    all.find((row) => row.event_type === "model_response")!,
    { parent_span_id: root.span_id, tokens_input: "24", tokens_output: "5" },
  );
  const summary = all.find((row) => row.event_type === "budget_summary");
  assert.deepStrictEqual(summary?.parent_span_id, root.span_id);
});

test("a skipped provider_call span leaves its requested tool attached to the turn root", async () => {
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
  assert.deepStrictEqual(
    all.some((row) => row.event_type === "provider_call"),
    false,
  );
  const toolCall = all.find((row) =>
    row.event_type === "tool_call" && row.tool_call_id === "c1"
  );
  assert.deepStrictEqual(toolCall?.parent_span_id, root.span_id);
  assert.partialDeepStrictEqual(loop.result!, {
    text: "complete despite skipped provider spans",
    tokens: { input: 84, output: 14, totalCalls: 2 },
  });
  assert.ok(
    loop.result!.receipt.includes("audit log has gaps"),
    `expected loop.result!.receipt to include "audit log has gaps"`,
  );
  assert.ok(warnings.some((line) => line.includes("Event write skipped")));
});

// A tool_call row is best-effort: an INSERT failure (for example an oversized
// tool result the column rejects) must not fail the turn or surface raw
// driver text.
test("tool_call event write failure does not fail the tool step or turn (best-effort containment)", async () => {
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
  assert.deepStrictEqual(loop.result?.text, "done despite event-write failure");
  // The skip is on record, by class only: the console line never carries the
  // driver error's message.
  const skipped = warnings.filter((line) =>
    line.includes("Event write skipped")
  );
  assert.ok(skipped.length > 0);
  for (const line of skipped) {
    assert.deepStrictEqual(line.includes("simulated write failure"), false);
    assert.ok(
      line.includes("Error"),
      `expected ${JSON.stringify(line)} to include "Error"`,
    );
  }
  // Best-effort never means silent: the receipt carries the skip count.
  assert.ok(
    loop.result!.receipt.includes("event write(s) failed"),
    `expected loop.result!.receipt to include "event write(s) failed"`,
  );
  assert.ok(
    loop.result!.receipt.includes("audit log has gaps"),
    `expected loop.result!.receipt to include "audit log has gaps"`,
  );
});

// ─── unparsed tool-call markup ───────────────────────────────────────────────

test("emits and persists content-free unparsed-markup metadata before completion", async () => {
  const modelText = "<tool_call>\nedit_file\n<tool_call>\nread_file\n";
  const loop = await loopTurn([chatReply({ content: modelText })], {
    prompt: "make the change",
  });
  const warning = loop.frames.find((f) =>
    f.type === "unparsedToolCallMarkupDetected"
  );
  assert.ok(warning?.type === "unparsedToolCallMarkupDetected");
  assert.deepStrictEqual(warning, {
    type: "unparsedToolCallMarkupDetected",
    sessionId: loop.result!.sessionId,
    count: warning.count,
    countIsLowerBound: warning.countIsLowerBound,
  });
  assert.ok(warning.count >= 1);
  assert.deepStrictEqual(
    /edit_file|read_file|<tool_call>/.test(JSON.stringify(warning)),
    false,
  );
  assert.ok(
    loop.frames.indexOf(warning) <
      loop.frames.findIndex((f) => f.type === "turnCompleted"),
  );
  const all = await rows(loop);
  assert.deepStrictEqual(
    all.some((row) => row.event_type === "tool_call"),
    false,
  );
  const call = all.find((row) => row.event_type === "provider_call")!;
  assert.deepStrictEqual(call.unparsed_tool_call_count, String(warning.count));
  assert.deepStrictEqual(
    /edit_file|read_file|<tool_call>/.test(JSON.stringify(call)),
    false,
  );
  assert.deepStrictEqual(
    all.find((row) => row.event_type === "model_response")?.content,
    loop.result!.text,
  );
});

test("flags a complete textual tool call the forced conclusion cannot run", async () => {
  // Stored reply from a local-model turn (BIT-564): after a repeated call the
  // loop forced a conclusion, which offers no tools, and the model answered
  // with a complete textual call that nothing ran or flagged.
  const block = "<tool_call>\n<function=read_file>\n" +
    "<parameter=path>\nREADME.md\n</parameter>\n</function>\n</tool_call>";
  const repeat = toolReply([LIST("c")]);
  const loop = await loopTurn([repeat, repeat, chatReply({ content: block })]);
  assert.deepStrictEqual(
    requestBody(loop.run.transport.requests[2]).tools,
    undefined,
  );
  assert.deepStrictEqual(loop.result?.text, block);
  const warning = loop.frames.find((f) =>
    f.type === "unparsedToolCallMarkupDetected"
  );
  assert.deepStrictEqual(warning, {
    type: "unparsedToolCallMarkupDetected",
    sessionId: loop.result!.sessionId,
    count: 1,
    countIsLowerBound: false,
  });
  assert.ok(
    loop.frames.indexOf(warning!) <
      loop.frames.findIndex((f) => f.type === "turnCompleted"),
  );
  const forced = (await rows(loop)).find((row) =>
    row.event_type === "provider_call" &&
    row.provider_call_purpose === "forced_conclusion"
  );
  assert.partialDeepStrictEqual(forced!, { unparsed_tool_call_count: "1" });
});

test("fails instead of completing when the unparsed-markup warning cannot be delivered", async () => {
  const seen: string[] = [];
  const loop = await quietly(() =>
    loopTurn([chatReply({ content: "<tool_call><tool_call>" })], {
      prompt: "make the change",
      frames: {
        onRuntimeEvent: (event) => {
          seen.push(event.type);
          if (event.type === "unparsedToolCallMarkupDetected") {
            throw new Error("client disconnected");
          }
        },
      },
    })
  );
  assert.ok(loop.value.error instanceof Error);
  assert.deepStrictEqual(loop.value.error.message, "client disconnected");
  assert.ok(seen.includes("turnFailed"));
  assert.deepStrictEqual(seen.includes("turnCompleted"), false);
});

// ─── provider and tool failures ──────────────────────────────────────────────

test("records a content-free provider-call failure with a safe classification", async () => {
  const body = "provider-controlled response body must not persist";
  const loop = await quietly(() =>
    loopTurn([{ respond: { status: 500, body } }], { prompt: "fail safely" })
  );
  assert.ok(loop.value.error instanceof Error);
  const call = (await rows(loop.value)).find((row) =>
    row.event_type === "provider_call"
  );
  assert.partialDeepStrictEqual(call!, {
    provider_call_order: "1",
    provider_call_purpose: "initial",
    stop_reason: "error",
  });
  assert.ok((call?.provider_error_class ?? "") !== "");
  assert.deepStrictEqual(JSON.stringify(call).includes(body), false);
});

test("a denied tool call's reason reaches the model verbatim on the next step, marked as an error", async () => {
  const loop = await loopTurn([
    toolReply([{ id: "bad-1", name: "read_file", arguments: {} }]),
    chatReply({ content: "recovered" }),
  ], { prompt: "read the friction log" });
  // The next call's transcript carries the denial as a tool message: the
  // full corrective text, linked to the failed call.
  const toolMessage = conversation(loop.run.transport.requests[1]).find((m) =>
    m.role === "tool"
  );
  assert.ok(toolMessage !== undefined);
  assert.deepStrictEqual(toolMessage.tool_call_id, "bad-1");
  assert.ok(
    toolMessage.content.includes(
      "invalid arguments for read_file: missing required argument: path",
    ),
    `expected toolMessage.content to include "invalid arguments for read_file: missing required argument: path"`,
  );
  assert.ok(
    toolMessage.content.includes(
      "Call read_file again with arguments matching the expected shape.",
    ),
    `expected toolMessage.content to include "Call read_file again with arguments matching the expected shape."`,
  );
  const event = (await rows(loop)).find((row) =>
    row.event_type === "tool_call" && row.tool_call_id === "bad-1"
  );
  assert.deepStrictEqual(event?.tool_is_error, "1");
});

test("a tool call that throws sanitizes toolCallCompleted's errorMessage", async () => {
  const hugePayload = "SELECT ".repeat(20_000);
  const loop = await quietly(() =>
    loopTurn([toolReply([WRITE("c1", "note.txt")])], {
      prompt: "write a note",
      approver: {
        confirmToolApproval: () => Promise.reject(new Error(hugePayload)),
      },
    })
  );
  assert.ok(loop.value.error instanceof Error);
  const completed = loop.value.frames.find((f) =>
    f.type === "toolCallCompleted" && f.isError
  );
  assert.ok(completed?.type === "toolCallCompleted");
  const message = String(completed.errorMessage);
  assert.deepStrictEqual(message.includes(hugePayload), false);
  assert.ok(
    message.includes("Error"),
    `expected ${JSON.stringify(message)} to include "Error"`,
  );
  assert.ok(
    message.includes(
      `${new TextEncoder().encode(hugePayload).byteLength} bytes`,
    ),
    `expected ${
      JSON.stringify(message)
    } to include \`\${new TextEncoder().encode(hugePayload).byteLength} bytes\``,
  );
});

// ─── cancellation inside a tool step ─────────────────────────────────────────

test("an abort during a running tool lets it settle and starts no queued tool", async () => {
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
    approver: {
      confirmToolApproval,
    },
    frames: {
      onRuntimeEvent: (event) => {
        if (event.type === "toolCallStarted") {
          throw new Error("observer failed");
        }
      },
    },
  });
  void pending.finally(() => turnSettled = true);
  await toolStarted;
  await Promise.resolve();
  assert.deepStrictEqual(turnSettled, false);
  releaseTool();
  const { result, run } = await quietly(() => pending).then((r) => r.value);
  assert.deepStrictEqual(result?.stopReason, "aborted");
  assert.deepStrictEqual(approvals, ["c1"]);
  assert.deepStrictEqual(run.transport.requests.length, 1);
});

test("an approval cancellation does not report a tool failure", async () => {
  const abortController = new AbortController();
  const turnId = "123e4567-e89b-42d3-a456-426614174000";
  const { result, frames } = await loopTurn([
    toolReply([WRITE("c1", "note.txt")]),
  ], {
    prompt: "write a note",
    turnId,
    abortSignal: abortController.signal,
    approver: {
      confirmToolApproval: () => {
        abortController.abort();
        throw abortController.signal.reason;
      },
    },
  });
  assert.deepStrictEqual(result?.stopReason, "aborted");
  assert.deepStrictEqual(
    frames.some((f) => f.type === "toolCallCompleted"),
    false,
  );
  assert.ok(
    frames.some((f) =>
      f.type === "turnAborted" && f.turnId === turnId &&
      f.sessionId === result?.sessionId && f.traceId === result?.traceId
    ),
  );
});

test("tool invocation crosses the boundary in the same turn that start-event emission begins", async () => {
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
    approver: {
      confirmToolApproval: (request) => {
        approvals.push(request.callId);
        return Promise.resolve({ decision: "deny", reason: "not now" });
      },
    },
    frames: {
      onRuntimeEvent: (event) => {
        if (event.type !== "toolCallStarted") return;
        markStartEmission();
        return startEventReleased;
      },
    },
  });
  await startEmission;
  // The first call's invocation started in the same event-loop turn as its
  // start frame, so its approval was already requested.
  assert.deepStrictEqual(approvals, ["c1"]);
  abortController.abort();
  releaseStartEvent();
  const { result } = await pending;
  assert.deepStrictEqual(result?.stopReason, "aborted");
  assert.deepStrictEqual(approvals, ["c1"]);
});

// ─── transcript shape ────────────────────────────────────────────────────────

test("each step replays the assistant's tool-call turn and its linked results", async () => {
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
  assert.ok(assistant !== undefined);
  assert.deepStrictEqual(assistant.content, "looking");
  assert.deepStrictEqual(assistant.tool_calls?.length, 2);
  const tools = followUp.filter((m) => m.role === "tool");
  assert.deepStrictEqual(tools.map((m) => m.tool_call_id), ["c1", "r1"]);
  assert.match(tools[1].content, /# readme/);
});

// ─── thinking replay (Anthropic) ─────────────────────────────────────────────

const SONNET_55: ModelSeed = {
  slug: "claude-sonnet-5-5",
  display_name: "Claude Sonnet 5.5",
  provider: "anthropic",
  api: "anthropic-messages",
  base_url: "https://api.anthropic.com",
  tier: 1,
  context_window: 1_000_000,
  max_output_tokens: 128_000,
  cost_input: 2,
  cost_output: 10,
  capabilities: ["text", "tools", "thinking", "thinking-progress-updates"],
};

const anthropicJson = (body: unknown): ScriptedExchange => ({
  respond: { body: JSON.stringify(body) },
});

describe("a two-tool-step Claude Sonnet 5.5 turn", () => {
  async function sonnetTurn() {
    const deltas: string[] = [];
    const loop = await loopTurn(
      [
        anthropicJson(SONNET_55_STEP_1),
        anthropicJson(SONNET_55_STEP_2),
        anthropicJson(SONNET_55_FINAL),
      ],
      {
        prompt: "first heading?",
        defaultCompanionModel: SONNET_55.slug,
        approver: {
          confirmPaidEscalation: () =>
            Promise.resolve({ decision: "approve" as const }),
        },
        frames: { onTextDelta: (delta) => void deltas.push(delta) },
      },
      (run) => run.env.set("ANTHROPIC_API_KEY", "test-key-not-real"),
      [SONNET_55],
    );
    assert.equal(loop.error, null);
    return { loop, deltas };
  }

  it("replays each step's thinking blocks unchanged on the next request", async () => {
    const { loop } = await sonnetTurn();
    const requests = loop.run.transport.requests.map((r) =>
      JSON.parse(r.body)
    );
    assert.equal(requests.length, 3);
    const assistant = (body: { messages: { role: string }[] }) =>
      body.messages.filter((m) => m.role === "assistant");
    assert.deepStrictEqual(assistant(requests[1]), [
      { role: "assistant", content: SONNET_55_STEP_1.content },
    ]);
    assert.deepStrictEqual(assistant(requests[2]), [
      { role: "assistant", content: SONNET_55_STEP_1.content },
      { role: "assistant", content: SONNET_55_STEP_2.content },
    ]);
    assert.equal(loop.result?.text, "The first heading is readme.");
  });

  it("shows the operator the narration between tool calls, then the reply", async () => {
    // A client that saw text frames does not print the buffered reply from
    // the result, so once narration has gone out the reply goes out too.
    const { deltas } = await sonnetTurn();
    assert.equal(
      deltas.join(""),
      "I'll start with the directory.\n\n" +
        "Listing the budget directory to find its modules.\n\n" +
        "Found README.md. Reading it for the first heading.\n\n" +
        "The first heading is readme.",
    );
  });

  it("does not repeat the narration when the turn is cancelled before its tools run", async () => {
    const abortController = new AbortController();
    const deltas: string[] = [];
    const loop = await quietly(() =>
      loopTurn(
        [anthropicJson(SONNET_55_STEP_1)],
        {
          prompt: "first heading?",
          defaultCompanionModel: SONNET_55.slug,
          abortSignal: abortController.signal,
          approver: {
            confirmPaidEscalation: () =>
              Promise.resolve({ decision: "approve" as const }),
          },
          frames: {
            onTextDelta: (delta) => void deltas.push(delta),
            onRuntimeEvent: (event) => {
              if (event.type === "toolStepStarted") abortController.abort();
            },
          },
        },
        (run) => run.env.set("ANTHROPIC_API_KEY", "test-key-not-real"),
        [SONNET_55],
      )
    ).then((r) => r.value);
    assert.equal(loop.result?.stopReason, "aborted");
    assert.equal(
      deltas.join(""),
      "I'll start with the directory.\n\n" +
        "Listing the budget directory to find its modules.\n\n",
    );
  });

  it("does not size a forced conclusion by blocks it will not send", async () => {
    // The step-limit conclusion changes the system prompt and drops the
    // tools, so the adapter sends no thinking; a reply whose signature alone
    // would overflow the window must not make the conclusion fail to fit.
    const huge = {
      ...SONNET_55_STEP_1,
      content: [
        { type: "thinking", thinking: "", signature: "s".repeat(400_000) },
        ...SONNET_55_STEP_1.content.slice(1),
      ],
    };
    const loop = await quietly(() =>
      loopTurn(
        [anthropicJson(huge), anthropicJson(SONNET_55_FINAL)],
        {
          prompt: "first heading?",
          defaultCompanionModel: SONNET_55.slug,
          maxToolSteps: 1,
          approver: {
            confirmPaidEscalation: () =>
              Promise.resolve({ decision: "approve" as const }),
          },
        },
        (run) => run.env.set("ANTHROPIC_API_KEY", "test-key-not-real"),
        [{ ...SONNET_55, context_window: 64_000, max_output_tokens: 4_096 }],
      )
    ).then((r) => r.value);
    assert.equal(loop.error, null);
    assert.equal(loop.result?.text, "The first heading is readme.");
    const last = JSON.parse(loop.run.transport.requests[1].body);
    assert.equal(last.tools, undefined);
    assert.ok(!JSON.stringify(last.messages).includes('"thinking"'));
  });

  it("records thinking in each provider call's output tokens and cost", async () => {
    const { loop } = await sonnetTurn();
    const calls = (await rows(loop)).filter((row) =>
      row.event_type === "provider_call"
    );
    assert.deepStrictEqual(
      calls.map((row) => [row.tokens_output, Number(row.cost_total)]),
      [
        ["410", (120 * 2 + 410 * 10) / 1_000_000],
        ["520", (180 * 2 + 520 * 10) / 1_000_000],
        ["300", (240 * 2 + 300 * 10) / 1_000_000],
      ],
    );
  });
});
