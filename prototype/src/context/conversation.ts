import type { WorkbenchMessage } from "../provider.ts";
import { formatSummaryMessage } from "./compression.ts";
import {
  ACP_TOOL_HISTORY_UNAVAILABLE_NAME,
  DomainError,
  type HistoryOmissionProjection,
  type WorkbenchSessionEvent,
} from "../contract/mod.ts";

/**
 * Rebuild prior session turns as real conversation messages for resume, so the
 * model sees structured user/assistant turns instead of a flattened "Conversation
 * so far:" string. Prompts live on session_start events (operator → user turns);
 * responses on model_response events (→ assistant turns); and tool_call events
 * are replayed as the assistant's tool-call intention immediately
 * followed by its matching result, so a resumed model sees its own tool trail
 * rather than a transcript that silently dropped it. Returns the most recent
 * `maxTurns` turns; whole turns are kept (no mid-turn truncation). The caller
 * appends the current user message and seeds the agent loop with the result.
 */
export function buildConversationMessages(
  events: WorkbenchSessionEvent[],
  options: {
    maxTurns?: number;
    onOmission?: (omission: HistoryOmissionProjection | undefined) => void;
  } = {},
): WorkbenchMessage[] {
  const maxTurns = options.maxTurns ?? 10;
  type ProjectionItem =
    | { kind: "message"; message: WorkbenchMessage; projectedPair?: true }
    | { kind: "withheld"; reason: "malformed" | "gap" };
  const items: ProjectionItem[] = [];
  let malformedToolRecords = 0;
  let gapMarkers = 0;
  const pushMessage = (
    message: WorkbenchMessage,
    projectedPair = false,
  ) => {
    items.push({
      kind: "message",
      message,
      ...(projectedPair ? { projectedPair: true as const } : {}),
    });
  };
  // The pinned summary from the most recent context_compressed event, if any.
  // It survives the recent-turns cap below, mirroring the live session where a
  // compression replaced everything before it.
  let pinnedSummary: ProjectionItem | null = null;
  for (const event of events) {
    if (event.eventType === "context_compressed") {
      // Compression replaced the elder turns with one summary, keeping a
      // verbatim tail. Rebuild the SAME marked summary the live session injected
      // — via the shared formatter — and keep exactly the turns it kept, so a
      // resumed transcript is [summary, tail, ...]: byte-consistent with what the
      // model saw. Removing everything before the event instead would drop the
      // tail and the current prompt too.
      //
      // Key on the RETAINED (trailing) count, never a compressed (leading) one:
      // the live path counts against a seed already capped to the recent turns,
      // while this rebuilds the FULL history, so a leading count would drop
      // unrelated oldest turns and leave the summarized ones standing. A trailing
      // count needs no shared base — see THE TURN-COUNTING INVARIANT on
      // countTurns, whose turn semantics this must match.
      //
      // A missing or unparseable payload — including an event predating the
      // retained count — keeps prior turns rather than losing history: that
      // session resumes uncompressed.
      if (event.content === null) continue;
      let parsed: { summary?: unknown; turnsRetained?: unknown };
      try {
        parsed = JSON.parse(event.content);
      } catch {
        continue;
      }
      const { summary, turnsRetained } = parsed;
      if (typeof summary !== "string" || summary.trim().length === 0) continue;
      if (
        typeof turnsRetained !== "number" ||
        !Number.isInteger(turnsRetained) || turnsRetained < 0
      ) {
        continue;
      }
      keepTrailingProjectionTurns(items, turnsRetained);
      pinnedSummary = {
        kind: "message",
        message: formatSummaryMessage(summary),
      };
      items.unshift(pinnedSummary);
    } else if (event.eventType === "session_start") {
      if (event.content === null) continue;
      pushMessage({ role: "user", content: event.content });
    } else if (
      event.eventType === "model_response" ||
      event.eventType === "agent_response"
    ) {
      if (event.content === null) continue;
      pushMessage({ role: "assistant", content: event.content });
    } else if (event.eventType === "tool_call") {
      if (event.toolName === ACP_TOOL_HISTORY_UNAVAILABLE_NAME) {
        gapMarkers += 1;
        items.push({ kind: "withheld", reason: "gap" });
        continue;
      }
      // One tool_call event carries both halves: the call (name/id/arguments)
      // and its result. Emit them as a paired assistant+tool sequence so the
      // wire-format invariant holds — a `tool` message MUST be immediately
      // preceded by an `assistant` message bearing the same tool-call id.
      if (
        event.toolHistoryValid === false || event.toolCallId === null ||
        event.toolName === null || event.toolArguments === null ||
        event.toolResult === null || event.toolIsError === null
      ) {
        malformedToolRecords += 1;
        items.push({ kind: "withheld", reason: "malformed" });
        continue;
      }
      pushMessage({
        role: "assistant",
        content: "",
        toolCalls: [{
          id: event.toolCallId,
          name: event.toolName,
          arguments: event.toolArguments,
        }],
      });
      pushMessage({
        role: "tool",
        toolCallId: event.toolCallId,
        name: event.toolName,
        content: event.toolResult,
        // Replay the failure mark, so a resumed transcript serializes the
        // result as an error (Anthropic is_error) exactly like the live turn.
        ...(event.toolIsError ? { isError: true } : {}),
      }, true);
    }
  }
  // Pin the summary past the recent-turns cap: keep it, then the most recent
  // `maxTurns` turns that followed it. Without this a long post-compression run
  // could slice the summary off and lose all the compressed history.
  const selected = pinnedSummary !== null && items[0] === pinnedSummary
    ? [pinnedSummary, ...sliceProjectionToRecentTurns(items.slice(1), maxTurns)]
    : sliceProjectionToRecentTurns(items, maxTurns);
  const messages = selected.flatMap((item) =>
    item.kind === "message" ? [item.message] : []
  );
  const detectedInHistory = malformedToolRecords + gapMarkers;
  const omission = detectedInHistory === 0 ? undefined : {
    detectedInHistory,
    malformedToolRecords,
    gapMarkers,
    callsUnknown: gapMarkers > 0,
    withheldFromProjection:
      selected.filter((item) => item.kind === "withheld").length,
    projectedPairs:
      selected.filter((item) =>
        item.kind === "message" && item.projectedPair === true
      ).length,
  } satisfies HistoryOmissionProjection;
  options.onOmission?.(omission);
  assertRepresentableToolHistory(messages);
  if (omission !== undefined && messages.length === 0) {
    throw new DomainError(
      "Session history is empty after withholding unavailable tool evidence",
    );
  }
  return messages;
}

/** Fail closed if a projected transcript contains a split tool pair. */
export function assertRepresentableToolHistory(
  messages: readonly WorkbenchMessage[],
): void {
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0) {
      const calls = message.toolCalls!;
      const result = messages[index + 1];
      if (
        calls.length !== 1 || result === undefined || result.role !== "tool" ||
        result.toolCallId !== calls[0].id
      ) {
        throw new DomainError(
          "Session contains unrepresentable persisted tool history",
        );
      }
    } else if (message.role === "tool") {
      const request = messages[index - 1];
      if (
        request === undefined || request.role !== "assistant" ||
        request.toolCalls?.length !== 1 ||
        request.toolCalls[0].id !== message.toolCallId
      ) {
        throw new DomainError(
          "Session contains unrepresentable persisted tool history",
        );
      }
    }
  }
}

/**
 * Keep only the most recent `turns` turns, mutating in place. Used on resume to
 * retain exactly the verbatim tail a context_compressed event kept, counted per
 * THE TURN-COUNTING INVARIANT (a turn begins at each user message — the same
 * rule `countTurns` and `sliceToRecentTurns` use; they must not drift apart).
 *
 * Trailing rather than leading on purpose: the live path's tail is a suffix of
 * the full history even though its seed was capped, so a trailing count means
 * the same thing to both paths. `turns` of 0 keeps nothing; more turns than
 * exist keeps everything.
 */
function keepTrailingProjectionTurns<
  T extends {
    kind: "message" | "withheld";
    message?: WorkbenchMessage;
  },
>(items: T[], turns: number): void {
  if (turns <= 0) {
    items.splice(0, items.length);
    return;
  }
  const userIndices: number[] = [];
  for (let i = 0; i < items.length; i++) {
    if (items[i].message?.role === "user") userIndices.push(i);
  }
  if (userIndices.length <= turns) return;
  items.splice(0, userIndices[userIndices.length - turns]);
}

/**
 * Keep the most recent `maxTurns` user-initiated turns. Truncation lands on a
 * `user` turn boundary so a `tool` message is never separated from the
 * `assistant` tool-call it answers (which the wire format forbids). For a
 * tool-free transcript this is exactly the prior "last maxTurns exchanges".
 */
function sliceProjectionToRecentTurns<
  T extends {
    kind: "message" | "withheld";
    message?: WorkbenchMessage;
  },
>(
  items: T[],
  maxTurns: number,
): T[] {
  const userIndices: number[] = [];
  for (let i = 0; i < items.length; i++) {
    if (items[i].message?.role === "user") userIndices.push(i);
  }
  if (userIndices.length <= maxTurns) return items;
  return items.slice(userIndices[userIndices.length - maxTurns]);
}
