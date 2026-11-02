import { deepEqual, equal, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import { modelResponse, type ModelReply } from "./model-server.ts";

const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
const toolCall = {
  id: "call_golden_1",
  type: "function",
  function: { name: "file_read", arguments: '{"path":"a.txt"}' },
};
interface Frame {
  choices: Array<{
    delta?: Record<string, unknown>;
    message?: Record<string, unknown>;
    finish_reason?: string;
  }>;
  usage?: unknown;
}

for (const stream of [true, false]) {
  describe(stream ? "streamed model replies" : "buffered model replies", () => {
    const request = {
      stream,
      tools: [{ function: { name: "file_read" } }],
    };

    async function rendered(reply: ModelReply, tools = request.tools) {
      const response = modelResponse({ stream, tools }, reply);
      equal(
        response.headers.get("content-type"),
        stream ? "text/event-stream" : "application/json",
      );
      if (!stream) return [await response.json() as Frame];
      const frames = (await response.text()).split("\n\n");
      deepEqual(frames.splice(-2), ["data: [DONE]", ""]);
      return frames.map((frame) =>
        JSON.parse(frame.slice("data: ".length)) as Frame
      );
    }

    it("keeps the legacy text response bytes", async () => {
      const response = modelResponse(request, { kind: "text", text: "Hello" });
      equal(
        await response.text(),
        stream
          ? 'data: {"choices":[{"index":0,"delta":{"content":"Hello"}}]}\n\n' +
            'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n' +
            "data: [DONE]\n\n"
          : '{"choices":[{"index":0,"message":{"role":"assistant","content":"Hello"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}',
      );
    });

    it("keeps the legacy tool response bytes and registry-name resolution", async () => {
      const response = modelResponse(request, {
        kind: "tool", tool: "file.read", arguments: { path: "a.txt" },
      });
      const content = stream
        ? { delta: { tool_calls: [{ index: 0, ...toolCall }] } }
        : {
          message: {
            role: "assistant", content: null, tool_calls: [toolCall],
          },
        };
      const finish = {
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage,
      };
      equal(
        await response.text(),
        stream
          ? `data: ${JSON.stringify({ choices: [{ index: 0, ...content }] })}\n\n` +
            `data: ${JSON.stringify(finish)}\n\n` + "data: [DONE]\n\n"
          : JSON.stringify({
            choices: [{ index: 0, ...content, finish_reason: "tool_calls" }],
            usage,
          }),
      );
    });

    for (const kind of ["text", "tool"] as const) {
      it(`sends reasoning before ${kind} content and reports reasoning usage`, async () => {
        const reply: ModelReply = {
          ...(kind === "text"
            ? { kind, text: "Hello" }
            : { kind, tool: "file.read", arguments: { path: "a.txt" } }),
          reasoning: "Think first.",
          reasoningTokens: 3,
          usage: { promptTokens: 20, completionTokens: 8 },
        };
        const result = await rendered(reply);
        const expectedUsage = {
          prompt_tokens: 20, completion_tokens: 8, total_tokens: 28,
          completion_tokens_details: { reasoning_tokens: 3 },
        };
        const finish_reason = kind === "text" ? "stop" : "tool_calls";
        if (stream) {
          deepEqual(result, [
            {
              choices: [{
                index: 0, delta: { reasoning_content: "Think first." },
              }],
            },
            {
              choices: [{
                index: 0,
                delta: kind === "text"
                  ? { content: "Hello" }
                  : { tool_calls: [{ index: 0, ...toolCall }] },
              }],
            },
            {
              choices: [{ index: 0, delta: {}, finish_reason }],
              usage: expectedUsage,
            },
          ]);
        } else {
          deepEqual(result, [{
            choices: [{
              index: 0,
              message: {
                role: "assistant", reasoning_content: "Think first.",
                ...(kind === "text"
                  ? { content: "Hello" }
                  : { content: null, tool_calls: [toolCall] }),
              },
              finish_reason,
            }],
            usage: expectedUsage,
          }]);
        }
      });
    }

    it("allows reasoning text without a token count", async () => {
      const frames = await rendered({
        kind: "text", text: "", reasoning: "Think",
      });
      deepEqual(frames[frames.length - 1].usage, usage);
      deepEqual(
        stream ? frames[0].choices[0].delta : frames[0].choices[0].message,
        stream
          ? { reasoning_content: "Think" }
          : { role: "assistant", reasoning_content: "Think", content: "" },
      );
    });

    it("preserves a zero reasoning count without reasoning text", async () => {
      const frames = await rendered({
        kind: "text", text: "ok", reasoningTokens: 0,
      });
      deepEqual(frames[frames.length - 1].usage, {
        ...usage, completion_tokens_details: { reasoning_tokens: 0 },
      });
      if (stream) equal(frames.length, 2);
      deepEqual(
        stream ? frames[0].choices[0].delta : frames[0].choices[0].message,
        stream ? { content: "ok" } : { role: "assistant", content: "ok" },
      );
    });

    for (const text of ["", "Partial answer"]) {
      it(`supports length finish with ${text ? "visible" : "reasoning-only"} output`, async () => {
        const frames = await rendered({
          kind: "text", text, finish: "length", reasoning: "Thinking",
          reasoningTokens: 5,
        });
        const final = frames[frames.length - 1];
        equal(final.choices[0].finish_reason, "length");
        deepEqual(final.usage, {
          ...usage, completion_tokens_details: { reasoning_tokens: 5 },
        });
        deepEqual(
          stream ? frames[1].choices[0].delta : frames[0].choices[0].message,
          stream ? { content: text } : {
            role: "assistant", reasoning_content: "Thinking", content: text,
          },
        );
      });
    }

    it("accepts an explicit stop finish", async () => {
      const frames = await rendered({
        kind: "text", text: "done", finish: "stop",
      });
      equal(frames[frames.length - 1].choices[0].finish_reason, "stop");
    });

    for (const tools of [[], request.tools]) {
      it(`sends an exact wire name with ${tools.length ? "unrelated" : "no"} offered tools`, async () => {
        const frames = await rendered({
          kind: "tool", wireName: "unoffered.tool!", arguments: { value: 1 },
        }, tools);
        const expected = {
          id: "call_golden_1", type: "function",
          function: { name: "unoffered.tool!", arguments: '{"value":1}' },
        };
        deepEqual(
          stream ? frames[0].choices[0].delta : frames[0].choices[0].message,
          stream ? { tool_calls: [{ index: 0, ...expected }] } : {
            role: "assistant", content: null, tool_calls: [expected],
          },
        );
        equal(frames[frames.length - 1].choices[0].finish_reason, "tool_calls");
      });

      it(`still rejects an unoffered registry id with ${tools.length ? "unrelated" : "no"} offered tools`, () => {
        throws(() => modelResponse({ stream, tools }, {
          kind: "tool", tool: "unoffered.tool", arguments: {},
        }), /was not offered/);
      });
    }
  });
}
