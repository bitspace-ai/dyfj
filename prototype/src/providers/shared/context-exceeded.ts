/**
 * Recognise a provider's "the request is larger than my context window"
 * rejection from its HTTP status and error body, so the engine can treat it
 * as context overflow instead of a generic provider failure. Pure: the body
 * is matched, never relayed — the engine's recovery needs the verdict and,
 * when the provider stated them, its token counts.
 */

export interface ContextExceededReport {
  /** The prompt size the provider measured, when its message states one. */
  requestedTokens?: number;
  /** The window the provider enforces, when its message states one. */
  limitTokens?: number;
}

/** The statuses a context-size rejection arrives under. */
const REJECTION_STATUSES = new Set([400, 413, 422]);

/**
 * Message shapes observed per API family; every pattern names the context
 * limit explicitly, so an unrelated 400 (a malformed request, a bad model
 * id) never classifies as overflow. Each is paired with the capture order of
 * its counts, when the message carries them: `[requested, limit]`.
 */
const REJECTION_PATTERNS: ReadonlyArray<
  { pattern: RegExp; counts?: "requested-limit" | "limit-requested" }
> = [
  // llama-server: "request (82366 tokens) exceeds the available context size
  // (32768 tokens), try increasing it", type "exceed_context_size_error".
  {
    pattern:
      /\((\d+) tokens\) exceeds the available context size \((\d+) tokens\)/i,
    counts: "requested-limit",
  },
  { pattern: /exceeds? the (?:available )?context (?:size|length|window)/i },
  { pattern: /exceed_context_size_error/i },
  // OpenAI-compatible hosted: "This model's maximum context length is 128000
  // tokens. However, your messages resulted in 130123 tokens".
  {
    pattern:
      /maximum context length is (\d+) tokens\. However, (?:your messages|you) (?:resulted in|requested) (\d+) tokens/i,
    counts: "limit-requested",
  },
  { pattern: /maximum context length is \d+ tokens/i },
  { pattern: /context_length_exceeded/i },
  // Anthropic: "prompt is too long: 213456 tokens > 200000 maximum".
  {
    pattern: /prompt is too long: (\d+) tokens > (\d+) maximum/i,
    counts: "requested-limit",
  },
  { pattern: /prompt is too long/i },
  // Gemini: "The input token count (1234567) exceeds the maximum number of
  // tokens allowed (1048576)".
  {
    pattern:
      /input token count \((\d+)\) exceeds the maximum number of tokens allowed \((\d+)\)/i,
    counts: "requested-limit",
  },
  { pattern: /input token count .*exceeds the maximum/i },
];

/** No model's window is near this; a larger count is noise, not data. */
const MAX_PLAUSIBLE_TOKENS = 100_000_000;

/** A count is read only as a plausible positive integer. */
function tokenCount(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.length > 12) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isSafeInteger(value) && value > 0 &&
      value <= MAX_PLAUSIBLE_TOKENS
    ? value
    : undefined;
}

/**
 * The context-exceeded verdict for a failed provider response: the report
 * (possibly empty) when the status and body say the request was too large
 * for the window, else null. The body is bounded by the caller's reader; a
 * further slice here keeps the regex work small regardless.
 */
export function classifyContextExceeded(
  status: number,
  body: string,
): ContextExceededReport | null {
  if (!REJECTION_STATUSES.has(status)) return null;
  const text = body.slice(0, 4_096);
  for (const { pattern, counts } of REJECTION_PATTERNS) {
    const match = pattern.exec(text);
    if (match === null) continue;
    if (counts === undefined) return {};
    const [first, second] = [tokenCount(match[1]), tokenCount(match[2])];
    return counts === "requested-limit"
      ? { requestedTokens: first, limitTokens: second }
      : { requestedTokens: second, limitTokens: first };
  }
  return null;
}
