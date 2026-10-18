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
 * strings collected, and one budget for every node visited and every key our
 * code takes from `for…in`); when it cannot finish, the text is
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
 * One budget for the whole walk: every node visited and every key `for…in`
 * yields, own or inherited, draws on it, so sibling objects cannot each
 * spend a fresh allowance.
 */
class WalkBudget {
  #used = 0;
  get remaining(): number {
    return MAX_WALK_VISITS - this.#used;
  }
  spend(): void {
    if (++this.#used > MAX_WALK_VISITS) throw new WalkIncomplete();
  }
}

/**
 * The own data properties of `value`, read through their descriptors: an
 * accessor is skipped, never invoked, because arguments can carry getters
 * (validation proves it rejects some calls before reading their items, and
 * masking must not read them either). An array longer than the remaining
 * budget is refused before any element is read, and each index read, a hole
 * included, draws on the budget; an object's keys draw on it as `for…in`
 * yields them, inherited ones included. Per-key work in our
 * code stops at the budget; the engine's own key enumeration for `for…in` is
 * not bounded by it. Arguments are JSON, which encodes no symbol keys and no
 * other non-enumerable properties (an array's intrinsic `length` aside, which
 * is read as a data property); the walk enumerates neither.
 */
function dataEntries(value: object, budget: WalkBudget): [string, unknown][] {
  const entries: [string, unknown][] = [];
  if (Array.isArray(value)) {
    const length = Reflect.getOwnPropertyDescriptor(value, "length")?.value;
    const count = typeof length === "number" ? length : 0;
    if (count > budget.remaining) throw new WalkIncomplete();
    for (let index = 0; index < count; index++) {
      // Every read is charged, a hole included: holes are not elements, so
      // charging only elements would leave a sparse array's reads free.
      budget.spend();
      const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
      if (descriptor !== undefined && "value" in descriptor) {
        entries.push([String(index), descriptor.value]);
      }
    }
    return entries;
  }
  for (const key in value) {
    budget.spend();
    if (!Object.hasOwn(value, key)) continue;
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor) {
      entries.push([key, descriptor.value]);
    }
  }
  return entries;
}

/**
 * Every string leaf of `args` worth masking, or undefined when the walk
 * could not finish: too deep, too many strings, the budget spent, or a
 * hostile object's trap threw. A partial set would mask some echoes and leak
 * others.
 */
function argumentLeaves(
  args: Record<string, unknown>,
): ArgumentLeaf[] | undefined {
  const leaves: ArgumentLeaf[] = [];
  const budget = new WalkBudget();
  const walk = (value: unknown, path: string, depth: number): void => {
    budget.spend();
    if (typeof value === "string") {
      if (value.length < MASK_MIN_LENGTH) return;
      if (leaves.length >= MAX_WALK_LEAVES) throw new WalkIncomplete();
      leaves.push({ path, value });
      return;
    }
    if (typeof value !== "object" || value === null) return;
    if (depth >= MAX_WALK_DEPTH) throw new WalkIncomplete();
    const isArray = Array.isArray(value);
    for (const [key, item] of dataEntries(value, budget)) {
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
    for (const [key, value] of dataEntries(args, budget)) {
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
