/**
 * Small helpers the ACP runner uses around its child processes: a bounded
 * wait for a promise to settle and a bounded capture of a child's stderr.
 */

import type { Readable } from "node:stream";

/** Whether `promise` settles, either way, within `timeoutMs`. */
export async function settlesWithin(promise: Promise<unknown>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Keep at most `maxBytes` of `stream` as text, destroying the stream once the
 * bound is reached.
 */
export function collectBoundedStderr(
  stream: Readable,
  maxBytes: number,
): { text: () => string; cancel: () => void } {
  const decoder = new TextDecoder();
  let detail = "";
  let bytes = 0;
  const cancel = () => {
    stream.on("error", () => {});
    stream.destroy();
  };
  stream.on("data", (chunk: Uint8Array) => {
    const remaining = maxBytes - bytes;
    if (remaining <= 0) return;
    const kept = chunk.subarray(0, remaining);
    detail += decoder.decode(kept, { stream: true });
    bytes += kept.byteLength;
    if (chunk.byteLength >= remaining) cancel();
  });
  return {
    text: () => detail + decoder.decode(),
    cancel,
  };
}
