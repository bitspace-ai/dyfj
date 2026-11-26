/**
 * DeepSeek DSML text tool-call markup: the parser and recovery scan for tool
 * calls a DeepSeek model wrote into its message text instead of a structured
 * `tool_calls` array.
 *
 * The dialect wraps one or more invokes in a `calls` (or `function_calls`)
 * element. Each tag is `<`, a separator, `DSML`, the same separator, an
 * optional space, then the element name and its attributes:
 *
 *     <sep>DSML<sep> calls>
 *     <sep>DSML<sep> invoke name="gate_wait">
 *     <sep>DSML<sep> parameter name="run" string="true">…closing parameter tag>
 *     <sep>DSML<sep> parameter name="wait_seconds" string="false">60</…>
 *     closing invoke tag
 *     closing calls tag
 *
 * The separator is the fullwidth vertical bar (U+FF5C) in the replies captured
 * live from DeepSeek V4.1 Flash 1017 via OpenRouter on 2026-11-24, and may be
 * the ASCII pipe on another tokenizer. The space after the separator is
 * optional. A `parameter`'s `string` attribute decides its reading: `"true"` is
 * literal text (multiline command lines included), `"false"` is JSON and must
 * parse.
 *
 * Every scan here is a linear walk over the text with bounded element counts,
 * so a hostile reply cannot make the parse quadratic or unbounded. The module
 * holds no policy about which tools may run: it reports what the markup says,
 * and the caller decides against the tools it offered.
 */
import { typedToolArgument } from "./text-markup-arguments.ts";
import {
  MAX_TEXT_TOOL_MARKUP_CANDIDATES,
  MAX_TEXT_TOOL_WRAPPER_WHITESPACE,
  MAX_UNPARSED_TOOL_CALL_MARKERS,
  MAX_UNPARSED_TOOL_CALL_SCAN_CHARACTERS,
} from "./text-markup-bounds.ts";

/** Fullwidth vertical bar (U+FF5C), the separator in the captured replies. */
const DSML_FULLWIDTH_PIPE = "\uFF5C";

/** The separator spellings an upstream may emit. */
const DSML_SEPARATORS = [DSML_FULLWIDTH_PIPE, "|"] as const;

/**
 * The run that marks a DSML tag, counted to bound markup scanning. Either
 * separator spelling holds it, so one counter covers both.
 */
export const DSML_MARKER_COUNT = "DSML";

/** Element names DSML uses. A tag with any other name is not DSML markup. */
const DSML_TAG_NAMES = new Set([
  "calls",
  "function_calls",
  "invoke",
  "parameter",
]);

/** Element names that open a block of invokes. */
const DSML_WRAPPER_NAMES = ["calls", "function_calls"] as const;

const DSML_TAG_OPENINGS = ["<", "</"] as const;

const MAX_DSML_NAME_LENGTH = 64;
const MAX_DSML_ATTRIBUTE_LENGTH = 512;
const MAX_DSML_ATTRIBUTES = 8;
const MAX_DSML_ELEMENTS = MAX_TEXT_TOOL_MARKUP_CANDIDATES + 1;

/** Longest separator on the wire, in UTF-16 code units. */
const MAX_DSML_SEPARATOR_LENGTH = Math.max(
  ...DSML_SEPARATORS.map((separator) => separator.length),
);

/**
 * Longest closing tag the parser accepts: `</`, a separator, `DSML`, the
 * separator, the space after it, the longest element name, the whitespace the
 * parser allows before `>`, and `>` itself. A reader that looks for a closing
 * wrapper only needs to re-read this many trailing characters of the text it
 * is withholding, so a block held across many deltas is probed in time linear
 * in the characters that arrived rather than in the withheld length.
 */
export const MAX_DSML_CLOSING_TAG_LENGTH = "</".length +
  MAX_DSML_SEPARATOR_LENGTH + DSML_MARKER_COUNT.length +
  MAX_DSML_SEPARATOR_LENGTH + (2 * MAX_TEXT_TOOL_WRAPPER_WHITESPACE) +
  Math.max(...[...DSML_TAG_NAMES].map((name) => name.length)) + ">".length;

function isDsmlSpace(character: string): boolean {
  return character === " " || character === "\t" || character === "\n" ||
    character === "\r" || character === "\f" || character === "\v";
}

function isDsmlNameCharacter(character: string): boolean {
  return /[A-Za-z0-9_-]/.test(character);
}

function isWrapperName(name: string): boolean {
  return (DSML_WRAPPER_NAMES as readonly string[]).includes(name);
}

/** A parsed DSML tag. */
interface DsmlTag {
  closing: boolean;
  name: string;
  attributes: Record<string, string>;
}

/** What a tag that the text ends inside revealed before it ran out. */
interface DsmlTagPrefix {
  closing: boolean;
  /** Characters read as the element name. */
  name: string;
  /** Whether the name was read to its end rather than to the text's end. */
  nameComplete: boolean;
  /** Whole attributes read before the text ended. */
  attributes: Record<string, string>;
  /** An attribute whose quoted value the text ends inside. */
  pendingAttribute?: { name: string; valuePrefix: string };
}

type DsmlTagParse =
  | { ok: true; tag: DsmlTag; end: number }
  | { ok: false; truncated: boolean; partial?: DsmlTagPrefix };

/**
 * The index of the next DSML tag opening at or after `from`, whichever
 * separator and whichever direction, or -1.
 */
function nextDsmlTagStart(text: string, from: number): number {
  let earliest = -1;
  for (const separator of DSML_SEPARATORS) {
    for (const lead of DSML_TAG_OPENINGS) {
      const token = `${lead}${separator}DSML${separator}`;
      const at = text.indexOf(token, from);
      if (at >= 0 && (earliest < 0 || at < earliest)) earliest = at;
    }
  }
  return earliest;
}

/**
 * The index of the next DSML closing-tag opening at or after `from`, whichever
 * separator and element name, or -1. A cheap gate a streaming reader can use
 * before paying for a whole-block parse.
 */
function dsmlClosingTagIndex(text: string, from: number): number {
  let earliest = -1;
  for (const separator of DSML_SEPARATORS) {
    const token = `</${separator}DSML${separator}`;
    const at = text.indexOf(token, from);
    if (at >= 0 && (earliest < 0 || at < earliest)) earliest = at;
  }
  return earliest;
}

/**
 * Index just past the first closing wrapper tag (`calls` or `function_calls`)
 * at or after `from`, or -1 while the text holds none. A reader that finds one
 * knows the block it is withholding has ended, so it parses the block once
 * instead of on every delta; the search itself is a cheap substring probe.
 */
export function dsmlWrapperClosingEnd(text: string, from: number): number {
  let at = dsmlClosingTagIndex(text, from);
  for (let seen = 0; at >= 0 && seen < MAX_TEXT_TOOL_MARKUP_CANDIDATES; seen++) {
    const parsed = parseDsmlTag(text, at);
    if (parsed.ok && parsed.tag.closing && isWrapperName(parsed.tag.name)) {
      return parsed.end;
    }
    if (parsed.ok) {
      at = dsmlClosingTagIndex(text, parsed.end);
      continue;
    }
    at = dsmlClosingTagIndex(text, at + 1);
  }
  return -1;
}

/**
 * How long a candidate block may stay undecided, in characters. A wrapper tag
 * and the invoke tag that follows it each fit well inside this: the longest
 * opening is `<`, a separator, `DSML`, the separator, a space, `function_calls`
 * and `>`, and the longest invoke opening adds a name attribute. A candidate
 * still undecided past it is prose, not markup on its way, so a reader stops
 * withholding there instead of holding the rest of the reply back.
 */
const MAX_DSML_UNDECIDED_PREFIX = 64 + MAX_DSML_NAME_LENGTH +
  MAX_TEXT_TOOL_WRAPPER_WHITESPACE;

/**
 * The index where a DSML tag opening begins in a text that ends inside it, or
 * -1. A tokenizer can split the opening anywhere - `<`, `<` + separator,
 * `<` + separator + `DS` - so a reader needs this to withhold the fragment
 * instead of flashing it. Only the tail long enough to hold an opening is
 * examined, so the scan is constant-time.
 */
export function dsmlPartialOpeningStart(text: string): number {
  const longest = 2 + (2 * MAX_DSML_SEPARATOR_LENGTH) + 4;
  const from = Math.max(0, text.length - longest + 1);
  for (let at = from; at < text.length; at++) {
    if (text[at] !== "<") continue;
    const tail = text.slice(at);
    for (const separator of DSML_SEPARATORS) {
      for (const lead of DSML_TAG_OPENINGS) {
        const token = `${lead}${separator}DSML${separator}`;
        if (token === tail) continue;
        if (token.startsWith(tail)) return at;
      }
    }
  }
  return -1;
}

/**
 * Parse one DSML tag at `at`. A tag the text ends inside reports `truncated`
 * with what it revealed, so a streaming reader can tell "not yet" from "not
 * this".
 */
function parseDsmlTag(text: string, at: number): DsmlTagParse {
  if (text[at] !== "<") return { ok: false, truncated: false };
  let i = at + 1;
  const closing = text[i] === "/";
  if (closing) i += 1;
  let separatorAt = -1;
  for (const separator of DSML_SEPARATORS) {
    const token = `${separator}DSML${separator}`;
    if (text.startsWith(token, i)) {
      i += token.length;
      separatorAt = i;
      break;
    }
    if (token.startsWith(text.slice(i))) {
      return {
        ok: false,
        truncated: true,
        partial: { closing, name: "", nameComplete: false, attributes: {} },
      };
    }
  }
  if (separatorAt < 0) return { ok: false, truncated: false };
  const attributes: Record<string, string> = {};
  const partial = (
    name: string,
    nameComplete: boolean,
    pendingAttribute?: { name: string; valuePrefix: string },
  ): DsmlTagParse => ({
    ok: false,
    truncated: true,
    partial: {
      closing,
      name,
      nameComplete,
      attributes,
      ...(pendingAttribute ? { pendingAttribute } : {}),
    },
  });
  const gapStart = i;
  while (
    i < text.length && isDsmlSpace(text[i]) &&
    i - gapStart < MAX_TEXT_TOOL_WRAPPER_WHITESPACE
  ) i++;
  if (
    i - gapStart >= MAX_TEXT_TOOL_WRAPPER_WHITESPACE && i < text.length &&
    isDsmlSpace(text[i])
  ) return { ok: false, truncated: false };
  const nameStart = i;
  while (
    i < text.length && i - nameStart < MAX_DSML_NAME_LENGTH &&
    isDsmlNameCharacter(text[i])
  ) i++;
  const name = text.slice(nameStart, i);
  const nameComplete = i < text.length && !isDsmlNameCharacter(text[i]);
  if (name.length === 0 && nameComplete) return { ok: false, truncated: false };
  if (!nameComplete) return partial(name, false);
  if (!DSML_TAG_NAMES.has(name)) return { ok: false, truncated: false };
  if (closing) {
    const closeGapStart = i;
    while (
      i < text.length && isDsmlSpace(text[i]) &&
      i - closeGapStart < MAX_TEXT_TOOL_WRAPPER_WHITESPACE
    ) i++;
    if (i >= text.length) return partial(name, true);
    if (text[i] !== ">") return { ok: false, truncated: false };
    return { ok: true, end: i + 1, tag: { closing: true, name, attributes } };
  }
  let attributeCount = 0;
  for (;;) {
    const attributeGapStart = i;
    while (
      i < text.length && isDsmlSpace(text[i]) &&
      i - attributeGapStart < MAX_TEXT_TOOL_WRAPPER_WHITESPACE
    ) i++;
    if (
      i - attributeGapStart >= MAX_TEXT_TOOL_WRAPPER_WHITESPACE &&
      i < text.length && isDsmlSpace(text[i])
    ) return { ok: false, truncated: false };
    if (i >= text.length) return partial(name, true);
    if (text[i] === ">") {
      return { ok: true, end: i + 1, tag: { closing: false, name, attributes } };
    }
    attributeCount += 1;
    if (attributeCount > MAX_DSML_ATTRIBUTES) {
      return { ok: false, truncated: false };
    }
    const keyStart = i;
    while (
      i < text.length && i - keyStart < MAX_DSML_NAME_LENGTH &&
      isDsmlNameCharacter(text[i])
    ) i++;
    const key = text.slice(keyStart, i);
    if (key.length === 0) {
      return i >= text.length
        ? partial(name, true)
        : { ok: false, truncated: false };
    }
    if (i >= text.length) return partial(name, true);
    if (text[i] !== "=") return { ok: false, truncated: false };
    i += 1;
    if (i >= text.length) return partial(name, true);
    const quote = text[i];
    if (quote !== '"' && quote !== "'") return { ok: false, truncated: false };
    i += 1;
    const valueStart = i;
    while (
      i < text.length && text[i] !== quote &&
      i - valueStart <= MAX_DSML_ATTRIBUTE_LENGTH
    ) i++;
    if (i - valueStart > MAX_DSML_ATTRIBUTE_LENGTH) {
      return { ok: false, truncated: false };
    }
    if (i >= text.length) {
      return partial(name, true, {
        name: key,
        valuePrefix: text.slice(valueStart),
      });
    }
    attributes[key] = text.slice(valueStart, i);
    i += 1;
  }
}

/** One recovered call and the block it came from. */
export interface DsmlRecoveredCall {
  name: string;
  arguments: Record<string, unknown>;
}

/** One invoke's parameters, read out of a block. */
interface DsmlInvokeScan {
  ok: boolean;
  /** Index just past the invoke's closing tag, when read whole. */
  end: number;
  invalid: boolean;
  truncated: boolean;
  arguments: Record<string, unknown>;
  /** Whether every parameter carried a value the budget accepted. */
  argumentsRecoverable: boolean;
}

function failedInvokeScan(
  options: { invalid?: boolean; truncated?: boolean },
): DsmlInvokeScan {
  return {
    ok: false,
    end: -1,
    invalid: options.invalid ?? false,
    truncated: options.truncated ?? false,
    arguments: {},
    argumentsRecoverable: false,
  };
}

/** Read the parameters of an invoke whose opening tag ends at `from`. */
function scanInvoke(text: string, from: number): DsmlInvokeScan {
  const args: Record<string, unknown> = {};
  let argumentsRecoverable = true;
  let i = from;
  for (let element = 0;; element++) {
    if (element > MAX_DSML_ELEMENTS) {
      return failedInvokeScan({ invalid: true });
    }
    const gapStart = i;
    while (
      i < text.length && isDsmlSpace(text[i]) &&
      i - gapStart < MAX_TEXT_TOOL_WRAPPER_WHITESPACE
    ) i++;
    if (
      i - gapStart >= MAX_TEXT_TOOL_WRAPPER_WHITESPACE && i < text.length &&
      isDsmlSpace(text[i])
    ) return failedInvokeScan({ invalid: true });
    if (i >= text.length) return failedInvokeScan({ truncated: true });
    const elementTag = parseDsmlTag(text, i);
    if (!elementTag.ok) {
      return failedInvokeScan({
        invalid: !elementTag.truncated,
        truncated: elementTag.truncated,
      });
    }
    const tag = elementTag.tag;
    if (tag.closing) {
      if (tag.name !== "invoke") return failedInvokeScan({ invalid: true });
      return {
        ok: true,
        end: elementTag.end,
        invalid: false,
        truncated: false,
        arguments: args,
        argumentsRecoverable,
      };
    }
    if (tag.name !== "parameter") return failedInvokeScan({ invalid: true });
    const key = tag.attributes.name;
    if (key === undefined) return failedInvokeScan({ invalid: true });
    const closingAt = nextDsmlTagStart(text, elementTag.end);
    if (closingAt < 0) return failedInvokeScan({ truncated: true });
    const closingTag = parseDsmlTag(text, closingAt);
    if (!closingTag.ok) {
      return failedInvokeScan({
        invalid: !closingTag.truncated,
        truncated: closingTag.truncated,
      });
    }
    if (!closingTag.tag.closing || closingTag.tag.name !== "parameter") {
      return failedInvokeScan({ invalid: true });
    }
    const raw = text.slice(elementTag.end, closingAt);
    // A `string="true"` value is the model's literal text, so its own leading
    // and trailing newlines are kept; a typed (`string="false"`) or
    // unmarked value is JSON or a bare token, where surrounding whitespace is
    // the element's layout rather than the value.
    const value = typedToolArgument(
      tag.attributes.string === "true" ? raw : raw.trim(),
      tag.attributes.string,
    );
    if (!value.ok) argumentsRecoverable = false;
    else args[key] = value.value;
    i = closingTag.end;
  }
}

/** What scanning a block from its wrapper opening revealed. */
interface DsmlBlockScan {
  /** The wrapper closed: the text holds a whole block. */
  complete: boolean;
  /** Index just past the wrapper's closing tag, when complete. */
  end: number;
  /** The block does not follow the DSML shape. */
  invalid: boolean;
  /** The text ended inside the block, so more may still arrive. */
  truncated: boolean;
  /** The block showed DSML structure past its wrapper opening. */
  structureRevealed: boolean;
  /** Names of the invokes read so far, in order. */
  invokeNames: string[];
  /** Whether a partial invoke name the text ends inside was revealed. */
  pendingInvokeName?: string;
  /** Whether every parameter of every invoke carried a usable value. */
  argumentsRecoverable: boolean;
  /** The invokes read, in order. */
  calls: DsmlRecoveredCall[];
}

function failedBlockScan(
  options: {
    invalid?: boolean;
    truncated?: boolean;
    structureRevealed?: boolean;
    invokeNames?: string[];
    pendingInvokeName?: string;
  } = {},
): DsmlBlockScan {
  return {
    complete: false,
    end: -1,
    invalid: options.invalid ?? false,
    truncated: options.truncated ?? false,
    structureRevealed: options.structureRevealed ?? false,
    invokeNames: options.invokeNames ?? [],
    ...(options.pendingInvokeName !== undefined
      ? { pendingInvokeName: options.pendingInvokeName }
      : {}),
    argumentsRecoverable: false,
    calls: [],
  };
}

/** The invoke name a truncated tag revealed, complete or partial. */
function pendingInvokeName(
  partial: DsmlTagPrefix | undefined,
): string | undefined {
  if (partial === undefined || partial.closing) return undefined;
  if (partial.name !== "invoke") return undefined;
  const complete = partial.attributes.name;
  if (complete !== undefined && complete.length > 0) return complete;
  const pending = partial.pendingAttribute;
  if (pending === undefined || pending.name !== "name") return undefined;
  return pending.valuePrefix.length === 0 ? undefined : pending.valuePrefix;
}

/**
 * Read a whole block from its wrapper opening at `wrapperStart`. Every failure
 * says which side of the streaming edge it is on: `truncated` means the text
 * ended inside the block, `invalid` means it ended somewhere the dialect does
 * not go.
 */
function scanDsmlBlock(text: string, wrapperStart: number): DsmlBlockScan {
  const wrapper = parseDsmlTag(text, wrapperStart);
  if (
    !wrapper.ok || wrapper.tag.closing ||
    !isWrapperName(wrapper.tag.name)
  ) return failedBlockScan({ invalid: true });
  const wrapperName = wrapper.tag.name;
  const calls: DsmlRecoveredCall[] = [];
  const invokeNames: string[] = [];
  let argumentsRecoverable = true;
  let structureRevealed = false;
  let i = wrapper.end;
  for (let element = 0;; element++) {
    if (element > MAX_DSML_ELEMENTS) {
      return failedBlockScan({ invalid: true, invokeNames, structureRevealed });
    }
    const gapStart = i;
    while (
      i < text.length && isDsmlSpace(text[i]) &&
      i - gapStart < MAX_TEXT_TOOL_WRAPPER_WHITESPACE
    ) i++;
    if (
      i - gapStart >= MAX_TEXT_TOOL_WRAPPER_WHITESPACE && i < text.length &&
      isDsmlSpace(text[i])
    ) {
      return failedBlockScan({ invalid: true, invokeNames, structureRevealed });
    }
    if (i >= text.length) {
      return failedBlockScan({
        truncated: true,
        invokeNames,
        structureRevealed,
      });
    }
    const elementTag = parseDsmlTag(text, i);
    if (!elementTag.ok) {
      if (!elementTag.truncated) {
        return failedBlockScan({
          invalid: true,
          invokeNames,
          structureRevealed,
        });
      }
      const pending = pendingInvokeName(elementTag.partial);
      return failedBlockScan({
        truncated: true,
        invokeNames,
        structureRevealed,
        ...(pending !== undefined ? { pendingInvokeName: pending } : {}),
      });
    }
    const tag = elementTag.tag;
    if (tag.closing) {
      if (tag.name !== wrapperName) {
        return failedBlockScan({
          invalid: true,
          invokeNames,
          structureRevealed,
        });
      }
      return {
        complete: true,
        end: elementTag.end,
        invalid: false,
        truncated: false,
        structureRevealed: true,
        invokeNames,
        argumentsRecoverable,
        calls,
      };
    }
    if (tag.name !== "invoke") {
      return failedBlockScan({ invalid: true, invokeNames, structureRevealed });
    }
    structureRevealed = true;
    const invokeName = tag.attributes.name;
    if (invokeName === undefined || invokeName.length === 0) {
      return failedBlockScan({ invalid: true, invokeNames, structureRevealed });
    }
    // The name is recorded before its body is read, so a block the text cuts
    // off inside an invoke still reports the tool that invoke named.
    invokeNames.push(invokeName);
    const invoke = scanInvoke(text, elementTag.end);
    if (!invoke.ok) {
      return failedBlockScan({
        invalid: invoke.invalid,
        truncated: invoke.truncated,
        invokeNames,
        structureRevealed,
      });
    }
    if (!invoke.argumentsRecoverable) argumentsRecoverable = false;
    else calls.push({ name: invokeName, arguments: invoke.arguments });
    i = invoke.end;
  }
}

/**
 * Index just past the block starting at `from`, or -1 while the text has not
 * revealed the block's end or does not hold a block there at all.
 */
export function dsmlBlockEnd(text: string, from: number): number {
  const wrapper = parseDsmlTag(text, from);
  if (
    !wrapper.ok || wrapper.tag.closing || !isWrapperName(wrapper.tag.name)
  ) return -1;
  const scan = scanDsmlBlock(text, from);
  return scan.complete ? scan.end : -1;
}

/** One recovered block of markup and the calls it held. */
export interface DsmlToolCallRemoval {
  /** Index of the wrapper opening. */
  start: number;
  /** Index just past the wrapper's closing tag. */
  end: number;
  calls: DsmlRecoveredCall[];
}

export interface DsmlToolCallExtraction {
  /** Spans to remove from the text, in order, one per recovered block. */
  removals: DsmlToolCallRemoval[];
  /** A block named an offered tool but its arguments could not be read. */
  unrecoverable: boolean;
}

/**
 * Recover the DSML blocks whose every invoke names an offered tool and whose
 * parameters all carry usable values. A block naming a tool the caller did not
 * offer, or one the text cuts off, is not recovered and not removed: it stays
 * in the text, where the unparsed-markup check can report it. `offeredNames`
 * undefined recovers any name, for a caller reading text with no tool set.
 */
export function extractDsmlToolCalls(
  text: string,
  offeredNames?: ReadonlySet<string>,
): DsmlToolCallExtraction {
  const removals: DsmlToolCallRemoval[] = [];
  let unrecoverable = false;
  let at = nextDsmlTagStart(text, 0);
  let candidates = 0;
  while (at >= 0 && candidates < MAX_TEXT_TOOL_MARKUP_CANDIDATES) {
    candidates += 1;
    const scan = scanDsmlBlock(text, at);
    if (scan.complete) {
      const offered = offeredNames === undefined ||
        scan.invokeNames.every((name) => offeredNames.has(name));
      if (offered && !scan.argumentsRecoverable) unrecoverable = true;
      if (offered && scan.argumentsRecoverable && scan.calls.length > 0) {
        removals.push({ start: at, end: scan.end, calls: scan.calls });
      }
      at = nextDsmlTagStart(text, scan.end);
      continue;
    }
    at = nextDsmlTagStart(text, at + 1);
  }
  return { removals, unrecoverable };
}

/**
 * The index of the earliest DSML markup the text cuts off while a streaming
 * reader could still be withholding it, or -1. Two shapes qualify, and each
 * mirrors the withholding rule a reader applies delta by delta, so a caller
 * that strips this suffix never cuts text it has already forwarded:
 *
 * - the text ends inside a wrapper opening that could still become one, or a
 *   whole wrapper opening with no invoke revealed after it, and the span is
 *   within `MAX_DSML_UNDECIDED_PREFIX` (the reader withholds it only that far);
 * - the block revealed an invoke naming an offered tool and then the text
 *   ended, whether inside an invoke name that only prefixes an offered one or
 *   past a whole invoke whose name is offered (the reader withholds that
 *   unconditionally, because recovery would run it if it had arrived whole).
 *
 * A block that closed but did not follow the dialect is prose the reader
 * already released, and it is never reported here.
 */
export function dsmlTruncatedBlockStart(
  text: string,
  offeredNames: ReadonlySet<string> | undefined,
): number {
  if (offeredNames === undefined || offeredNames.size === 0) return -1;
  let at = nextDsmlTagStart(text, 0);
  let candidates = 0;
  while (at >= 0 && candidates < MAX_TEXT_TOOL_MARKUP_CANDIDATES) {
    candidates += 1;
    const undecided = text.length - at <= MAX_DSML_UNDECIDED_PREFIX;
    const wrapper = parseDsmlTag(text, at);
    if (!wrapper.ok) {
      if (
        wrapper.truncated && wrapper.partial !== undefined &&
        !wrapper.partial.closing && couldBecomeWrapper(wrapper.partial) &&
        undecided
      ) return at;
      at = nextDsmlTagStart(text, at + 1);
      continue;
    }
    if (wrapper.tag.closing || !isWrapperName(wrapper.tag.name)) {
      at = nextDsmlTagStart(text, at + 1);
      continue;
    }
    const scan = scanDsmlBlock(text, at);
    if (!scan.truncated) {
      at = nextDsmlTagStart(text, at + 1);
      continue;
    }
    const namedOffered = scan.invokeNames.length > 0 &&
      scan.invokeNames.every((name) => offeredNames.has(name));
    const pending = scan.pendingInvokeName;
    const startingOffered = pending !== undefined &&
      [...offeredNames].some((offered) => offered.startsWith(pending));
    if (namedOffered || startingOffered) return at;
    if (scan.invokeNames.length === 0 && scan.pendingInvokeName === undefined) {
      if (undecided) return at;
    }
    at = nextDsmlTagStart(text, at + 1);
  }
  return -1;
}

/**
 * The index of the earliest block that recovery would run: a block whose first
 * invoke already names an offered tool. That is the point a streaming reader
 * withholds from, whether the block has finished arriving or not.
 */
export function dsmlRecoverableStart(
  text: string,
  offeredNames: ReadonlySet<string> | undefined,
): number {
  return dsmlStartCandidate(text, offeredNames, true);
}

/**
 * The index of the earliest block that may still become recoverable: the text
 * has not yet revealed an invoke name, or has revealed one only in part, and
 * what it shows is consistent with an offered tool. A reader withholds from
 * here while it waits for the rest, but only while the candidate is shorter
 * than `MAX_DSML_UNDECIDED_PREFIX`: a stray wrapper opening in prose stops
 * holding text back once nothing follows it.
 */
export function dsmlPossibleStart(
  text: string,
  offeredNames: ReadonlySet<string> | undefined,
): number {
  return dsmlStartCandidate(text, offeredNames, false);
}

/**
 * The index of the earliest block a reader withholds from, or -1.
 * `requireOfferedName` separates the two readings: a confirmed start belongs to
 * a block whose first invoke already names an offered tool, and an undecided one
 * only while the text still fits `MAX_DSML_UNDECIDED_PREFIX`.
 */
function dsmlStartCandidate(
  text: string,
  offeredNames: ReadonlySet<string> | undefined,
  requireOfferedName: boolean,
): number {
  if (offeredNames === undefined || offeredNames.size === 0) return -1;
  /** Whether this reading withholds for a block it has not confirmed yet. */
  const undecided = !requireOfferedName;
  let at = nextDsmlTagStart(text, 0);
  let candidates = 0;
  while (at >= 0 && candidates < MAX_TEXT_TOOL_MARKUP_CANDIDATES) {
    candidates += 1;
    const wrapper = parseDsmlTag(text, at);
    if (!wrapper.ok) {
      if (
        undecided && wrapper.truncated && wrapper.partial !== undefined &&
        !wrapper.partial.closing && couldBecomeWrapper(wrapper.partial) &&
        text.length - at <= MAX_DSML_UNDECIDED_PREFIX
      ) return at;
      at = nextDsmlTagStart(text, at + 1);
      continue;
    }
    if (wrapper.tag.closing || !isWrapperName(wrapper.tag.name)) {
      at = nextDsmlTagStart(text, at + 1);
      continue;
    }
    const invokeAt = nextDsmlTagStart(text, wrapper.end);
    if (invokeAt < 0) {
      if (undecided && text.length - at <= MAX_DSML_UNDECIDED_PREFIX) {
        return at;
      }
      at = nextDsmlTagStart(text, at + 1);
      continue;
    }
    const invoke = parseDsmlTag(text, invokeAt);
    if (!invoke.ok) {
      if (!invoke.truncated) {
        at = nextDsmlTagStart(text, at + 1);
        continue;
      }
      const pending = pendingInvokeName(invoke.partial);
      if (pending === undefined) {
        if (undecided && text.length - at <= MAX_DSML_UNDECIDED_PREFIX) {
          return at;
        }
        at = nextDsmlTagStart(text, at + 1);
        continue;
      }
      const matches = [...offeredNames].some((offered) =>
        offered.startsWith(pending)
      );
      if (matches) return at;
      at = nextDsmlTagStart(text, at + 1);
      continue;
    }
    if (invoke.tag.closing || invoke.tag.name !== "invoke") {
      at = nextDsmlTagStart(text, at + 1);
      continue;
    }
    const name = invoke.tag.attributes.name;
    if (name === undefined || name.length === 0) {
      if (undecided && text.length - at <= MAX_DSML_UNDECIDED_PREFIX) {
        return at;
      }
      at = nextDsmlTagStart(text, at + 1);
      continue;
    }
    if (!offeredNames.has(name)) {
      at = nextDsmlTagStart(text, at + 1);
      continue;
    }
    return at;
  }
  return -1;
}

function couldBecomeWrapper(partial: DsmlTagPrefix): boolean {
  if (partial.nameComplete) return isWrapperName(partial.name);
  return DSML_WRAPPER_NAMES.some((name) => name.startsWith(partial.name));
}

/**
 * Count the DSML blocks left in the text that ran no tool. A whole block counts
 * once. A block the text cuts off counts only when it shows DSML structure past
 * its opening, so a stray wrapper opening in prose stays prose. Blocks past the
 * scan bound are not counted; the reported count is capped, and says whether it
 * is a lower bound.
 */
export function countUnparsedDsmlMarkup(
  text: string,
): { count: number; countIsLowerBound: boolean } {
  const none = { count: 0, countIsLowerBound: false };
  if (text.length > MAX_UNPARSED_TOOL_CALL_SCAN_CHARACTERS) return none;
  let count = 0;
  let at = nextDsmlTagStart(text, 0);
  let candidates = 0;
  while (at >= 0 && candidates < MAX_TEXT_TOOL_MARKUP_CANDIDATES) {
    candidates += 1;
    const wrapper = parseDsmlTag(text, at);
    if (
      !wrapper.ok || wrapper.tag.closing ||
      !isWrapperName(wrapper.tag.name)
    ) {
      at = nextDsmlTagStart(text, at + 1);
      continue;
    }
    const scan = scanDsmlBlock(text, at);
    if (scan.complete) {
      if (scan.invokeNames.length > 0) count += 1;
      at = nextDsmlTagStart(text, scan.end);
      continue;
    }
    if (scan.structureRevealed) count += 1;
    at = nextDsmlTagStart(text, at + 1);
  }
  if (count === 0) return none;
  return {
    count: Math.min(count, MAX_UNPARSED_TOOL_CALL_MARKERS),
    countIsLowerBound: count > MAX_UNPARSED_TOOL_CALL_MARKERS,
  };
}
