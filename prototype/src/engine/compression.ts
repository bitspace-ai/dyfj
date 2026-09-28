/**
 * Transcript compression for a routed turn: summarize elder conversation
 * turns into a named-section summary on an on-machine model, persist the
 * `context_compressed` event that lets resume rebuild the same transcript,
 * and only then hand the compressed transcript back.
 *
 * Two triggers share it: `loadTranscript`'s proactive compression before the
 * first call, and the agent loop's reactive recovery when a call overflows
 * the context window. Every failure path returns a declined outcome rather
 * than throwing; the caller decides what a decline means. The one exception
 * is a write whose durability cannot be determined, which fails the turn.
 */
import { generateSpanId, generateULID } from "../kernel/mod.ts";
import { contextCompressedEvent } from "../store/mod.ts";
import {
  isLocalWorkbenchModel,
  selectWorkbenchModel,
  type WorkbenchMessage,
  type WorkbenchModel,
} from "../providers/mod.ts";
import {
  compressElderTranscript,
  COMPRESSION_SYSTEM_PROMPT,
  type CompressionCompletion,
  type CompressionOutcome,
  type ContextOverflowRecoverer,
  countTurns,
  partitionForCompression,
  VERBATIM_TAIL_TURNS,
} from "../context/mod.ts";
import {
  classifyErrorKind,
  ContextCompressionPersistenceUncertainError,
} from "./errors.ts";
import { observedProviderCall } from "./observed-call.ts";
import type { RoutedTurn } from "./routed-turn.ts";
import { emitRuntimeEvent } from "./runtime-events.ts";
import {
  estimateRuntimeInputCount,
  transcriptEstimateText,
} from "./transcript.ts";
import { commitEvent } from "./turn-state.ts";

export type CompressionTrigger = "proactive" | "context_overflow";

type Compressed = Extract<CompressionOutcome, { status: "compressed" }>;

/**
 * Compress `elder`. `turnsRetained` is the number of turns that, AT THE
 * MOMENT THE EVENT IS WRITTEN, already exist in the event stream and survive
 * verbatim in the live transcript. It is the caller's to compute: the two
 * triggers differ on whether the current prompt is already inside the tail,
 * and getting that wrong silently drops a retained turn on resume.
 */
export async function compressTranscript(
  turn: RoutedTurn,
  elder: WorkbenchMessage[],
  turnsRetained: number,
  trigger: CompressionTrigger,
): Promise<CompressionOutcome> {
  const model = compressionModel(turn);
  if (!("slug" in model)) return model;
  const outcome = await compressElderTranscript(
    elder,
    compressionCompletion(turn, model),
    (msgs) => estimateRuntimeInputCount(transcriptEstimateText("", msgs)),
    turn.input.abortSignal,
  );
  if (outcome.status !== "compressed") return outcome;
  if (!await persistCompression(turn, outcome, turnsRetained, trigger)) {
    return { status: "declined", reason: "compression event not persisted" };
  }
  // Durable now: surface it live — visible context source (receipt +
  // inspector) and a runtime event, so compression is never invisible.
  turn.state.contextSourceLines.push(
    `compressed conversation summary (${outcome.turnsCompressed} turns ` +
      `→ ~${outcome.tokensAfterEstimate} tokens)`,
  );
  await emitRuntimeEvent(turn.input.frames?.onRuntimeEvent, {
    type: "contextCompressed",
    sessionId: turn.state.session.sessionId,
    compressorModelSlug: outcome.compressorModelSlug,
    trigger,
    turnsCompressed: outcome.turnsCompressed,
    tokensBeforeEstimate: outcome.tokensBeforeEstimate,
    tokensAfterEstimate: outcome.tokensAfterEstimate,
  });
  return outcome;
}

/**
 * Reactive recovery: compress-then-retry, used when a call overflows the
 * context window and the caller supplied no recoverer of its own. A declined
 * compression returns null, which fails the turn with the structured
 * ContextWindowOverflowError — never a corrupted transcript.
 */
export function compressionRecoverer(
  turn: RoutedTurn,
): ContextOverflowRecoverer {
  return async (context) => {
    const { elder, tail } = partitionForCompression(
      context.messages,
      VERBATIM_TAIL_TURNS,
    );
    // No +1 here, unlike the proactive path: context.messages is the
    // transcript that overflowed, which ALREADY ends with the current prompt,
    // so the prompt is inside `tail` and counting it again would over-retain
    // on resume.
    const outcome = await compressTranscript(
      turn,
      elder,
      countTurns(tail),
      "context_overflow",
    );
    if (outcome.status !== "compressed") return null;
    return { messages: [outcome.summaryMessage, ...tail] };
  };
}

/**
 * The on-machine model compression runs on: the session model when it is
 * tier 0 and local, else the registry's preferred tier-0 local model. It
 * never escalates to a hosted endpoint; a decline is the only alternative.
 */
function compressionModel(
  turn: RoutedTurn,
): WorkbenchModel | CompressionOutcome {
  const { models, selected } = turn.route;
  let model: WorkbenchModel;
  try {
    // Locality is a ROUTING input, not only a backstop: tier does not imply
    // on-machine, so both arms must consider local rows only. The session
    // model may itself be a tier-0 hosted row, and the registry's preferred
    // tier-0 row may be hosted while a local one exists — either would
    // otherwise decline compression despite a routable local model. Filter to
    // on-machine candidates first, then let the selector apply its own
    // pricing/preference rules within them.
    const localTier0 = models.filter(
      (candidate) => candidate.tier === 0 && isLocalWorkbenchModel(candidate),
    );
    model = selected.tier === 0 && isLocalWorkbenchModel(selected)
      ? selected
      : selectWorkbenchModel(
        localTier0,
        { tier: 0 },
        turn.input.defaultCompanionModel,
      ).selected;
  } catch {
    // Empty candidate set (or an unpriced one) throws from the selector; a
    // decline is the only outcome — compression never escalates off-machine.
    return {
      status: "declined",
      reason: "no local model routable for compression",
    };
  }
  // Locality boundary — NOT tier alone: a tier-0 row could name a hosted
  // provider, which would send the elder transcript off-machine. Require an
  // on-machine local provider on a loopback URL; decline otherwise.
  if (!isLocalWorkbenchModel(model)) {
    return {
      status: "declined",
      reason: "no on-machine local model for compression",
    };
  }
  return model;
}

/** One budget-gated, recorded compression call on `model`. */
function compressionCompletion(
  turn: RoutedTurn,
  model: WorkbenchModel,
): CompressionCompletion {
  const { state, route } = turn;
  const { budget, anomalyConfig } = state.session;
  return async (compressionInput) => {
    const estimatedInputCount = estimateRuntimeInputCount(
      transcriptEstimateText(COMPRESSION_SYSTEM_PROMPT, compressionInput),
    );
    // Gate on the compression model's OWN tier (0 → free, so the gates pass
    // trivially); a paid model — which selection forbids — would be caught
    // here, and any budget refusal declines compression via the catch in
    // compressElderTranscript rather than failing the turn.
    await route.anomalyGate.ensureAllowed(
      budget.checkAnomaly(model.tier, anomalyConfig),
    );
    await route.budgetCeilingGate.ensureAllowed(
      budget.checkPreCall(model.tier, model.costInput, estimatedInputCount),
    );
    // No tools, no streaming to the operator: the compression turn produces
    // a structured summary out of band, never rendered as reply text.
    const { turn: result, recorded } = await observedProviderCall(
      turn.observed,
      {
        params: {
          systemPrompt: COMPRESSION_SYSTEM_PROMPT,
          prompt: "",
          messages: compressionInput,
          routing: { modelId: model.slug },
          models: route.models,
          abortSignal: turn.input.abortSignal,
          sessionId: state.session.sessionId,
          ...turn.ports.providerIo,
        },
        model,
        order: ++state.providerCallOrder,
        purpose: "context_compression",
        authzBasis: "policy:local-compression",
        recordUnparsedToolCallMarkup: false,
      },
    );
    if (recorded) {
      state.reasoningTokens += result.usage.reasoning ?? 0;
    }
    return {
      text: result.text,
      modelSlug: result.model.slug,
      stopReason: result.stopReason,
    };
  };
}

/**
 * Persist the compression FIRST and durably. The live turn uses the
 * compressed transcript only once the event that lets resume reconstruct it
 * is written; a write that did not land declines compression, so the live
 * transcript never diverges from what resume would rebuild. Returns whether
 * the event is durable.
 */
async function persistCompression(
  turn: RoutedTurn,
  outcome: Compressed,
  turnsRetained: number,
  trigger: CompressionTrigger,
): Promise<boolean> {
  const { session } = turn.state;
  // The id is generated HERE, not inside the write, so a rejected write can
  // be probed for by id — see the ambiguity handling below.
  const compressionEventId = generateULID();
  try {
    await commitEvent(
      turn.ports.store,
      contextCompressedEvent({
        event_id: compressionEventId,
        session_id: session.sessionId,
        trace_id: session.traceId,
        span_id: generateSpanId(),
        parent_span_id: session.turnRootSpanId,
        principal_id: session.principalId,
        principal_type: "agent",
        action: "compress",
        resource: "conversation_context",
        authz_basis: "policy:local-compression",
        ...session.authnEventFields,
        content: JSON.stringify({
          summary: outcome.summary,
          // LOAD-BEARING for replay: the count of turns kept verbatim at this
          // event's boundary, counted per THE TURN-COUNTING INVARIANT (see
          // countTurns). Trailing, so it needs no shared base — replay
          // rebuilds the full history while the live seed is capped to the
          // recent turns, and a leading count would mean different things to
          // each. `turnsCompressed` below is observability only (the CLI
          // status line); replay never keys on it.
          turnsRetained,
          turnsCompressed: outcome.turnsCompressed,
          compressorModelSlug: outcome.compressorModelSlug,
          trigger,
          tokensBeforeEstimate: outcome.tokensBeforeEstimate,
          tokensAfterEstimate: outcome.tokensAfterEstimate,
        }),
      }),
    );
    return true;
  } catch (err) {
    return await resolveRejectedWrite(turn, compressionEventId, err);
  }
}

/**
 * A rejected write does NOT mean "not persisted": the row may have committed
 * and only the acknowledgment been lost. Probe by id to resolve the three
 * real cases: not durable (decline), durable (adopt), or unknowable (fail).
 */
async function resolveRejectedWrite(
  turn: RoutedTurn,
  compressionEventId: string,
  err: unknown,
): Promise<boolean> {
  // Log the error CLASS, not its message: the failing write carries the
  // conversation summary, and a DB/serialization error can quote it — this
  // channel is content-free by convention. classifyErrorKind never reads a
  // string OFF the candidate (.name and .constructor.name are both ordinary,
  // attacker-shapeable properties) — classification comes from instanceof
  // against classes this codebase controls.
  const kind = classifyErrorKind(err);
  let landed: boolean;
  try {
    landed = await turn.ports.store.events.exists(compressionEventId);
  } catch (probeErr) {
    // Genuinely ambiguous — we cannot learn whether the row is durable, so no
    // choice is safe: continuing uncompressed may diverge from a resume that
    // applies the event, and adopting may pin a summary that was never
    // stored. Ambiguity is the one case that fails the turn.
    throw new ContextCompressionPersistenceUncertainError(
      kind,
      classifyErrorKind(probeErr),
    );
  }
  if (!landed) {
    // Genuinely not persisted: decline, and the caller continues on the
    // uncompressed transcript — the designed graceful fallback.
    console.warn(
      `context compression event write failed (${kind}); declining`,
    );
    return false;
  }
  // Rejected, but the row IS durable. Adopt the compression: resume will
  // rebuild from this event, so the live transcript must match it.
  console.warn(
    `context compression event write reported ${kind} but the row is ` +
      `durable; adopting the compressed transcript`,
  );
  return true;
}
