/**
 * Anthropic Messages request bodies.
 */
import { createHash, type Hash } from "node:crypto";
import type {
  ProviderReplay,
  WorkbenchMessage,
  WorkbenchToolCall,
  WorkbenchToolDefinition,
} from "../types.ts";
import { toolWireNames, wireNameLookup } from "../shared/tool-names.ts";

export const ANTHROPIC_API_VERSION = "2023-06-01";
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 16000;
/** The `api` an Anthropic `ProviderReplay` carries. */
export const ANTHROPIC_REPLAY_API = "anthropic-messages";

/**
 * The catalog capability of a model that writes progress updates between
 * tool calls (Claude Sonnet 5.5). Such a model is asked for
 * `display: "updates"`, which returns those updates as readable thinking
 * text and keeps its reasoning hidden; the setting is in beta behind
 * `ANTHROPIC_PROGRESS_UPDATES_BETA`. Other models are sent no thinking
 * configuration, so their requests are as before.
 */
export const ANTHROPIC_PROGRESS_UPDATES_CAPABILITY =
  "thinking-progress-updates";
export const ANTHROPIC_PROGRESS_UPDATES_BETA =
  "thinking-display-updates-2026-08-18";

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string }
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

type AnthropicSystemBlock = {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
};

type AnthropicWireTool = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

/**
 * Digests of the request a reply was produced under. Anthropic accepts a
 * thinking block back only while the `system` prompt, the `tools` and every
 * message before it are unchanged (an edit is a 400 on newer accounts, a
 * silent drop on older ones), so a reply's blocks are replayed only while
 * the digest of what now precedes them matches the one taken when they were
 * produced. Messages are added in order and never revisited: the wire
 * messages before an assistant turn are final once it is reached.
 */
class PrefixDigest {
  readonly #hash: Hash;
  #added = 0;

  constructor(
    system: readonly AnthropicSystemBlock[],
    tools: readonly AnthropicWireTool[] | undefined,
  ) {
    this.#hash = createHash("sha256");
    this.#hash.update(JSON.stringify({ system, tools: tools ?? null }));
  }

  /** The digest of the request header and `messages`, in order. */
  after(messages: readonly AnthropicWireMessage[]): string {
    for (; this.#added < messages.length; this.#added++) {
      this.#hash.update("\n" + JSON.stringify(messages[this.#added]));
    }
    return this.#hash.copy().digest("hex");
  }
}

/**
 * The digest a reply to `body` records: everything the request sent, which
 * is everything before the reply.
 */
export function anthropicReplyPrefixDigest(body: {
  system: readonly AnthropicSystemBlock[];
  tools?: readonly AnthropicWireTool[];
  messages: readonly AnthropicWireMessage[];
}): string {
  return new PrefixDigest(body.system, body.tools).after(body.messages);
}

/**
 * The reply's blocks, when they are still this assistant message as the
 * engine holds it: the same text and the same tool calls in the same order.
 * Anything else (a merged continuation, an edited turn) is not what the
 * model produced, so it is rebuilt from the message instead.
 */
function replayContent(
  replay: ProviderReplay,
  content: string,
  toolCalls: readonly WorkbenchToolCall[],
): AnthropicContentBlock[] | undefined {
  const blocks = replay.content as AnthropicContentBlock[];
  let text = "";
  const toolUses: Extract<AnthropicContentBlock, { type: "tool_use" }>[] = [];
  for (const block of blocks) {
    if (block.type === "text") text += block.text;
    if (block.type === "tool_use") toolUses.push(block);
  }
  const sameCalls = toolUses.length === toolCalls.length &&
    toolUses.every((use, i) =>
      use.id === toolCalls[i].id &&
      JSON.stringify(use.input) === JSON.stringify(toolCalls[i].arguments ?? {})
    );
  return text === content && sameCalls ? blocks : undefined;
}

/**
 * Map the agent-loop history to Anthropic's message shape: assistant turns carry
 * `tool_use` blocks (names sanitized to the wire form we offered), and tool
 * results become `tool_result` blocks in a following user turn. Consecutive tool
 * results are merged into a single user turn, which is how Anthropic expects a
 * batch of results for one assistant turn's tool calls.
 *
 * An assistant turn that carries an Anthropic reply is sent as that reply's
 * blocks, unchanged and in order (thinking and redacted thinking included),
 * while the request before it is the one it was produced under. The first
 * turn that fails that check, and every later one, is rebuilt from its text
 * and tool calls without thinking: a block after a changed prefix is invalid,
 * and so is every block after it.
 */
function toAnthropicWireMessages(
  prompt: string,
  messages: WorkbenchMessage[] | undefined,
  tools: WorkbenchToolDefinition[] | undefined,
  prefix: PrefixDigest,
): AnthropicWireMessage[] {
  if (!messages || messages.length === 0) {
    return [{ role: "user", content: prompt }];
  }
  const wireName = wireNameLookup(tools);
  const wire: AnthropicWireMessage[] = [];
  let replaying = true;
  for (const m of messages) {
    if (m.role === "user") {
      wire.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      const replayed = replaying && m.replay?.api === ANTHROPIC_REPLAY_API &&
          m.replay.prefixDigest === prefix.after(wire)
        ? replayContent(m.replay, m.content, m.toolCalls ?? [])
        : undefined;
      if (m.replay !== undefined && replayed === undefined) replaying = false;
      if (replayed !== undefined) {
        wire.push({ role: "assistant", content: replayed });
        continue;
      }
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
    /** Ask for progress updates (`ANTHROPIC_PROGRESS_UPDATES_CAPABILITY`). */
    progressUpdates?: boolean;
  } = {},
) {
  // The stable system prompt is the cache prefix: cache_control on the first
  // block, volatile additions in later blocks, so repeated turns read the
  // prefix at cache pricing instead of re-paying full input price.
  const system: AnthropicSystemBlock[] = [
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

  const tools: AnthropicWireTool[] | undefined =
    options.tools && options.tools.length > 0
      ? toolWireNames(options.tools).map(({ wire, tool }) => ({
        name: wire,
        description: tool.description,
        input_schema: tool.parameters,
      }))
      : undefined;

  const body: {
    model: string;
    max_tokens: number;
    stream: boolean;
    system: AnthropicSystemBlock[];
    messages: AnthropicWireMessage[];
    tools?: AnthropicWireTool[];
    thinking?: { type: "adaptive"; display: "updates" };
  } = {
    model,
    max_tokens: options.maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
    stream,
    system,
    messages: toAnthropicWireMessages(
      prompt,
      options.messages,
      options.tools,
      new PrefixDigest(system, tools),
    ),
  };
  if (tools) body.tools = tools;
  if (options.progressUpdates) {
    body.thinking = { type: "adaptive", display: "updates" };
  }
  return body;
}
