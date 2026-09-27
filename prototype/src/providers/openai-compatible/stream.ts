/**
 * OpenAI-compatible streaming: SSE line parsing and the streaming reader that
 * accumulates structured tool-call deltas and withholds recoverable text
 * tool-call markup from live output.
 */
import { MAX_CANONICAL_JSON_CHARACTERS } from "../../kernel/mod.ts";
import { DomainError } from "../../contract/mod.ts";
import type {
  WorkbenchCallTimings,
  WorkbenchToolCall,
  WorkbenchToolDefinition,
} from "../types.ts";
import { isAbortFromSignal } from "../shared/abort.ts";
import { isIncompleteSseDataLine } from "../shared/sse.ts";
import {
  MAX_OPENAI_RESPONSE_BYTES,
  MAX_OPENAI_RESPONSE_CHUNKS,
  MAX_OPENAI_RESPONSE_READS,
} from "../shared/response-bounds.ts";
import {
  confirmedTextToolMarkupStart,
  countNewTextToolMarkupCandidates,
  extractTextToolCallsInternal,
  MAX_TEXT_TOOL_MARKUP_CANDIDATES,
  possibleTextToolMarkupStart,
  stripIncompleteTextToolCallSuffix,
  TEXT_FUNCTION_MARKER,
  TEXT_PARAMETER_MARKER,
} from "../shared/text-tool-calls.ts";
import { finiteNonnegativeTokenCount } from "../shared/tokens.ts";
import { toolWireNames } from "../shared/tool-names.ts";
import {
  MAX_STRUCTURED_TOOL_CALLS,
  MAX_STRUCTURED_TOOL_NAME_CHARACTERS,
  type OpenAIChatStreamEvent,
  type OpenAIChatUsage,
  parseToolArguments,
} from "./response.ts";

export function parseOpenAIChatStreamLine(
  line: string,
): OpenAIChatStreamEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || !trimmed.startsWith("data:")) return null;

  const data = trimmed.slice("data:".length).trim();
  if (data === "[DONE]") return { done: true };

  const json = JSON.parse(data) as {
    error?: unknown;
    choices?: Array<{
      delta?: {
        content?: string;
        reasoning?: string;
        reasoning_content?: string;
        reasoning_details?: Array<{
          type?: string;
          text?: string;
          summary?: string;
        }>;
        tool_calls?: Array<{
          index?: number;
          id?: string;
          type?: string;
          function?: { name?: string; arguments?: string };
        }>;
      };
      message?: {
        content?: string;
        reasoning?: string;
        reasoning_content?: string;
        reasoning_details?: Array<{
          type?: string;
          text?: string;
          summary?: string;
        }>;
      };
      finish_reason?: string;
    }>;
    usage?: OpenAIChatUsage;
  };
  if (Object.hasOwn(json, "error")) {
    throw new DomainError("Provider stream returned an error envelope");
  }
  const choice = json.choices?.[0];
  const reasoningDetails = choice?.delta?.reasoning_details ??
    choice?.message?.reasoning_details;
  const structuredReasoning = reasoningDetails
    ?.map((detail) =>
      detail.type === "reasoning.text"
        ? detail.text ?? ""
        : detail.type === "reasoning.summary"
        ? detail.summary ?? ""
        : ""
    )
    .join("");
  const legacyReasoning = choice?.delta?.reasoning ??
    choice?.delta?.reasoning_content ?? choice?.message?.reasoning ??
    choice?.message?.reasoning_content;
  const rawToolCalls = choice?.delta?.tool_calls;
  if (rawToolCalls && rawToolCalls.length > MAX_STRUCTURED_TOOL_CALLS) {
    throw new DomainError("Provider returned too many structured tool calls");
  }
  const toolCallDeltas = rawToolCalls && rawToolCalls.length > 0
    ? rawToolCalls.map((tc, i) => ({
      index: tc.index ?? i,
      id: tc.id,
      name: tc.function?.name,
      argumentsFragment: tc.function?.arguments,
    }))
    : undefined;
  return {
    done: false,
    textDelta: choice?.delta?.content ?? choice?.message?.content ?? undefined,
    reasoningDelta: structuredReasoning || legacyReasoning || undefined,
    toolCallDeltas,
    finishReason: choice?.finish_reason ?? undefined,
    usage: json.usage,
  };
}

export async function readOpenAIChatStream(
  response: Response,
  onTextDelta: (delta: string) => void,
  now: () => number,
  requestStarted: number,
  headersReceived: number,
  abortSignal?: AbortSignal,
  tools?: WorkbenchToolDefinition[],
): Promise<{
  text: string;
  visibleText: string;
  reasoningCharacters: number;
  toolCallCharacters: number;
  usageGeneratedCharacters?: number;
  usageReasoningCharacters?: number;
  usageCompletionReasoningCharacters?: number;
  aborted: boolean;
  finishReason?: string;
  usage?: OpenAIChatUsage;
  // The OpenAI-compatible stream carries tool calls as indexed deltas, which
  // this reader accumulates — so a streamed turn can both stream text and
  // request tools (unlike the Anthropic/Google streaming readers).
  toolCalls?: WorkbenchToolCall[];
  timings: WorkbenchCallTimings;
}> {
  if (!response.body) {
    throw new Error("Streaming model response did not include a response body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let lineFragments: string[] = [];
  let text = "";
  let reasoningCharacters = 0;
  let toolCallCharacters = 0;
  let finishReason: string | undefined;
  let usage: OpenAIChatUsage | undefined;
  let usageGeneratedCharacters: number | undefined;
  let usageReasoningCharacters: number | undefined;
  let usageCompletionReasoningCharacters: number | undefined;
  let firstTokenAt: number | undefined;
  // Withhold a recognized offered-tool wrapper until it closes. Recoverable
  // markup stays hidden; trailing prose resumes immediately after the close.
  let suppressing = false;
  let sawTextToolMarkup = false;
  let textToolRecoveryDisabled = !tools || tools.length === 0;
  let functionCandidates = 0;
  let parameterCandidates = 0;
  let functionCandidateTail = "";
  let parameterCandidateTail = "";
  let forwardedLength = 0;
  let forwardedText = "";
  let closingSearchFrom = 0;
  let receivedBytes = 0;
  let receivedChunks = 0;
  let receivedReads = 0;
  let structuredToolNameCharacters = 0;
  let aborted = false;

  const offeredNames = tools
    ? new Set(toolWireNames(tools).map(({ wire }) => wire))
    : undefined;
  const emitTextDelta = (delta: string) => {
    if (delta.length === 0) return;
    forwardedText += delta;
    onTextDelta(delta);
  };
  const forwardAvailableText = () => {
    while (forwardedLength < text.length) {
      if (textToolRecoveryDisabled) {
        emitTextDelta(text.slice(forwardedLength));
        forwardedLength = text.length;
        return;
      }
      if (suppressing) {
        const closing = text.indexOf("</tool_call>", closingSearchFrom);
        if (closing < 0) {
          closingSearchFrom = Math.max(
            forwardedLength,
            text.length - "</tool_call>".length + 1,
          );
          return;
        }
        const end = closing + "</tool_call>".length;
        const candidate = text.slice(forwardedLength, end);
        const extraction = extractTextToolCallsInternal(
          candidate,
          offeredNames,
          true,
        );
        if (extraction.unrecoverable || extraction.toolCalls.length === 0) {
          emitTextDelta(candidate);
        } else {
          sawTextToolMarkup = true;
        }
        forwardedLength = end;
        suppressing = false;
        closingSearchFrom = end;
        continue;
      }
      const pending = text.slice(forwardedLength);
      const confirmed = confirmedTextToolMarkupStart(pending, tools);
      if (confirmed >= 0) {
        if (confirmed > 0) {
          emitTextDelta(pending.slice(0, confirmed));
          forwardedLength += confirmed;
        }
        suppressing = true;
        closingSearchFrom = forwardedLength;
        continue;
      }
      const possible = possibleTextToolMarkupStart(pending, tools);
      const safeEnd = possible >= 0 ? forwardedLength + possible : text.length;
      if (safeEnd > forwardedLength) {
        emitTextDelta(text.slice(forwardedLength, safeEnd));
        forwardedLength = safeEnd;
      }
      return;
    }
  };

  // Tool calls arrive as deltas keyed by index; id/name land in the first
  // fragment for that index and arguments stream as string fragments (MLX sends
  // the whole call in one delta, hosted OpenAI fragments it — both accumulate).
  const toolAcc = new Map<
    number,
    { id?: string; name?: string; args: string }
  >();

  const applyEvent = (event: OpenAIChatStreamEvent) => {
    if (event.reasoningDelta) {
      reasoningCharacters += event.reasoningDelta.length;
    }
    if (event.textDelta) {
      firstTokenAt ??= now();
      if (!textToolRecoveryDisabled) {
        const functionUpdate = countNewTextToolMarkupCandidates(
          functionCandidateTail,
          event.textDelta,
          TEXT_FUNCTION_MARKER,
          MAX_TEXT_TOOL_MARKUP_CANDIDATES - functionCandidates,
        );
        functionCandidateTail = functionUpdate.tail;
        functionCandidates += functionUpdate.count;
        const parameterUpdate = countNewTextToolMarkupCandidates(
          parameterCandidateTail,
          event.textDelta,
          TEXT_PARAMETER_MARKER,
          MAX_TEXT_TOOL_MARKUP_CANDIDATES - parameterCandidates,
        );
        parameterCandidateTail = parameterUpdate.tail;
        parameterCandidates += parameterUpdate.count;
      }
      text += event.textDelta;
      if (
        !textToolRecoveryDisabled &&
        (
          functionCandidates > MAX_TEXT_TOOL_MARKUP_CANDIDATES ||
          parameterCandidates > MAX_TEXT_TOOL_MARKUP_CANDIDATES
        )
      ) {
        if (sawTextToolMarkup) {
          throw new DomainError(
            "Provider returned too many textual tool-call markers",
          );
        }
        textToolRecoveryDisabled = true;
        suppressing = false;
      }
      forwardAvailableText();
    }
    for (const delta of event.toolCallDeltas ?? []) {
      if (
        !toolAcc.has(delta.index) &&
        toolAcc.size >= MAX_STRUCTURED_TOOL_CALLS
      ) {
        throw new DomainError(
          "Provider returned too many structured tool calls",
        );
      }
      const acc = toolAcc.get(delta.index) ?? { args: "" };
      if (delta.id) acc.id = delta.id;
      if (delta.name) {
        structuredToolNameCharacters += delta.name.length;
        if (
          structuredToolNameCharacters >
            MAX_STRUCTURED_TOOL_NAME_CHARACTERS
        ) {
          throw new DomainError(
            "Provider returned too many structured tool calls",
          );
        }
        acc.name = (acc.name ?? "") + delta.name;
        toolCallCharacters += delta.name.length;
      }
      if (delta.argumentsFragment) {
        toolCallCharacters += delta.argumentsFragment.length;
        if (
          acc.args.length + delta.argumentsFragment.length >
            MAX_CANONICAL_JSON_CHARACTERS
        ) {
          throw new DomainError("Provider returned oversized tool arguments");
        }
        acc.args += delta.argumentsFragment;
      }
      toolAcc.set(delta.index, acc);
    }
    if (event.finishReason) finishReason = event.finishReason;
    if (event.usage) {
      const previousPrompt = finiteNonnegativeTokenCount(usage?.prompt_tokens);
      const incomingPrompt = finiteNonnegativeTokenCount(
        event.usage.prompt_tokens,
      );
      const previousCompletion = finiteNonnegativeTokenCount(
        usage?.completion_tokens,
      );
      const incomingCompletion = finiteNonnegativeTokenCount(
        event.usage.completion_tokens,
      );
      const previousReasoning = finiteNonnegativeTokenCount(
        usage?.completion_tokens_details?.reasoning_tokens,
      );
      const incomingReasoning = finiteNonnegativeTokenCount(
        event.usage.completion_tokens_details?.reasoning_tokens,
      );
      usage = {
        ...(previousPrompt !== undefined || incomingPrompt !== undefined
          ? {
            prompt_tokens: Math.max(previousPrompt ?? 0, incomingPrompt ?? 0),
          }
          : {}),
        ...(previousCompletion !== undefined || incomingCompletion !== undefined
          ? {
            completion_tokens: Math.max(
              previousCompletion ?? 0,
              incomingCompletion ?? 0,
            ),
          }
          : {}),
        ...(previousReasoning !== undefined || incomingReasoning !== undefined
          ? {
            completion_tokens_details: {
              reasoning_tokens: Math.max(
                previousReasoning ?? 0,
                incomingReasoning ?? 0,
              ),
            },
          }
          : {}),
      };
      if (
        incomingCompletion !== undefined &&
        (previousCompletion === undefined ||
          incomingCompletion > previousCompletion ||
          (incomingCompletion === previousCompletion &&
            event.finishReason !== undefined))
      ) {
        usageGeneratedCharacters = text.length + toolCallCharacters;
        usageCompletionReasoningCharacters = reasoningCharacters;
      }
      if (
        incomingReasoning !== undefined &&
        (previousReasoning === undefined ||
          incomingReasoning > previousReasoning ||
          (incomingReasoning === previousReasoning &&
            event.finishReason !== undefined))
      ) {
        usageReasoningCharacters = reasoningCharacters;
      }
    }
  };

  const parseAndApplyStreamLine = async (line: string) => {
    try {
      const event = parseOpenAIChatStreamLine(line);
      if (event && !event.done) applyEvent(event);
    } catch (error) {
      void reader.cancel().catch(() => {});
      throw error;
    }
  };

  while (true) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (error) {
      if (!isAbortFromSignal(error, abortSignal)) throw error;
      aborted = true;
      break;
    }
    const { value, done } = chunk;
    if (done) {
      break;
    }
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
    const parts = decoder.decode(value, { stream: true }).split("\n");
    lineFragments.push(parts.shift() ?? "");
    for (const part of parts) {
      const line = lineFragments.join("");
      lineFragments = [part];
      await parseAndApplyStreamLine(line);
    }
  }
  if (!aborted) lineFragments.push(decoder.decode());
  const buffer = lineFragments.join("");
  if (buffer.trim().length > 0) {
    try {
      await parseAndApplyStreamLine(buffer);
    } catch (error) {
      if (!aborted || !isIncompleteSseDataLine(buffer, error)) throw error;
    }
  }
  aborted ||= abortSignal?.aborted === true;
  const deliverable = aborted || suppressing || sawTextToolMarkup
    ? stripIncompleteTextToolCallSuffix(text, tools)
    : text;
  if (!deliverable.startsWith(forwardedText)) {
    throw new DomainError("Provider stream presentation diverged");
  }
  emitTextDelta(deliverable.slice(forwardedText.length));

  const toolCalls: WorkbenchToolCall[] = [...toolAcc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, acc]) => {
      return {
        id: acc.id ?? `tool-call-${index + 1}`,
        name: acc.name ?? "",
        arguments: parseToolArguments(acc.args),
      };
    });

  const completed = now();
  return {
    text,
    visibleText: deliverable,
    reasoningCharacters,
    toolCallCharacters,
    usageGeneratedCharacters,
    usageReasoningCharacters,
    usageCompletionReasoningCharacters,
    aborted,
    finishReason,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage,
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
