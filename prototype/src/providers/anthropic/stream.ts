/**
 * Anthropic Messages response reading: SSE line parsing, the buffered JSON
 * reader, and the streaming reader. The streaming reader carries text only:
 * tool-offering turns are buffered.
 */
import { DomainError } from "../../contract/mod.ts";
import type { WorkbenchCallTimings, WorkbenchToolCall } from "../types.ts";
import { readSseLines } from "../shared/sse.ts";

export interface AnthropicStreamEvent {
  done: boolean;
  textDelta?: string;
  stopReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export function parseAnthropicStreamLine(
  line: string,
): AnthropicStreamEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || !trimmed.startsWith("data:")) return null;

  const json = JSON.parse(trimmed.slice("data:".length).trim()) as {
    type?: string;
    error?: unknown;
    message?: {
      usage?: {
        input_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      };
    };
    delta?: { type?: string; text?: string; stop_reason?: string };
    usage?: { output_tokens?: number };
  };
  if (json.type === "error") {
    throw new DomainError("Anthropic stream returned an error envelope");
  }

  switch (json.type) {
    case "message_start":
      return {
        done: false,
        inputTokens: json.message?.usage?.input_tokens,
        cacheReadTokens: json.message?.usage?.cache_read_input_tokens,
        cacheWriteTokens: json.message?.usage?.cache_creation_input_tokens,
      };
    case "content_block_delta":
      return json.delta?.type === "text_delta"
        ? { done: false, textDelta: json.delta.text }
        : { done: false };
    case "message_delta":
      return {
        done: false,
        stopReason: json.delta?.stop_reason,
        outputTokens: json.usage?.output_tokens,
      };
    case "message_stop":
      return { done: true };
    default:
      return null;
  }
}

export async function readAnthropicMessagesJson(
  response: Response,
  now: () => number,
  requestStarted: number,
  headersReceived: number,
): Promise<{
  text: string;
  aborted?: false;
  stopReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  toolCalls?: WorkbenchToolCall[];
  timings: WorkbenchCallTimings;
}> {
  const json = await response.json() as {
    content?: Array<{
      type?: string;
      text?: string;
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
    }>;
    stop_reason?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  const completed = now();

  let text = "";
  const toolCalls: WorkbenchToolCall[] = [];
  for (const block of json.content ?? []) {
    if (block.type === "text" && block.text) text += block.text;
    if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id ?? `tool-call-${toolCalls.length + 1}`,
        name: block.name ?? "",
        arguments: block.input ?? {},
      });
    }
  }

  return {
    text,
    stopReason: json.stop_reason,
    inputTokens: json.usage?.input_tokens,
    outputTokens: json.usage?.output_tokens,
    cacheReadTokens: json.usage?.cache_read_input_tokens,
    cacheWriteTokens: json.usage?.cache_creation_input_tokens,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    timings: {
      responseHeadersMs: Math.round(headersReceived - requestStarted),
      totalMs: Math.round(completed - requestStarted),
    },
  };
}

export async function readAnthropicMessagesStream(
  response: Response,
  onTextDelta: (delta: string) => void,
  now: () => number,
  requestStarted: number,
  headersReceived: number,
  abortSignal?: AbortSignal,
): Promise<{
  text: string;
  aborted: boolean;
  stopReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  toolCalls?: WorkbenchToolCall[];
  timings: WorkbenchCallTimings;
}> {
  if (!response.body) {
    throw new Error("Streaming model response did not include a response body");
  }

  const reader = response.body.getReader();
  let text = "";
  let stopReason: string | undefined;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let cacheReadTokens: number | undefined;
  let cacheWriteTokens: number | undefined;
  let firstTokenAt: number | undefined;

  const applyEvent = (event: AnthropicStreamEvent) => {
    if (event.textDelta) {
      firstTokenAt ??= now();
      text += event.textDelta;
      onTextDelta(event.textDelta);
    }
    if (event.stopReason) stopReason = event.stopReason;
    if (event.inputTokens !== undefined) {
      inputTokens = Math.max(inputTokens ?? 0, event.inputTokens);
    }
    if (event.outputTokens !== undefined) {
      outputTokens = Math.max(outputTokens ?? 0, event.outputTokens);
    }
    if (event.cacheReadTokens !== undefined) {
      cacheReadTokens = Math.max(
        cacheReadTokens ?? 0,
        event.cacheReadTokens,
      );
    }
    if (event.cacheWriteTokens !== undefined) {
      cacheWriteTokens = Math.max(
        cacheWriteTokens ?? 0,
        event.cacheWriteTokens,
      );
    }
  };

  const parseAndApplyStreamLine = (line: string) => {
    try {
      const event = parseAnthropicStreamLine(line);
      if (event && !event.done) applyEvent(event);
    } catch (error) {
      void reader.cancel().catch(() => {});
      throw error;
    }
  };

  const aborted = await readSseLines(
    reader,
    abortSignal,
    parseAndApplyStreamLine,
  );

  const completed = now();
  return {
    text,
    aborted,
    stopReason,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    timings: {
      responseHeadersMs: Math.round(headersReceived - requestStarted),
      timeToFirstTokenMs: firstTokenAt === undefined
        ? undefined
        : Math.round(firstTokenAt - requestStarted),
      generationMs: firstTokenAt === undefined
        ? undefined
        : Math.round(completed - firstTokenAt),
      totalMs: Math.round(completed - requestStarted),
    },
  };
}
