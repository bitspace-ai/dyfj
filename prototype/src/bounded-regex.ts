/**
 * Run a model-supplied regular expression under a wall-clock budget the caller
 * can actually enforce.
 *
 * `grep_files` is auto-approved, and the pattern it receives is only as
 * trustworthy as the model's context — which includes workspace file content
 * the model just read. A pattern like `(a+)+$` against a long non-matching line
 * runs for exponential time, and `RegExp.test` cannot be interrupted: on the
 * main thread that wedges the runtime's event loop with no approval prompt in
 * front of it.
 *
 * Matching therefore runs in a Worker, whose only job is that it can be
 * terminated. The budget — not the pattern — is what bounds the cost.
 *
 * This is NOT a permission sandbox. Deno's `deno.permissions` worker option
 * still requires --unstable-worker-options, so the worker inherits the host's
 * permissions. On the model-facing path it runs one fixed module of ours that
 * performs no I/O, so those permissions go unused — but `specifier` is an
 * override the tests use, and anything passed there runs with the same
 * inherited permissions. Do not read the worker boundary as isolation, and do
 * not wire `specifier` to anything a caller outside this repo can choose.
 */

/**
 * Cumulative wall clock for regex *matching* across every file in one
 * `grep_files` call. It does not cover traversal, `stat`, reads, decoding, or
 * result assembly — those are bounded by the entry, size, and output ceilings
 * in file-tools.ts, not by this clock.
 */
export const DEFAULT_REGEX_BUDGET_MS = 2_000;

/**
 * Longest accepted pattern. The worker budget bounds *execution*; compilation
 * happens on the main thread before any worker exists, so parsing cost is
 * bounded by refusing long patterns rather than by the clock.
 */
export const MAX_PATTERN_LENGTH = 1_024;

/** The pattern used its whole time budget. The matcher is dead afterwards. */
export class RegexBudgetExceeded extends Error {
  constructor(budgetMs: number) {
    super(`pattern exceeded its ${budgetMs}ms matching budget`);
    this.name = "RegexBudgetExceeded";
  }
}

/**
 * The matching worker could not be started, so nothing was matched.
 *
 * Deliberately carries no cause text: the underlying failure names the worker
 * module's absolute path, and this message reaches both the model and the
 * durable event transcript.
 */
export class RegexUnavailable extends Error {
  constructor() {
    super("regex matcher unavailable");
    this.name = "RegexUnavailable";
  }
}

/**
 * Locate the worker module. `import.meta.resolve` is the right call under Deno,
 * but the vitest SSR transform rewrites `import.meta` to an object that has
 * only `url` — so resolve defensively rather than shipping a matcher that works
 * in tests and not at runtime, or the reverse.
 */
function defaultWorkerSpecifier(): string {
  const meta = import.meta as unknown as {
    resolve?: (specifier: string) => string;
    url?: string;
  };
  if (typeof meta.resolve === "function") {
    return meta.resolve("./regex-worker.ts");
  }
  if (typeof meta.url === "string") {
    return new URL("./regex-worker.ts", meta.url).href;
  }
  throw new RegexUnavailable();
}

export class BoundedMatcher {
  readonly #pattern: string;
  readonly #budgetMs: number;
  readonly #explicitSpecifier: string | undefined;
  #worker: Worker | null = null;
  #spentMs = 0;
  #nextId = 1;
  #dead = false;

  /**
   * Compiling the pattern here, in-process, is deliberate: compilation cannot
   * backtrack, so an invalid pattern fails fast and synchronously without
   * paying for a worker. Only *execution* needs the budget — but compilation
   * is not free either, and it happens before the worker exists, so the length
   * ceiling above is what bounds it.
   */
  constructor(
    pattern: string,
    options: { budgetMs?: number; specifier?: string } = {},
  ) {
    if (pattern.length > MAX_PATTERN_LENGTH) {
      throw new Error(
        `pattern is longer than ${MAX_PATTERN_LENGTH} characters`,
      );
    }
    new RegExp(pattern);
    this.#pattern = pattern;
    this.#budgetMs = options.budgetMs ?? DEFAULT_REGEX_BUDGET_MS;
    this.#explicitSpecifier = options.specifier;
  }

  /** Milliseconds of budget left; 0 once exhausted. */
  get remainingMs(): number {
    return Math.max(0, this.#budgetMs - this.#spentMs);
  }

  /**
   * Indices of the lines matching the pattern.
   *
   * Throws `RegexBudgetExceeded` when the shared budget runs out — the worker
   * is terminated at that point and this matcher is spent. Throws
   * `RegexUnavailable` if no worker could be started, so a caller that cannot
   * match fails closed rather than falling back to the main thread.
   */
  async matchLines(lines: string[]): Promise<number[]> {
    if (lines.length === 0) return [];
    if (this.#dead) throw new RegexBudgetExceeded(this.#budgetMs);
    const remaining = this.remainingMs;
    if (remaining <= 0) {
      this.close();
      throw new RegexBudgetExceeded(this.#budgetMs);
    }

    const worker = this.#ensureWorker();
    const id = this.#nextId++;
    const started = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      return await new Promise<number[]>((resolve, reject) => {
        timer = setTimeout(() => {
          // The worker is mid-`test()` and will not answer. Kill it; a
          // terminated worker cannot be reused, so mark this matcher spent.
          this.close();
          reject(new RegexBudgetExceeded(this.#budgetMs));
        }, remaining);
        worker.onmessage = (
          event: MessageEvent<
            { id: number; hits?: number[]; error?: string }
          >,
        ) => {
          if (event.data.id !== id) return;
          if (event.data.error !== undefined) {
            reject(new Error(event.data.error));
            return;
          }
          resolve(event.data.hits ?? []);
        };
        worker.onerror = (event: ErrorEvent) => {
          // Keep the failure local: without preventDefault a worker error also
          // surfaces as an unhandled global error and can take down the host.
          event.preventDefault?.();
          this.close();
          reject(new RegexUnavailable());
        };
        worker.postMessage({ id, pattern: this.#pattern, lines });
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.#spentMs += performance.now() - started;
    }
  }

  /** Terminate the worker. Safe to call more than once. */
  close(): void {
    this.#dead = true;
    if (this.#worker !== null) {
      this.#worker.terminate();
      this.#worker = null;
    }
  }

  #ensureWorker(): Worker {
    if (this.#worker !== null) return this.#worker;
    try {
      const specifier = this.#explicitSpecifier ?? defaultWorkerSpecifier();
      this.#worker = new Worker(specifier, { type: "module" });
    } catch (err) {
      this.#dead = true;
      throw err instanceof RegexUnavailable ? err : new RegexUnavailable();
    }
    return this.#worker;
  }
}
