/**
 * Argument-value coercion shared by the textual tool-call recovery paths, so
 * the markup dialects type a parameter value the same way.
 */
import {
  MAX_CANONICAL_JSON_CHARACTERS,
  MAX_CANONICAL_JSON_DEPTH,
  MAX_CANONICAL_JSON_ENTRIES,
} from "../../kernel/mod.ts";

export type CoercedToolArgument =
  | { ok: true; value: unknown }
  | { ok: false };

/**
 * Whether a raw argument value stays inside the JSON budget the durable tool
 * call is held to: characters, nesting depth and entry count.
 */
export function toolArgumentWithinBudget(raw: string): boolean {
  if (raw.length > MAX_CANONICAL_JSON_CHARACTERS) return false;
  let depth = 0;
  let entries = 1;
  let inString = false;
  let escaped = false;
  for (const character of raw) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "{" || character === "[") {
      depth += 1;
      entries += 1;
      if (
        depth > MAX_CANONICAL_JSON_DEPTH ||
        entries > MAX_CANONICAL_JSON_ENTRIES
      ) return false;
    } else if (character === "}" || character === "]") {
      depth -= 1;
    } else if (character === ",") {
      entries += 1;
      if (entries > MAX_CANONICAL_JSON_ENTRIES) return false;
    }
  }
  return true;
}

/**
 * A `string="true"` value is the model's literal text, never parsed as JSON, so
 * only the character budget applies: its commas and brackets are content, not
 * structure, and a long command line or file body must not be rejected for
 * looking like deep or wide JSON.
 */
function literalToolArgument(raw: string): CoercedToolArgument {
  return raw.length <= MAX_CANONICAL_JSON_CHARACTERS
    ? { ok: true, value: raw }
    : { ok: false };
}

function jsonToolArgument(raw: string): CoercedToolArgument {
  if (!toolArgumentWithinBudget(raw)) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

/**
 * The Qwen `<parameter=NAME>VALUE</parameter>` reading: the value is JSON when
 * it parses and literal text otherwise. An empty value stays the empty string.
 */
export function coerceToolArgument(raw: string): CoercedToolArgument {
  if (!toolArgumentWithinBudget(raw)) return { ok: false };
  if (raw === "") return { ok: true, value: "" };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: true, value: raw };
  }
}

/**
 * A DSML parameter's `string` attribute decides its reading: `"true"` is
 * literal text, `"false"` is JSON and must parse (a value the model declared
 * typed but did not write as JSON is unrecoverable rather than guessed at),
 * and an absent attribute falls back to the Qwen reading.
 */
export function typedToolArgument(
  raw: string,
  stringAttribute: string | undefined,
): CoercedToolArgument {
  if (stringAttribute === "true") return literalToolArgument(raw);
  if (stringAttribute === "false") return jsonToolArgument(raw);
  return coerceToolArgument(raw);
}
