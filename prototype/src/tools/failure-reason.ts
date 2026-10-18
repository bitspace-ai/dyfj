/**
 * The one-line reason an operator sees for a failed tool call: on the REPL's
 * ✗ line, in the runtime log, and in the durable `tool_call` event of a
 * command whose arguments are redacted.
 *
 * A failure reason can quote the call's own arguments back (an upstream
 * server echoing the body it rejected). The event store redacts argument
 * values, so an echo must not carry one back into the store, the log or the
 * screen: an exact echo of an argument string of eight or more characters is
 * replaced by `<arg:PATH>`. The walk over the arguments is bounded (depth,
 * strings collected, nodes visited); when it cannot finish, the text is
 * withheld rather than masked part-way. Credential-shaped text is then
 * scrubbed, and the line is made single-line and capped. A server that
 * reformats an argument before quoting it is not masked. The model's copy of
 * the reason is not this: it sent those values itself.
 */

import { sanitizeBoundaryText, scrubSensitiveShapes } from "../kernel/mod.ts";

/** The operator line's cap, in UTF-8 bytes. */
export const OPERATOR_REASON_MAX_BYTES = 160;

/** The operator line when the arguments are too large to mask safely. */
export const MASKING_WITHHELD_REASON =
  "reason withheld: arguments too large to mask";

const MASK_MIN_LENGTH = 8;
const MAX_WALK_DEPTH = 8;
const MAX_WALK_LEAVES = 256;
// Every node counts, so branches with no eligible string still cost.
const MAX_WALK_VISITS = 1_024;

/** The walk stopped before it saw every argument value. */
class WalkIncomplete extends Error {}

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
 * masking must not read them either). More entries than the walk may visit
 * means it cannot finish.
 */
function dataEntries(value: object): [string, unknown][] {
  const entries: [string, unknown][] = [];
  if (Array.isArray(value)) {
    // By index, so a huge array costs no more than the visit budget.
    const length = Reflect.getOwnPropertyDescriptor(value, "length")?.value;
    const count = typeof length === "number" ? length : 0;
    if (count > MAX_WALK_VISITS) throw new WalkIncomplete();
    for (let index = 0; index < count; index++) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
      if (descriptor !== undefined && "value" in descriptor) {
        entries.push([String(index), descriptor.value]);
      }
    }
    return entries;
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length > MAX_WALK_VISITS) throw new WalkIncomplete();
  for (const key of keys) {
    if (typeof key !== "string") continue;
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor) {
      entries.push([key, descriptor.value]);
    }
  }
  return entries;
}

/**
 * Every string leaf of `args` worth masking, or undefined when the walk
 * could not finish: too deep, too many strings or nodes, or a hostile
 * object's trap threw. A partial set would mask some echoes and leak others.
 */
function argumentLeaves(
  args: Record<string, unknown>,
): ArgumentLeaf[] | undefined {
  const leaves: ArgumentLeaf[] = [];
  let visits = 0;
  const walk = (value: unknown, path: string, depth: number): void => {
    if (++visits > MAX_WALK_VISITS) throw new WalkIncomplete();
    if (typeof value === "string") {
      if (value.length < MASK_MIN_LENGTH) return;
      if (leaves.length >= MAX_WALK_LEAVES) throw new WalkIncomplete();
      leaves.push({ path, value });
      return;
    }
    if (typeof value !== "object" || value === null) return;
    if (depth >= MAX_WALK_DEPTH) throw new WalkIncomplete();
    const isArray = Array.isArray(value);
    for (const [key, item] of dataEntries(value)) {
      walk(
        item,
        isArray
          ? `${path}[${safePathSegment(key)}]`
          : `${path}.${safePathSegment(key)}`,
        depth + 1,
      );
    }
  };
  try {
    for (const [key, value] of dataEntries(args)) {
      walk(value, safePathSegment(key), 0);
    }
  } catch {
    return undefined;
  }
  return leaves;
}

/**
 * `text` with every echoed argument value replaced by `<arg:PATH>`, or
 * undefined when the arguments are too large or too strange to mask safely.
 */
export function maskArgumentEchoes(
  text: string,
  args: Record<string, unknown>,
): string | undefined {
  const leaves = argumentLeaves(args);
  if (leaves === undefined) return undefined;
  // Longest first, so a value that contains another is masked whole.
  leaves.sort((a, b) => b.value.length - a.value.length);
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
  withheld: string = MASKING_WITHHELD_REASON,
): string {
  const masked = maskArgumentEchoes(reason, args);
  return sanitizeBoundaryText(
    scrubSensitiveShapes(masked ?? withheld),
    OPERATOR_REASON_MAX_BYTES,
  );
}
