/**
 * OpenAI-compatible response shapes, structured tool-call limits, and the
 * bounded buffered (JSON) reader.
 */
import { DomainError } from "../../contract/mod.ts";
import type { WorkbenchCallTimings, WorkbenchToolCall } from "../types.ts";
import {
  MAX_OPENAI_RESPONSE_BYTES,
  MAX_OPENAI_RESPONSE_CHUNKS,
  MAX_OPENAI_RESPONSE_READS,
} from "../shared/response-bounds.ts";
import { toolArgumentWithinBudget } from "../shared/text-tool-calls.ts";

export interface OpenAIToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  argumentsFragment?: string;
}

export interface OpenAIChatStreamEvent {
  done: boolean;
  textDelta?: string;
  reasoningDelta?: string;
  toolCallDeltas?: OpenAIToolCallDelta[];
  finishReason?: string;
  usage?: OpenAIChatUsage;
}

export interface OpenAIChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
}

export const MAX_STRUCTURED_TOOL_CALLS = 128;
export const MAX_STRUCTURED_TOOL_NAME_CHARACTERS = 64 * 1024;

export async function readBoundedOpenAIText(
  response: Response,
): Promise<string> {
  if (!response.body) {
    throw new DomainError("Provider response did not include a body");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let receivedBytes = 0;
  let receivedChunks = 0;
  let receivedReads = 0;
  const text: string[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    receivedReads += 1;
    receivedBytes += value.byteLength;
    if (value.byteLength > 0) receivedChunks += 1;
    if (
      receivedBytes > MAX_OPENAI_RESPONSE_BYTES ||
      receivedChunks > MAX_OPENAI_RESPONSE_CHUNKS ||
      receivedReads > MAX_OPENAI_RESPONSE_READS
    ) {
      void reader.cancel().catch(() => {});
      throw new DomainError("Provider response exceeded the adapter limit");
    }
    text.push(decoder.decode(value, { stream: true }));
  }
  text.push(decoder.decode());
  return text.join("");
}

async function readBoundedOpenAIJson<T>(response: Response): Promise<T> {
  return JSON.parse(await readBoundedOpenAIText(response)) as T;
}

export async function readOpenAIChatJson(
  response: Response,
  now: () => number,
  requestStarted: number,
  headersReceived: number,
): Promise<{
  text: string;
  visibleText?: string;
  aborted?: false;
  finishReason?: string;
  usage?: OpenAIChatUsage;
  toolCalls?: WorkbenchToolCall[];
  toolCallCharacters: number;
  timings: WorkbenchCallTimings;
}> {
  const json = await readBoundedOpenAIJson<{
    error?: unknown;
    choices?: Array<{
      message?: {
        content?: string;
        tool_calls?: Array<{
          id?: string;
          type?: string;
          function?: {
            name?: string;
            arguments?: string;
          };
        }>;
      };
      finish_reason?: string;
    }>;
    usage?: OpenAIChatUsage;
  }>(response);
  if (Object.hasOwn(json, "error")) {
    throw new DomainError("Provider response returned an error envelope");
  }
  const completed = now();
  const choice = json.choices?.[0];
  const rawToolCalls = choice?.message?.tool_calls;
  const toolCallCharacters = (rawToolCalls ?? []).reduce(
    (total, call) =>
      total + (call.function?.name?.length ?? 0) +
      (call.function?.arguments?.length ?? 0),
    0,
  );
  return {
    text: choice?.message?.content ?? "",
    finishReason: choice?.finish_reason,
    usage: json.usage,
    toolCalls: parseOpenAIToolCalls(rawToolCalls),
    toolCallCharacters,
    timings: {
      responseHeadersMs: Math.round(headersReceived - requestStarted),
      totalMs: Math.round(completed - requestStarted),
    },
  };
}

function parseOpenAIToolCalls(
  toolCalls:
    | Array<{
      id?: string;
      type?: string;
      function?: { name?: string; arguments?: string };
    }>
    | undefined,
): WorkbenchToolCall[] | undefined {
  if (!toolCalls || toolCalls.length === 0) return undefined;
  if (
    toolCalls.length > MAX_STRUCTURED_TOOL_CALLS ||
    toolCalls.reduce(
        (total, toolCall) => total + (toolCall.function?.name?.length ?? 0),
        0,
      ) > MAX_STRUCTURED_TOOL_NAME_CHARACTERS
  ) {
    throw new DomainError("Provider returned too many structured tool calls");
  }
  return toolCalls.map((toolCall, idx) => ({
    id: toolCall.id ?? `tool-call-${idx + 1}`,
    name: toolCall.function?.name ?? "",
    arguments: parseToolArguments(toolCall.function?.arguments),
  }));
}

export function parseToolArguments(
  value: string | undefined,
): Record<string, unknown> {
  if (!value) return {};
  if (!toolArgumentWithinBudget(value)) {
    throw new DomainError("Provider returned oversized tool arguments");
  }
  try {
    const parsed = JSON.parse(value);
    if (
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return {};
  }
  return {};
}
