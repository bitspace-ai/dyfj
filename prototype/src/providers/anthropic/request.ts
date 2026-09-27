/**
 * Anthropic Messages request bodies.
 */
import type { WorkbenchMessage, WorkbenchToolDefinition } from "../types.ts";
import { toolWireNames, wireNameLookup } from "../shared/tool-names.ts";

export const ANTHROPIC_API_VERSION = "2023-06-01";
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 16000;

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | {
    type: "tool_use";
    id: string;
    name: string;
    input: Record<string, unknown>;
  }
  | {
    type: "tool_result";
    tool_use_id: string;
    content: string;
    is_error?: boolean;
  };

type AnthropicWireMessage = {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
};

/**
 * Map the agent-loop history to Anthropic's message shape: assistant turns carry
 * `tool_use` blocks (names sanitized to the wire form we offered), and tool
 * results become `tool_result` blocks in a following user turn. Consecutive tool
 * results are merged into a single user turn, which is how Anthropic expects a
 * batch of results for one assistant turn's tool calls.
 */
function toAnthropicWireMessages(
  prompt: string,
  messages: WorkbenchMessage[] | undefined,
  tools: WorkbenchToolDefinition[] | undefined,
): AnthropicWireMessage[] {
  if (!messages || messages.length === 0) {
    return [{ role: "user", content: prompt }];
  }
  const wireName = wireNameLookup(tools);
  const wire: AnthropicWireMessage[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      wire.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      const blocks: AnthropicContentBlock[] = [];
      if (m.content && m.content.trim().length > 0) {
        blocks.push({ type: "text", text: m.content });
      }
      for (const tc of m.toolCalls ?? []) {
        blocks.push({
          type: "tool_use",
          id: tc.id,
          name: wireName(tc.name),
          input: tc.arguments ?? {},
        });
      }
      wire.push({ role: "assistant", content: blocks });
    } else {
      const block: AnthropicContentBlock = {
        type: "tool_result",
        tool_use_id: m.toolCallId,
        content: m.content,
        ...(m.isError ? { is_error: true } : {}),
      };
      const last = wire[wire.length - 1];
      if (
        last && last.role === "user" && Array.isArray(last.content) &&
        last.content[0]?.type === "tool_result"
      ) {
        last.content.push(block);
      } else {
        wire.push({ role: "user", content: [block] });
      }
    }
  }
  return wire;
}

export function buildAnthropicMessagesRequest(
  model: string,
  systemPrompt: string,
  prompt: string,
  stream = false,
  options: {
    jsonObject?: boolean;
    tools?: WorkbenchToolDefinition[];
    messages?: WorkbenchMessage[];
    maxTokens?: number;
  } = {},
) {
  // The stable system prompt is the cache prefix: cache_control on the first
  // block, volatile additions in later blocks, so repeated turns read the
  // prefix at cache pricing instead of re-paying full input price.
  const system: Array<{
    type: "text";
    text: string;
    cache_control?: { type: "ephemeral" };
  }> = [
    {
      type: "text",
      text: systemPrompt,
      cache_control: { type: "ephemeral" },
    },
  ];
  if (options.jsonObject) {
    system.push({
      type: "text",
      text: "Respond with a single valid JSON object and nothing else.",
    });
  }

  const body: {
    model: string;
    max_tokens: number;
    stream: boolean;
    system: typeof system;
    messages: AnthropicWireMessage[];
    tools?: Array<{
      name: string;
      description: string;
      input_schema: Record<string, unknown>;
    }>;
  } = {
    model,
    max_tokens: options.maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
    stream,
    system,
    messages: toAnthropicWireMessages(prompt, options.messages, options.tools),
  };
  if (options.tools && options.tools.length > 0) {
    body.tools = toolWireNames(options.tools).map(
      ({ wire, tool }) => ({
        name: wire,
        description: tool.description,
        input_schema: tool.parameters,
      }),
    );
  }
  return body;
}
