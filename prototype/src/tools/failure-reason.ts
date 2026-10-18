/**
 * The one-line reason an operator sees for a failed tool call: on the REPL's
 * ✗ line, in the runtime log, and in the durable `tool_call` event of a
 * command whose arguments are redacted.
 *
 * A failure reason can quote the call's own arguments back (an upstream
 * server echoing the body it rejected). The event store redacts argument
 * values, so an echo must not carry one back into the store, the log or the
 * screen. Nothing is rewritten: when the text echoes any argument value, the
 * line is withheld and names only the declared top-level arguments it echoes
 * (`upstream error (text withheld: it echoes argument issueId)`), or says
 * "an argument" when none is declared. Otherwise
 * the text is shown with credential-shaped text scrubbed, single-lined and
 * capped. The model's copy of the reason is not this: it sent those values
 * itself.
 *
 * What counts as an echo, within the first `ECHO_WINDOW_CHARS` characters of
 * the text (more than the capped line can show): a string of eight or more
 * characters anywhere; a shorter string or a number where it stands as a
 * whole token, bounded by characters that are not letters or digits (so `BIT`
 * is found in `BIT-697` but not in `BITS`, and `1` not in `10`); and, when the
 * text runs past the window, a window tail of three or more characters that
 * begins some value (a cut-off start shorter than three is not detected; the
 * stored event copy stops short of the edge for that reason). Booleans and null never count. A server that reformats
 * an argument before quoting it is not detected. The work is bounded by the
 * window and by the argument walk below, never by the size of the text.
 */

import { sanitizeBoundaryText, scrubSensitiveShapes } from "../kernel/mod.ts";

/** The operator line's cap, in UTF-8 bytes. */
export const OPERATOR_REASON_MAX_BYTES = 160;

/** How much of a reason the echo check reads: more than the line can show. */
export const ECHO_WINDOW_CHARS = 640;

const SUBSTRING_MIN_LENGTH = 8;
const TAIL_PREFIX_MIN_LENGTH = 3;
const MAX_NAMED_ARGUMENTS = 3;
const MAX_WALK_DEPTH = 8;
const MAX_WALK_LEAVES = 256;
// Every node counts, so branches with no eligible value still cost.
const MAX_WALK_VISITS = 1_024;

/** The walk stopped before it saw every argument value. */
class WalkIncomplete extends Error {}

interface ArgumentLeaf {
  path: string;
  value: string;
  /** Strings of 8+ characters match anywhere; shorter ones and numbers only as whole tokens. */
  match: "substring" | "token";
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
 * the echo check must not read them either). An array longer than the remaining
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
 * Every string and number leaf of `args` worth checking, or undefined when the walk
 * could not finish: too deep, too many strings, the budget spent, or a
 * hostile object's trap threw. A partial set would catch some echoes and miss
 * others.
 */
function argumentLeaves(
  args: Record<string, unknown>,
): ArgumentLeaf[] | undefined {
  const leaves: ArgumentLeaf[] = [];
  const budget = new WalkBudget();
  const walk = (value: unknown, path: string, depth: number): void => {
    budget.spend();
    if (typeof value === "string" || typeof value === "number") {
      const text = String(value);
      if (text === "") return;
      if (leaves.length >= MAX_WALK_LEAVES) throw new WalkIncomplete();
      leaves.push({
        path,
        value: text,
        match: typeof value === "string" && text.length >= SUBSTRING_MIN_LENGTH
          ? "substring"
          : "token",
      });
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

const WORD_CHARACTER = /[\p{L}\p{N}]/u;

function isWordCharacter(character: string | undefined): boolean {
  return character !== undefined && WORD_CHARACTER.test(character);
}

/** Whether `leaf` occurs in `window`: anywhere, or only as a whole token. */
function occursIn(window: string, leaf: ArgumentLeaf): boolean {
  if (leaf.match === "substring") return window.includes(leaf.value);
  let from = 0;
  for (;;) {
    const start = window.indexOf(leaf.value, from);
    if (start === -1) return false;
    const end = start + leaf.value.length;
    if (!isWordCharacter(window[start - 1]) && !isWordCharacter(window[end])) {
      return true;
    }
    from = start + 1;
  }
}

/** Whether the window's last characters begin `value`: an echo cut at the edge. */
function tailBeginsValue(window: string, value: string): boolean {
  const longest = Math.min(window.length, value.length - 1);
  for (let length = TAIL_PREFIX_MIN_LENGTH; length <= longest; length++) {
    if (value.startsWith(window.slice(window.length - length))) return true;
  }
  return false;
}

/**
 * The paths of the arguments whose values `text` echoes within the window,
 * in walk order; empty when it echoes none; undefined when the arguments are
 * too large or too strange to check, which the caller treats as an echo.
 */
export function findArgumentEchoes(
  text: string,
  args: Record<string, unknown>,
): string[] | undefined {
  const leaves = argumentLeaves(args);
  if (leaves === undefined) return undefined;
  const window = text.slice(0, ECHO_WINDOW_CHARS);
  const continues = text.length > ECHO_WINDOW_CHARS;
  const paths: string[] = [];
  for (const leaf of leaves) {
    if (paths.includes(leaf.path)) continue;
    if (occursIn(window, leaf) || (continues && tailBeginsValue(window, leaf.value))) {
      paths.push(leaf.path);
    }
  }
  return paths;
}

/**
 * What a withheld line says it echoes. Only a top-level key the command's
 * schema declares is named: deeper path segments, and undeclared keys, can
 * be data (a dictionary keyed by a token), so they are never printed.
 */
function echoedArguments(
  paths: string[],
  declared: readonly string[],
): string {
  const names: string[] = [];
  let undeclared = false;
  for (const path of paths) {
    const topLevel = path.split(/[.[]/, 1)[0] ?? "";
    if (!declared.includes(topLevel)) {
      undeclared = true;
    } else if (!names.includes(topLevel)) {
      names.push(topLevel);
    }
  }
  if (names.length === 0) return "an argument";
  const more = names.length - MAX_NAMED_ARGUMENTS;
  const listed = names.slice(0, MAX_NAMED_ARGUMENTS).join(", ") +
    (more > 0 ? ` and ${more} more` : "");
  return `argument ${listed}${undeclared ? " and another argument" : ""}`;
}

/** A reason this code composed itself, quoting nothing: scrubbed and capped. */
export function fixedOperatorReason(reason: string): string {
  return sanitizeBoundaryText(
    scrubSensitiveShapes(reason.slice(0, 4 * OPERATOR_REASON_MAX_BYTES)),
    OPERATOR_REASON_MAX_BYTES,
  );
}

/**
 * The line an operator sees for `reason`: withheld when it echoes any
 * argument value, naming the declared top-level arguments it echoes;
 * otherwise scrubbed, single-lined and capped. `label` leads a withheld line
 * (`upstream error`, `error`); `declared` is the command's input-schema
 * property names, the only names a withheld line prints.
 */
export function operatorFailureReason(
  reason: string,
  args: Record<string, unknown>,
  options: { label?: string; declared?: readonly string[] } = {},
): string {
  const label = options.label ?? "error";
  const echoes = findArgumentEchoes(reason, args);
  if (echoes === undefined) {
    return fixedOperatorReason(
      `${label} (text withheld: arguments too large to check)`,
    );
  }
  if (echoes.length > 0) {
    return fixedOperatorReason(
      `${label} (text withheld: it echoes ${
        echoedArguments(echoes, options.declared ?? [])
      })`,
    );
  }
  return fixedOperatorReason(reason);
}
