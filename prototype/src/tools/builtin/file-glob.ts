/**
 * Glob matching for `glob_files` and grep's `include` filter, without RegExp.
 *
 * A segment-wise wildcard matcher using the standard star-backtrack trick. It
 * is worst-case quadratic, so every comparison is charged against a budget
 * shared by the whole call; see the search section comment in file-search.ts.
 */

/** Glob patterns longer than this are refused rather than matched. */
const MAX_GLOB_LENGTH = 512;
/**
 * Aggregate comparison budget for glob matching across one whole call.
 *
 * Length and entry ceilings bound the inputs but not their product: a
 * near-worst-case 512-char pattern against a long path is ~2e6 comparisons, and
 * 50,000 entries of that would occupy the event loop for minutes — on a tool
 * nothing prompts for. Unlike the regex path there is no worker to terminate,
 * because the matcher is ours and can simply count. Ordinary searches land
 * three orders of magnitude below this.
 */
const HARD_MAX_GLOB_STEPS = 20_000_000;

/**
 * Does `ch` fall in a `[...]` class body (leading `!` or `^` negates)?
 *
 * The caller charges `body.length` before calling: this scan is proportional to
 * the class body, so leaving it uncharged would let `*[bbbb…c]` do ~500
 * comparisons per counted step and slip the aggregate budget by that factor.
 */
function matchClass(body: string, ch: string): boolean {
  let negate = false;
  let i = 0;
  if (body[0] === "!" || body[0] === "^") {
    negate = true;
    i = 1;
  }
  let hit = false;
  for (; i < body.length; i++) {
    if (body[i + 1] === "-" && i + 2 < body.length) {
      if (ch >= body[i] && ch <= body[i + 2]) hit = true;
      i += 2;
    } else if (body[i] === ch) {
      hit = true;
    }
  }
  return negate ? !hit : hit;
}

/**
 * The pattern token starting at `p`: how many chars it spans, and its test.
 *
 * Both the delimiter search and the class test are charged to the budget, so
 * every character the matcher actually examines is counted — not just the outer
 * loop iterations, which is what an aggregate bound has to mean.
 */
function tokenAt(
  pat: string,
  p: number,
  budget: GlobBudget,
): { len: number; test: (ch: string) => boolean } {
  const c = pat[p];
  if (c === "?") return { len: 1, test: () => true };
  if (c === "[") {
    const end = pat.indexOf("]", p + 1);
    budget.steps += end === -1 ? pat.length - p : end - p;
    if (end !== -1) {
      const body = pat.slice(p + 1, end);
      return {
        len: end - p + 1,
        test: (ch) => {
          budget.steps += body.length;
          return matchClass(body, ch);
        },
      };
    }
    return { len: 1, test: (ch) => ch === "[" }; // unterminated: literal
  }
  return { len: 1, test: (ch) => ch === c };
}

/**
 * Match one path segment against one glob segment (`*`, `?`, `[...]`).
 *
 * The classic wildcard algorithm: advance greedily, and on a mismatch rewind to
 * one character past the last `*`. Worst case is O(name × pattern) with no
 * recursion and no backtracking blowup — which is the whole reason globs are
 * not translated into a RegExp and run against model-supplied input.
 */
function matchSegment(name: string, pat: string, budget: GlobBudget): boolean {
  let n = 0;
  let p = 0;
  let starN = -1;
  let starP = -1;
  while (n < name.length) {
    if (++budget.steps > budget.cap) return false;
    if (p < pat.length && pat[p] === "*") {
      starP = p;
      starN = n;
      p++;
      continue;
    }
    if (p < pat.length) {
      // Checked around the token too, not just at the top of the loop: a class
      // token charges its own scan, so a long final class could cross the cap
      // and still return a match.
      const tok = tokenAt(pat, p, budget);
      if (budget.steps > budget.cap) return false;
      const matched = tok.test(name[n]);
      if (budget.steps > budget.cap) return false;
      if (matched) {
        n++;
        p += tok.len;
        continue;
      }
    }
    if (starP !== -1) {
      starN++;
      n = starN;
      p = starP + 1;
      continue;
    }
    return false;
  }
  while (p < pat.length && pat[p] === "*") p++;
  return p === pat.length;
}

/** Same algorithm one level up, with `**` standing for zero or more segments. */
function matchSegments(
  path: string[],
  glob: string[],
  budget: GlobBudget,
): boolean {
  let n = 0;
  let g = 0;
  let starN = -1;
  let starG = -1;
  while (n < path.length) {
    if (++budget.steps > budget.cap) return false;
    if (g < glob.length && glob[g] === "**") {
      starG = g;
      starN = n;
      g++;
      continue;
    }
    if (
      g < glob.length && glob[g] !== "**" &&
      matchSegment(path[n], glob[g], budget)
    ) {
      n++;
      g++;
      continue;
    }
    if (starG !== -1) {
      starN++;
      n = starN;
      g = starG + 1;
      continue;
    }
    return false;
  }
  while (g < glob.length && glob[g] === "**") g++;
  return g === glob.length;
}

/**
 * True when a workspace-relative path matches the glob. `**` crosses `/`; `*`,
 * `?` and `[...]` do not. Over-long patterns match nothing rather than being
 * matched — the length cap is what keeps the quadratic worst case small.
 */
export function matchesGlobPath(
  path: string,
  glob: string,
  budget: GlobBudget = newGlobBudget(),
): boolean {
  if (globPatternError(glob) !== null) return false;
  return matchSegments(path.split("/"), glob.split("/"), budget);
}

/**
 * Comparison budget shared by every glob match in one call. `exhausted` is what
 * the executors report: once the budget runs out every further match returns
 * false, which without a note would look exactly like "no more matches".
 */
export interface GlobBudget {
  steps: number;
  cap: number;
}

export function newGlobBudget(cap = HARD_MAX_GLOB_STEPS): GlobBudget {
  return { steps: 0, cap };
}

export function globBudgetExhausted(budget: GlobBudget): boolean {
  return budget.steps > budget.cap;
}

/**
 * Why a glob is unusable, or null when it is fine. Callers reject explicitly
 * rather than leaning on `matchesGlobPath` returning false for everything: a
 * silently unmatchable pattern reads as "nothing here" when it means "I did not
 * look".
 */
export function globPatternError(glob: string): string | null {
  if (glob.length === 0) return "pattern must be non-empty";
  if (glob.length > MAX_GLOB_LENGTH) {
    return `pattern is longer than ${MAX_GLOB_LENGTH} characters`;
  }
  return null;
}
