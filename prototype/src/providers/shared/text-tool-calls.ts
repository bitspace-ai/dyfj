/**
 * Text tool-call extraction: recovering tool calls a model emitted as
 * `<tool_call><function=...>` markup instead of structured calls, and the
 * streaming-side helpers that withhold and strip that markup. Moved verbatim
 * from the single-file provider module with `export` keywords added; since
 * then `detectUnparsedToolCallMarkup` also counts complete blocks left unrun,
 * pinned by fixtures from captured model replies (BIT-564). Refactor it only
 * with fixture coverage from real captured model outputs.
 */
import {
  canonicalJson,
  MAX_CANONICAL_JSON_CHARACTERS,
  MAX_CANONICAL_JSON_DEPTH,
  MAX_CANONICAL_JSON_ENTRIES,
} from "../../kernel/mod.ts";
import type {
  WorkbenchToolCall,
  WorkbenchToolDefinition,
  WorkbenchTurnResult,
} from "../types.ts";
import { MAX_OPENAI_RESPONSE_BYTES } from "./response-bounds.ts";
import { toolWireNames } from "./tool-names.ts";

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
const MAX_TEXT_TOOL_WRAPPER_WHITESPACE = 32;
export const MAX_TEXT_TOOL_MARKUP_CANDIDATES = 64;
export const TEXT_FUNCTION_MARKER = "<function=";
export const TEXT_PARAMETER_MARKER = "<parameter=";
const TEXT_FUNCTION_CLOSING = "</function>";
const UNPARSED_TOOL_CALL_OPENING = "<tool_call>";
const UNPARSED_TOOL_CALL_CLOSING = "</tool_call>";
export const MAX_UNPARSED_TOOL_CALL_MARKERS = 64;
/**
 * Equal-valued character bound for the OpenAI adapter's 4 MiB response-byte
 * ceiling. UTF-8 decoding cannot produce more UTF-16 code units than input
 * bytes, and JSON unescaping only contracts the representation, so model text
 * from an accepted response fits this whole-text bound.
 */
export const MAX_UNPARSED_TOOL_CALL_SCAN_CHARACTERS = MAX_OPENAI_RESPONSE_BYTES;

/**
 * Detect tool-call markup that remains in the text after textual-call
 * recovery, and so ran no tool. Two shapes count:
 *
 * - a function element in a complete block: a `<function=NAME>` opening
 *   followed by `</function>` inside a `<tool_call>` wrapper that then
 *   closes. Recovery removes every block it runs, so an element left behind
 *   went unrun: no tools were offered (a forced conclusion), the name was not
 *   offered, or its arguments were unrecoverable;
 * - the degraded Qwen-compatible shape: at least two exact wrapper openings
 *   left unmatched by closings. One stray opening is not structural evidence.
 *
 * A balanced wrapper with no function element stays prose. Markers are
 * processed in order, so a closing matches only the latest preceding open
 * wrapper; leading closings cannot cancel later openings. Each open wrapper
 * owns the function evidence found directly inside it, so an element counts
 * once, toward the innermost wrapper, whatever the order of nesting; a
 * function element a wrapper close interrupts counts nothing. Inputs beyond
 * the accepted-response bound are not prefix-classified; the whole-text scan
 * is linear and the reported count remains bounded.
 */
export function detectUnparsedToolCallMarkup(
  text: string,
): WorkbenchTurnResult["unparsedToolCallMarkup"] {
  if (text.length > MAX_UNPARSED_TOOL_CALL_SCAN_CHARACTERS) return undefined;
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
  if (count === 0) return undefined;
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
): boolean {
  let count = 0;
  let searchFrom = 0;
  for (;;) {
    const found = text.indexOf(marker, searchFrom);
    if (found < 0) return false;
    count++;
    if (count > MAX_TEXT_TOOL_MARKUP_CANDIDATES) return true;
    searchFrom = found + marker.length;
  }
}

function exceedsTextToolMarkupCandidateLimits(text: string): boolean {
  return exceedsTextToolMarkupCandidateLimit(text, TEXT_FUNCTION_MARKER) ||
    exceedsTextToolMarkupCandidateLimit(text, TEXT_PARAMETER_MARKER);
}

export function countNewTextToolMarkupCandidates(
  tail: string,
  delta: string,
  marker: string,
  remaining: number,
): { count: number; tail: string } {
  const combined = tail + delta;
  let count = 0;
  let searchFrom = 0;
  for (;;) {
    const found = combined.indexOf(marker, searchFrom);
    if (found < 0) break;
    count++;
    if (count > remaining) break;
    searchFrom = found + marker.length;
  }
  return {
    count,
    tail: combined.slice(-(marker.length - 1)),
  };
}

type CoercedParamValue =
  | { ok: true; value: unknown }
  | { ok: false };

export function toolArgumentWithinBudget(raw: string): boolean {
  if (raw.length > MAX_CANONICAL_JSON_CHARACTERS) return false;
  let depth = 0;
  let entries = 1;
  let inString = false;
  let escaped = false;
  for (const character of raw) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "{" || character === "[") {
      depth += 1;
      entries += 1;
      if (
        depth > MAX_CANONICAL_JSON_DEPTH ||
        entries > MAX_CANONICAL_JSON_ENTRIES
      ) return false;
    } else if (character === "}" || character === "]") {
      depth -= 1;
    } else if (character === ",") {
      entries += 1;
      if (entries > MAX_CANONICAL_JSON_ENTRIES) return false;
    }
  }
  return true;
}

function coerceParamValue(raw: string): CoercedParamValue {
  if (!toolArgumentWithinBudget(raw)) return { ok: false };
  if (raw === "") return { ok: true, value: "" };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: true, value: raw };
  }
}

/**
 * Recover tool calls that a model emitted as text instead of structured
 * tool_calls. Qwen3-Coder (via mlx_lm) frequently leaks its native XML dialect
 * into the content — `<tool_call><function=NAME>…</function></tool_call>` —
 * which the inference server does not parse. Runtime recovery requires the
 * complete explicit wrapper, so unwrapped, incomplete, and unoffered
 * function-like prose is not executable.
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
  const toolCalls: WorkbenchToolCall[] = [];
  let unrecoverable = false;
  const retained: string[] = [];
  let retainedThrough = 0;
  const fn = new RegExp(TEXT_FUNCTION_RE);
  const wrapperTag = "<tool_call>";
  let wrapper = -1;
  let nextWrapper = text.indexOf(wrapperTag);
  let match: RegExpExecArray | null;
  while ((match = fn.exec(text)) !== null) {
    while (nextWrapper >= 0 && nextWrapper < match.index) {
      wrapper = nextWrapper;
      nextWrapper = text.indexOf(wrapperTag, nextWrapper + wrapperTag.length);
    }
    let hasAssociatedWrapper = false;
    if (wrapper >= retainedThrough) {
      let contentStart = wrapper + wrapperTag.length;
      while (
        contentStart < match.index &&
        contentStart - (wrapper + wrapperTag.length) <
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
    const hasClosingWrapper = text.startsWith("</tool_call>", closingStart);
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
      const value = coerceParamValue(p[2].trim());
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
    toolCalls.push({
      id: `text-tool-${toolCalls.length + 1}`,
      name: match[1],
      arguments: args,
    });
    const markupStart = hasAssociatedWrapper ? wrapper : match.index;
    if (hasClosingWrapper) {
      markupEnd = closingStart + "</tool_call>".length;
    }
    retained.push(text.slice(retainedThrough, markupStart));
    retainedThrough = markupEnd;
    wrapper = -1;
  }
  if (unrecoverable || toolCalls.length === 0) {
    return { toolCalls: [], cleaned: text, unrecoverable };
  }
  retained.push(text.slice(retainedThrough));
  const retainedText = retained.join("");
  const cleaned = preserveWhitespace ? retainedText : retainedText.trim();
  return { toolCalls, cleaned, unrecoverable: false };
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

function textToolMarkupStart(
  text: string,
  tools: WorkbenchToolDefinition[] | undefined,
): number {
  if (!tools || tools.length === 0) return -1;
  const offered = toolWireNames(tools).map(({ wire }) => wire);
  const maxUndecidedPrefix = "<function=".length +
    Math.max(...offered.map((name) => name.length)) +
    (2 * MAX_TEXT_TOOL_WRAPPER_WHITESPACE);
  let wrapper = text.indexOf("<tool_call>");
  while (wrapper >= 0) {
    const rawAfterWrapper = wrapper + "<tool_call>".length;
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
      if ("<function=".startsWith(undecided)) return wrapper;
      if (text.startsWith("<function=", afterWrapper)) {
        const functionStart = afterWrapper + "<function=".length;
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
    wrapper = text.indexOf("<tool_call>", wrapper + 1);
  }
  const partial = text.lastIndexOf("<tool_call");
  return partial >= 0 &&
      "<tool_call>".startsWith(text.slice(partial))
    ? partial
    : -1;
}

export function possibleTextToolMarkupStart(
  text: string,
  tools: WorkbenchToolDefinition[] | undefined,
): number {
  return textToolMarkupStart(text, tools);
}

export function confirmedTextToolMarkupStart(
  text: string,
  tools: WorkbenchToolDefinition[] | undefined,
): number {
  if (!tools || tools.length === 0) return -1;
  const offered = new Set(toolWireNames(tools).map(({ wire }) => wire));
  const maxOfferedNameLength = Math.max(
    ...[...offered].map((name) => name.length),
  );
  let wrapper = text.indexOf("<tool_call>");
  while (wrapper >= 0) {
    const rawOpeningStart = wrapper + "<tool_call>".length;
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
      text.startsWith("<function=", openingStart)
    ) {
      const nameStart = openingStart + "<function=".length;
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
    wrapper = text.indexOf("<tool_call>", wrapper + 1);
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
  let wrapper = text.indexOf("<tool_call>");
  while (wrapper >= 0) {
    const rawOpeningStart = wrapper + "<tool_call>".length;
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
      text.startsWith("<function=", openingStart)
    ) {
      const nameStart = openingStart + "<function=".length;
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
    wrapper = text.indexOf("<tool_call>", wrapper + 1);
  }
  return -1;
}

export function stripIncompleteTextToolCallSuffix(
  text: string,
  tools: WorkbenchToolDefinition[] | undefined,
): string {
  if (!tools || tools.length === 0) return text;
  if (exceedsTextToolMarkupCandidateLimits(text)) return text;
  const offered = new Set(toolWireNames(tools).map(({ wire }) => wire));
  const extraction = extractTextToolCallsInternal(
    text,
    offered,
    true,
  );
  if (extraction.unrecoverable) return text;
  const withoutCompleteCalls = extraction.cleaned;
  const confirmed = confirmedTextToolMarkupStart(withoutCompleteCalls, tools);
  const incomplete = confirmed >= 0
    ? confirmed
    : recognizedIncompleteTextToolMarkupStart(withoutCompleteCalls, tools);
  return incomplete < 0
    ? withoutCompleteCalls
    : withoutCompleteCalls.slice(0, incomplete);
}
