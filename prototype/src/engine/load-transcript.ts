/**
 * The `loadTranscript` stage (specs/01-architecture.md §5.1): the
 * conversation the first provider call carries — prior turns as real
 * messages (companion turns only; one-shot ask and next-work turns carry no
 * history) followed by the current user message — compressed first when it
 * would crowd the active model's context window.
 */
import type { WorkbenchMessage } from "../providers/mod.ts";
import {
  CONTEXT_COMPRESSION_TRIGGER_FRACTION,
  countTurns,
  partitionForCompression,
  VERBATIM_TAIL_TURNS,
} from "../context/mod.ts";
import { compressTranscript } from "./compression.ts";
import type { RoutedTurn } from "./routed-turn.ts";
import {
  estimateRuntimeInputCount,
  transcriptEstimateText,
} from "./transcript.ts";

/** Run the stage: seed, compress when needed, append the prompt. */
export async function loadTranscript(
  turn: RoutedTurn,
): Promise<WorkbenchMessage[]> {
  const { state, input, route } = turn;
  const prompt: WorkbenchMessage = { role: "user", content: state.modelPrompt };
  let seededHistory: WorkbenchMessage[] = !state.session.usesRepoAskContext
    ? input.conversationMessages ?? []
    : [];
  const contextWindow = route.selected.contextWindow;
  // Proactive compression: when the seeded transcript would cross ~50% of the
  // active model's context window, compress the elder turns before the first
  // provider call, keeping the most recent turns verbatim. A declined
  // compression leaves the transcript untouched and the turn runs
  // uncompressed.
  if (seededHistory.length > 0 && contextWindow !== undefined) {
    const estimatedTokens = estimateRuntimeInputCount(
      transcriptEstimateText(state.systemPrompt, [...seededHistory, prompt]),
    );
    if (
      estimatedTokens >= contextWindow * CONTEXT_COMPRESSION_TRIGGER_FRACTION
    ) {
      const { elder, tail } = partitionForCompression(
        seededHistory,
        VERBATIM_TAIL_TURNS,
      );
      // +1 for the current prompt: it was already persisted as a
      // session_start BEFORE this compression event, and it is appended to
      // the live transcript just below — so at this event's boundary the
      // retained turns are `tail` plus that prompt. Partitioning
      // `seededHistory` (which excludes the prompt) makes this off-by-one easy
      // to miss; resume would silently drop the oldest retained turn.
      const outcome = await compressTranscript(
        turn,
        elder,
        countTurns(tail) + 1,
        "proactive",
      );
      if (outcome.status === "compressed") {
        seededHistory = [outcome.summaryMessage, ...tail];
      }
    }
  }
  return [...seededHistory, prompt];
}
