// Recovery policy for provider turns that stop with stopReason "length".
// A "length" stop is ambiguous: either the response hit the model's per-call
// output budget (the input fit; the answer was cut off), or the conversation
// no longer fits the model's context window (the window filled mid-response).
// The two need opposite handling — a cheap bounded retry vs a structured
// failure that names the operator's options — so classification comes first,
// from the model registry's catalog limits plus the turn's reported usage.
// The agent loop (workbench.ts) owns the retry/failure mechanics; everything
// here is pure and unit-testable.

import type { WorkbenchMessage, WorkbenchModel } from "./provider";
import { DomainError, sanitizeBoundaryText } from "./turn-contract";

export type LengthStopClassification =
  | "output_budget_exhausted"
  | "context_overflow";

export type LengthRecoveryOutcome =
  | "recovered"
  | "still_truncated"
  | "retry_refused_budget"
  /** The adapter cannot run a transcript retry (modelSupportsTranscriptRetry). */
  | "retry_unsupported"
  /**
   * Both the output cap and the context window bound this stop: the
   * continuation (original transcript + partial answer + nudge) no longer fits
   * the window, so retrying would be a doomed over-window call. The capped
   * partial is delivered instead. Upgrade site for a future compressor:
   * compress-then-continue when both limits bind.
   */
  | "retry_would_overflow"
  /** The recovery hook or the retry call threw; the error surfaces after this. */
  | "retry_errored"
  | "overflow_failed";

/**
 * Overflow evidence threshold: input + output at or past this fraction of the
 * catalog context window reads as "the window filled", not "the output cap
 * bound". Slightly under 1.0 because provider token accounting (template
 * overhead, estimate fallbacks) does not land exactly on the window edge.
 */
export const CONTEXT_OVERFLOW_WINDOW_FRACTION = 0.98;

export interface LengthStopUsage {
  input: number;
  output: number;
}

/**
 * Classify a "length" stop. Overflow requires positive evidence; when the
 * catalog declares no limits the default is output-budget exhaustion, because
 * its recovery (one bounded retry) is the cheap reversible path while the
 * overflow verdict fails the turn.
 *
 * Order matters: a response that used its full output cap stopped because of
 * that cap — even at the window edge the generator could not have continued —
 * so the output-cap check wins over the window check.
 */
export function classifyLengthStop(
  model: Pick<WorkbenchModel, "contextWindow" | "maxOutputTokens">,
  usage: LengthStopUsage,
): LengthStopClassification {
  if (
    model.maxOutputTokens !== undefined &&
    usage.output >= model.maxOutputTokens
  ) {
    return "output_budget_exhausted";
  }
  if (
    model.contextWindow !== undefined &&
    usage.input + usage.output >=
      model.contextWindow * CONTEXT_OVERFLOW_WINDOW_FRACTION
  ) {
    return "context_overflow";
  }
  return "output_budget_exhausted";
}

/**
 * Nudge appended (with the truncated text as the assistant turn) for the one
 * bounded continuation retry. Continuation — rather than re-asking with a
 * raised output cap — keeps the retry inside the model's own limits and needs
 * no per-adapter max-tokens plumbing.
 */
export const LENGTH_CONTINUATION_NUDGE =
  "Your previous reply was cut off mid-response by the output token limit. " +
  "Continue exactly where you left off. Do not repeat anything you already " +
  "wrote and do not summarize it.";

/**
 * Build the transcript for the continuation retry: the conversation as sent,
 * the truncated text as the assistant's (partial) turn, then the nudge. Pure —
 * returns a new array; the loop's live transcript is not mutated, so a failed
 * or refused retry leaves the turn's state exactly as it was.
 */
export function buildContinuationMessages(
  messages: WorkbenchMessage[],
  partialText: string,
): WorkbenchMessage[] {
  return [
    ...messages,
    { role: "assistant", content: partialText },
    { role: "user", content: LENGTH_CONTINUATION_NUDGE },
  ];
}

export interface ContextOverflowDetails {
  modelSlug: string;
  contextWindow?: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * The operator-visible statement of the overflow condition and the ways out.
 * Also the message of ContextWindowOverflowError, so every transport that
 * surfaces the turn error shows the same guidance.
 */
export function buildContextOverflowMessage(
  details: ContextOverflowDetails,
): string {
  const windowNote = details.contextWindow !== undefined
    ? `${details.contextWindow}-token context window`
    : "context window";
  return (
    `Context window overflow: the conversation no longer fits the ` +
    // The slug is registry data riding a DomainError message that
    // summarizeError trusts downstream — bounded and control-stripped at
    // construction like every other registry-sourced error field.
    `${windowNote} of ${sanitizeBoundaryText(details.modelSlug, 120)} ` +
    `(this turn used ~${details.inputTokens} input + ` +
    `${details.outputTokens} output tokens). ` +
    `Options: switch to a larger-context model with /model, or start a ` +
    `fresh session.`
  );
}

/**
 * Structured failure for a context-window overflow. The turn fails; session
 * state stays consistent (no model_response event is written, so a resumed
 * transcript carries no half-turn) and the message names the operator's
 * options. A context compressor can prevent this failure via the recovery
 * hook below.
 */
export class ContextWindowOverflowError extends DomainError {
  constructor(public readonly details: ContextOverflowDetails) {
    super(buildContextOverflowMessage(details));
    this.name = "ContextWindowOverflowError";
  }
}

/**
 * Hook seam for context-overflow recovery (the future context compressor
 * plugs in here — compress-then-retry). When the agent loop
 * classifies a length stop as overflow it consults this hook (when injected
 * via WorkbenchRuntimeInput.recoverContextOverflow) before failing: a returned
 * plan buys exactly one retry with the plan's (e.g. compressed) transcript;
 * null — or a retry that still overflows — falls through to the structured
 * ContextWindowOverflowError. The hook never loops. `messages` is a snapshot:
 * mutating it does not touch the live agent-loop transcript.
 *
 * Known seam limitation for the compressor slice to own: text deltas from the
 * overflowed attempt have already streamed when the hook runs, so a
 * successful retry's answer replaces the partial in the result/audit trail
 * while a streaming client saw both.
 */
export interface ContextOverflowRecoveryContext {
  sessionId: string;
  modelSlug: string;
  contextWindow?: number;
  usage: LengthStopUsage;
  systemPrompt: string;
  messages: WorkbenchMessage[];
}

export interface ContextOverflowRecoveryPlan {
  messages: WorkbenchMessage[];
}

export type ContextOverflowRecoverer = (
  context: ContextOverflowRecoveryContext,
) => Promise<ContextOverflowRecoveryPlan | null>;

/**
 * Whether an error thrown by the budget machinery ahead of a provider call
 * means "the envelope refused this call". Used only for the recovery retry:
 * a refused retry downgrades to returning the truncated turn instead of
 * failing it — the paid partial output already streamed to the operator.
 * First-call budget errors keep their existing turn-failing behavior.
 *
 * A RunawayAnomalyHaltError is deliberately NOT a refusal: the anomaly gate
 * is a hard stop on runaway spend, and downgrading it to a delivered partial
 * would erase the halt from callers and the audit trail. It propagates and
 * fails the turn like any first-call halt.
 */
export function isBudgetRefusal(err: unknown): boolean {
  const name = (err as Error)?.name;
  return name === "BudgetExceededError" ||
    name === "BudgetCeilingDeclinedError";
}
