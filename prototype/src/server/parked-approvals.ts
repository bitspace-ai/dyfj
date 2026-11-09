// Parked approvals: the approval requests of turns that have no client
// connection to ask. A runtime-started (headless) turn's approver parks each
// request here against the turn's session, and the turn waits. A park is
// answered only through the `approvals/answer` RPC method (`rpc/approvals.ts`)
// on the runtime socket, naming a session and approval id that are pending
// together. That socket is the operator's: any process that can connect to it
// can answer, which is why no agent tool names an approval and agent shells
// must not reach the socket. Text sent to the session is refused while a park
// waits (`rpc/turn-core.ts`).
//
// This registry is the single writer of the pending set. A request is listed
// only once its `approval_parked` event is written, but the session counts as
// waiting (`hasPending`) from the moment the request arrives, so a turn
// submitted while the park is being recorded is refused too. Its end (an answer, a
// timeout or the turn's cancellation) is recorded as an `approval_resolved`
// event, best-effort: the turn does not wait for that write, and a failed
// write is logged by class and leaves no event. The pending set lives in
// memory: a parked turn does not survive a runtime restart, so neither does
// its park.

import type { WorkbenchAuthContext } from "../contract/mod.ts";
import { writeMaybe } from "../engine/mod.ts";
import { generateSpanId, generateULID } from "../kernel/mod.ts";
import {
  approvalParkedEvent,
  approvalResolvedEvent,
  type EventInsert,
} from "../store/mod.ts";

/** How long a park waits for the operator before it denies: 24 hours. */
export const DEFAULT_PARK_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/** Where a request was raised: the turn's session and trace. */
export interface ParkSite {
  sessionId: string;
  traceId: string;
}

/** A parked request, as `approvals/pending` lists it. */
export interface ParkedApproval {
  approvalId: string;
  /** ISO-8601 time the request was parked. */
  parkedAt: string;
  /** The request exactly as a connected client would have been sent it. */
  request: unknown;
}

export interface ParkedApprovalsDeps {
  /** Append one event to the log; a rejection means it was not recorded. */
  writeEvent: (event: EventInsert) => Promise<void>;
  /** The auth posture parks and answers are recorded under. */
  authContext?: WorkbenchAuthContext;
  /**
   * How long a park waits, counted from the request, recording included. A
   * park still waiting then is answered with a denial.
   */
  timeoutMs?: number;
  now?: () => Date;
}

type Resolution =
  | { by: "operator"; response: unknown }
  | { by: "timeout" }
  | { by: "cancel" };

interface Entry {
  view: ParkedApproval;
  settle(resolution: Resolution): void;
}

const LOCAL_AUTH: WorkbenchAuthContext = {
  transport: "loopback",
  authnStatus: "authenticated",
  authnMechanism: "local_user",
  authnIssuerRef: "local_os",
  authzBasis: "policy:loopback-uds",
};

const EXTERNAL_AGENT_PERMISSION = "external_agent_permission";

/** The kind a request names, for the log: `tool` when it names none. */
function requestKind(request: unknown): string {
  const kind = (request as { kind?: unknown } | null)?.kind;
  return typeof kind === "string" && kind.length <= 64 ? kind : "tool";
}

function commandIdOf(request: unknown): string | null {
  const id = (request as { commandId?: unknown } | null)?.commandId;
  return typeof id === "string" && id.length <= 128 ? id : null;
}

/**
 * The verdict an answer gives, for the log, by the same rules the turn's
 * parsers apply (`rpc/approval.ts`). An external agent's permission is
 * approved only by selecting one of its allow options; any other request only
 * by an explicit `approve`. `abort` ends the turn.
 */
export function answerVerdict(
  request: unknown,
  response: unknown,
): "approved" | "denied" | "cancelled" {
  const answer = typeof response === "object" && response !== null
    ? response as Record<string, unknown>
    : {};
  if (answer.decision === "abort") return "cancelled";
  if (requestKind(request) !== EXTERNAL_AGENT_PERMISSION) {
    return answer.decision === "approve" ? "approved" : "denied";
  }
  if (
    answer.decision !== "select" || typeof answer.optionId !== "string" ||
    answer.optionId.length === 0
  ) {
    return "denied";
  }
  const options = (request as { options?: unknown }).options;
  const chosen = Array.isArray(options)
    ? options.find((option) =>
      (option as { optionId?: unknown })?.optionId === answer.optionId
    ) as { kind?: unknown } | undefined
    : undefined;
  return chosen?.kind === "allow_once" || chosen?.kind === "allow_always"
    ? "approved"
    : "denied";
}

function timeoutDenial(timeoutMs: number) {
  return {
    decision: "deny",
    reason: `approval timed out after ${
      Math.round(timeoutMs / 1000)
    } s with no answer`,
  };
}

/**
 * Wait for `work`, or for the first of `signals` to abort. Which one ended the
 * wait is returned; a rejection of `work` that comes first is thrown.
 */
function firstOf<K extends string>(
  work: Promise<void>,
  signals: ReadonlyArray<readonly [K, AbortSignal | undefined]>,
): Promise<"done" | K> {
  return new Promise((resolve, reject) => {
    const cleanups: (() => void)[] = [];
    const finish = (outcome: () => void) => {
      for (const cleanup of cleanups) cleanup();
      outcome();
    };
    for (const [name, signal] of signals) {
      if (signal === undefined) continue;
      if (signal.aborted) return finish(() => resolve(name));
      const onAbort = () => finish(() => resolve(name));
      signal.addEventListener("abort", onAbort, { once: true });
      cleanups.push(() => signal.removeEventListener("abort", onAbort));
    }
    work.then(
      () => finish(() => resolve("done")),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

export class ParkedApprovals {
  readonly #bySession = new Map<string, Map<string, Entry>>();
  /** Requests per session whose `approval_parked` write has not settled. */
  readonly #recording = new Map<string, number>();
  readonly #writeEvent: ParkedApprovalsDeps["writeEvent"];
  readonly #auth: WorkbenchAuthContext;
  readonly #timeoutMs: number;
  readonly #now: () => Date;

  constructor(deps: ParkedApprovalsDeps) {
    this.#writeEvent = deps.writeEvent;
    this.#auth = deps.authContext ?? LOCAL_AUTH;
    this.#timeoutMs = deps.timeoutMs ?? DEFAULT_PARK_TIMEOUT_MS;
    this.#now = deps.now ?? (() => new Date());
  }

  /**
   * Park one request and wait for its answer. Resolves with the operator's
   * raw response, or with a denial when the park times out. Rejects with the
   * signal's reason when the turn is cancelled, and rejects when the park
   * cannot be recorded: a request whose `approval_parked` write fails is
   * never listed. The timeout and the cancel signal also bound how long the
   * turn waits for that write; the write itself is not cancelled.
   */
  async park(
    site: ParkSite,
    request: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    signal?.throwIfAborted();
    const approvalId = crypto.randomUUID();
    const toolName = commandIdOf(request);
    const timedOut = AbortSignal.timeout(this.#timeoutMs);

    const recorded = this.#writeEvent(approvalParkedEvent({
      ...this.#serviceFields(site),
      action: "park",
      resource: approvalId,
      tool_name: toolName,
      content: JSON.stringify({ approvalId, kind: requestKind(request) }),
    }));
    this.#recordingStarted(site.sessionId);
    let first: Awaited<ReturnType<typeof firstOf<"cancel" | "timeout">>>;
    try {
      first = await firstOf(recorded, [
        ["cancel", signal],
        ["timeout", timedOut],
      ] as const);
    } finally {
      this.#recordingEnded(site.sessionId);
    }
    if (first !== "done") {
      // Ended while the park was being recorded. If the record lands anyway,
      // writing its end is attempted after it. Only the ids are kept for
      // that, not the request.
      const verdict = first === "timeout" ? "denied" : "cancelled";
      void recorded.then(
        () =>
          this.#recordResolution(site, approvalId, toolName, {
            by: first,
            verdict,
          }),
        () => {},
      );
      if (first === "cancel") throw signal!.reason;
      return timeoutDenial(this.#timeoutMs);
    }

    return new Promise<unknown>((resolve, reject) => {
      const onCancel = () => entry.settle({ by: "cancel" });
      const onTimeout = () => entry.settle({ by: "timeout" });
      const entry: Entry = {
        view: { approvalId, parkedAt: this.#now().toISOString(), request },
        settle: (resolution) => {
          // Withdrawn in the same step it is settled, so a second answer
          // finds nothing to resolve.
          if (!this.#remove(site.sessionId, approvalId)) return;
          signal?.removeEventListener("abort", onCancel);
          timedOut.removeEventListener("abort", onTimeout);
          void this.#recordResolution(site, approvalId, toolName, {
            by: resolution.by,
            verdict: resolution.by === "operator"
              ? answerVerdict(request, resolution.response)
              : resolution.by === "timeout"
              ? "denied"
              : "cancelled",
          });
          if (resolution.by === "cancel") reject(signal?.reason);
          else if (resolution.by === "timeout") {
            resolve(timeoutDenial(this.#timeoutMs));
          } else resolve(resolution.response);
        },
      };
      let session = this.#bySession.get(site.sessionId);
      if (session === undefined) {
        session = new Map();
        this.#bySession.set(site.sessionId, session);
      }
      session.set(approvalId, entry);
      signal?.addEventListener("abort", onCancel, { once: true });
      timedOut.addEventListener("abort", onTimeout, { once: true });
      // Either may have fired between the record landing and these listeners.
      if (signal?.aborted) onCancel();
      else if (timedOut.aborted) onTimeout();
    });
  }

  /** The requests parked for one session, oldest first. */
  pending(sessionId: string): ParkedApproval[] {
    return [...(this.#bySession.get(sessionId)?.values() ?? [])].map((
      entry,
    ) => entry.view);
  }

  /** Whether a request is parked for the session, or being recorded. */
  hasPending(sessionId: string): boolean {
    return (this.#bySession.get(sessionId)?.size ?? 0) > 0 ||
      (this.#recording.get(sessionId) ?? 0) > 0;
  }

  /**
   * Answer one parked request. False when that id is not pending for that
   * session: never parked there, already answered, timed out or withdrawn.
   */
  answer(
    sessionId: string,
    approvalId: string,
    response: unknown,
  ): boolean {
    const entry = this.#bySession.get(sessionId)?.get(approvalId);
    if (entry === undefined) return false;
    entry.settle({ by: "operator", response });
    return true;
  }

  #recordingStarted(sessionId: string): void {
    this.#recording.set(sessionId, (this.#recording.get(sessionId) ?? 0) + 1);
  }

  #recordingEnded(sessionId: string): void {
    const left = (this.#recording.get(sessionId) ?? 1) - 1;
    if (left > 0) this.#recording.set(sessionId, left);
    else this.#recording.delete(sessionId);
  }

  #remove(sessionId: string, approvalId: string): boolean {
    const session = this.#bySession.get(sessionId);
    if (session?.delete(approvalId) !== true) return false;
    if (session.size === 0) this.#bySession.delete(sessionId);
    return true;
  }

  #serviceFields(site: ParkSite) {
    return {
      event_id: generateULID(),
      session_id: site.sessionId,
      trace_id: site.traceId,
      span_id: generateSpanId(),
      principal_id: "dyfj-workbench",
      principal_type: "service" as const,
      authz_basis: this.#auth.authzBasis,
      authn_status: this.#auth.authnStatus,
      authn_mechanism: this.#auth.authnMechanism,
      authn_issuer_ref: this.#auth.authnIssuerRef,
    };
  }

  // Best-effort and not awaited by the turn: an answer stands whether or not
  // its record is written, and a stalled write must not hold the turn. A
  // failure is logged by class, as other best-effort event writes are.
  #recordResolution(
    site: ParkSite,
    approvalId: string,
    toolName: string | null,
    end: {
      by: Resolution["by"];
      verdict: "approved" | "denied" | "cancelled";
    },
  ): Promise<void> {
    const base = this.#serviceFields(site);
    const fields = end.by === "operator"
      ? {
        ...base,
        principal_id: "user",
        principal_type: "human" as const,
        action: "decide",
      }
      : { ...base, action: "enforce" };
    return writeMaybe(() =>
      this.#writeEvent(approvalResolvedEvent({
        ...fields,
        permission_verdict: end.verdict,
        resource: approvalId,
        tool_name: toolName,
        content: JSON.stringify({ approvalId, resolution: end.by }),
      })), true);
  }
}
