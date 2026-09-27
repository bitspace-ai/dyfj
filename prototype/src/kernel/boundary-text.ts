/** Sanitizing for short single-field text that crosses a trust boundary. */
import { clipToUtf8Bytes } from "./utf8.ts";

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
 *     (the UDS peer is another local process, not this one), so honest
 *     content passes through unaffected
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
  return clipToUtf8Bytes(stripped, maxBytes) ?? stripped;
}
