/**
 * The bounded read of a non-2xx response body, shared by every adapter. The
 * classifier matches the first few KiB and the operator sees only a byte
 * count, so nothing past the cap is worth holding: the read stops there,
 * cancels the rest, and says it was cut. Bytes are counted as they arrive,
 * so no second copy of the body is ever made to measure it.
 */

/** The most of an error body any adapter keeps in memory. */
export const MAX_ERROR_BODY_BYTES = 64 * 1024;

export interface ErrorBody {
  /** The body's text up to the cap; empty when there was no body. */
  text: string;
  /** Bytes received and kept, at most the cap. */
  bytes: number;
  /** Whether the body went past the cap, or the read failed part-way. */
  truncated: boolean;
}

export async function readBoundedErrorBody(
  response: Response,
  maxBytes: number = MAX_ERROR_BODY_BYTES,
): Promise<ErrorBody> {
  const stream = response.body;
  if (stream === null) return { text: "", bytes: 0, truncated: false };
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytes = 0;
  let truncated = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const room = maxBytes - bytes;
      const kept = value.byteLength > room ? value.subarray(0, room) : value;
      parts.push(decoder.decode(kept, { stream: true }));
      bytes += kept.byteLength;
      if (kept.byteLength < value.byteLength) {
        truncated = true;
        void reader.cancel().catch(() => {});
        break;
      }
    }
  } catch {
    // A body that fails part-way (a reset mid-read) is reported as cut; what
    // arrived still classifies.
    truncated = true;
  }
  // Flushing a cut body would turn its trailing partial character into
  // U+FFFD and push the text past the cap; a whole body has nothing pending.
  if (!truncated) parts.push(decoder.decode());
  return { text: parts.join(""), bytes, truncated };
}
