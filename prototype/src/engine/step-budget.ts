/**
 * The progress-aware tool-step budget (BIT-992).
 *
 * A turn's tool steps were bounded by one fixed number, so a productive turn
 * working through a repo was interrupted mid-stride while its dollar budgets
 * were nowhere near spent. This module replaces that single bound with three
 * numbers and a progress test:
 *
 *   - the **soft limit**: the step count the turn was configured for (the
 *     standing `[agent] max_tool_steps`);
 *   - the **ceiling**: the hard safety bound the turn may never pass;
 *   - **extension**: whether a productive turn may raise its soft limit
 *     toward the ceiling, in chunks.
 *
 * After each tool step the loop asks `decide`. A step inside the soft limit
 * continues. Past it, the budget watches two things. An unproductive step
 * counts toward a stall streak and never extends the limit: two of them in a
 * row stop the turn early instead of burning the rest of the budget on a loop.
 * A productive step clears the streak, and extends the limit only when the turn
 * has reached the limit it is running under, so one extension is recorded per
 * chunk rather than on every step. Spend outranks progress: a turn whose dollar
 * budgets are already spent stops before extending, because the next provider
 * call would be refused anyway.
 *
 * A turn whose limit must not extend - the operator named it with
 * `--tool-steps N` or `/steps N`, or `[agent] step_extension = false` - has no
 * policy to apply: `decide` returns `continue` for every step and the loop
 * ends the turn where it always did, so a fixed limit writes no
 * `step_budget` event and reads as it did before this module existed.
 *
 * The budget is state, and its single writer is the agent loop.
 */

/** Consecutive unproductive steps at the soft limit that end a turn. */
export const STALL_STEPS = 2;

/** Why a turn's tool use ended. */
export type StepStopReason =
  /** The hard safety ceiling. */
  | "ceiling"
  /** Consecutive steps with no forward progress. */
  | "stall"
  /** The turn's spend limits leave no room for another call. */
  | "budget";

/** The three numbers a turn's step budget is fixed from. */
export interface StepBudgetPolicy {
  /** The configured step count, before any extension. */
  softLimit: number;
  /** The hard bound, however productive the turn is. */
  ceiling: number;
  /** Whether a productive turn may raise its soft limit toward the ceiling. */
  extension: boolean;
}

/** What one completed tool step did, for the budget's decision. */
export interface StepOutcome {
  /** The step just completed, counting from 1. */
  step: number;
  /** The step made forward progress (see `noteToolProgress`). */
  productive: boolean;
  /** The turn's spend so far. */
  turnSpentUsd: number;
  /** The turn's spend since its last step that made progress. */
  stallSpentUsd: number;
  turnLimitUsd: number;
  runawayStallUsd: number;
}

/**
 * A stop as the model and the operator read it: the step the turn stopped at
 * (never the limit it was running under, which a stall stops short of), that
 * limit, the stall streak that ended the turn, and why it ended.
 */
export interface StepStopFacts {
  /** The step the turn stopped at, counting from 1. */
  step: number;
  /** The step limit the turn was running under. */
  limit: number;
  /** Consecutive unproductive steps; meaningful for a stall. */
  stalled: number;
  /** Why tool use ended, or undefined for a limit the turn simply reached. */
  reason: StepStopReason | undefined;
}

/** What the budget decided after a step. */
export type StepDecision =
  | { kind: "continue" }
  | { kind: "extended"; from: number; to: number }
  | { kind: "stop"; reason: StepStopReason; effectiveLimit: number };

/**
 * How many steps one extension grants: half the soft limit, at least one.
 * Half the soft budget keeps a long turn's extension deliberate rather than
 * open-ended, and never lets one productive step jump to the ceiling.
 */
export function extensionChunk(softLimit: number): number {
  return Math.max(1, Math.floor(softLimit / 2));
}

/** The step budget of one turn; the agent loop is its only writer. */
export class StepBudget {
  readonly softLimit: number;
  readonly ceiling: number;
  readonly extension: boolean;
  #effectiveLimit: number;
  #stalledSteps = 0;
  #stopReason: StepStopReason | undefined;

  constructor(policy: StepBudgetPolicy) {
    this.softLimit = Math.max(1, Math.trunc(policy.softLimit));
    this.ceiling = Math.max(1, Math.trunc(policy.ceiling));
    this.extension = policy.extension;
    this.#effectiveLimit = Math.min(this.softLimit, this.ceiling);
  }

  /** The step count the turn may reach, after any extension so far. */
  get effectiveLimit(): number {
    return this.#effectiveLimit;
  }

  /** Consecutive unproductive steps at the soft limit. */
  get stalledSteps(): number {
    return this.#stalledSteps;
  }

  /** Why tool use ended, or undefined while the turn may still step. */
  get stopReason(): StepStopReason | undefined {
    return this.#stopReason;
  }

  /** Whether the turn has stopped taking steps. */
  get stopped(): boolean {
    return this.#stopReason !== undefined;
  }

  /** Whether another tool step may start after `steps` completed ones. */
  allowsAnotherStep(steps: number): boolean {
    return !this.stopped && steps < this.#effectiveLimit;
  }

  /**
   * The stop the turn made, at `step`, as the handoff and the notice read it.
   * Read after the stop, so `reason` is the one that ended tool use.
   */
  stopFacts(step: number): StepStopFacts {
    return {
      step,
      limit: this.#effectiveLimit,
      stalled: this.#stalledSteps,
      reason: this.#stopReason,
    };
  }

  /** Whether the step just run reached the budget, so tool use ends here. */
  atLimit(steps: number): boolean {
    return this.stopped || steps >= this.#effectiveLimit;
  }

  /**
   * Decide what the step just completed means for the budget. Ceiling and
   * spend outrank progress; the soft limit is where the question is first
   * asked, so a step inside it always continues.
   */
  decide(outcome: StepOutcome): StepDecision {
    if (this.#stopReason !== undefined) return this.#stop(this.#stopReason);
    // A limit that must not extend has nothing to decide, and no stop of its
    // own to record: the loop reads `atLimit` and ends the turn where the
    // fixed limit always ended it, with the receipt it always printed.
    if (!this.extension) return { kind: "continue" };
    if (outcome.step >= this.ceiling) return this.#stop("ceiling");
    if (outcome.step < this.softLimit) return { kind: "continue" };
    if (
      outcome.turnSpentUsd >= outcome.turnLimitUsd ||
      outcome.stallSpentUsd >= outcome.runawayStallUsd
    ) {
      return this.#stop("budget");
    }
    // An unproductive step counts toward the stall streak and never extends:
    // progress is what buys steps, so a step without it buys none. Two in a
    // row end tool use wherever they land, and a single one at the limit ends
    // it too, because there is no chunk left to spend on the next step.
    if (!outcome.productive) {
      this.#stalledSteps += 1;
      if (
        this.#stalledSteps >= STALL_STEPS ||
        outcome.step >= this.#effectiveLimit
      ) {
        return this.#stop("stall");
      }
      return { kind: "continue" };
    }
    this.#stalledSteps = 0;
    // The extension question is asked at the limit the turn is running under,
    // not on every step past the soft limit: a chunk holds until it is used.
    if (outcome.step < this.#effectiveLimit) return { kind: "continue" };
    return this.#extend();
  }

  #extend(): StepDecision {
    const from = this.#effectiveLimit;
    const to = Math.min(this.ceiling, from + extensionChunk(this.softLimit));
    this.#effectiveLimit = to;
    return { kind: "extended", from, to };
  }

  #stop(reason: StepStopReason): StepDecision {
    this.#stopReason = reason;
    return { kind: "stop", reason, effectiveLimit: this.#effectiveLimit };
  }
}
