/**
 * Turn seam contract (— "lock the REST/SSE seam contract").
 *
 * The single typed definition of what crosses the `POST /api/turn` boundary,
 * shared by the server (`http.ts`, which produces it) and every client
 * (`cli.ts` today, any future headless Workshop driver tomorrow, which consume
 * it). This is the migration firewall's contract: the runtime may change behind
 * it, but the receipt a turn carries over the wire is pinned here.
 *
 * Before this module the client hand-rolled its own copy of the result shape
 * and the SSE frame union; they had already drifted (the client copy was
 * missing `context`, so `context.sources` could never reach it). One definition
 * makes such drift a compile error instead of a silent wire regression.
 *
 * The server asserts its `WorkbenchRuntimeResult` satisfies `TurnReceipt`
 * (see `http.ts`), so dropping or renaming a receipt field stops compiling.
 */

/**
 * The receipt a single turn carries — identical on the buffered (JSON) and
 * streaming (SSE) paths. This is the operator-facing, recomputable record of
 * what a turn cost, which model ran, how it routed, and what fed its context.
 */
export interface TurnReceipt {
  sessionId: string;
  traceId: string;
  text: string;
  receipt: string;
  model: {
    displayName: string;
    slug: string;
    provider?: string;
    api?: string;
    tier: 0 | 1 | 2;
  };
  route: { reason: string };
  cost: {
    estimatedUsd: number;
    totalUsd: number;
    paidInferenceUsed: boolean;
  };
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalCalls: number;
  };
  /** Context provenance — what fed the turn (memory + repo sources). */
  context: { sources: string[] };
}

/**
 * SSE frame protocol, negotiated via `Accept: text/event-stream`. Each wire
 * frame is `data: <json>\n\n` carrying one of these, discriminated by `t`:
 *   delta  — incremental model text
 *   event  — a lifecycle record (opaque JSON; the typed record is the receipt —
 *            except the superseding-retry signal below, which is pinned here
 *            because clients must ACT on it, not merely display it)
 *   done   — terminal success, carrying the full TurnReceipt
 *   error  — terminal failure
 */
export type TurnStreamFrame =
  | { t: "delta"; text: string }
  | { t: "event"; event: Record<string, unknown> }
  | { t: "done"; result: TurnReceipt }
  | { t: "error"; message: string };

/**
 * The superseding-retry signal. Emitted between the deltas of an abandoned
 * attempt and the deltas of the retry that replaces it — e.g. when
 * context-overflow recovery re-runs a turn on a recovered (compressed)
 * transcript. Everything streamed for this turn BEFORE the signal is stale:
 * the retry's answer replaces it, it does not continue it. A rendering client
 * must reset its rendered buffer for the turn; the authoritative text is
 * whatever streams after, or the receipt's `text`.
 *
 * This is the one lifecycle event whose shape is part of the wire contract:
 * deltas and events share one ordered channel on both transports (SSE frames,
 * UDS `stream` notifications), so in-order delivery of the signal relative to
 * the deltas around it is guaranteed. Continuation retries (output-cap
 * recovery) never emit it — their retry streams only new text.
 */
// A type alias, not an interface: the transports forward events as
// `Record<string, unknown>` frames, and only alias-declared object types are
// assignable to that index signature.
export type SupersedingRetryStartedEvent = {
  type: "supersedingRetryStarted";
  sessionId: string;
  modelSlug: string;
  /** What made the retry superseding (extensible union). */
  reason: "context_overflow_recovery";
};

/** Discriminator guard for consumers reading opaque event records. */
export function isSupersedingRetryStarted(
  event: Record<string, unknown>,
): event is Record<string, unknown> & SupersedingRetryStartedEvent {
  return event.type === "supersedingRetryStarted";
}

/**
 * Buffered (non-streaming) JSON turn response: the receipt plus the batched
 * lifecycle events. The streaming path delivers the same receipt in the `done`
 * frame and the same events as `event` frames — transports differ only in how
 * events arrive, never in the receipt.
 */
export interface BufferedTurnResponse extends TurnReceipt {
  events: Array<Record<string, unknown>>;
}
