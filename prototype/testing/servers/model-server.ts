/**
 * Loopback OpenAI-compatible model server for process-level tests.
 *
 * Stands in for a local model runtime (ollama, mlx-lm) at the network
 * boundary: it speaks `POST <base>/chat/completions`, streamed (SSE) or
 * buffered JSON, and answers from a caller-supplied script. It never reaches
 * the network and never imports runtime code, so tests that use it stay
 * black-box.
 *
 * A script sees each request body and returns one reply:
 * - `text`: a plain completion.
 * - `tool`: a single structured tool call, named by its registry id; the wire
 *   name is looked up in the request's offered tools.
 * - `hold`: stream some text, then keep the stream open until the client
 *   aborts the request (for cancellation tests).
 *
 * Usage figures are part of the reply, so cost accounting is deterministic.
 */

export interface ChatMessage {
  role: string;
  content?: unknown;
  tool_calls?: unknown;
  tool_call_id?: string;
}

export interface ChatRequest {
  model?: string;
  stream?: boolean;
  messages?: ChatMessage[];
  tools?: Array<{ function?: { name?: string } }>;
  [key: string]: unknown;
}

export interface ReplyUsage {
  promptTokens: number;
  completionTokens: number;
}

export type ModelReply =
  | { kind: "text"; text: string; usage?: ReplyUsage }
  | {
    kind: "tool";
    tool: string;
    arguments: Record<string, unknown>;
    usage?: ReplyUsage;
  }
  | { kind: "hold"; text: string };

export type ModelScript = (request: ChatRequest) => ModelReply;

export interface ModelServer {
  /** Base URL to seed into a models row (`http://127.0.0.1:<port>/v1`). */
  baseUrl: string;
  port: number;
  /** Every request body received, in arrival order. */
  requests: ChatRequest[];
  close(): Promise<void>;
}

const DEFAULT_USAGE: ReplyUsage = { promptTokens: 10, completionTokens: 5 };

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function usageJson(usage: ReplyUsage) {
  return {
    prompt_tokens: usage.promptTokens,
    completion_tokens: usage.completionTokens,
    total_tokens: usage.promptTokens + usage.completionTokens,
  };
}

/**
 * Resolve a registry tool id to the wire name the client offered. Clients may
 * sanitize names (for example `.` to `_`), so an exact match wins, then a
 * sanitized match. An unoffered tool is a script error, reported as HTTP 500.
 */
function wireToolName(request: ChatRequest, tool: string): string {
  const offered = (request.tools ?? [])
    .map((entry) => entry.function?.name)
    .filter((name): name is string => typeof name === "string");
  if (offered.includes(tool)) return tool;
  const sanitized = tool.replace(/[^A-Za-z0-9_-]/g, "_");
  if (offered.includes(sanitized)) return sanitized;
  throw new Error(
    `tool ${tool} was not offered (offered: ${offered.join(",")})`,
  );
}

function streamedReply(request: ChatRequest, reply: ModelReply): Response {
  const encoder = new TextEncoder();
  if (reply.kind === "hold") {
    // The stream stays open until the client goes away, which cancels it.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(sse({
          choices: [{ index: 0, delta: { content: reply.text } }],
        })));
      },
    });
    return new Response(body, {
      headers: { "content-type": "text/event-stream" },
    });
  }
  const usage = reply.usage ?? DEFAULT_USAGE;
  const frames = reply.kind === "text"
    ? [
      sse({ choices: [{ index: 0, delta: { content: reply.text } }] }),
      sse({
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: usageJson(usage),
      }),
    ]
    : [
      sse({
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_golden_1",
              type: "function",
              function: {
                name: wireToolName(request, reply.tool),
                arguments: JSON.stringify(reply.arguments),
              },
            }],
          },
        }],
      }),
      sse({
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        usage: usageJson(usage),
      }),
    ];
  frames.push("data: [DONE]\n\n");
  return new Response(frames.join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

function bufferedReply(request: ChatRequest, reply: ModelReply): Response {
  if (reply.kind === "hold") {
    throw new Error("hold replies require a streamed request");
  }
  const usage = usageJson(reply.usage ?? DEFAULT_USAGE);
  if (reply.kind === "text") {
    return Response.json({
      choices: [{
        index: 0,
        message: { role: "assistant", content: reply.text },
        finish_reason: "stop",
      }],
      usage,
    });
  }
  return Response.json({
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_golden_1",
          type: "function",
          function: {
            name: wireToolName(request, reply.tool),
            arguments: JSON.stringify(reply.arguments),
          },
        }],
      },
      finish_reason: "tool_calls",
    }],
    usage,
  });
}

export function startModelServer(script: ModelScript): ModelServer {
  const requests: ChatRequest[] = [];
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    async (request) => {
      const url = new URL(request.url);
      if (
        request.method !== "POST" || !url.pathname.endsWith("/chat/completions")
      ) {
        return new Response("not found", { status: 404 });
      }
      try {
        const body = await request.json() as ChatRequest;
        requests.push(body);
        const reply = script(body);
        return body.stream === true
          ? streamedReply(body, reply)
          : bufferedReply(body, reply);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return new Response(`model script error: ${message}`, { status: 500 });
      }
    },
  );
  const port = (server.addr as Deno.NetAddr).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    port,
    requests,
    close: () => server.shutdown(),
  };
}
