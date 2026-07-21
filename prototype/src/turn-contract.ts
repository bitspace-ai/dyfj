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
    /**
     * Provider-reported reasoning/thinking tokens across the turn, when the
     * provider reports them separately from visible output (e.g. Gemini's
     * thoughtsTokenCount). Optional and additive: older servers omit it, and
     * clients must render it only when present and non-zero. Display-only —
     * recorded usage and cost intentionally exclude these tokens.
     */
    reasoning?: number;
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
/**
 * What made a retry superseding. Deliberately open: producers may add reasons,
 * and a consumer that does not recognize one must still reset its render rather
 * than ignore the signal. Known values are spelled out for autocomplete; the
 * open arm keeps the type honest about what the guard actually accepts, so a
 * consumer cannot narrow to a closed set that the wire does not guarantee.
 */
export type SupersedingRetryReason =
  | "context_overflow_recovery"
  | (string & {});

export type SupersedingRetryStartedEvent = {
  type: "supersedingRetryStarted";
  sessionId: string;
  modelSlug: string;
  reason: SupersedingRetryReason;
};

/**
 * Discriminator guard for consumers reading opaque event records.
 *
 * Takes `unknown`: event frames arrive as unvalidated JSON over SSE and the UDS
 * seam, so a buggy or hostile producer can send `null` or a primitive. Reject
 * those instead of throwing on a property read.
 *
 * `reason` is accepted as any non-empty string rather than pinned to today's
 * single value: it is an open union (`SupersedingRetryReason`), and pinning it
 * here would make a future producer's signal silently fail to reset the render —
 * a missed reset is the corrupted output this contract exists to prevent, and is
 * worse than the malformed frame being guarded against. The empty string is
 * still rejected: every real reason names something.
 */
export function isSupersedingRetryStarted(
  event: unknown,
): event is Record<string, unknown> & SupersedingRetryStartedEvent {
  if (typeof event !== "object" || event === null) return false;
  const record = event as Record<string, unknown>;
  return record.type === "supersedingRetryStarted" &&
    typeof record.sessionId === "string" &&
    typeof record.modelSlug === "string" &&
    typeof record.reason === "string" && record.reason.length > 0;
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

/**
 * Marker base class for errors this codebase constructs from app-controlled,
 * bounded values — a routing reason, a config field, an operator's typed
 * decline reason, a policy verdict — never by echoing back an untrusted or
 * unbounded value from a driver, dependency, or external system. Every
 * intentional error type this codebase throws (RpcError, BudgetExceededError,
 * ContextWindowOverflowError, the provider setup errors, etc.) extends this,
 * so `summarizeError` can trust its message enough to forward a capped
 * excerpt. `instanceof Error` proves nothing about provenance — a caught
 * driver/dependency error is `instanceof Error` too, and its message can
 * embed exactly the unbounded payload this boundary exists to keep off the
 * wire — so anything that is NOT a DomainError renders as class + byte count
 * only, no message content at all, not even a short one.
 */
export class DomainError extends Error {}

// The safe cap on a DomainError's message crossing the turn/wire boundary. A
// runtime event, a UDS/SSE notification, a console-bound presenter, or a CLI
// error printer that forwards `err.message` verbatim risks leaking whatever
// that message contains — safe for a DomainError (bounded by construction),
// unsafe for anything else. Shared here (not duplicated per side) because the
// server (workbench.ts) and every client (cli.ts) need the identical
// discipline.
export const MAX_ERROR_SUMMARY_BYTES = 500;

/**
 * Summarize `error` for anything that crosses the turn/wire boundary. Never
 * throws.
 *
 * - `DomainError` (app-authored, safe by construction): the message passes
 *   through, capped at `MAX_ERROR_SUMMARY_BYTES` with a fixed
 *   `DomainError` + byte-count marker on truncation — the existing, more
 *   permissive treatment, because these messages carry real
 *   operator-relevant diagnostic content (a budget ceiling, a
 *   context-window figure, a declined-escalation reason).
 * - Anything else (a caught driver/dependency error, or a non-Error throw):
 *   a fixed provenance label + byte count ONLY. No prefix of the message is
 *   ever included — a short foreign message can still be exactly the
 *   leaking fragment, so there is no size threshold under which forwarding
 *   it is safe.
 *
 * Every string this function returns is either a DomainError message
 * (bounded by construction) or built from its own fixed literals. It never
 * reads `.name` or `.constructor.name` off the candidate: both are ordinary
 * writable properties, so a foreign error could carry an arbitrary,
 * oversized, or control-character payload in them, and an uncapped label
 * would reopen exactly the channel this boundary closes. Callers that can
 * prove more (the server's fixed-literal class table) may log a richer
 * label themselves.
 */
export function summarizeError(error: unknown): string {
  try {
    // Message extraction is best-effort: a hostile object's `message` getter
    // or `toString` can throw, and this function must not.
    let message: string;
    try {
      message = error instanceof Error ? error.message : String(error);
    } catch {
      message = "";
    }
    const encoded = new TextEncoder().encode(message);
    const label = error instanceof Error ? "Error" : typeof error;
    if (!(error instanceof DomainError)) {
      return `[${label}, ${encoded.byteLength} bytes]`;
    }
    if (encoded.byteLength <= MAX_ERROR_SUMMARY_BYTES) return message;
    // fatal: false — a byte-boundary cut can land mid multi-byte sequence;
    // decode permissively (U+FFFD for the partial tail) since this is a
    // display excerpt, not the value itself.
    const excerpt = new TextDecoder("utf-8", { fatal: false })
      .decode(encoded.slice(0, MAX_ERROR_SUMMARY_BYTES));
    return `${excerpt}… [truncated; DomainError, ${encoded.byteLength} bytes]`;
  } catch {
    // Even summarization can fail — encoding a near-limit string can throw
    // on allocation. The never-throws contract survives on a fixed literal
    // that carries no content at all.
    return "[unrepresentable error]";
  }
}

// A "short" cap for a single field interpolated into a larger DomainError
// message (a decline reason, an approval comment) — smaller than
// MAX_ERROR_SUMMARY_BYTES because it is one piece of a bigger message, not
// the whole thing.
export const MAX_REASON_FIELD_BYTES = 200;

/**
 * Cap `raw` to `maxBytes` UTF-8 bytes (byte-safe — never splits a multi-byte
 * character) and strip C0/C1 control characters and DEL, including the ESC
 * byte that starts a terminal escape sequence. Tab/newline/carriage-return
 * collapse to a single space rather than being dropped outright — this
 * function's callers are single-field, 200–500-byte strings (a reason, a
 * wire-derived error message), not multi-line content, and LF/CR are their
 * own injection surface at that size: an embedded LF can forge a fake log
 * line in a durable/console record, and a CR can rewind the cursor to
 * overwrite a rendered prefix in a terminal. Collapsing instead of dropping
 * keeps words from running together (a reason of "line one\nline two" reads
 * as "line one line two", not "line oneline two").
 *
 * DomainError is a provenance marker, not a content filter: it means "this
 * codebase constructed the message," not "every byte in it is safe to
 * display or store." Two places still need explicit sanitizing even for
 * trusted DomainErrors:
 *   - A reason/comment field interpolated into a DomainError's message that
 *     originated from an operator, a remote approval peer, or an injected
 *     callback the caller controls — content this codebase did not author,
 *     merely relayed.
 *   - A message reconstructed on one side of the wire from a string the
 *     OTHER side sent — the sender already ran its own message through
 *     summarizeError, but the wire itself is not a trust boundary
 *     (config.serverUrl is operator-configurable; the UDS peer is a local
 *     socket, not this process), so honest content passes through unaffected
 *     while a hostile or buggy peer's content is bounded and inert.
 */
export function sanitizeBoundaryText(raw: string, maxBytes: number): string {
  // Iterate by code point (not UTF-16 code unit) so a surrogate pair stays
  // intact, and filter by numeric range rather than a regex/string literal
  // containing control characters -- those are exactly the bytes this
  // function exists to strip, so building the filter out of numeric
  // comparisons avoids ever writing one into the source.
  let stripped = "";
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    const isTab = code === 9;
    const isLf = code === 10;
    const isCr = code === 13;
    if (isTab || isLf || isCr) {
      stripped += " ";
      continue;
    }
    const isC0Control = code <= 31;
    const isDel = code === 127;
    const isC1Control = code >= 128 && code <= 159;
    if (isC0Control || isDel || isC1Control) continue;
    stripped += ch;
  }
  const encoded = new TextEncoder().encode(stripped);
  if (encoded.byteLength <= maxBytes) return stripped;
  // Byte-safe: walk the cut point back over any trailing UTF-8 continuation
  // bytes (top two bits `10`) so it lands on a character boundary -- no
  // replacement characters, no risk of landing mid multi-byte sequence.
  let end = maxBytes;
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end--;
  return new TextDecoder("utf-8").decode(encoded.slice(0, end));
}
