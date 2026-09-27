// Response reading for the synthetic API family. Streams are SSE `data:`
// lines of typed events (`text`, `tool_call`, `done`, `error`); a buffered
// response is one JSON object.

import { DomainError } from "../../../src/contract/mod.ts";
import type {
  WorkbenchCallTimings,
  WorkbenchToolCall,
} from "../../../src/providers/mod.ts";
import { readSseLines } from "../../../src/providers/shared/sse.ts";

export interface SyntheticUsage {
  input?: number;
  output?: number;
}

export interface SyntheticRead {
  text: string;
  aborted: boolean;
  reason?: string;
  usage?: SyntheticUsage;
  toolCalls?: WorkbenchToolCall[];
  timings: WorkbenchCallTimings;
}

type SyntheticEvent =
  | { type: "text"; text: string }
  | {
    type: "tool_call";
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }
  | { type: "done"; reason?: string; usage?: SyntheticUsage }
  | { type: "error"; message?: string };

export function parseSyntheticStreamLine(line: string): SyntheticEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;
  const event = JSON.parse(trimmed.slice("data:".length)) as SyntheticEvent;
  if (event.type === "error") {
    throw new DomainError("Synthetic stream returned an error event");
  }
  return event;
}

export async function readSyntheticJson(
  response: Response,
  now: () => number,
  requestStarted: number,
  headersReceived: number,
): Promise<SyntheticRead> {
  const json = await response.json() as {
    text?: string;
    tool_calls?: WorkbenchToolCall[];
    reason?: string;
    usage?: SyntheticUsage;
  };
  const completed = now();
  return {
    text: json.text ?? "",
    aborted: false,
    reason: json.reason,
    usage: json.usage,
    toolCalls: json.tool_calls && json.tool_calls.length > 0
      ? json.tool_calls
      : undefined,
    timings: {
      responseHeadersMs: Math.round(headersReceived - requestStarted),
      totalMs: Math.round(completed - requestStarted),
    },
  };
}

export async function readSyntheticStream(
  response: Response,
  onTextDelta: (delta: string) => void,
  now: () => number,
  requestStarted: number,
  headersReceived: number,
  signal: AbortSignal | undefined,
): Promise<SyntheticRead> {
  if (!response.body) {
    throw new Error("Streaming model response did not include a response body");
  }
  const reader = response.body.getReader();
  let text = "";
  let reason: string | undefined;
  let usage: SyntheticUsage | undefined;
  let firstTokenAt: number | undefined;
  const toolCalls: WorkbenchToolCall[] = [];

  const aborted = await readSseLines(reader, signal, (line) => {
    let event: SyntheticEvent | null;
    try {
      event = parseSyntheticStreamLine(line);
    } catch (error) {
      void reader.cancel().catch(() => {});
      throw error;
    }
    if (event === null) return;
    if (event.type === "text") {
      firstTokenAt ??= now();
      text += event.text;
      onTextDelta(event.text);
    } else if (event.type === "tool_call") {
      toolCalls.push({
        id: event.id,
        name: event.name,
        arguments: event.arguments,
      });
    } else if (event.type === "done") {
      reason = event.reason;
      usage = event.usage;
    }
  });

  const completed = now();
  return {
    text,
    aborted,
    reason,
    usage,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
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
