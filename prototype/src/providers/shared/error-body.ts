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
  /**
   * Whether the read stopped before the body's end: at the cap (so `bytes`
   * is a lower bound on the body's size), or because the read failed.
   */
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
      // Reaching the cap ends the read, whether or not more follows: the
      // header deadline is long cleared, so waiting for the next chunk of a
      // body that is exactly the cap and never closes would park the
      // adapter forever. The count is then a lower bound.
      if (bytes >= maxBytes) {
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
