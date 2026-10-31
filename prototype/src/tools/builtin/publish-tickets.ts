/**
 * The publish ticket registry (BIT-786): the one owner of a session's publish
 * runs, held in the runtime's memory and never persisted.
 *
 * A ticket is what an approval will bind: it pins the repository, branch and
 * commit resolved host-side when it was created. The registry stores that pin
 * and `markPushing` refuses a head that moved; comparing the live layout
 * against the pin before each phase is the phase runner's job. The push transitions (`markPushing`, `markPushed`, `markPrOpen`,
 * `markDenied`, `markPushFailed`, `notePrFailed`) are reached by no registered
 * tool: `runPush` (`publish-push.ts`) drives them, and the tool that calls it
 * is a later slice.
 *
 * In memory only, deliberately. After a runtime restart a ticket is gone and
 * `publish/status` says `unknown` rather than guessing: the gate report on
 * disk is not a source of truth about a run this process no longer holds.
 *
 * Single writer: only the registry mutates a ticket, and only through the
 * transitions below. Callers read copies.
 */

import { randomUUID } from "node:crypto";
import type { GitLayout } from "./publish-git.ts";

/** What a ticket is doing. Each transition is one of the methods below. */
export type PublishPhase =
  /** Created; the pre-gate is running or about to. */
  | "pre-gate"
  /** The pre-gate passed; the gate is running. */
  | "gated"
  /** The pre-gate or the gate failed, timed out or was cancelled. */
  | "failed"
  /** Both gates passed; waiting for a push approval. */
  | "ready"
  /** A push is approved and in flight. */
  | "pushing"
  /** Pushed. */
  | "pushed"
  /** The pull request is open. */
  | "pr-open"
  /** The approval was refused: the ticket is dead. */
  | "denied"
  /** Past its TTL, or its head moved under it. */
  | "expired";

/** How many tickets one session may retain; the oldest is dropped first. */
export const MAX_TICKETS_PER_SESSION = 8;

/** How many tickets the whole runtime may retain, across every session. */
export const MAX_TICKETS_TOTAL = 128;

/** One publish run, as the tool reports it. */
export interface PublishTicketView {
  ticket: string;
  sessionId: string;
  phase: PublishPhase;
  /** The pinned layout: what an approval binds. */
  repository: string;
  branch: string | null;
  head: string | null;
  /** Where the gate's combined output is written. */
  reportPath: string;
  /** Which phase's failure this is, once `phase` is `failed`. */
  failedPhase?: "pre-gate" | "gate" | "push";
  /** Why it failed, as one operator-facing line. */
  reason?: string;
  /** The pull request `open_pr` reported, once one is open. */
  prUrl?: string;
  /** The first output kept, for a report. */
  outputHead?: string;
  truncatedOutput: boolean;
  /**
   * Why the run's report file could not be written, when it could not. The
   * phase's verdict stands; this says the report is short.
   */
  reportError?: string;
  /** The pinned layout, so a runner can compare it without a lookup. */
  layout: GitLayout;
  createdAtMs: number;
  /** Set when the phase ended; `elapsedMs` is then final. */
  endedAtMs?: number;
  trackerIssue?: string;
}

/** A ticket's mutable record. Only this module writes it. */
interface TicketRecord extends PublishTicketView {
  /** The run in flight, when a phase is running. */
  cancelHook?: () => void;
}

/** One registry, owned by the composition root for the runtime's lifetime. */
export class PublishTickets {
  readonly #bySession = new Map<string, Map<string, TicketRecord>>();
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(options: { ttlMs: number; now?: () => number }) {
    this.#ttlMs = options.ttlMs;
    this.#now = options.now ?? (() => Date.now());
  }

  /** A new ticket, pinned to `layout`; it starts in `pre-gate`. */
  create(input: {
    sessionId: string;
    layout: GitLayout;
    /**
     * The report path for this ticket. It is a callback because the default
     * path names the ticket id, and only this module mints one.
     */
    reportPathFor: (ticket: string) => string;
    trackerIssue?: string;
  }): PublishTicketView {
    const now = this.#now();
    // Expire anything already dead before adding: a session's map stays small.
    this.#expireSession(input.sessionId);
    const ticket = randomUUID();
    const record: TicketRecord = {
      ticket,
      sessionId: input.sessionId,
      phase: "pre-gate",
      repository: input.layout.topLevel,
      branch: branchOf(input.layout),
      head: input.layout.head,
      reportPath: input.reportPathFor(ticket),
      truncatedOutput: false,
      createdAtMs: now,
      // A copy: the caller's object must not be able to move the pin.
      layout: { ...input.layout },
      ...(input.trackerIssue === undefined
        ? {}
        : { trackerIssue: input.trackerIssue }),
    };
    let tickets = this.#bySession.get(input.sessionId);
    if (tickets === undefined) {
      tickets = new Map();
      this.#bySession.set(input.sessionId, tickets);
    }
    tickets.set(record.ticket, record);
    while (tickets.size > MAX_TICKETS_PER_SESSION) {
      const oldest = tickets.keys().next().value;
      if (oldest === undefined) break;
      this.#drop(input.sessionId, oldest);
    }
    this.#enforceTotal();
    return viewOf(record);
  }

  /**
   * One ticket, as its session may see it. Null when this process holds no
   * such ticket: after a restart the caller reports `unknown`.
   */
  get(sessionId: string, ticket: string): PublishTicketView | null {
    const record = this.#live(sessionId, ticket);
    return record === null ? null : viewOf(record);
  }

  /** The session's newest ticket, so a caller need not carry the id. */
  latest(sessionId: string): PublishTicketView | null {
    this.#expireSession(sessionId);
    const tickets = this.#bySession.get(sessionId);
    if (tickets === undefined) return null;
    let last: TicketRecord | undefined;
    for (const record of tickets.values()) last = record;
    return last === undefined ? null : viewOf(last);
  }

  /**
   * Every ticket a session still retains, newest last, expired ones included:
   * an expired ticket stays until a `sweep` drops it, so a caller can still
   * report what happened. Expiry is applied first, so no stale phase is shown.
   */
  list(sessionId: string): PublishTicketView[] {
    this.#expireSession(sessionId);
    return [...(this.#bySession.get(sessionId)?.values() ?? [])].map(viewOf);
  }

  /**
   * Drop every session's expired tickets and the session maps they empty.
   * Returns how many tickets went. A caller with no reason to keep a spent
   * ticket calls this; `list` and `status` still report one until it does.
   */
  sweep(): number {
    let dropped = 0;
    for (const [sessionId, tickets] of this.#bySession) {
      for (const [ticket, record] of tickets) {
        if (record.phase !== "expired") continue;
        // An expired record's cancel hook was already run by the expiry.
        tickets.delete(ticket);
        dropped += 1;
      }
      if (tickets.size === 0) this.#bySession.delete(sessionId);
    }
    return dropped;
  }

  /** The pre-gate passed; the gate is about to run. */
  markGated(sessionId: string, ticket: string): PublishTicketView | null {
    return this.#transition(sessionId, ticket, ["pre-gate"], "gated");
  }

  /** Both gates passed. Nothing registered reads this phase yet. */
  markReady(sessionId: string, ticket: string): PublishTicketView | null {
    return this.#transition(sessionId, ticket, ["gated"], "ready");
  }

  /**
   * Record that the run's report could not be written, on a ticket that is not
   * failing for any other reason. The phases' verdicts stand; the report is
   * what the operator would read, so its absence is not silent.
   */
  noteReportError(
    sessionId: string,
    ticket: string,
    reason: string,
  ): PublishTicketView | null {
    const record = this.#live(sessionId, ticket);
    if (record === null) return null;
    record.reportError = reason;
    return viewOf(record);
  }

  /** A gate stopped the run. The reason and findings are what is reported. */
  markFailed(
    sessionId: string,
    ticket: string,
    failedPhase: "pre-gate" | "gate",
    reason: string,
    outputHead: string,
    truncatedOutput: boolean,
    reportError?: string,
  ): PublishTicketView | null {
    const record = this.#live(sessionId, ticket);
    // Only a running phase can fail: a ticket already failed, expired or past
    // the gates keeps the verdict and reason it has.
    if (record === null) return null;
    if (record.phase !== "pre-gate" && record.phase !== "gated") return null;
    record.cancelHook = undefined;
    record.phase = "failed";
    record.failedPhase = failedPhase;
    record.reason = reason;
    record.outputHead = outputHead;
    record.truncatedOutput = truncatedOutput;
    if (reportError !== undefined) record.reportError = reportError;
    record.endedAtMs = this.#now();
    return viewOf(record);
  }

  /**
   * Register the run a phase in flight left behind. Refused for a ticket in a
   * terminal phase - failed, expired, ready - because there is then nothing
   * left to cancel, and a hook on such a ticket would be a stop no phase waits
   * for. Returns whether the hook was attached.
   */
  attachCancelHook(
    sessionId: string,
    ticket: string,
    hook: () => void,
  ): boolean {
    const record = this.#live(sessionId, ticket);
    if (record === null) return false;
    if (record.phase !== "pre-gate" && record.phase !== "gated") return false;
    record.cancelHook = hook;
    return true;
  }

  /** A cancel request: the run stops, and the ticket records why. */
  cancel(sessionId: string, ticket: string): PublishTicketView | null {
    const record = this.#live(sessionId, ticket);
    if (record === null) return null;
    if (record.phase !== "pre-gate" && record.phase !== "gated") return null;
    const running = record.phase;
    const hook = record.cancelHook;
    record.cancelHook = undefined;
    runHook(hook);
    record.phase = "failed";
    record.failedPhase = running === "gated" ? "gate" : "pre-gate";
    record.reason = "cancelled by the operator";
    record.endedAtMs = this.#now();
    return viewOf(record);
  }

  /** The approval was refused: the ticket is dead and cannot be pushed. */
  markDenied(sessionId: string, ticket: string): PublishTicketView | null {
    return this.#transition(sessionId, ticket, ["ready"], "denied");
  }

  /**
   * A push is approved and in flight (`runPush` drives this; no tool is
   * registered for it yet). A head that moved since the gate expireds the
   * ticket instead.
   */
  markPushing(
    sessionId: string,
    ticket: string,
    head: string,
  ): PublishTicketView | null {
    const record = this.#live(sessionId, ticket);
    if (record === null || record.phase !== "ready") return null;
    if (record.head !== head) {
      // The head moved between the gate and now: the approval no longer
      // describes what would be published.
      record.phase = "expired";
      record.reason = "the head moved after the gate passed";
      record.endedAtMs = this.#now();
      return viewOf(record);
    }
    record.phase = "pushing";
    return viewOf(record);
  }

  /** The push finished. */
  markPushed(sessionId: string, ticket: string): PublishTicketView | null {
    return this.#settle(sessionId, ticket, "pushing", "pushed");
  }

  /**
   * The push stopped the run. Final: a ticket is pushed at most once, so there
   * is no phase to return to and no second attempt to approve.
   */
  markPushFailed(
    sessionId: string,
    ticket: string,
    reason: string,
    outputHead: string,
    truncatedOutput: boolean,
  ): PublishTicketView | null {
    const record = this.#live(sessionId, ticket);
    if (record === null || record.phase !== "pushing") return null;
    record.cancelHook = undefined;
    record.phase = "failed";
    record.failedPhase = "push";
    record.reason = reason;
    record.outputHead = outputHead;
    record.truncatedOutput = truncatedOutput;
    record.endedAtMs = this.#now();
    return viewOf(record);
  }

  /**
   * `open_pr` failed. The ticket stays `pushed` - the push did happen, and a
   * ticket that said otherwise would invite pushing the same commits twice -
   * so a later call retries only the pull request.
   */
  notePrFailed(
    sessionId: string,
    ticket: string,
    reason: string,
    outputHead: string,
    truncatedOutput: boolean,
  ): PublishTicketView | null {
    const record = this.#live(sessionId, ticket);
    if (record === null || record.phase !== "pushed") return null;
    record.reason = reason;
    record.outputHead = outputHead;
    record.truncatedOutput = truncatedOutput;
    return viewOf(record);
  }

  /**
   * The pull request is open, and this is the URL it reported. The reason an
   * earlier `notePrFailed` left is cleared: the failure it described is over.
   */
  markPrOpen(
    sessionId: string,
    ticket: string,
    prUrl: string,
  ): PublishTicketView | null {
    const record = this.#live(sessionId, ticket);
    if (record === null || record.phase !== "pushed") return null;
    record.phase = "pr-open";
    record.prUrl = prUrl;
    delete record.reason;
    record.endedAtMs = this.#now();
    return viewOf(record);
  }

  /**
   * Mark every ticket past its TTL expired, then drop the ones already
   * expired. Returns how many were marked on this call.
   */
  expireStale(): number {
    let changed = 0;
    for (const sessionId of [...this.#bySession.keys()]) {
      changed += this.#expireSession(sessionId);
    }
    this.sweep();
    return changed;
  }

  /** Remove one ticket, stopping the run it owns. */
  #drop(sessionId: string, ticket: string): void {
    const tickets = this.#bySession.get(sessionId);
    const record = tickets?.get(ticket);
    if (tickets === undefined || record === undefined) return;
    const hook = record.cancelHook;
    record.cancelHook = undefined;
    // Eviction is bounded-memory bookkeeping, not a verdict: a run whose
    // ticket is gone would have nowhere to report, so it is stopped.
    runHook(hook);
    tickets.delete(ticket);
    if (tickets.size === 0) this.#bySession.delete(sessionId);
  }

  /** Keep the whole registry within its bound, oldest ticket first. */
  #enforceTotal(): void {
    // Expired tickets go first: they are the cheapest thing to forget, and
    // the map that held them goes with them. TTL expiry is applied across
    // every session first, so a stale run elsewhere is not kept while a
    // finished ticket is evicted.
    this.expireStale();
    let total = 0;
    for (const tickets of this.#bySession.values()) total += tickets.size;
    if (total <= MAX_TICKETS_TOTAL) return;
    const order: { sessionId: string; ticket: string; at: number }[] = [];
    for (const [sessionId, tickets] of this.#bySession) {
      for (const [ticket, record] of tickets) {
        order.push({ sessionId, ticket, at: record.createdAtMs });
      }
    }
    order.sort((a, b) => a.at - b.at);
    for (const entry of order) {
      if (total <= MAX_TICKETS_TOTAL) break;
      this.#drop(entry.sessionId, entry.ticket);
      total -= 1;
    }
  }

  #expireSession(sessionId: string): number {
    const tickets = this.#bySession.get(sessionId);
    if (tickets === undefined) return 0;
    const now = this.#now();
    let changed = 0;
    for (const record of tickets.values()) {
      // A push in flight or done is a fact about GitHub, not a pending
      // approval: relabelling it expired would hide that commits went out.
      if (
        record.phase === "expired" || record.phase === "pr-open" ||
        record.phase === "pushing" || record.phase === "pushed"
      ) continue;
      if (now - record.createdAtMs <= this.#ttlMs) continue;
      // A ticket that expires takes its running gate with it: a run whose
      // approval can never be used must not keep a process tree alive.
      const hook = record.cancelHook;
      record.cancelHook = undefined;
      runHook(hook);
      record.phase = "expired";
      record.reason = "the ticket outlived its lifetime";
      record.endedAtMs = now;
      changed += 1;
    }
    return changed;
  }

  /**
   * The record, or null when this session holds no such ticket. TTL expiry is
   * applied first, so a caller sees `expired` rather than a stale phase.
   */
  #live(sessionId: string, ticket: string): TicketRecord | null {
    const record = this.#bySession.get(sessionId)?.get(ticket);
    if (record === undefined) return null;
    this.#expireSession(sessionId);
    return record;
  }

  #transition(
    sessionId: string,
    ticket: string,
    from: readonly PublishPhase[],
    to: PublishPhase,
  ): PublishTicketView | null {
    const record = this.#live(sessionId, ticket);
    if (record === null || !from.includes(record.phase)) return null;
    record.phase = to;
    if (to === "ready") record.cancelHook = undefined;
    return viewOf(record);
  }

  #settle(
    sessionId: string,
    ticket: string,
    from: PublishPhase,
    to: PublishPhase,
  ): PublishTicketView | null {
    const record = this.#live(sessionId, ticket);
    if (record === null || record.phase !== from) return null;
    record.phase = to;
    record.endedAtMs = this.#now();
    return viewOf(record);
  }
}

/** The branch name from a ref, or null on a detached head. */
export function branchOf(layout: GitLayout): string | null {
  const ref = layout.branchRef;
  if (ref === null || !ref.startsWith("refs/heads/")) return null;
  return ref.slice("refs/heads/".length);
}

function viewOf(record: TicketRecord): PublishTicketView {
  const { cancelHook: _cancel, ...rest } = record;
  return { ...rest, layout: { ...rest.layout } };
}

/**
 * Run a cancel hook without letting it throw into the registry: the state
 * change that follows must happen whether or not the stop succeeded.
 */
function runHook(hook: (() => void) | undefined): void {
  try {
    hook?.();
  } catch {
    // The run's own failure path reports what happened to its process.
  }
}
