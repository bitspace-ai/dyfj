/**
 * OpenAI-compatible chat/completions request bodies.
 */
import type { WorkbenchMessage, WorkbenchToolDefinition } from "../types.ts";
import { toolWireNames, wireNameLookup } from "../shared/tool-names.ts";

type OpenAIWireMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
};

/**
 * Build the OpenAI `messages` array: system prefix, then either the structured
 * history (assistant tool_calls + tool results, names sanitized to the same wire
 * form we offered) or the single seed user prompt when no history is supplied.
 */
function toOpenAIWireMessages(
  systemPrompt: string,
  prompt: string,
  messages: WorkbenchMessage[] | undefined,
  historyTools: WorkbenchToolDefinition[] | undefined,
): OpenAIWireMessage[] {
  const wire: OpenAIWireMessage[] = [
    { role: "system", content: systemPrompt },
  ];
  if (!messages || messages.length === 0) {
    wire.push({ role: "user", content: prompt });
    return wire;
  }
  const wireName = wireNameLookup(historyTools);
  for (const m of messages) {
    if (m.role === "user") {
      wire.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      const out: OpenAIWireMessage = { role: "assistant", content: m.content };
      if (m.toolCalls && m.toolCalls.length > 0) {
        out.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: {
            name: wireName(tc.name),
            arguments: JSON.stringify(tc.arguments ?? {}),
          },
        }));
      }
      wire.push(out);
    } else {
      wire.push({
        role: "tool",
        tool_call_id: m.toolCallId,
        content: m.content,
      });
    }
  }
  return wire;
}

export function buildOpenAIChatRequest(
  model: string,
  systemPrompt: string,
  prompt: string,
  stream = false,
  options: {
    jsonObject?: boolean;
    tools?: WorkbenchToolDefinition[];
    /** Definitions used only to serialize historical tool-call names. */
    historyTools?: WorkbenchToolDefinition[];
    messages?: WorkbenchMessage[];
    maxCompletionTokens?: number;
    reasoningEffort?: string;
    /**
     * Ask a streaming response to end with a usage frame. OpenAI reports no
     * usage on a stream without it; local servers are not sent it.
     */
    includeStreamUsage?: boolean;
  } = {},
) {
  const body: {
    model: string;
    stream: boolean;
    stream_options?: { include_usage: true };
    messages: OpenAIWireMessage[];
    response_format?: { type: "json_object" };
    max_completion_tokens?: number;
    reasoning_effort?: string;
    tools?: Array<{
      type: "function";
      function: WorkbenchToolDefinition;
    }>;
    tool_choice?: "auto";
  } = {
    model,
    stream,
    messages: toOpenAIWireMessages(
      systemPrompt,
      prompt,
      options.messages,
      options.historyTools ?? options.tools,
    ),
  };
  if (stream && options.includeStreamUsage) {
    body.stream_options = { include_usage: true };
  }
  if (options.jsonObject) {
    body.response_format = { type: "json_object" };
  }
  if (options.maxCompletionTokens !== undefined) {
    body.max_completion_tokens = options.maxCompletionTokens;
  }
  if (options.reasoningEffort !== undefined) {
    body.reasoning_effort = options.reasoningEffort;
  }
  if (options.tools && options.tools.length > 0) {
    // Sanitize names to ^[a-zA-Z0-9_-]+$ — OpenAI rejects dotted command ids
    // (e.g. memory.read) with HTTP 400. Mapped back in executeOpenAICompatibleTurn.
    body.tools = toolWireNames(options.tools).map(({ wire, tool }) => ({
      type: "function",
      function: { ...tool, name: wire },
    }));
    body.tool_choice = "auto";
  }
  return body;
}
