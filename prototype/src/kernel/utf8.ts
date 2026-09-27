/**
 * UTF-8 byte bounding: cut or measure text against a byte ceiling without
 * splitting a multi-byte character.
 */

/**
 * The largest prefix of `bytes` that is at most `maxBytes` long and does not
 * split a multi-byte UTF-8 character. A UTF-8 continuation byte has the top two
 * bits `10`; walking the cut back while it sits on a continuation byte lands it
 * on the start of a character (or the end of the array), so the result decodes
 * cleanly with zero replacement characters. A naive `slice` plus a permissive
 * decode can instead swap a clipped tail for a differently-sized replacement
 * character and end up past the ceiling it was enforcing. A negative ceiling is
 * treated as zero, never as an offset from the end.
 */
export function utf8SafePrefix(
  bytes: Uint8Array,
  maxBytes: number,
): Uint8Array {
  let end = Math.max(0, Math.min(maxBytes, bytes.byteLength));
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end);
}

/**
 * `text` cut to at most `maxBytes` encoded UTF-8 bytes on a character
 * boundary, or null when it already fits.
 */
export function clipToUtf8Bytes(text: string, maxBytes: number): string | null {
  const encoded = new TextEncoder().encode(text);
  if (encoded.byteLength <= maxBytes) return null;
  return new TextDecoder().decode(utf8SafePrefix(encoded, maxBytes));
}

/**
 * `initialBytes` plus the UTF-8 length of `value`, or undefined as soon as the
 * running total exceeds `maxBytes`. The text is encoded in bounded chunks into
 * a fixed buffer, so an oversized value is refused without first allocating
 * its whole encoding. A value that adds nothing never overflows, even when
 * `initialBytes` is already past the limit.
 */
export function utf8ByteLengthWithinLimit(
  value: string,
  maxBytes: number,
  initialBytes = 0,
): number | undefined {
  const chunkCodeUnits = 4_096;
  // A BMP character needs at most 3 UTF-8 bytes. A surrogate pair needs 4
  // bytes across 2 code units, while a lone surrogate becomes U+FFFD (3
  // bytes), so 3 bytes per UTF-16 code unit is a conservative chunk bound.
  const maxBytesPerCodeUnit = 3;
  const encoder = new TextEncoder();
  const buffer = new Uint8Array(chunkCodeUnits * maxBytesPerCodeUnit);
  let bytes = initialBytes;
  for (let start = 0; start < value.length;) {
    let end = Math.min(start + chunkCodeUnits, value.length);
    // Never split a surrogate pair across chunks: each half alone would
    // encode as U+FFFD and miscount.
    if (
      end < value.length && value.charCodeAt(end - 1) >= 0xD800 &&
      value.charCodeAt(end - 1) <= 0xDBFF &&
      value.charCodeAt(end) >= 0xDC00 && value.charCodeAt(end) <= 0xDFFF
    ) {
      end -= 1;
    }
    const chunk = value.slice(start, end);
    const { read, written } = encoder.encodeInto(chunk, buffer);
    // A short read violates the buffer invariant. Report overflow so the
    // caller refuses the value rather than undercounting it.
    if (read !== chunk.length) return undefined;
    bytes += written;
    if (bytes > maxBytes) return undefined;
    start += read;
  }
  return bytes;
}
