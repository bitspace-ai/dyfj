// Headless turns: turns the runtime starts itself, with no client connection.
// They run over the same turn core as the `turn` RPC (`rpc/turn-core.ts`), with
// two different seams: the frame sink keeps only the session it learns from
// the turn's `sessionStart` event, and the approver parks each approval
// request in `ParkedApprovals` against that session until the operator answers
// it (`approvals/answer`). A request raised before the session is announced, or
// one whose park cannot be recorded, is denied instead. Text deltas have no
// reader; the turn's events are in the log.
//
// This is a runtime service, not an RPC method. Nothing starts a headless turn
// yet; a coordinator's dispatch tools are its intended caller.

import type {
  FrameSink,
  SessionOwners,
  TurnRequestBody,
  TurnTicket,
  WorkbenchRuntimeResult,
} from "../engine/mod.ts";
import type { ParkedApprovals, ParkSite } from "./parked-approvals.ts";
import { approverOver } from "./rpc/approval.ts";
import { buildTurnCore, type TurnCoreDeps } from "./rpc/turn-core.ts";

export interface HeadlessTurn {
  /** The turn's cancel signal. */
  ticket: TurnTicket;
  /**
   * The turn's session id, once the runtime announces it. Rejects if the turn
   * ends before its session starts.
   */
  session: Promise<string>;
  /** The turn's receipt. */
  result: Promise<WorkbenchRuntimeResult>;
}

export interface HeadlessTurns {
  start(body: TurnRequestBody): HeadlessTurn | { error: string };
}

export interface HeadlessTurnDeps extends TurnCoreDeps {
  parkedApprovals: ParkedApprovals;
}

const PARK_FAILED = "the approval request could not be parked for the operator";

export function buildHeadlessTurns(deps: HeadlessTurnDeps): HeadlessTurns {
  const core = buildTurnCore(deps);
  const parked = deps.parkedApprovals;
  return {
    start: (body) => {
      const resolved = core.resolve(body);
      if ("error" in resolved) return resolved;
      const ticket = deps.owners.admit();

      // Written only by this turn's sink, from its `sessionStart` event; read
      // by its approver. A request raised before the session is known cannot
      // be parked against it, and is denied.
      let site: ParkSite | undefined;
      let announce!: (sessionId: string) => void;
      let unannounced!: (error: Error) => void;
      const session = new Promise<string>((resolve, reject) => {
        announce = resolve;
        unannounced = reject;
      });
      // Observed here, so a turn that never announces does not leave an
      // unhandled rejection behind.
      session.catch(() => {});

      const frames: FrameSink = {
        onRuntimeEvent: (event) => {
          if (event.type !== "sessionStart") return;
          site = { sessionId: event.sessionId, traceId: event.traceId };
          announce(event.sessionId);
        },
      };
      const approver = approverOver(
        (request, signal) =>
          site === undefined
            ? Promise.reject(new Error("no session to park against"))
            : parked.park(site, request, signal),
        ticket,
        { tool: PARK_FAILED, budget: PARK_FAILED },
      );

      const result = core.run(resolved, { ticket, approver, frames });
      void result.then(
        () => unannounced(new Error("the turn ended before its session started")),
        () => unannounced(new Error("the turn failed before its session started")),
      );
      return { ticket, session, result };
    },
  };
}
