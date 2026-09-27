/** Deterministic, budget-bounded JSON serialization. */

// The budget canonicalJson enforces. Exported so a caller that pre-screens raw
// JSON text before parsing it can apply the same ceilings.
export const MAX_CANONICAL_JSON_DEPTH = 64;
export const MAX_CANONICAL_JSON_ENTRIES = 1_024;
export const MAX_CANONICAL_JSON_CHARACTERS = 64 * 1_024;

interface CanonicalJsonBudget {
  remainingEntries: number;
  remainingCharacters: number;
}

/**
 * Serialize `value` as JSON with object keys sorted, so two structurally equal
 * values produce the same string. Returns undefined instead of serializing
 * when the value exceeds the depth, entry, or character budget: the caller
 * treats an oversized value as incomparable rather than paying to encode it.
 * Objects contribute their own enumerable keys only (`toJSON` is not
 * consulted); any other value serializes as `JSON.stringify` would, with a
 * value it drops (such as `undefined`) rendered as the text `undefined`.
 */
export function canonicalJson(value: unknown): string | undefined {
  return canonicalJsonWithin(value, 0, {
    remainingEntries: MAX_CANONICAL_JSON_ENTRIES,
    remainingCharacters: MAX_CANONICAL_JSON_CHARACTERS,
  });
}

function canonicalJsonWithin(
  value: unknown,
  depth: number,
  budget: CanonicalJsonBudget,
): string | undefined {
  if (
    depth > MAX_CANONICAL_JSON_DEPTH || budget.remainingEntries-- <= 0
  ) return undefined;
  if (Array.isArray(value)) {
    if (value.length > budget.remainingEntries) return undefined;
    const punctuation = 2 + Math.max(0, value.length - 1);
    if (punctuation > budget.remainingCharacters) return undefined;
    budget.remainingCharacters -= punctuation;
    const items: string[] = [];
    for (const item of value) {
      const canonical = canonicalJsonWithin(item, depth + 1, budget);
      if (canonical === undefined) return undefined;
      items.push(canonical);
    }
    return `[${items.join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const keys: string[] = [];
    for (const key in record) {
      if (!Object.hasOwn(record, key)) continue;
      if (keys.length >= budget.remainingEntries) return undefined;
      keys.push(key);
    }
    keys.sort();
    const punctuation = 2 + Math.max(0, keys.length - 1);
    if (punctuation > budget.remainingCharacters) return undefined;
    budget.remainingCharacters -= punctuation;
    const entries: string[] = [];
    for (const key of keys) {
      if (key.length > budget.remainingCharacters) return undefined;
      const encodedKey = JSON.stringify(key);
      if (encodedKey.length + 1 > budget.remainingCharacters) return undefined;
      budget.remainingCharacters -= encodedKey.length + 1;
      const canonical = canonicalJsonWithin(record[key], depth + 1, budget);
      if (canonical === undefined) return undefined;
      entries.push(`${encodedKey}:${canonical}`);
    }
    return `{${entries.join(",")}}`;
  }
  if (typeof value === "string" && value.length > budget.remainingCharacters) {
    return undefined;
  }
  const serialized = JSON.stringify(value) ?? "undefined";
  if (serialized.length > budget.remainingCharacters) return undefined;
  budget.remainingCharacters -= serialized.length;
  return serialized;
}
