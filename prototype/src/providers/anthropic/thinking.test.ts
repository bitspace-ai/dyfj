// Thinking blocks through the Anthropic adapter: kept as returned, replayed
// unchanged within a tool turn while the request before them is unchanged,
// and the narration between tool calls handed to the operator. The responses
// are a two-tool-step Claude Sonnet 5.5 turn (testing/fixtures).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SONNET_55_FINAL,
  SONNET_55_STEP_1,
  SONNET_55_STEP_2,
} from "../../../testing/fixtures/anthropic-thinking.ts";
import { MapEnv } from "../../../testing/fakes/map-env.ts";
import {
  type RecordedRequest,
  ScriptedHttpTransport,
} from "../../../testing/fakes/scripted-http-transport.ts";
import {
  runWorkbenchTurn,
  type WorkbenchMessage,
  type WorkbenchModel,
  type WorkbenchToolDefinition,
  type WorkbenchTurnResult,
} from "../mod.ts";

const sonnet55: WorkbenchModel = {
  slug: "claude-sonnet-5-5",
  displayName: "Claude Sonnet 5.5",
  provider: "anthropic",
  api: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
  tier: 1,
  costInput: 2,
  costOutput: 10,
  capabilities: ["text", "tools", "thinking", "thinking-progress-updates"],
};

const sonnet5: WorkbenchModel = {
  ...sonnet55,
  slug: "claude-sonnet-5",
  displayName: "Claude Sonnet 5",
  capabilities: ["text", "tools", "thinking"],
};

const tools: WorkbenchToolDefinition[] = [
  {
    name: "list_files",
    description: "List files",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "read_file",
    description: "Read a file",
    parameters: { type: "object", properties: {} },
  },
];

const env = new MapEnv({ ANTHROPIC_API_KEY: "test-key-not-real" });

interface Call {
  result: WorkbenchTurnResult;
  request: RecordedRequest;
}

/** One buffered call with tools offered, answered by `response`. */
async function call(
  model: WorkbenchModel,
  messages: WorkbenchMessage[],
  response: unknown,
  systemPrompt = "sys",
): Promise<Call> {
  const transport = new ScriptedHttpTransport([{
    respond: { body: JSON.stringify(response) },
  }]);
  const result = await runWorkbenchTurn({
    systemPrompt,
    prompt: "seed",
    messages,
    tools,
    routing: { modelId: model.slug },
    models: [model],
    fetchFn: transport.fetch,
    getEnv: (name) => env.get(name),
  });
  return { result, request: transport.requests[0] };
}

/** The step a tool loop appends: the assistant turn, then its results. */
function step(
  result: WorkbenchTurnResult,
  output: string,
): WorkbenchMessage[] {
  const toolCalls = result.toolCalls ?? [];
  return [
    {
      role: "assistant",
      content: result.text,
      toolCalls,
      ...(result.replay === undefined ? {} : { replay: result.replay }),
    },
    ...toolCalls.map((tc): WorkbenchMessage => ({
      role: "tool",
      toolCallId: tc.id,
      name: tc.name,
      content: output,
    })),
  ];
}

const body = (request: RecordedRequest) => JSON.parse(request.body);

const prompt: WorkbenchMessage = { role: "user", content: "first heading?" };

describe("anthropic thinking replay", () => {
  it("replays every assistant turn of a two-step tool loop unchanged", async () => {
    const first = await call(sonnet55, [prompt], SONNET_55_STEP_1);
    const history = [prompt, ...step(first.result, "README.md")];
    const second = await call(sonnet55, history, SONNET_55_STEP_2);
    history.push(...step(second.result, "# readme"));
    const third = await call(sonnet55, history, SONNET_55_FINAL);

    const sent = body(third.request).messages;
    assert.deepStrictEqual(sent[1], {
      role: "assistant",
      content: SONNET_55_STEP_1.content,
    });
    assert.deepStrictEqual(sent[3], {
      role: "assistant",
      content: SONNET_55_STEP_2.content,
    });
    // The step's own request replayed the first step the same way.
    assert.deepStrictEqual(
      body(second.request).messages[1].content,
      SONNET_55_STEP_1.content,
    );
    assert.equal(third.result.text, "The first heading is readme.");
  });

  it("keeps text and tool calls as before alongside the kept blocks", async () => {
    const { result } = await call(sonnet55, [prompt], SONNET_55_STEP_1);
    assert.equal(result.text, "I'll start with the directory.");
    assert.deepStrictEqual(result.toolCalls, [{
      id: "toolu_list",
      name: "list_files",
      arguments: { path: "." },
    }]);
    assert.equal(result.stopReason, "tool_use");
  });

  it("drops the blocks once the system prompt before them changes", async () => {
    // A forced conclusion sends a longer system prompt and no tools: the
    // blocks were produced under the old prefix, and Anthropic rejects or
    // drops a block whose prefix changed.
    const first = await call(sonnet55, [prompt], SONNET_55_STEP_1);
    const history = [prompt, ...step(first.result, "README.md")];
    const next = await call(
      sonnet55,
      history,
      SONNET_55_FINAL,
      "sys\n\nWorkbench instruction: conclude.",
    );
    assert.deepStrictEqual(body(next.request).messages[1].content, [
      { type: "text", text: "I'll start with the directory." },
      {
        type: "tool_use",
        id: "toolu_list",
        name: "list_files",
        input: { path: "." },
      },
    ]);
  });

  it("drops a block and every later one once an earlier message changes", async () => {
    const first = await call(sonnet55, [prompt], SONNET_55_STEP_1);
    const history = [prompt, ...step(first.result, "README.md")];
    const second = await call(sonnet55, history, SONNET_55_STEP_2);
    history.push(...step(second.result, "# readme"));
    // A context fit trims the first step's tool result in place.
    history[2] = { ...history[2], content: "[trimmed]" } as WorkbenchMessage;
    const third = await call(sonnet55, history, SONNET_55_FINAL);

    const sent = body(third.request).messages;
    // The first step's blocks came before the edit and stay.
    assert.deepStrictEqual(sent[1].content, SONNET_55_STEP_1.content);
    // The second step's came after it and go.
    assert.deepStrictEqual(sent[3].content, [{
      type: "tool_use",
      id: "toolu_read",
      name: "read_file",
      input: { path: "README.md" },
    }]);
  });

  it("does not replay blocks that no longer match the assistant turn", async () => {
    const first = await call(sonnet55, [prompt], SONNET_55_STEP_1);
    const [assistant, ...results] = step(first.result, "README.md");
    const edited = { ...assistant, content: "something else" };
    const next = await call(
      sonnet55,
      [prompt, edited, ...results],
      SONNET_55_FINAL,
    );
    assert.deepStrictEqual(body(next.request).messages[1].content, [
      { type: "text", text: "something else" },
      {
        type: "tool_use",
        id: "toolu_list",
        name: "list_files",
        input: { path: "." },
      },
    ]);
  });

  it("bills thinking as output: cost follows output_tokens", async () => {
    const { result } = await call(sonnet55, [prompt], SONNET_55_STEP_1);
    // 410 output tokens, almost all thinking: the visible text is a sentence.
    assert.equal(result.usage.output, 410);
    assert.equal(result.usage.reasoning, undefined);
    assert.equal(
      result.usage.cost.total,
      (120 / 1_000_000) * 2 + (410 / 1_000_000) * 10,
    );
  });
});

describe("anthropic progress updates", () => {
  it("asks a progress-update model for its updates", async () => {
    const { request } = await call(sonnet55, [prompt], SONNET_55_STEP_1);
    assert.deepStrictEqual(body(request).thinking, {
      type: "adaptive",
      display: "updates",
    });
    assert.equal(
      request.headers["anthropic-beta"],
      "thinking-display-updates-2026-08-18",
    );
  });

  it("hands the operator the narration between tool calls, in order", async () => {
    const first = await call(sonnet55, [prompt], SONNET_55_STEP_1);
    assert.equal(
      first.result.progressText,
      "I'll start with the directory.\n\n" +
        "Listing the budget directory to find its modules.",
    );
    const history = [prompt, ...step(first.result, "README.md")];
    const second = await call(sonnet55, history, SONNET_55_STEP_2);
    assert.equal(
      second.result.progressText,
      "Found README.md. Reading it for the first heading.",
    );
  });

  it("has no narration on a reply that calls no tool", async () => {
    const { result } = await call(sonnet55, [prompt], SONNET_55_FINAL);
    assert.equal(result.progressText, undefined);
  });
});

describe("anthropic models without progress updates", () => {
  it("send no thinking configuration or beta header", async () => {
    const { request } = await call(sonnet5, [prompt], SONNET_55_STEP_1);
    assert.equal(body(request).thinking, undefined);
    assert.equal(request.headers["anthropic-beta"], undefined);
  });

  it("get no narration", async () => {
    const { result } = await call(sonnet5, [prompt], SONNET_55_STEP_1);
    assert.equal(result.progressText, undefined);
  });

  it("carry nothing to replay when the reply has no thinking", async () => {
    const { result } = await call(sonnet5, [prompt], {
      content: [
        { type: "text", text: "Listing." },
        { type: "tool_use", id: "t1", name: "list_files", input: {} },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    assert.equal(result.replay, undefined);
  });
});
