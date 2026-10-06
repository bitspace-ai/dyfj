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
 * The output reserve when the catalog declares no output cap, and the most
 * of the window any reserve may take: a row whose output cap equals its
 * window must still leave room for input.
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
 * the output reserve (the requested output cap, bounded to a quarter of the
 * window; a default when the catalog declares none), then the margin.
 */
export function requestInputBudget(
  contextWindow: number,
  outputCap: number | undefined,
): number {
  const reserve = Math.min(
    outputCap ?? DEFAULT_OUTPUT_RESERVE_TOKENS,
    Math.floor(contextWindow * OUTPUT_RESERVE_MAX_FRACTION),
  );
  return Math.floor((contextWindow - reserve) * CONTEXT_FIT_MARGIN);
}

/**
 * The text a request contributes to the estimate: the system prompt, the
 * transcript and the tool definitions the request offers. Tool definitions
 * are part of the fixed prefix every call carries and are not small — a
 * full catalog is thousands of tokens — so an estimate without them fits
 * on paper and overflows on the wire.
 */
export function requestEstimateText(
  systemPrompt: string,
  messages: readonly WorkbenchMessage[],
  tools: readonly unknown[] | undefined,
): string {
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
 * Keep the first `keepChars` characters of a tool result, on a code-point
 * boundary, followed by the marker. Returns null when the result already
 * fits, or when the cut would save no more than the marker costs, so a
 * result is never marked as trimmed when nothing worth cutting was cut.
 */
export function trimToolResult(
  content: string,
  keepChars: number,
  commandId: string,
  contextWindow: number,
): TrimmedResult | null {
  const totalChars = content.length;
  if (totalChars <= keepChars + TRIM_MARKER_ALLOWANCE_CHARS) return null;
  let cut = Math.max(0, keepChars);
  // Never split a surrogate pair: back off one unit when the cut would land
  // between a high surrogate and its low half.
  const code = content.charCodeAt(cut - 1);
  if (cut > 0 && code >= 0xd800 && code <= 0xdbff) cut -= 1;
  const kept = content.slice(0, cut);
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
    );
    if (trimmed === null) continue;
    out[i] = { ...message, content: trimmed.content };
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
