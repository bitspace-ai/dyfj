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
  countNewTextToolMarkupCandidates,
  dsmlPossibleMarkupStart,
  dsmlRecoverableMarkupStart,
  extractTextToolCallsInternal,
  MAX_DSML_MARKUP_TOKENS,
  MAX_TEXT_TOOL_MARKUP_CANDIDATES,
  qwenConfirmedMarkupStart,
  qwenPossibleTextToolMarkupStart,
  stripIncompleteTextToolCallSuffix,
  TEXT_FUNCTION_MARKER,
  TEXT_PARAMETER_MARKER,
} from "../shared/text-tool-calls.ts";
import {
  DSML_MARKER_COUNTS,
  dsmlBlockEnd,
  dsmlPartialOpeningStart,
  dsmlWrapperClosingEnd,
  MAX_DSML_CLOSING_TAG_LENGTH,
} from "../shared/dsml-tool-calls.ts";
import { finiteNonnegativeTokenCount } from "../shared/tokens.ts";
import { toolWireNames } from "../shared/tool-names.ts";
import {
  MAX_STRUCTURED_TOOL_CALLS,
  MAX_STRUCTURED_TOOL_NAME_CHARACTERS,
  type OpenAIChatStreamEvent,
  type OpenAIChatUsage,
  parseToolArguments,
  upstreamField,
} from "./response.ts";
import {
  mergeUpstreamEvidence,
  type ProviderUpstreamEvidence,
} from "./upstream.ts";

export function parseOpenAIChatStreamLine(
  line: string,
): OpenAIChatStreamEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || !trimmed.startsWith("data:")) return null;

  const data = trimmed.slice("data:".length).trim();
  if (data === "[DONE]") return { done: true };

  const json = JSON.parse(data) as {
    error?: unknown;
    id?: unknown;
    provider?: unknown;
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
    ...upstreamField(json),
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
  /**
   * The completion count reported in the frame that carried the largest
   * billed cost, so the cost is trusted only when it covers the final count.
   */
  usageCostCompletionTokens?: number;
  aborted: boolean;
  finishReason?: string;
  usage?: OpenAIChatUsage;
  /**
   * Who served the call: the first frame that reported each value.
   */
  upstream?: ProviderUpstreamEvidence;
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
  const presenter = createTextPresenter(tools, onTextDelta);
  const toolCallAcc = createToolCallAccumulator();
  let lineFragments: string[] = [];
  let reasoningCharacters = 0;
  let finishReason: string | undefined;
  let usageState: StreamUsageState = {};
  let upstream: ProviderUpstreamEvidence | undefined;
  let firstTokenAt: number | undefined;
  let receivedBytes = 0;
  let receivedChunks = 0;
  let receivedReads = 0;
  let aborted = false;

  const applyEvent = (event: OpenAIChatStreamEvent) => {
    if (event.reasoningDelta) {
      reasoningCharacters += event.reasoningDelta.length;
    }
    if (event.textDelta) {
      firstTokenAt ??= now();
      presenter.append(event.textDelta);
    }
    toolCallAcc.apply(event.toolCallDeltas ?? []);
    upstream = mergeUpstreamEvidence(upstream, event.upstream);
    if (event.finishReason) finishReason = event.finishReason;
    if (event.usage) {
      usageState = applyStreamUsage(usageState, event.usage, {
        finishReason: event.finishReason,
        generatedCharacters: presenter.text.length + toolCallAcc.characters,
        reasoningCharacters,
      });
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
    let chunk: Awaited<ReturnType<typeof reader.read>>;
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
  const visibleText = presenter.finish(aborted);
  const toolCalls = toolCallAcc.toolCalls();

  const completed = now();
  return {
    text: presenter.text,
    visibleText,
    reasoningCharacters,
    toolCallCharacters: toolCallAcc.characters,
    usageGeneratedCharacters: usageState.usageGeneratedCharacters,
    usageReasoningCharacters: usageState.usageReasoningCharacters,
    usageCompletionReasoningCharacters:
      usageState.usageCompletionReasoningCharacters,
    usageCostCompletionTokens: usageState.usageCostCompletionTokens,
    aborted,
    finishReason,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage: usageState.usage,
    ...(upstream === undefined ? {} : { upstream }),
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

/**
 * Counts one markup marker's occurrences across the deltas of a reply, carrying
 * the tail a marker may straddle, and reports whether the count has passed the
 * bound that makes text recovery unsafe. Each counter owns one marker.
 */
function createMarkupCandidateCounter(limit: number) {
  let count = 0;
  let tail = "";
  return {
    /** Whether the count passed `limit`; the count stops being exact there. */
    get exceeded(): boolean {
      return count > limit;
    },
    observe(delta: string, markers: readonly string[]): void {
      const update = countNewTextToolMarkupCandidates(
        tail,
        delta,
        markers,
        limit - count,
      );
      tail = update.tail;
      count += update.count;
    },
  };
}

/**
 * The end of the withheld span when a closed DSML wrapper holds a block
 * recovery runs in full, or -1. Anything short of that - a block that does not
 * follow the dialect, one naming a tool the request did not offer, one whose
 * arguments could not be read, or a body with text left over - means part of
 * the span is not DSML markup. The caller then reads the body again under the
 * ordinary rules, so a complete Qwen call inside it is withheld and recovered,
 * an incomplete one is withheld until it settles or the reply ends, and a
 * nested block is read as a block. Showing that body raw instead would leave a
 * Qwen call both executed and displayed.
 */
function withheldDsmlRecoveredEnd(
  text: string,
  offeredNames: ReadonlySet<string> | undefined,
): number {
  const end = dsmlBlockEnd(text, 0);
  if (end < 0) return -1;
  const extraction = extractTextToolCallsInternal(
    text.slice(0, end),
    offeredNames,
    true,
  );
  return !extraction.unrecoverable && extraction.toolCalls.length > 0 &&
      extraction.cleaned.length === 0
    ? end
    : -1;
}

/** The Qwen wrapper's closing tag, which ends a withheld Qwen block. */
const QWEN_TOOL_CALL_CLOSING = "</tool_call>";

/**
 * The close-tag probe for one withheld block. Only the characters that arrived
 * after the last probe can hold a closing tag's start, plus the longest tag's
 * worth of overlap in case one straddled a previous delta, so the probe reads a
 * carried tail window rather than rescanning the withheld span. The withheld
 * chunks themselves are never joined on the probe's account: the join happens
 * once, when the block ends or the turn finishes.
 */
function createWithheldCloseProbe() {
  /** Index just past the close tag, once found. */
  let closingTagEnd = -1;
  /** The tail the last probe covered, and the characters appended since. */
  let tail = "";
  let newText = "";
  const reset = (): void => {
    closingTagEnd = -1;
    tail = "";
    newText = "";
  };
  return {
    /** Start probing a span whose whole text is already withheld. */
    begin(withheldText: string): void {
      reset();
      newText = withheldText;
    },
    /** Note characters appended to the withheld span. */
    append(delta: string): void {
      newText += delta;
    },
    reset,
    /**
     * Index just past the withheld block's close tag, or -1 while it has not
     * arrived. `heldCharacters` is how many characters are withheld in total,
     * so a tag found inside the probed window reports its index in the withheld
     * span rather than in the window.
     */
    probe(
      dialect: "qwen" | "dsml" | undefined,
      heldCharacters: number,
    ): number {
      if (closingTagEnd >= 0) return closingTagEnd;
      if (newText.length === 0) return -1;
      const windowText = tail + newText;
      const windowStart = heldCharacters - windowText.length;
      const found = dialect === "qwen"
        ? qwenClosingTagEnd(windowText)
        : dsmlWrapperClosingEnd(windowText, 0);
      if (found < 0) {
        tail = windowText.slice(-(MAX_DSML_CLOSING_TAG_LENGTH - 1));
        newText = "";
        return -1;
      }
      closingTagEnd = windowStart + found;
      return closingTagEnd;
    },
  };
}

/** Index just past a Qwen `</tool_call>` close tag in `text`, or -1. */
function qwenClosingTagEnd(text: string): number {
  const closing = text.indexOf(QWEN_TOOL_CALL_CLOSING);
  return closing < 0 ? -1 : closing + QWEN_TOOL_CALL_CLOSING.length;
}

/**
 * Live presentation of streamed text. Text is forwarded to `onTextDelta` as it
 * arrives, except for a recognized offered-tool block of either markup dialect,
 * which is withheld until it closes: recoverable markup stays hidden, and
 * trailing prose resumes as soon as the block ends. A block still arriving is
 * only ever withheld while it may still turn out recoverable, so ordinary prose
 * that happens to hold a markup marker is held back for at most
 * `MAX_DSML_UNDECIDED_PREFIX` characters. The presenter owns all of that state;
 * the reader only appends deltas and finishes once.
 */
function createTextPresenter(
  tools: WorkbenchToolDefinition[] | undefined,
  onTextDelta: (delta: string) => void,
) {
  let text = "";
  /** Which dialect is being withheld, or undefined when nothing is. */
  let suppressing: "qwen" | "dsml" | undefined;
  const withheldClose = createWithheldCloseProbe();
  let sawTextToolMarkup = false;
  let textToolRecoveryDisabled = !tools || tools.length === 0;
  const functionCandidates = createMarkupCandidateCounter(
    MAX_TEXT_TOOL_MARKUP_CANDIDATES,
  );
  const parameterCandidates = createMarkupCandidateCounter(
    MAX_TEXT_TOOL_MARKUP_CANDIDATES,
  );
  const dsmlCandidates = createMarkupCandidateCounter(MAX_DSML_MARKUP_TOKENS);
  /**
   * The text not yet decided: what the reader still has to look at, drained as
   * it is emitted or withheld. It is held as the chunks it arrived in, so a
   * withheld block is never rebuilt from a growing string at each delta; the
   * join happens once, when the block ends or the turn finishes.
   */
  let pendingParts: string[] = [];
  let pendingChars = 0;
  let pendingJoin: string | undefined = "";
  let forwardedText = "";

  const offeredNames = tools
    ? new Set(toolWireNames(tools).map(({ wire }) => wire))
    : undefined;
  /** The undecided text, joined. Cached until the next append or drop. */
  const pending = (): string => (pendingJoin ??= pendingParts.join(""));
  const appendPending = (delta: string) => {
    if (delta.length === 0) return;
    pendingParts.push(delta);
    pendingChars += delta.length;
    pendingJoin = undefined;
  };
  const dropPendingPrefix = (characters: number) => {
    if (characters <= 0) return;
    const rest = pending().slice(characters);
    pendingParts = rest.length === 0 ? [] : [rest];
    pendingChars = rest.length;
    pendingJoin = rest;
  };
  const emitTextDelta = (delta: string) => {
    if (delta.length === 0) return;
    forwardedText += delta;
    onTextDelta(delta);
  };
  /** Emit the decided prefix of the undecided text and drop it. */
  const release = (characters: number) => {
    if (characters <= 0) return;
    emitTextDelta(pending().slice(0, characters));
    dropPendingPrefix(characters);
  };
  /** Stop withholding, dropping the close-tag probe state with it. */
  const endWithholding = () => {
    suppressing = undefined;
    withheldClose.reset();
  };
  /**
   * Emit the withheld span, or hide it once recovery confirms it runs. A span
   * that holds a recoverable call is not shown raw: what reaches the operator
   * is the span with those calls removed, so a call nested in markup the reader
   * was withholding cannot be both executed and displayed.
   */
  const settleWithheld = (end: number) => {
    const candidate = pending().slice(0, end);
    const extraction = extractTextToolCallsInternal(
      candidate,
      offeredNames,
      true,
    );
    if (extraction.unrecoverable) {
      emitTextDelta(candidate);
    } else if (extraction.toolCalls.length > 0) {
      sawTextToolMarkup = true;
      emitTextDelta(extraction.cleaned);
    } else {
      emitTextDelta(candidate);
    }
    endWithholding();
    dropPendingPrefix(end);
  };
  /** Start withholding the undecided text in one dialect. */
  const beginWithholding = (dialect: "qwen" | "dsml") => {
    endWithholding();
    suppressing = dialect;
    withheldClose.begin(pending());
  };
  /** Index just past the close tag of the withheld block, or -1. */
  const withheldClosingEnd = (): number =>
    withheldClose.probe(suppressing, pendingChars);
  const forwardAvailableText = () => {
    while (true) {
      if (textToolRecoveryDisabled) {
        release(pendingChars);
        return;
      }
      if (suppressing === "dsml") {
        // A closing wrapper tag is the cheap proof the block ended; the parse
        // then runs once, on the whole block, rather than on every delta.
        if (withheldClosingEnd() < 0) return;
        const recoveredEnd = withheldDsmlRecoveredEnd(pending(), offeredNames);
        if (recoveredEnd >= 0) {
          sawTextToolMarkup = true;
          endWithholding();
          dropPendingPrefix(recoveredEnd);
          continue;
        }
        // The wrapper closed around something recovery did not run as one whole
        // DSML block. Release its first character and read on, so the body is
        // decided by the same rules as any other text rather than shown raw.
        release(1);
        endWithholding();
        continue;
      }
      if (suppressing === "qwen") {
        const closeEnd = withheldClosingEnd();
        if (closeEnd < 0) return;
        settleWithheld(closeEnd);
        continue;
      }
      const current = pending();
      const dsmlStart = dsmlRecoverableMarkupStart(current, tools);
      const qwenStart = qwenConfirmedMarkupStart(current, tools);
      const markupStart = dsmlStart >= 0 && (qwenStart < 0 || dsmlStart <= qwenStart)
        ? dsmlStart
        : qwenStart;
      if (markupStart >= 0) {
        release(markupStart);
        beginWithholding(markupStart === dsmlStart ? "dsml" : "qwen");
        continue;
      }
      const safeStarts = [
        qwenPossibleTextToolMarkupStart(current, tools),
        dsmlPossibleMarkupStart(current, tools),
        dsmlPartialOpeningStart(current),
      ].filter((start) => start >= 0);
      const safeEnd = safeStarts.length === 0
        ? current.length
        : Math.min(...safeStarts);
      if (safeEnd > 0) release(safeEnd);
      return;
    }
  };

  return {
    /** Everything appended so far, markup included. */
    get text(): string {
      return text;
    },
    append(delta: string): void {
      if (!textToolRecoveryDisabled) {
        functionCandidates.observe(delta, [TEXT_FUNCTION_MARKER]);
        parameterCandidates.observe(delta, [TEXT_PARAMETER_MARKER]);
        dsmlCandidates.observe(delta, DSML_MARKER_COUNTS);
      }
      text += delta;
      appendPending(delta);
      if (suppressing !== undefined) withheldClose.append(delta);
      if (
        !textToolRecoveryDisabled &&
        (
          functionCandidates.exceeded ||
          parameterCandidates.exceeded ||
          dsmlCandidates.exceeded
        )
      ) {
        if (sawTextToolMarkup) {
          throw new DomainError(
            "Provider returned too many textual tool-call markers",
          );
        }
        textToolRecoveryDisabled = true;
        endWithholding();
      }
      forwardAvailableText();
    },
    /** Flush what may still be shown and return the deliverable text. */
    finish(aborted: boolean): string {
      const deliverable = aborted || suppressing || sawTextToolMarkup
        ? stripIncompleteTextToolCallSuffix(text, tools)
        : text;
      if (!deliverable.startsWith(forwardedText)) {
        throw new DomainError("Provider stream presentation diverged");
      }
      emitTextDelta(deliverable.slice(forwardedText.length));
      pendingParts = [];
      pendingChars = 0;
      pendingJoin = "";
      return deliverable;
    },
  };
}

/**
 * Accumulates structured tool calls. They arrive as deltas keyed by index;
 * id/name land in the first fragment for that index and arguments stream as
 * string fragments (MLX sends the whole call in one delta, hosted OpenAI
 * fragments it — both accumulate).
 */
function createToolCallAccumulator() {
  const toolAcc = new Map<
    number,
    { id?: string; name?: string; args: string }
  >();
  let structuredToolNameCharacters = 0;
  let characters = 0;

  return {
    /** Name and argument characters received so far. */
    get characters(): number {
      return characters;
    },
    apply(deltas: NonNullable<OpenAIChatStreamEvent["toolCallDeltas"]>): void {
      for (const delta of deltas) {
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
          characters += delta.name.length;
        }
        if (delta.argumentsFragment) {
          characters += delta.argumentsFragment.length;
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
    },
    toolCalls(): WorkbenchToolCall[] {
      return [...toolAcc.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([index, acc]) => ({
          id: acc.id ?? `tool-call-${index + 1}`,
          name: acc.name ?? "",
          arguments: parseToolArguments(acc.args),
        }));
    },
  };
}

/** Usage seen so far, and the character counts it was reported against. */
interface StreamUsageState {
  usage?: OpenAIChatUsage;
  usageGeneratedCharacters?: number;
  usageReasoningCharacters?: number;
  usageCompletionReasoningCharacters?: number;
  usageCostCompletionTokens?: number;
}

/**
 * Fold one streamed usage frame into the state. The character snapshots move
 * only when the frame's token count grows, or holds steady on the frame that
 * finishes the turn, so each snapshot matches the text the final count
 * describes.
 */
function applyStreamUsage(
  state: StreamUsageState,
  incoming: OpenAIChatUsage,
  at: {
    finishReason?: string;
    generatedCharacters: number;
    reasoningCharacters: number;
  },
): StreamUsageState {
  const advanced = (
    previous: number | undefined,
    next: number | undefined,
  ) =>
    next !== undefined &&
    (previous === undefined || next > previous ||
      (next === previous && at.finishReason !== undefined));
  const completionAdvanced = advanced(
    finiteNonnegativeTokenCount(state.usage?.completion_tokens),
    finiteNonnegativeTokenCount(incoming.completion_tokens),
  );
  const reasoningAdvanced = advanced(
    finiteNonnegativeTokenCount(
      state.usage?.completion_tokens_details?.reasoning_tokens,
    ),
    finiteNonnegativeTokenCount(
      incoming.completion_tokens_details?.reasoning_tokens,
    ),
  );
  const costAdvanced = advanced(
    finiteNonnegativeTokenCount(state.usage?.cost),
    finiteNonnegativeTokenCount(incoming.cost),
  );
  return {
    usage: mergeStreamUsage(state.usage, incoming),
    usageCostCompletionTokens: costAdvanced
      ? finiteNonnegativeTokenCount(incoming.completion_tokens)
      : state.usageCostCompletionTokens,
    usageGeneratedCharacters: completionAdvanced
      ? at.generatedCharacters
      : state.usageGeneratedCharacters,
    usageCompletionReasoningCharacters: completionAdvanced
      ? at.reasoningCharacters
      : state.usageCompletionReasoningCharacters,
    usageReasoningCharacters: reasoningAdvanced
      ? at.reasoningCharacters
      : state.usageReasoningCharacters,
  };
}

/**
 * Merge a streamed usage frame into the usage seen so far. Each count keeps
 * the larger finite value, so a later partial frame cannot erase an earlier
 * total; a count neither frame reports stays absent.
 */
export function mergeStreamUsage(
  previous: OpenAIChatUsage | undefined,
  incoming: OpenAIChatUsage,
): OpenAIChatUsage {
  const max = (a: number | undefined, b: number | undefined) => {
    const x = finiteNonnegativeTokenCount(a);
    const y = finiteNonnegativeTokenCount(b);
    return x === undefined && y === undefined
      ? undefined
      : Math.max(x ?? 0, y ?? 0);
  };
  const prompt = max(previous?.prompt_tokens, incoming.prompt_tokens);
  const completion = max(
    previous?.completion_tokens,
    incoming.completion_tokens,
  );
  const reasoning = max(
    previous?.completion_tokens_details?.reasoning_tokens,
    incoming.completion_tokens_details?.reasoning_tokens,
  );
  const cached = max(
    previous?.prompt_tokens_details?.cached_tokens,
    incoming.prompt_tokens_details?.cached_tokens,
  );
  const cacheWrite = max(
    previous?.prompt_tokens_details?.cache_write_tokens,
    incoming.prompt_tokens_details?.cache_write_tokens,
  );
  const cost = max(previous?.cost, incoming.cost);
  return {
    ...(cost !== undefined ? { cost } : {}),
    ...(prompt !== undefined ? { prompt_tokens: prompt } : {}),
    ...(completion !== undefined ? { completion_tokens: completion } : {}),
    ...(reasoning !== undefined
      ? { completion_tokens_details: { reasoning_tokens: reasoning } }
      : {}),
    ...(cached !== undefined || cacheWrite !== undefined
      ? {
        prompt_tokens_details: {
          ...(cached !== undefined ? { cached_tokens: cached } : {}),
          ...(cacheWrite !== undefined
            ? { cache_write_tokens: cacheWrite }
            : {}),
        },
      }
      : {}),
  };
}
