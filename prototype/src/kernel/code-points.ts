/** Code-point (not UTF-16 code unit) helpers. */

/**
 * Take at most `limit` code points from `source` and stop. A string is a
 * valid source; the iterator is not drained past the budget.
 */
export function takeCodePointPrefix(
  source: Iterable<string>,
  limit: number,
): string[] {
  const out: string[] = [];
  if (limit <= 0) return out;
  for (const ch of source) {
    out.push(ch);
    if (out.length >= limit) break;
  }
  return out;
}
