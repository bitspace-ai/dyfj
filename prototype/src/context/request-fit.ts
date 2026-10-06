/**
 * Request fitting: the arithmetic that decides whether a provider request
 * fits the model's context window, and the projections that make it fit —
 * bounding a fresh tool result against the window left for the turn, and
 * shrinking earlier tool results to a short prefix plus a marker the model
 * can read. Pure: the token estimator is injected, nothing here touches the
 * store or a provider.
 *
 * Shrinking is a projection of what the model is sent, never a rewrite of
 * the durable `tool_call` events: the audit copy keeps the result (within
 * its own column limit) and the request builder decides what the model sees.
 */

import type { WorkbenchMessage } from "../providers/mod.ts";

/**
 * The share of the input budget the estimate may fill. The estimator counts
 * four characters per token, which undercounts code and JSON; the margin
 * keeps a request the estimate says fits from being one the provider
 * rejects.
 */
export const CONTEXT_FIT_MARGIN = 0.95;

/**
 * The output reserve when the request transmits no output cap (a local
 * OpenAI-compatible request with none requested: the server's own limit
 * applies, and it counts the prompt alone), and the most of the window
 * that default may take on a small window.
 */
export const DEFAULT_OUTPUT_RESERVE_TOKENS = 2_048;
export const OUTPUT_RESERVE_MAX_FRACTION = 0.25;

/** What a shrunk tool result keeps: enough to recall what it was. */
export const SHRUNK_TOOL_RESULT_CHARS = 1_024;

/**
 * Room the marker may take. A cut that would save less than this is not
 * made: it would replace content with a marker of the same size, and it is
 * what keeps a second pass over an already-trimmed result from re-trimming
 * it with a marker that misstates the original size.
 */
export const TRIM_MARKER_ALLOWANCE_CHARS = 512;

/**
 * The least a fresh tool result keeps when the window is nearly full: the
 * fit step shrinks older results to make room before this one is reduced
 * further, so a tight share never erases a result outright.
 */
export const MIN_TOOL_RESULT_CHARS = 1_024;

/** The estimator's inverse, for turning a token allowance into characters. */
const CHARS_PER_TOKEN = 4;

/** A token estimate for a request's text, injected by the caller. */
export type TokenEstimator = (text: string) => number;

/**
 * The input tokens a request may carry on `contextWindow`: the window less
 * the output reserve, then the margin. The reserve is the output cap the
 * request transmits, in full — a provider that counts the cap against the
 * window refuses input + cap over it, so a smaller reserve admits a
 * request the provider rejects — or, when the request transmits none, the
 * default bounded to a quarter of the window. A cap at or over the window
 * leaves no budget: no request fits such a row, and the overflow error
 * says so.
 */
export function requestInputBudget(
  contextWindow: number,
  transmittedOutputCap: number | undefined,
): number {
  const reserve = transmittedOutputCap ?? Math.min(
    DEFAULT_OUTPUT_RESERVE_TOKENS,
    Math.floor(contextWindow * OUTPUT_RESERVE_MAX_FRACTION),
  );
  return Math.max(
    0,
    Math.floor((contextWindow - reserve) * CONTEXT_FIT_MARGIN),
  );
}

/**
 * What an adapter puts on the wire: the transcript with the tool
 * definitions (OpenAI-compatible, Anthropic), or only the system prompt and
 * the current prompt (Gemini, which sends no history and no tools).
 */
export type RequestWire = "transcript" | "prompt_only";

/**
 * The text a request contributes to the estimate, by what its adapter
 * sends: the system prompt, the transcript and the tool definitions the
 * request offers, or the system prompt and the prompt alone. Tool
 * definitions are part of the fixed prefix every transcript call carries
 * and are not small — a full catalog is thousands of tokens — so an
 * estimate without them fits on paper and overflows on the wire.
 */
export function requestEstimateText(
  systemPrompt: string,
  messages: readonly WorkbenchMessage[],
  tools: readonly unknown[] | undefined,
  wire: RequestWire = "transcript",
): string {
  if (wire === "prompt_only") {
    const prompt = messages[currentTurnStart(messages)];
    return `${systemPrompt}\n${prompt?.role === "user" ? prompt.content : ""}`;
  }
  const body = messages
    .map((m) =>
      m.role === "assistant"
        ? m.content + (m.toolCalls ? JSON.stringify(m.toolCalls) : "")
        : m.content
    )
    .join("\n");
  const toolText = tools === undefined || tools.length === 0
    ? ""
    : `\n${JSON.stringify(tools)}`;
  return `${systemPrompt}\n${body}${toolText}`;
}

/** The remaining-window hint the model gets with a trimmed result. */
function recoveryHint(commandId: string): string {
  switch (commandId) {
    case "read_file":
      return "Re-read the file in smaller pieces with read_file's offset and limit.";
    case "grep_files":
    case "glob_files":
    case "list_files":
    case "memory.search":
    case "web_search":
      return "Re-run the search with a narrower query or path.";
    case "bash":
    case "git":
      return "Re-run the command with its output narrowed, for example piped " +
        "through head, tail or grep.";
    default:
      return "Re-run the tool with narrower arguments.";
  }
}

/**
 * The marker a trimmed result ends with: code-authored text the model can
 * act on, stating what survived, what was cut, and how to get the rest.
 */
export function trimmedResultMarker(
  commandId: string,
  contextWindow: number,
  keptChars: number,
  totalChars: number,
): string {
  return `\n\n[Workbench trimmed this ${commandId} result to fit the model's ` +
    `${contextWindow}-token context window: the first ${keptChars} of ` +
    `${totalChars} characters are shown; the rest was cut. ` +
    `${recoveryHint(commandId)}]`;
}

export interface TrimmedResult {
  content: string;
  keptChars: number;
  totalChars: number;
}

/**
 * The marker's exact shape, anchored at the end of a result, so a result
 * trimmed once (bounded when it was produced) can be trimmed again with
 * its original size intact rather than the marker counted as payload.
 * Consulted only for a result whose message carries `trimmedFrom`: text
 * alone is not provenance, and a result whose own output ends like the
 * marker is payload like any other.
 */
const TRIM_MARKER_AT_END =
  /\n\n\[Workbench trimmed this \S+ result to fit the model's \d+-token context window: the first \d+ of (\d+) characters are shown; the rest was cut\. [^\]\n]*\]$/;

/** A result already trimmed: its payload before the marker, and its original size. */
export function parseTrimmedResult(
  content: string,
): { payload: string; totalChars: number } | null {
  const match = TRIM_MARKER_AT_END.exec(content);
  if (match === null) return null;
  const totalChars = Number.parseInt(match[1], 10);
  if (!Number.isSafeInteger(totalChars)) return null;
  return { payload: content.slice(0, match.index), totalChars };
}

/**
 * Keep the first `keepChars` characters of a tool result, on a code-point
 * boundary, followed by the marker. A result trimmed before (`trimmedFrom`
 * set by the engine when it cut it) is cut on its payload and keeps
 * reporting its original size; without that provenance the whole content
 * is payload, whatever it ends with. Returns null when the result already
 * fits, or when the cut would save no more than the marker costs, so a
 * result is never marked as trimmed when nothing worth cutting was cut.
 */
export function trimToolResult(
  content: string,
  keepChars: number,
  commandId: string,
  contextWindow: number,
  trimmedFrom?: number,
): TrimmedResult | null {
  const prior = trimmedFrom === undefined ? null : parseTrimmedResult(content);
  const payload = prior?.payload ?? content;
  const totalChars = trimmedFrom ?? content.length;
  if (payload.length <= keepChars + TRIM_MARKER_ALLOWANCE_CHARS) return null;
  let cut = Math.max(0, keepChars);
  // Never split a surrogate pair: back off one unit when the cut would land
  // between a high surrogate and its low half.
  const code = payload.charCodeAt(cut - 1);
  if (cut > 0 && code >= 0xd800 && code <= 0xdbff) cut -= 1;
  const kept = payload.slice(0, cut);
  return {
    content: kept +
      trimmedResultMarker(commandId, contextWindow, kept.length, totalChars),
    keptChars: kept.length,
    totalChars,
  };
}

/**
 * The share of the window one tool result may take when it is produced:
 * what remains after the request so far, divided among the calls still to
 * run in the step (so parallel reads split the room evenly, and a small
 * result leaves its share to the next), never below the floor.
 */
export function toolResultShareChars(
  remainingTokens: number,
  callsRemaining: number,
): number {
  const remainingChars = Math.max(0, remainingTokens) * CHARS_PER_TOKEN;
  return Math.max(
    MIN_TOOL_RESULT_CHARS,
    Math.floor(remainingChars / Math.max(1, callsRemaining)),
  );
}

/** The index of the message that starts the current turn: its prompt. */
export function currentTurnStart(
  messages: readonly WorkbenchMessage[],
): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return i;
  }
  return 0;
}

export interface ToolResultTrim {
  index: number;
  commandId: string;
  callId: string;
  keptChars: number;
  totalChars: number;
}

/**
 * Shrink tool results in `messages[from, to)`, oldest first, until
 * `estimate(messages)` is within `budget` or every candidate is shrunk.
 * Returns a new array and the trims applied; the input is not mutated.
 * A result already shrunk is left alone (`trimToolResult`), so a second
 * pass over a fitted transcript changes nothing.
 */
export function shrinkToolResults(
  messages: readonly WorkbenchMessage[],
  range: { from: number; to: number },
  budget: number,
  estimate: (messages: readonly WorkbenchMessage[]) => number,
  contextWindow: number,
): { messages: WorkbenchMessage[]; trims: ToolResultTrim[] } {
  const out = [...messages];
  const trims: ToolResultTrim[] = [];
  if (estimate(out) <= budget) return { messages: out, trims };
  for (
    let i = Math.max(0, range.from);
    i < Math.min(out.length, range.to);
    i++
  ) {
    const message = out[i];
    if (message.role !== "tool") continue;
    const trimmed = trimToolResult(
      message.content,
      SHRUNK_TOOL_RESULT_CHARS,
      message.name,
      contextWindow,
      message.trimmedFrom,
    );
    if (trimmed === null) continue;
    out[i] = {
      ...message,
      content: trimmed.content,
      trimmedFrom: trimmed.totalChars,
    };
    trims.push({
      index: i,
      commandId: message.name,
      callId: message.toolCallId,
      keptChars: trimmed.keptChars,
      totalChars: trimmed.totalChars,
    });
    if (estimate(out) <= budget) break;
  }
  return { messages: out, trims };
}

/**
 * The longest prefix of whole turns of `elder` whose compression input the
 * compressor can take (`estimate(prefix) <= budget`), and what is left.
 * A turn begins at each user message (THE TURN-COUNTING INVARIANT); the
 * cut lands on one so the retained count stays meaningful on resume. A
 * prefix that is only an earlier summary is nothing to compress — a summary
 * of a summary makes no room — so it is returned empty. An elder whose
 * first turn alone is over the budget is also returned empty: the caller
 * declines rather than send it.
 */
export function compressibleSlice(
  elder: readonly WorkbenchMessage[],
  budget: number,
  estimate: (messages: readonly WorkbenchMessage[]) => number,
  isSummary: (message: WorkbenchMessage) => boolean,
): { slice: WorkbenchMessage[]; remainder: WorkbenchMessage[] } {
  const boundaries: number[] = [];
  for (let i = 1; i < elder.length; i++) {
    if (elder[i].role === "user") boundaries.push(i);
  }
  boundaries.push(elder.length);
  let end = 0;
  for (const boundary of boundaries) {
    if (estimate(elder.slice(0, boundary)) > budget) break;
    end = boundary;
  }
  const slice = elder.slice(0, end);
  if (slice.every(isSummary)) return { slice: [], remainder: [...elder] };
  return { slice, remainder: elder.slice(end) };
}
