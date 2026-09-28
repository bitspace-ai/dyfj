/**
 * Runtime-event delivery through the frame port's `onRuntimeEvent`
 * handler. Status events are best-effort; the two safety signals are
 * fail-closed.
 */

import {
  summarizeError,
  type SupersedingRetryStartedEvent,
  type UnparsedToolCallMarkupDetectedEvent,
  type WorkbenchRuntimeEvent,
} from "../contract/mod.ts";
import type { FrameSink } from "./runtime-types.ts";

export async function emitRuntimeEvent(
  handler: FrameSink["onRuntimeEvent"],
  event: WorkbenchRuntimeEvent,
): Promise<void> {
  if (!handler) return;
  try {
    await handler(event);
  } catch (err) {
    // Provenance-summarized, never raw: an observer failure can wrap a
    // foreign error whose message embeds payload content.
    console.warn(`Runtime observer skipped: ${summarizeError(err)}`);
  }
}

/**
 * Deliver the superseding-retry signal without the best-effort swallow used for
 * non-safety runtime events.
 *
 * Non-safety runtime events are status lines: losing one costs the consumer
 * some progress detail. This signal requires a consumer to *act* —
 * it is what tells a streaming client to discard the text it has already
 * rendered. If it is dropped, the replacement deltas concatenate onto the stale
 * ones and are presented as one answer, which is exactly the corruption this
 * contract exists to prevent. So delivery is fail-closed: a throwing handler
 * propagates, the caller's catch closes the recovery trail, and the turn fails
 * instead of streaming a replacement the consumer cannot distinguish.
 *
 * No handler means no event channel at all (the in-process presenter): there is
 * nothing to drop, and the recovery log note is that consumer's signal.
 */
export async function deliverSupersedingRetrySignal(
  handler: FrameSink["onRuntimeEvent"],
  event: SupersedingRetryStartedEvent,
): Promise<void> {
  if (!handler) return;
  await handler(event);
}

/**
 * Deliver the unparsed-markup warning as a required safety signal. A turn must
 * not complete successfully when its client could not receive the disclosure.
 */
export async function deliverUnparsedToolCallMarkupSignal(
  handler: FrameSink["onRuntimeEvent"],
  event: UnparsedToolCallMarkupDetectedEvent,
): Promise<void> {
  if (!handler) return;
  await handler(event);
}
