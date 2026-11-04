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
