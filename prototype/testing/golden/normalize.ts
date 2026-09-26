/**
 * Golden-snapshot normalizer.
 *
 * Replaces only the volatile values the golden suite spec lists — ULIDs and
 * other generated IDs (trace, span, UUID), timestamps, durations, temp paths
 * and PIDs — with stable placeholders. Harness-chosen ephemeral endpoints
 * (the loopback ports of the Dolt and model servers) are handled like temp
 * paths: the harness registers them as literal substitutions. Nothing else is
 * rewritten, so any other change in behavior shows up as a snapshot diff.
 *
 * Generated IDs are numbered in first-seen order within one normalizer, so a
 * snapshot still shows which fields carry the same ID (for example, every
 * event of one session sharing `<ULID:1>`).
 */

export interface NormalizerOptions {
  /** Literal substrings to replace, e.g. temp roots, sockets, loopback URLs. */
  literals?: ReadonlyArray<readonly [value: string, placeholder: string]>;
}

type IdKind = "ULID" | "UUID" | "TRACE" | "SPAN";

// Session slugs embed a lowercased ULID, so matching is case-insensitive.
const ULID = /\b[0-9A-HJKMNP-TV-Z]{26}\b/gi;
const UUID =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const TRACE_ID = /\b[0-9a-f]{32}\b/g;
const SPAN_ID = /\b[0-9a-f]{16}\b/g;
// Timestamps keep their shape (separators, precision, offset) with every
// digit masked, so a change of wire format still shows up as a diff.
const TIMESTAMP =
  /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g;
// `Date.prototype.toString()` text, e.g.
// "Sat Sep 26 2026 21:51:50 GMT+0000 (Coordinated Universal Time)".
const JS_DATE =
  /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{2} \d{4} \d{2}:\d{2}:\d{2} GMT[+-]\d{4}(?: \([^)]*\))?/g;
const DATE = /\b\d{4}-\d{2}-\d{2}\b/g;
const TEXT_PID = /\b(pid[ =:]\s*)\d+\b/gi;
// Rendered wall-clock measurements, e.g. "Total elapsed: 47ms" or "TTFT 1.2s".
const TEXT_DURATION = /\b\d+(?:\.\d+)?\s?(?:ms|s)\b/g;

// Object keys whose numeric value is a wall-clock measurement or a process id.
// Case-sensitive on purpose: `totalMs`/`duration_ms` are durations, while a
// key like `maxItems` merely ends in the same letters.
const DURATION_KEY =
  /(?:^|_)(?:duration|elapsed|latency|uptime)|(?:[a-z]Ms|_ms|[a-z]Seconds|_seconds)$/;
const PID_KEY = /(?:^|_)pid$/i;

export interface Normalizer {
  normalize<T>(value: T): unknown;
  text(value: string): string;
}

export function createNormalizer(options: NormalizerOptions = {}): Normalizer {
  // Longest first, so a path that contains another registered path wins.
  const literals = [...(options.literals ?? [])]
    .filter(([value]) => value.length > 0)
    .sort((a, b) => b[0].length - a[0].length);
  const ids = new Map<string, string>();
  const counters: Record<IdKind, number> = {
    ULID: 0,
    UUID: 0,
    TRACE: 0,
    SPAN: 0,
  };
  const idFor = (kind: IdKind, raw: string): string => {
    const key = `${kind}:${raw.toLowerCase()}`;
    let placeholder = ids.get(key);
    if (placeholder === undefined) {
      counters[kind] += 1;
      placeholder = `<${kind}:${counters[kind]}>`;
      ids.set(key, placeholder);
    }
    return placeholder;
  };

  const text = (input: string): string => {
    let out = input;
    for (const [value, placeholder] of literals) {
      out = out.split(value).join(placeholder);
    }
    out = out.replace(
      TIMESTAMP,
      (raw) => `<TIMESTAMP ${raw.replace(/\d/g, "n")}>`,
    );
    out = out.replace(JS_DATE, "<TIMESTAMP js-date-string>");
    out = out.replace(DATE, "<DATE>");
    out = out.replace(UUID, (raw) => idFor("UUID", raw));
    out = out.replace(ULID, (raw) => idFor("ULID", raw));
    out = out.replace(TRACE_ID, (raw) => idFor("TRACE", raw));
    out = out.replace(SPAN_ID, (raw) => idFor("SPAN", raw));
    out = out.replace(TEXT_PID, (_match, prefix: string) => `${prefix}<PID>`);
    out = out.replace(TEXT_DURATION, "<DURATION>");
    return out;
  };

  const walk = (value: unknown, key?: string): unknown => {
    if (typeof value === "string") return text(value);
    if (typeof value === "number" && key !== undefined) {
      if (PID_KEY.test(key)) return "<PID>";
      if (DURATION_KEY.test(key)) return "<DURATION>";
      return value;
    }
    if (Array.isArray(value)) return value.map((item) => walk(item));
    if (value instanceof Date) return "<TIMESTAMP date-object>";
    if (typeof value === "object" && value !== null) {
      const out: Record<string, unknown> = {};
      for (const [childKey, child] of Object.entries(value)) {
        out[childKey] = walk(child, childKey);
      }
      return out;
    }
    return value;
  };

  return { normalize: (value) => walk(value), text };
}
