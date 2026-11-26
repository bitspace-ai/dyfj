/**
 * Text tool-call extraction: recovering tool calls a model emitted as
 * `<tool_call><function=...>` markup instead of structured calls, and the
 * streaming-side helpers that withhold and strip that markup. Moved verbatim
 * from the single-file provider module with `export` keywords added; since
 * then `detectUnparsedToolCallMarkup` also counts function elements in
 * complete blocks left unrun, pinned by fixtures from captured model replies
 * (BIT-564), and the DeepSeek DSML dialect joins the Qwen one as a second
 * recoverable spelling (`dsml-tool-calls.ts`, BIT-991). Refactor it only with
 * fixture coverage from real captured model outputs.
 */
import { canonicalJson } from "../../kernel/mod.ts";
import type {
  WorkbenchToolCall,
  WorkbenchToolDefinition,
  WorkbenchTurnResult,
} from "../types.ts";
import {
  countUnparsedDsmlMarkup,
  DSML_MARKER_COUNTS,
  dsmlPossibleStart,
  dsmlRecoverableStart,
  dsmlTruncatedBlockStart,
  extractDsmlToolCalls,
} from "./dsml-tool-calls.ts";
import { coerceToolArgument } from "./text-markup-arguments.ts";
import {
  MAX_DSML_MARKUP_TOKENS,
  MAX_TEXT_TOOL_MARKUP_CANDIDATES,
  MAX_TEXT_TOOL_WRAPPER_WHITESPACE,
  MAX_UNPARSED_TOOL_CALL_MARKERS,
  MAX_UNPARSED_TOOL_CALL_SCAN_CHARACTERS,
} from "./text-markup-bounds.ts";
import { toolWireNames } from "./tool-names.ts";

export {
  MAX_DSML_MARKUP_TOKENS,
  MAX_TEXT_TOOL_MARKUP_CANDIDATES,
  MAX_UNPARSED_TOOL_CALL_MARKERS,
  MAX_UNPARSED_TOOL_CALL_SCAN_CHARACTERS,
} from "./text-markup-bounds.ts";
export { toolArgumentWithinBudget } from "./text-markup-arguments.ts";

export function canonicalToolCallSignature(
  call: WorkbenchToolCall,
): string | undefined {
  const argumentsJson = canonicalJson(call.arguments);
  return argumentsJson === undefined
    ? undefined
    : `${call.name}\0${argumentsJson}`;
}

const TEXT_FUNCTION_RE = /<function=([^>\s]+)\s{0,32}>([\s\S]*?)<\/function>/g;
const TEXT_PARAM_RE = /<parameter=([^>\s]+)\s*>([\s\S]*?)<\/parameter>/g;
export const TEXT_FUNCTION_MARKER = "<function=";
export const TEXT_PARAMETER_MARKER = "<parameter=";
const TEXT_FUNCTION_CLOSING = "</function>";
const UNPARSED_TOOL_CALL_OPENING = "<tool_call>";
const UNPARSED_TOOL_CALL_CLOSING = "</tool_call>";
const TEXT_TOOL_WRAPPER_OPENING = "<tool_call>";
const TEXT_TOOL_WRAPPER_CLOSING = "</tool_call>";

/** One recovered unit of markup: a span to remove and the calls it carried. */
interface RecoveredTextBlock {
  start: number;
  end: number;
  calls: { name: string; arguments: Record<string, unknown> }[];
}

/**
 * Detect tool-call markup that remains in the text after textual-call
 * recovery, and so ran no tool. Two dialects count, each in the shapes that
 * mean structure rather than prose:
 *
 * - Qwen `<tool_call>`: a function element in a complete block (a
 *   `<function=NAME>` opening followed by `</function>` inside a `<tool_call>`
 *   wrapper that then closes), or at least two exact wrapper openings left
 *   unmatched by closings. One stray opening is not structural evidence.
 * - DeepSeek DSML: each whole `calls` / `function_calls` block left in the
 *   text, and each such block the text cuts off once it has revealed DSML
 *   structure past its opening.
 *
 * For either dialect a balanced wrapper with no element inside stays prose.
 * Markers are processed in order, so a closing matches only the latest
 * preceding open wrapper; leading closings cannot cancel later openings. Each
 * open Qwen wrapper owns the function evidence found directly inside it, so an
 * element counts once, toward the innermost wrapper, whatever the order of
 * nesting; a function element a wrapper close interrupts counts nothing.
 * Inputs beyond the accepted-response bound are not prefix-classified; the
 * whole-text scan is linear and the reported count remains bounded.
 */
export function detectUnparsedToolCallMarkup(
  text: string,
): WorkbenchTurnResult["unparsedToolCallMarkup"] {
  if (text.length > MAX_UNPARSED_TOOL_CALL_SCAN_CHARACTERS) return undefined;
  const qwen = countUnparsedQwenMarkup(text);
  const dsml = countUnparsedDsmlMarkup(text);
  const count = qwen.count + dsml.count;
  if (count === 0) return undefined;
  return {
    count: Math.min(count, MAX_UNPARSED_TOOL_CALL_MARKERS),
    countIsLowerBound: count > MAX_UNPARSED_TOOL_CALL_MARKERS ||
      qwen.countIsLowerBound || dsml.countIsLowerBound,
  };
}

function countUnparsedQwenMarkup(
  text: string,
): { count: number; countIsLowerBound: boolean } {
  const openWrappers: OpenToolCallWrapper[] = [];
  let unrunFunctionCount = 0;
  let openingAt = text.indexOf(UNPARSED_TOOL_CALL_OPENING);
  let closingAt = text.indexOf(UNPARSED_TOOL_CALL_CLOSING);
  let functionAt = text.indexOf(TEXT_FUNCTION_MARKER);
  let functionClosingAt = text.indexOf(TEXT_FUNCTION_CLOSING);
  for (;;) {
    const at = earliestMarker(
      openingAt,
      closingAt,
      functionAt,
      functionClosingAt,
    );
    if (at < 0) break;
    const innermost = openWrappers.at(-1);
    if (at === openingAt) {
      openWrappers.push({ functionPending: false, closedFunctions: 0 });
      openingAt = text.indexOf(
        UNPARSED_TOOL_CALL_OPENING,
        openingAt + UNPARSED_TOOL_CALL_OPENING.length,
      );
    } else if (at === closingAt) {
      unrunFunctionCount += openWrappers.pop()?.closedFunctions ?? 0;
      closingAt = text.indexOf(
        UNPARSED_TOOL_CALL_CLOSING,
        closingAt + UNPARSED_TOOL_CALL_CLOSING.length,
      );
    } else if (at === functionAt) {
      if (innermost && isTextFunctionOpening(text, functionAt)) {
        innermost.functionPending = true;
      }
      functionAt = text.indexOf(
        TEXT_FUNCTION_MARKER,
        functionAt + TEXT_FUNCTION_MARKER.length,
      );
    } else {
      if (innermost?.functionPending) {
        innermost.functionPending = false;
        innermost.closedFunctions += 1;
      }
      functionClosingAt = text.indexOf(
        TEXT_FUNCTION_CLOSING,
        functionClosingAt + TEXT_FUNCTION_CLOSING.length,
      );
    }
  }
  const unmatchedOpeningCount = openWrappers.length >= 2
    ? openWrappers.length
    : 0;
  const count = unrunFunctionCount + unmatchedOpeningCount;
  if (count === 0) return { count: 0, countIsLowerBound: false };
  return {
    count: Math.min(count, MAX_UNPARSED_TOOL_CALL_MARKERS),
    countIsLowerBound: count > MAX_UNPARSED_TOOL_CALL_MARKERS,
  };
}

/** Function evidence owned by one open `<tool_call>` wrapper. */
interface OpenToolCallWrapper {
  /** A function opening seen inside this wrapper awaits its `</function>`. */
  functionPending: boolean;
  /** Function elements opened and closed directly inside this wrapper. */
  closedFunctions: number;
}

function earliestMarker(...positions: number[]): number {
  let earliest = -1;
  for (const position of positions) {
    if (position >= 0 && (earliest < 0 || position < earliest)) {
      earliest = position;
    }
  }
  return earliest;
}

/**
 * Whether `<function=` at `at` opens a function element as recovery reads
 * one: a non-empty name, bounded whitespace, then `>`. The name stops at `<`
 * so that scans from successive markers never overlap.
 */
function isTextFunctionOpening(text: string, at: number): boolean {
  const nameStart = at + TEXT_FUNCTION_MARKER.length;
  let nameEnd = nameStart;
  while (
    nameEnd < text.length &&
    text[nameEnd] !== ">" &&
    text[nameEnd] !== "<" &&
    text[nameEnd].trim().length > 0
  ) {
    nameEnd++;
  }
  if (nameEnd === nameStart) return false;
  let openingEnd = nameEnd;
  while (
    openingEnd < text.length &&
    openingEnd - nameEnd < MAX_TEXT_TOOL_WRAPPER_WHITESPACE &&
    text[openingEnd].trim().length === 0
  ) {
    openingEnd++;
  }
  return text[openingEnd] === ">";
}

function exceedsTextToolMarkupCandidateLimit(
  text: string,
  marker: string,
  limit: number,
): boolean {
  let count = 0;
  let searchFrom = 0;
  for (;;) {
    const found = text.indexOf(marker, searchFrom);
    if (found < 0) return false;
    count++;
    if (count > limit) return true;
    searchFrom = found + marker.length;
  }
}

/**
 * Whether the text holds more than `limit` occurrences of the markers taken
 * together. Markers are separate spellings of one construct, so they share one
 * budget; none is a prefix of another, so no occurrence is counted twice.
 */
function exceedsTextToolMarkupCandidateLimitsFor(
  text: string,
  markers: readonly string[],
  limit: number,
): boolean {
  let count = 0;
  for (const marker of markers) {
    let searchFrom = 0;
    for (;;) {
      const found = text.indexOf(marker, searchFrom);
      if (found < 0) break;
      count++;
      if (count > limit) return true;
      searchFrom = found + marker.length;
    }
  }
  return false;
}

function exceedsTextToolMarkupCandidateLimits(text: string): boolean {
  return exceedsTextToolMarkupCandidateLimit(
    text,
    TEXT_FUNCTION_MARKER,
    MAX_TEXT_TOOL_MARKUP_CANDIDATES,
  ) ||
    exceedsTextToolMarkupCandidateLimit(
      text,
      TEXT_PARAMETER_MARKER,
      MAX_TEXT_TOOL_MARKUP_CANDIDATES,
    ) ||
    exceedsTextToolMarkupCandidateLimitsFor(
      text,
      DSML_MARKER_COUNTS,
      MAX_DSML_MARKUP_TOKENS,
    );
}

/**
 * Count occurrences of any of `markers` in the delta, carrying the tail one may
 * straddle. Several spellings of one construct share the count, so the tail is
 * the longest marker's overlap rather than any single one's.
 */
export function countNewTextToolMarkupCandidates(
  tail: string,
  delta: string,
  markers: readonly string[],
  remaining: number,
): { count: number; tail: string } {
  const combined = tail + delta;
  let count = 0;
  let longest = 1;
  for (const marker of markers) {
    longest = Math.max(longest, marker.length);
    let searchFrom = 0;
    for (;;) {
      const found = combined.indexOf(marker, searchFrom);
      if (found < 0) break;
      count++;
      if (count > remaining) break;
      searchFrom = found + marker.length;
    }
    if (count > remaining) break;
  }
  return {
    count,
    tail: combined.slice(-(longest - 1)),
  };
}

/**
 * Read the Qwen `<tool_call><function=…>` blocks recovery can run, as spans
 * over the text. A block is recoverable when the wrapper opens at the function
 * element, closes after it, and (given the offered names) names an offered
 * tool.
 */
function qwenToolCallBlocks(
  text: string,
  offeredNames?: ReadonlySet<string>,
): { blocks: RecoveredTextBlock[]; unrecoverable: boolean } {
  const blocks: RecoveredTextBlock[] = [];
  let unrecoverable = false;
  let consumedThrough = 0;
  const fn = new RegExp(TEXT_FUNCTION_RE);
  let wrapper = -1;
  let nextWrapper = text.indexOf(TEXT_TOOL_WRAPPER_OPENING);
  let match: RegExpExecArray | null;
  while ((match = fn.exec(text)) !== null) {
    while (nextWrapper >= 0 && nextWrapper < match.index) {
      wrapper = nextWrapper;
      nextWrapper = text.indexOf(
        TEXT_TOOL_WRAPPER_OPENING,
        nextWrapper + TEXT_TOOL_WRAPPER_OPENING.length,
      );
    }
    let hasAssociatedWrapper = false;
    if (wrapper >= consumedThrough) {
      let contentStart = wrapper + TEXT_TOOL_WRAPPER_OPENING.length;
      while (
        contentStart < match.index &&
        contentStart - (wrapper + TEXT_TOOL_WRAPPER_OPENING.length) <
          MAX_TEXT_TOOL_WRAPPER_WHITESPACE &&
        text[contentStart].trim().length === 0
      ) {
        contentStart++;
      }
      hasAssociatedWrapper = contentStart === match.index;
    }
    let markupEnd = match.index + match[0].length;
    let closingStart = markupEnd;
    while (
      closingStart < text.length &&
      text[closingStart].trim().length === 0
    ) {
      closingStart++;
    }
    const hasClosingWrapper = text.startsWith(
      TEXT_TOOL_WRAPPER_CLOSING,
      closingStart,
    );
    if (
      offeredNames !== undefined &&
      (
        !offeredNames.has(match[1]) ||
        !hasAssociatedWrapper ||
        !hasClosingWrapper
      )
    ) {
      wrapper = -1;
      continue;
    }
    const args: Record<string, unknown> = {};
    const params = new RegExp(TEXT_PARAM_RE);
    let p: RegExpExecArray | null;
    let recoverable = true;
    while ((p = params.exec(match[2])) !== null) {
      const value = coerceToolArgument(p[2].trim());
      if (!value.ok) {
        recoverable = false;
        break;
      }
      args[p[1]] = value.value;
    }
    if (!recoverable) {
      unrecoverable = true;
      wrapper = -1;
      continue;
    }
    const markupStart = hasAssociatedWrapper ? wrapper : match.index;
    if (hasClosingWrapper) {
      markupEnd = closingStart + TEXT_TOOL_WRAPPER_CLOSING.length;
    }
    blocks.push({
      start: markupStart,
      end: markupEnd,
      calls: [{ name: match[1], arguments: args }],
    });
    consumedThrough = markupEnd;
    wrapper = -1;
  }
  return { blocks, unrecoverable };
}

/**
 * Recover tool calls that a model emitted as text instead of structured
 * tool_calls, in either dialect it is known to leak: the Qwen
 * `<tool_call><function=NAME>…</function></tool_call>` block and the DeepSeek
 * DSML block (`dsml-tool-calls.ts`). Runtime recovery requires the complete
 * explicit wrapper of whichever dialect, so unwrapped, incomplete, and
 * unoffered function-like prose is not executable. The recovered calls come
 * back in the order their markup appeared, and the returned text is the input
 * with those spans removed.
 */
export function extractTextToolCallsInternal(
  text: string,
  offeredNames?: ReadonlySet<string>,
  preserveWhitespace = false,
): {
  toolCalls: WorkbenchToolCall[];
  cleaned: string;
  unrecoverable: boolean;
} {
  if (exceedsTextToolMarkupCandidateLimits(text)) {
    return { toolCalls: [], cleaned: text, unrecoverable: false };
  }
  const qwen = qwenToolCallBlocks(text, offeredNames);
  const dsml = extractDsmlToolCalls(text, offeredNames);
  // A Qwen block whose arguments could not be read fails the whole Qwen
  // reading closed: the caller gets no Qwen call and the Qwen markup stays in
  // the text, so a reply that offered a call the reader could not type is
  // never half-executed. The DSML dialect is read independently, so a block it
  // can recover whole is still recovered.
  const blocks = [...(qwen.unrecoverable ? [] : qwen.blocks), ...dsml.removals]
    .sort((a, b) => a.start - b.start);
  const unrecoverable = qwen.unrecoverable || dsml.unrecoverable;
  const kept: RecoveredTextBlock[] = [];
  let through = 0;
  for (const block of blocks) {
    if (block.start < through) continue;
    kept.push(block);
    through = block.end;
  }
  if (kept.length === 0) return { toolCalls: [], cleaned: text, unrecoverable };
  const retained: string[] = [];
  let retainedThrough = 0;
  for (const block of kept) {
    retained.push(text.slice(retainedThrough, block.start));
    retainedThrough = block.end;
  }
  retained.push(text.slice(retainedThrough));
  const retainedText = retained.join("");
  const calls = kept.flatMap((block) => block.calls);
  return {
    toolCalls: calls.map((call, index) => ({
      id: `text-tool-${index + 1}`,
      name: call.name,
      arguments: call.arguments,
    })),
    cleaned: preserveWhitespace ? retainedText : retainedText.trim(),
    unrecoverable: false,
  };
}

export function extractTextToolCalls(
  text: string,
  offeredNames?: ReadonlySet<string>,
): { toolCalls: WorkbenchToolCall[]; cleaned: string } {
  const { toolCalls, cleaned } = extractTextToolCallsInternal(
    text,
    offeredNames,
  );
  return { toolCalls, cleaned };
}

/** The earliest DSML markup the reader may withhold from, or -1. */
export function dsmlPossibleMarkupStart(
  text: string,
  tools: WorkbenchToolDefinition[] | undefined,
): number {
  if (!tools || tools.length === 0) return -1;
  return dsmlPossibleStart(text, offeredWireNames(tools));
}

/** The earliest DSML markup a reader can stop withholding for, or -1. */
export function dsmlRecoverableMarkupStart(
  text: string,
  tools: WorkbenchToolDefinition[] | undefined,
): number {
  if (!tools || tools.length === 0) return -1;
  return dsmlRecoverableStart(text, offeredWireNames(tools));
}

/** The earliest Qwen markup the reader may withhold from, or -1. */
export function qwenPossibleTextToolMarkupStart(
  text: string,
  tools: WorkbenchToolDefinition[] | undefined,
): number {
  if (!tools || tools.length === 0) return -1;
  const offered = toolWireNames(tools).map(({ wire }) => wire);
  const maxUndecidedPrefix = TEXT_FUNCTION_MARKER.length +
    Math.max(...offered.map((name) => name.length)) +
    (2 * MAX_TEXT_TOOL_WRAPPER_WHITESPACE);
  let wrapper = text.indexOf(TEXT_TOOL_WRAPPER_OPENING);
  while (wrapper >= 0) {
    const rawAfterWrapper = wrapper + TEXT_TOOL_WRAPPER_OPENING.length;
    let afterWrapper = rawAfterWrapper;
    while (
      afterWrapper < text.length &&
      afterWrapper - rawAfterWrapper < MAX_TEXT_TOOL_WRAPPER_WHITESPACE &&
      text[afterWrapper].trim().length === 0
    ) {
      afterWrapper++;
    }
    const wrapperGapIsBounded = afterWrapper - rawAfterWrapper <=
        MAX_TEXT_TOOL_WRAPPER_WHITESPACE &&
      (
        afterWrapper === text.length ||
        text[afterWrapper].trim().length > 0
      );
    if (
      wrapperGapIsBounded &&
      text.length - rawAfterWrapper <= maxUndecidedPrefix
    ) {
      if (afterWrapper === text.length) return wrapper;
      const undecided = text.slice(afterWrapper);
      if (TEXT_FUNCTION_MARKER.startsWith(undecided)) return wrapper;
      if (text.startsWith(TEXT_FUNCTION_MARKER, afterWrapper)) {
        const functionStart = afterWrapper + TEXT_FUNCTION_MARKER.length;
        let functionEnd = functionStart;
        while (
          functionEnd < text.length &&
          text[functionEnd] !== ">" &&
          text[functionEnd].trim().length > 0
        ) {
          functionEnd++;
        }
        const fragment = text.slice(functionStart, functionEnd);
        if (fragment.length === 0) return wrapper;
        if (
          functionEnd === text.length &&
          offered.some((name) => name.startsWith(fragment))
        ) {
          return wrapper;
        }
        if (
          text[functionEnd] === ">" &&
          offered.includes(fragment)
        ) {
          return wrapper;
        }
        let openingEnd = functionEnd;
        while (
          openingEnd < text.length &&
          openingEnd - functionEnd < MAX_TEXT_TOOL_WRAPPER_WHITESPACE &&
          text[openingEnd].trim().length === 0
        ) {
          openingEnd++;
        }
        if (
          offered.includes(fragment) &&
          openingEnd - functionEnd <= MAX_TEXT_TOOL_WRAPPER_WHITESPACE &&
          (
            openingEnd === text.length ||
            text[openingEnd] === ">"
          )
        ) {
          return wrapper;
        }
      }
    }
    wrapper = text.indexOf(TEXT_TOOL_WRAPPER_OPENING, wrapper + 1);
  }
  const partial = text.lastIndexOf("<tool_call");
  return partial >= 0 &&
      TEXT_TOOL_WRAPPER_OPENING.startsWith(text.slice(partial))
    ? partial
    : -1;
}

function offeredWireNames(
  tools: WorkbenchToolDefinition[] | undefined,
): Set<string> | undefined {
  return tools && tools.length > 0
    ? new Set(toolWireNames(tools).map(({ wire }) => wire))
    : undefined;
}

/** The earliest Qwen markup recovery can run, or -1. */
export function qwenConfirmedMarkupStart(
  text: string,
  tools: WorkbenchToolDefinition[] | undefined,
): number {
  if (!tools || tools.length === 0) return -1;
  const offered = new Set(toolWireNames(tools).map(({ wire }) => wire));
  const maxOfferedNameLength = Math.max(
    ...[...offered].map((name) => name.length),
  );
  let wrapper = text.indexOf(TEXT_TOOL_WRAPPER_OPENING);
  while (wrapper >= 0) {
    const rawOpeningStart = wrapper + TEXT_TOOL_WRAPPER_OPENING.length;
    let openingStart = rawOpeningStart;
    while (
      openingStart < text.length &&
      openingStart - rawOpeningStart < MAX_TEXT_TOOL_WRAPPER_WHITESPACE &&
      text[openingStart].trim().length === 0
    ) {
      openingStart++;
    }
    if (
      openingStart - rawOpeningStart <= MAX_TEXT_TOOL_WRAPPER_WHITESPACE &&
      text.startsWith(TEXT_FUNCTION_MARKER, openingStart)
    ) {
      const nameStart = openingStart + TEXT_FUNCTION_MARKER.length;
      let nameEnd = nameStart;
      while (
        nameEnd < text.length &&
        nameEnd - nameStart <= maxOfferedNameLength &&
        text[nameEnd] !== ">" &&
        text[nameEnd].trim().length > 0
      ) {
        nameEnd++;
      }
      let openingEnd = nameEnd;
      while (
        openingEnd < text.length &&
        openingEnd - nameEnd < MAX_TEXT_TOOL_WRAPPER_WHITESPACE &&
        text[openingEnd].trim().length === 0
      ) {
        openingEnd++;
      }
      if (
        nameEnd - nameStart <= maxOfferedNameLength &&
        text[openingEnd] === ">" &&
        offered.has(text.slice(nameStart, nameEnd))
      ) {
        return wrapper;
      }
    }
    wrapper = text.indexOf(TEXT_TOOL_WRAPPER_OPENING, wrapper + 1);
  }
  return -1;
}

function recognizedIncompleteTextToolMarkupStart(
  text: string,
  tools: WorkbenchToolDefinition[] | undefined,
): number {
  if (!tools || tools.length === 0) return -1;
  const offered = toolWireNames(tools).map(({ wire }) => wire);
  const maxOfferedNameLength = Math.max(...offered.map((name) => name.length));
  let wrapper = text.indexOf(TEXT_TOOL_WRAPPER_OPENING);
  while (wrapper >= 0) {
    const rawOpeningStart = wrapper + TEXT_TOOL_WRAPPER_OPENING.length;
    let openingStart = rawOpeningStart;
    while (
      openingStart < text.length &&
      openingStart - rawOpeningStart < MAX_TEXT_TOOL_WRAPPER_WHITESPACE &&
      text[openingStart].trim().length === 0
    ) {
      openingStart++;
    }
    if (
      openingStart - rawOpeningStart <= MAX_TEXT_TOOL_WRAPPER_WHITESPACE &&
      text.startsWith(TEXT_FUNCTION_MARKER, openingStart)
    ) {
      const nameStart = openingStart + TEXT_FUNCTION_MARKER.length;
      let nameEnd = nameStart;
      while (
        nameEnd < text.length &&
        nameEnd - nameStart <= maxOfferedNameLength &&
        text[nameEnd] !== ">" &&
        text[nameEnd].trim().length > 0
      ) {
        nameEnd++;
      }
      const fragment = text.slice(nameStart, nameEnd);
      let openingEnd = nameEnd;
      while (
        openingEnd < text.length &&
        openingEnd - nameEnd < MAX_TEXT_TOOL_WRAPPER_WHITESPACE &&
        text[openingEnd].trim().length === 0
      ) {
        openingEnd++;
      }
      const openingCanStillFinish = nameEnd === text.length ||
        text[nameEnd] === ">" ||
        (
          text[nameEnd]?.trim().length === 0 &&
          (openingEnd === text.length || text[openingEnd] === ">")
        );
      const offeredNameMatches = nameEnd === text.length
        ? offered.some((name) => name.startsWith(fragment))
        : offered.includes(fragment);
      if (
        fragment.length > 0 &&
        openingCanStillFinish &&
        offeredNameMatches
      ) {
        return wrapper;
      }
    }
    wrapper = text.indexOf(TEXT_TOOL_WRAPPER_OPENING, wrapper + 1);
  }
  return -1;
}

/**
 * Strip a trailing text tool call the reply cut off. Recovery removes every
 * complete block; what remains is stripped only where a delivered reply could
 * still be holding markup the presenter never forwarded: an incomplete Qwen
 * call, or a DSML block the text ends inside while the reader would still be
 * withholding it (`dsmlTruncatedBlockStart`). A block that arrived whole and
 * simply did not follow the dialect is prose, and prose the presenter already
 * forwarded is never cut, because the caller's emitted text must be a prefix
 * of what it returns.
 */
export function stripIncompleteTextToolCallSuffix(
  text: string,
  tools: WorkbenchToolDefinition[] | undefined,
): string {
  if (!tools || tools.length === 0) return text;
  if (exceedsTextToolMarkupCandidateLimits(text)) return text;
  const offered = new Set(toolWireNames(tools).map(({ wire }) => wire));
  const dsmlCut = dsmlTruncatedBlockStart(text, offered);
  // A withheld DSML block runs to the end of the reply, so nothing after its
  // start was forwarded - but recovery also removes complete calls that sit
  // *inside* that withheld span, because it reads each dialect independently of
  // the other. The withheld suffix is therefore not `text.length - dsmlCut`
  // characters of the text with complete calls removed; it is shorter by
  // whatever was removed inside it, which is how the cut once landed inside
  // forwarded prose or past the start of the string. Strip the prefix alone, so
  // no removed span can sit past the cut.
  const source = dsmlCut < 0 ? text : text.slice(0, dsmlCut);
  return stripCompleteCallsAndIncompleteQwenSuffix(source, tools, offered) ??
    text;
}

/**
 * The delivered text for one span: every complete recovered call removed, then
 * any trailing incomplete Qwen call. Undefined when recovery found markup it
 * could not run, which leaves the caller to decide what to deliver.
 */
function stripCompleteCallsAndIncompleteQwenSuffix(
  text: string,
  tools: WorkbenchToolDefinition[],
  offered: ReadonlySet<string>,
): string | undefined {
  const extraction = extractTextToolCallsInternal(text, offered, true);
  if (extraction.unrecoverable) return undefined;
  const withoutCompleteCalls = extraction.cleaned;
  const confirmed = qwenConfirmedMarkupStart(withoutCompleteCalls, tools);
  const incomplete = confirmed >= 0
    ? confirmed
    : recognizedIncompleteTextToolMarkupStart(withoutCompleteCalls, tools);
  const qwenKeep = incomplete < 0 ? withoutCompleteCalls.length : incomplete;
  return withoutCompleteCalls.slice(0, qwenKeep);
}
