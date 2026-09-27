/**
 * Gemini response reading: SSE line parsing, the buffered JSON reader, and the
 * streaming reader. Thinking parts are counted as reasoning, never as text.
 */
import { DomainError } from "../../contract/mod.ts";
import type { WorkbenchCallTimings } from "../types.ts";
import { readSseLines } from "../shared/sse.ts";
import { finiteNonnegativeTokenCount } from "../shared/tokens.ts";

export interface GeminiStreamEvent {
  done: boolean;
  textDelta?: string;
  reasoningCharacters?: number;
  stopReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
}

export function parseGeminiStreamLine(line: string): GeminiStreamEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || !trimmed.startsWith("data:")) return null;

  const json = JSON.parse(trimmed.slice("data:".length).trim()) as {
    error?: unknown;
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string; thought?: boolean }> };
      finishReason?: string;
    }>;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      thoughtsTokenCount?: number;
    };
  };
  if (Object.hasOwn(json, "error")) {
    throw new DomainError("Gemini stream returned an error envelope");
  }
  const candidate = json.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  // Exclude thinking parts: reasoning content is not answer text.
  const textDelta = parts
    .filter((part) => !part.thought)
    .map((part) => part.text ?? "")
    .join("") || undefined;
  const reasoningCharacters = parts
    .filter((part) => part.thought)
    .reduce((total, part) => total + (part.text?.length ?? 0), 0);
  return {
    done: false,
    textDelta,
    ...(reasoningCharacters > 0 ? { reasoningCharacters } : {}),
    stopReason: candidate?.finishReason,
    inputTokens: json.usageMetadata?.promptTokenCount,
    outputTokens: json.usageMetadata?.candidatesTokenCount,
    // Thinking tokens draw from maxOutputTokens but are not visible output;
    // length-stop classification needs them to see true budget consumption.
    reasoningTokens: json.usageMetadata?.thoughtsTokenCount,
  };
}

export async function readGeminiJson(
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
  reasoningTokens?: number;
  usageTextCharacters?: number;
  timings: WorkbenchCallTimings;
}> {
  const json = await response.json() as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string; thought?: boolean }> };
      finishReason?: string;
    }>;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      thoughtsTokenCount?: number;
    };
  };
  const completed = now();
  const candidate = json.candidates?.[0];
  // Exclude thinking parts: reasoning content is not answer text.
  const text = (candidate?.content?.parts ?? [])
    .filter((part) => !part.thought)
    .map((part) => part.text ?? "")
    .join("");

  return {
    text,
    stopReason: candidate?.finishReason,
    inputTokens: json.usageMetadata?.promptTokenCount,
    outputTokens: json.usageMetadata?.candidatesTokenCount,
    reasoningTokens: json.usageMetadata?.thoughtsTokenCount,
    timings: {
      responseHeadersMs: Math.round(headersReceived - requestStarted),
      totalMs: Math.round(completed - requestStarted),
    },
  };
}

export async function readGeminiStream(
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
  reasoningTokens?: number;
  reasoningCharacters: number;
  usageReasoningCharacters?: number;
  usageTextCharacters?: number;
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
  let reasoningTokens: number | undefined;
  let reasoningCharacters = 0;
  let usageReasoningCharacters: number | undefined;
  let usageTextCharacters: number | undefined;
  let firstTokenAt: number | undefined;

  const applyEvent = (event: GeminiStreamEvent) => {
    if (event.textDelta) {
      firstTokenAt ??= now();
      text += event.textDelta;
      onTextDelta(event.textDelta);
    }
    reasoningCharacters += event.reasoningCharacters ?? 0;
    if (event.stopReason) stopReason = event.stopReason;
    const previousOutput = finiteNonnegativeTokenCount(outputTokens);
    const incomingOutput = finiteNonnegativeTokenCount(event.outputTokens);
    const previousReasoning = finiteNonnegativeTokenCount(reasoningTokens);
    const incomingReasoning = finiteNonnegativeTokenCount(
      event.reasoningTokens,
    );
    if (event.inputTokens !== undefined) {
      inputTokens = Math.max(inputTokens ?? 0, event.inputTokens);
    }
    if (incomingOutput !== undefined) {
      outputTokens = Math.max(previousOutput ?? 0, incomingOutput);
    }
    if (incomingReasoning !== undefined) {
      reasoningTokens = Math.max(previousReasoning ?? 0, incomingReasoning);
    }
    if (
      incomingReasoning !== undefined &&
      (previousReasoning === undefined ||
        incomingReasoning > previousReasoning ||
        (incomingReasoning === previousReasoning &&
          event.stopReason !== undefined))
    ) {
      usageReasoningCharacters = reasoningCharacters;
    }
    if (
      incomingOutput !== undefined &&
      (previousOutput === undefined || incomingOutput > previousOutput ||
        (incomingOutput === previousOutput && event.stopReason !== undefined))
    ) {
      usageTextCharacters = text.length;
    }
  };

  const parseAndApplyStreamLine = (line: string) => {
    try {
      const event = parseGeminiStreamLine(line);
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
    reasoningTokens,
    reasoningCharacters,
    usageReasoningCharacters,
    usageTextCharacters,
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
