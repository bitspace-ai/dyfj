/**
 * Server-sent-event line reading shared by the adapters.
 */
import { isAbortFromSignal } from "./abort.ts";

export function isIncompleteSseDataLine(line: string, error: unknown): boolean {
  if (!(error instanceof SyntaxError)) return false;
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return false;
  const data = trimmed.slice("data:".length).trim();
  if (data.length === 0) return true;
  if (data === "[DONE]") return false;
  if (
    error.message.includes("Unexpected end of JSON input") ||
    error.message.includes("Unterminated string in JSON")
  ) {
    return true;
  }
  const position = /at position (\d+)/.exec(error.message)?.[1];
  return position !== undefined && Number(position) >= data.length;
}

/**
 * Read a response body as SSE lines, split on `\r?\n`, handing each complete
 * line to `onLine` and the unterminated remainder to it once the body ends.
 *
 * A read that fails with the caller's own abort reason ends the stream as
 * aborted rather than throwing; the remainder is then still offered, and a
 * frame it cuts off mid-JSON is dropped instead of failing the turn. Any other
 * failure, from the body or from `onLine`, propagates. Resolves whether the
 * stream ended by abort, including an abort that raced a clean end.
 */
export async function readSseLines(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  abortSignal: AbortSignal | undefined,
  onLine: (line: string) => void,
): Promise<boolean> {
  const decoder = new TextDecoder();
  let buffer = "";
  let aborted = false;

  while (true) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (error) {
      if (!isAbortFromSignal(error, abortSignal)) throw error;
      aborted = true;
      break;
    }
    const { value, done } = chunk;
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      onLine(line);
    }
  }
  if (!aborted) buffer += decoder.decode();
  if (buffer.trim().length > 0) {
    try {
      onLine(buffer);
    } catch (error) {
      if (!aborted || !isIncompleteSseDataLine(buffer, error)) throw error;
    }
  }
  return aborted || abortSignal?.aborted === true;
}
