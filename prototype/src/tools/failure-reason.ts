/**
 * The one-line reason an operator sees for a failed tool call: on the REPL's
 * ✗ line, in the runtime log, and in the durable `tool_call` event of a
 * command whose arguments are redacted.
 *
 * A failure reason can quote the call's own arguments back (an upstream
 * server echoing the body it rejected). The event store redacts argument
 * values, so an echo must not carry one back into the store, the log or the
 * screen: every argument string of eight or more characters, at any depth,
 * is replaced by `<arg:PATH>`. Credential-shaped text is then scrubbed, and
 * the line is made single-line and capped. The model's copy of the reason is
 * not this: it sent those values itself.
 */

import { sanitizeBoundaryText, scrubSensitiveShapes } from "../kernel/mod.ts";

/** The operator line's cap, in UTF-8 bytes. */
export const OPERATOR_REASON_MAX_BYTES = 160;

const MASK_MIN_LENGTH = 8;
const MAX_WALK_DEPTH = 8;
const MAX_WALK_LEAVES = 256;

interface ArgumentLeaf {
  path: string;
  value: string;
}

function safePathSegment(key: string): string {
  return key.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "?";
}

/**
 * The own data properties of `value`, read through their descriptors: an
 * accessor is skipped, never invoked, because arguments can carry getters
 * (validation proves it rejects some calls before reading their items, and
 * masking must not read them either). A hostile object's traps end the walk.
 */
function dataEntries(value: object): [string, unknown][] {
  const entries: [string, unknown][] = [];
  if (Array.isArray(value)) {
    // By index, so a huge array costs no more than the leaf cap.
    const length = Reflect.getOwnPropertyDescriptor(value, "length")?.value;
    const end = Math.min(typeof length === "number" ? length : 0, MAX_WALK_LEAVES);
    for (let index = 0; index < end; index++) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
      if (descriptor !== undefined && "value" in descriptor) {
        entries.push([String(index), descriptor.value]);
      }
    }
    return entries;
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") continue;
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor) {
      entries.push([key, descriptor.value]);
    }
    if (entries.length >= MAX_WALK_LEAVES) break;
  }
  return entries;
}

/** String leaves of `args` worth masking, bounded in depth and count. */
function argumentLeaves(args: Record<string, unknown>): ArgumentLeaf[] {
  const leaves: ArgumentLeaf[] = [];
  const walk = (value: unknown, path: string, depth: number): void => {
    if (leaves.length >= MAX_WALK_LEAVES || depth > MAX_WALK_DEPTH) return;
    if (typeof value === "string") {
      if (value.length >= MASK_MIN_LENGTH) leaves.push({ path, value });
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const isArray = Array.isArray(value);
    for (const [key, item] of dataEntries(value)) {
      if (leaves.length >= MAX_WALK_LEAVES) return;
      walk(
        item,
        isArray ? `${path}[${safePathSegment(key)}]` : `${path}.${safePathSegment(key)}`,
        depth + 1,
      );
    }
  };
  try {
    for (const [key, value] of dataEntries(args)) {
      if (leaves.length >= MAX_WALK_LEAVES) break;
      walk(value, safePathSegment(key), 0);
    }
  } catch {
    // A proxy trap threw: mask what was collected before it.
  }
  return leaves;
}

/** `text` with every echoed argument value replaced by `<arg:PATH>`. */
export function maskArgumentEchoes(
  text: string,
  args: Record<string, unknown>,
): string {
  // Longest first, so a value that contains another is masked whole.
  const leaves = argumentLeaves(args).sort((a, b) =>
    b.value.length - a.value.length
  );
  let masked = text;
  for (const leaf of leaves) {
    if (masked.includes(leaf.value)) {
      masked = masked.split(leaf.value).join(`<arg:${leaf.path}>`);
    }
  }
  return masked;
}

/** The masked, scrubbed, single-line, capped reason an operator sees. */
export function operatorFailureReason(
  reason: string,
  args: Record<string, unknown>,
): string {
  return sanitizeBoundaryText(
    scrubSensitiveShapes(maskArgumentEchoes(reason, args)),
    OPERATOR_REASON_MAX_BYTES,
  );
}
