/**
 * Bounds and checks shared by every path that persists or replays an external
 * agent's tool history: the reconstructed-transcript projection and per-call
 * ACP tool evidence. Each check fails closed with a fixed message that never
 * carries historical content.
 */
import { containsSensitiveShape, utf8ByteLengthWithinLimit } from "./kernel/mod.ts";
import { DomainError } from "./contract/mod.ts";

/** Per-field bounds for one projected tool exchange. */
export const MAX_HISTORY_TOOL_NAME_BYTES = 128;
export const MAX_HISTORY_TOOL_CALL_ID_BYTES = 128;
export const MAX_HISTORY_TOOL_ARGUMENTS_BYTES = 4_096;
export const MAX_HISTORY_TOOL_RESULT_BYTES = 8_192;
export const MAX_HISTORY_TOOL_ARGUMENT_NODES = 256;
export const MAX_HISTORY_TOOL_ARGUMENT_DEPTH = 16;

const SAFE_HISTORY_METADATA = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

/**
 * Whether `value` carries something shaped like a live credential: values of
 * that shape must not be replayed into a prompt.
 */
export function historyContainsSecretShape(value: string): boolean {
  return containsSensitiveShape(value);
}

const JSON_ESCAPE = /\\(?:u([0-9A-Fa-f]{4})|(["\\/bfnrt]))/g;
const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

/**
 * How many levels of JSON string escaping the credential check decodes. Each
 * level is one linear pass, so the cap keeps the check linear in the text's
 * length however deeply hostile text nests its escapes.
 */
export const MAX_HISTORY_JSON_ESCAPE_LEVELS = 4;

/** `text` with one level of JSON string escapes decoded. */
function withOneJsonEscapeLevelDecoded(text: string): string {
  return text.replace(
    JSON_ESCAPE,
    (_match, hex: string | undefined, simple: string | undefined) =>
      hex === undefined
        ? SIMPLE_ESCAPES[simple!]
        : String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

/**
 * Whether `text` carries something shaped like a live credential. The check
 * reads the text in three forms: as it is, as `sanitizeHistoryText` would
 * store it, and with every backslash removed. It then decodes one level of
 * JSON string escapes and reads the result in the same three forms, for up to
 * `MAX_HISTORY_JSON_ESCAPE_LEVELS` levels, stopping early once a pass changes
 * nothing. Every pass is read, not only the last, because a later pass can
 * undo a match an earlier one exposed (`\u005ctoken` decodes to `\token`,
 * then to a tab and `oken`). Text that holds serialized JSON escapes its
 * quotes and may escape any character (`{\"\u0074oken\":...}`), which the
 * shapes alone do not match. Each reading is one linear pass over the text.
 */
export function historyTextContainsSecretShape(text: string): boolean {
  let current = text;
  for (let level = 0; ; level += 1) {
    if (
      containsSensitiveShape(current) ||
      containsSensitiveShape(sanitizeHistoryText(current))
    ) {
      return true;
    }
    if (!current.includes("\\")) return false;
    if (containsSensitiveShape(current.replaceAll("\\", ""))) return true;
    if (level === MAX_HISTORY_JSON_ESCAPE_LEVELS) return false;
    const next = withOneJsonEscapeLevelDecoded(current);
    if (next === current) return false;
    current = next;
  }
}

/**
 * Whether a JSON value, or its serialized form `json`, carries something
 * shaped like a live credential. `json` must be what `value` serializes to,
 * so the value is acyclic. The serialized form and every key and string in
 * the value are each read as `historyTextContainsSecretShape` reads text. The
 * walk keeps one frame per open array or object, not one entry per element.
 */
export function historyValueContainsSecretShape(
  value: unknown,
  json: string,
): boolean {
  if (historyTextContainsSecretShape(json)) return true;
  const frames: Iterator<unknown>[] = [[value][Symbol.iterator]()];
  while (frames.length > 0) {
    const next = frames[frames.length - 1].next();
    if (next.done === true) {
      frames.pop();
      continue;
    }
    const part = next.value;
    if (typeof part === "string") {
      if (historyTextContainsSecretShape(part)) return true;
    } else if (Array.isArray(part)) {
      frames.push(part[Symbol.iterator]());
    } else if (part !== null && typeof part === "object") {
      frames.push(objectKeysAndValues(part));
    }
  }
  return false;
}

/** Each own enumerable key of `part`, then its value, without copying. */
export function* objectKeysAndValues(part: object): Generator<unknown> {
  for (const key in part) {
    if (!Object.hasOwn(part, key)) continue;
    yield key;
    yield (part as Record<string, unknown>)[key];
  }
}

/**
 * Strip control characters while keeping line structure. Line feeds survive
 * because quoting (above) is what makes them safe; tabs and carriage returns
 * collapse to a space so no record can be rewritten in a terminal or split
 * into a forged line.
 */
export function sanitizeHistoryText(raw: string): string {
  let out = "";
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 10 || code === 0x2028 || code === 0x2029) {
      out += "\n";
      continue;
    }
    if (code === 9 || code === 13) {
      out += " ";
      continue;
    }
    const isC0Control = code <= 31;
    const isDel = code === 127;
    const isC1Control = code >= 128 && code <= 159;
    if (isC0Control || isDel || isC1Control) continue;
    out += ch;
  }
  return out;
}

/**
 * Bound and sanitize one field. Overflow throws rather than truncates: a
 * shortened tool result reads as complete evidence and would be a quieter
 * defect than a refused turn. `field` is a fixed caller literal — no
 * historical content ever reaches the message.
 */
export function boundedHistoryField(
  value: string,
  maxBytes: number,
  field: string,
): string {
  if (utf8ByteLengthWithinLimit(value, maxBytes) === undefined) {
    throw new DomainError(
      `ACP continuity reconstruction exceeded the ${field} limit`,
    );
  }
  return sanitizeHistoryText(value);
}

export function malformedToolHistory(): never {
  throw new DomainError(
    "ACP continuity reconstruction found malformed tool history",
  );
}

/** A history bound was exceeded, as opposed to a malformed value. */
export class HistoryLimitError extends DomainError {}

function toolArgumentLimit(kind = "tool argument"): never {
  throw new HistoryLimitError(
    `ACP continuity reconstruction exceeded the ${kind} limit`,
  );
}

export function boundedHistoryArguments(value: Record<string, unknown>): string {
  const parts: string[] = [];
  const ancestors = new Set<object>();
  let bytes = 0;
  let nodes = 0;
  const append = (part: string): void => {
    const partBytes = utf8ByteLengthWithinLimit(
      part,
      MAX_HISTORY_TOOL_ARGUMENTS_BYTES - bytes,
    );
    if (partBytes === undefined) toolArgumentLimit();
    bytes += partBytes;
    parts.push(part);
  };
  const appendJsonString = (part: string): void => {
    if (
      utf8ByteLengthWithinLimit(part, MAX_HISTORY_TOOL_ARGUMENTS_BYTES) ===
        undefined
    ) {
      toolArgumentLimit();
    }
    append(JSON.stringify(part));
  };
  const encode = (part: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_HISTORY_TOOL_ARGUMENT_NODES) {
      toolArgumentLimit("tool argument complexity");
    }
    if (part === null) {
      append("null");
      return;
    }
    if (typeof part === "string") {
      appendJsonString(part);
      return;
    }
    if (typeof part === "boolean") {
      append(part ? "true" : "false");
      return;
    }
    if (typeof part === "number") {
      if (!Number.isFinite(part)) malformedToolHistory();
      append(JSON.stringify(part));
      return;
    }
    if (typeof part !== "object") malformedToolHistory();
    if (depth >= MAX_HISTORY_TOOL_ARGUMENT_DEPTH) {
      toolArgumentLimit("tool argument complexity");
    }
    if (ancestors.has(part)) malformedToolHistory();
    ancestors.add(part);
    try {
      if (Array.isArray(part)) {
        if (part.length > MAX_HISTORY_TOOL_ARGUMENT_NODES) {
          toolArgumentLimit("tool argument complexity");
        }
        append("[");
        for (let index = 0; index < part.length; index++) {
          if (!Object.hasOwn(part, index)) malformedToolHistory();
          if (index > 0) append(",");
          encode(part[index], depth + 1);
        }
        append("]");
        return;
      }
      const prototype = Object.getPrototypeOf(part);
      if (prototype !== Object.prototype && prototype !== null) {
        malformedToolHistory();
      }
      if (Object.getOwnPropertySymbols(part).length > 0) malformedToolHistory();
      const keys = Object.keys(part);
      if (keys.length > MAX_HISTORY_TOOL_ARGUMENT_NODES) {
        toolArgumentLimit("tool argument complexity");
      }
      append("{");
      for (let index = 0; index < keys.length; index++) {
        const key = keys[index];
        const descriptor = Object.getOwnPropertyDescriptor(part, key);
        if (descriptor === undefined || !("value" in descriptor)) {
          malformedToolHistory();
        }
        if (index > 0) append(",");
        appendJsonString(key);
        append(":");
        encode(descriptor.value, depth + 1);
      }
      append("}");
    } finally {
      ancestors.delete(part);
    }
  };
  encode(value, 0);
  return parts.join("");
}

export function boundedHistoryMetadata(
  value: string,
  maxBytes: number,
  field: string,
): string {
  const bounded = boundedHistoryField(value, maxBytes, field);
  if (!SAFE_HISTORY_METADATA.test(bounded)) malformedToolHistory();
  assertNoSecretShape(bounded);
  return bounded;
}


export function assertNoSecretShape(value: string): void {
  if (historyContainsSecretShape(value)) {
    throw new DomainError(
      "ACP continuity reconstruction found secret-shaped tool history",
    );
  }
}
