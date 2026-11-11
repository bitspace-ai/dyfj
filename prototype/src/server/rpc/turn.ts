// The `turn` namespace: `turn` runs one agentic turn on this connection and
// `turn/cancel` cancels it. Approvals go to the connected client as
// server-initiated `approval` requests; text deltas and runtime events go
// back as `stream` notifications. The turn itself runs in the turn core
// (`turn-core.ts`); this binding supplies the connection's approver and sink.

import {
  isSupersedingRetryStarted,
  type TurnStreamFrame,
  type WorkbenchRuntimeEvent,
} from "../../contract/mod.ts";
import {
  type FrameSink,
  isValidTurnId,
  type TurnRequestBody,
  type TurnTicket,
} from "../../engine/mod.ts";
import {
  asRecord,
  type RpcContext,
  RpcError,
  RpcErrorCode,
  type RpcHandlers,
} from "../../transport/mod.ts";
import { approverOver } from "./approval.ts";
import {
  buildTurnCore,
  type TurnApprover,
  type TurnCoreDeps,
} from "./turn-core.ts";

export type { TurnPosture } from "./turn-core.ts";

/**
 * Delivers out-of-band session-scoped runtime notices (such as a child
 * session parking on an approval) to the clients of `sessionId` it knows:
 * each client running a turn there gets the notice once, through its turn's
 * sink, and each other connection that has run a turn there (`bindPeer`, the
 * 64 most recent) gets it as a `stream` notification. A connection that has
 * not yet run a turn on the session is not known and gets nothing.
 */
export interface SessionEventHub {
  emit(sessionId: string, event: WorkbenchRuntimeEvent): void;
  attachTurn(
    sessionId: string,
    ctx: RpcContext,
    sink: (event: WorkbenchRuntimeEvent) => void,
  ): () => void;
  bindPeer(ctx: RpcContext, sessionId: string): void;
}

const MAX_IDLE_SESSION_PEERS = 64;

export function createSessionEventHub(): SessionEventHub {
  const activeSinks = new Map<
    string,
    Map<RpcContext, (event: WorkbenchRuntimeEvent) => void>
  >();
  const peerSessions = new Map<RpcContext, string>();

  return {
    attachTurn(sessionId, ctx, sink) {
      let sinks = activeSinks.get(sessionId);
      if (sinks === undefined) {
        sinks = new Map();
        activeSinks.set(sessionId, sinks);
      }
      sinks.set(ctx, sink);
      return () => {
        const current = activeSinks.get(sessionId);
        if (current === undefined || current.get(ctx) !== sink) return;
        current.delete(ctx);
        if (current.size === 0) activeSinks.delete(sessionId);
      };
    },
    bindPeer(ctx, sessionId) {
      peerSessions.delete(ctx);
      peerSessions.set(ctx, sessionId);
      while (peerSessions.size > MAX_IDLE_SESSION_PEERS) {
        const oldest = peerSessions.keys().next().value;
        if (oldest === undefined) break;
        peerSessions.delete(oldest);
      }
    },
    emit(sessionId, event) {
      const sinks = activeSinks.get(sessionId);
      for (const sink of [...(sinks?.values() ?? [])]) {
        try {
          sink(event);
        } catch {
          // A broken sink never blocks delivery to other listeners.
        }
      }
      for (const [ctx, boundSessionId] of [...peerSessions.entries()]) {
        if (boundSessionId !== sessionId || sinks?.has(ctx) === true) continue;
        ctx.notify(
          "stream",
          { t: "event", event } satisfies TurnStreamFrame,
        ).catch(() => {
          peerSessions.delete(ctx);
        });
      }
    },
  };
}

export interface TurnHandlerDeps extends TurnCoreDeps {
  sessionEvents?: SessionEventHub;
}

// The turn's approver: each decision goes to the connected client as a
// server-initiated `approval` request, bounded by the turn's cancel signal.
// A failed request (no client approver, dropped connection) denies,
// fail-closed.
function clientApprover(ctx: RpcContext, activeTurn: TurnTicket): TurnApprover {
  return approverOver(
    (request, signal) => ctx.request("approval", request, signal),
    activeTurn,
    {
      tool: "approval request failed (no client approver?)",
      budget: "budget ceiling approval failed (no client approver?)",
    },
  );
}

// The turn's frame sink: text deltas and runtime events go back to the
// connected client as `stream` notifications, tagged with the request's turn
// id when it named one.
function streamFrames(ctx: RpcContext, turnId: string | undefined): FrameSink {
  const tag = turnId === undefined ? {} : { turnId };
  // A client that drops mid-turn makes every subsequent notify reject.
  // Deltas and status events are best-effort, so their send failures are
  // swallowed and logged once per turn rather than once per frame (a
  // tool-heavy turn would otherwise flood the log). The superseding-retry
  // signal is the exception — handled fail-closed below.
  let streamNotifyFailureLogged = false;
  const noteStreamNotifyFailure = (err: unknown): void => {
    if (streamNotifyFailureLogged) return;
    streamNotifyFailureLogged = true;
    // Log the error's class, not its message: a Unix-socket write error can
    // carry the socket path, and this warning channel is path-free by
    // convention. Sends continue best-effort; only repeated warnings are
    // suppressed this turn.
    const kind = err instanceof Error ? err.name : "unknown";
    console.warn(
      `stream notify failed (${kind}) — client likely disconnected; ` +
        `further failures this turn will not be logged`,
    );
  };
  return {
    // Stream frames carry the shared TurnStreamFrame union — one wire
    // shape for clients to consume. Deltas are
    // best-effort: a dropped one costs some rendered text, not correctness,
    // so the notify promise is observed (not left to reject unhandled) but
    // its failure is only logged, never surfaced to the runtime.
    onTextDelta: (text) => {
      ctx.notify(
        "stream",
        { t: "delta", text, ...tag } satisfies TurnStreamFrame,
      ).catch(noteStreamNotifyFailure);
    },
    // Safety-critical signals are the events whose delivery the runtime
    // must observe: a superseding retry resets rendered text, while an
    // unparsed-markup warning prevents an unqualified success. Their send
    // failures are returned so the runtime can fail closed. Every other
    // runtime event is a fire-and-forget notification — a failed send is
    // nothing to report, and returning its rejection would only make the
    // runtime's best-effort emitter warn once per event (a flood on a
    // tool-heavy turn after the client drops). So swallow those, logging once.
    onRuntimeEvent: (event) => {
      const sent = ctx.notify(
        "stream",
        { t: "event", event, ...tag } satisfies TurnStreamFrame,
      );
      if (
        isSupersedingRetryStarted(event) ||
        event.type === "unparsedToolCallMarkupDetected"
      ) return sent;
      return sent.catch(noteStreamNotifyFailure);
    },
  };
}

// The `turn` method: run an agentic turn over the engine's shared turn entry —
// lock/resume/clearance/paid — streaming intermediate text
// deltas and runtime events back as `stream` notifications on this connection.
// The final receipt is the RPC result; errors propagate as RPC errors.
export function buildTurnHandlers(deps: TurnHandlerDeps): RpcHandlers {
  // The engine's session owners: turn locks, budget scopes and cancel
  // signals. The connection map below only records which turn each
  // connection is running.
  const { owners } = deps;
  const core = buildTurnCore(deps);
  const activeTurns = new Map<RpcContext, Map<string, TurnTicket>>();

  return {
    turn: async (params, ctx) => {
      const resolved = core.resolve(asRecord(params) as TurnRequestBody);
      if ("error" in resolved) {
        throw new RpcError(RpcErrorCode.invalidParams, resolved.error);
      }
      const turnId = resolved.runtimeInput.turnId;
      const activeKey = turnId ?? crypto.randomUUID();
      const activeTurn = owners.admit();
      let contextTurns = activeTurns.get(ctx);
      if (contextTurns?.size) {
        throw new RpcError(
          RpcErrorCode.invalidParams,
          "connection already has an active turn",
        );
      }
      if (contextTurns === undefined) {
        contextTurns = new Map();
        activeTurns.set(ctx, contextTurns);
      }
      contextTurns.set(activeKey, activeTurn);
      const baseFrames = streamFrames(ctx, turnId);
      let detachSessionEvents = () => {};
      let boundSessionId: string | undefined;
      const bindSession = (sessionId: string) => {
        if (boundSessionId === sessionId) return;
        boundSessionId = sessionId;
        deps.sessionEvents?.bindPeer(ctx, sessionId);
        detachSessionEvents();
        if (deps.sessionEvents !== undefined) {
          detachSessionEvents = deps.sessionEvents.attachTurn(
            sessionId,
            ctx,
            (event) => {
              void baseFrames.onRuntimeEvent?.(event);
            },
          );
        }
      };
      if (resolved.sessionId !== undefined) {
        bindSession(resolved.sessionId);
      }
      const frames: FrameSink = {
        onTextDelta: baseFrames.onTextDelta,
        onRuntimeEvent: (event) => {
          if (event.type === "sessionStart") {
            bindSession(event.sessionId);
          }
          return baseFrames.onRuntimeEvent?.(event);
        },
      };
      try {
        return await core.run(resolved, {
          ticket: activeTurn,
          approver: clientApprover(ctx, activeTurn),
          frames,
        });
      } finally {
        detachSessionEvents();
        const contextTurns = activeTurns.get(ctx);
        if (contextTurns?.get(activeKey) === activeTurn) {
          contextTurns.delete(activeKey);
          if (contextTurns.size === 0) activeTurns.delete(ctx);
        }
      }
    },
    "turn/cancel": (params, ctx) => {
      const turnId = asRecord(params).turnId;
      if (!isValidTurnId(turnId)) {
        throw new RpcError(
          RpcErrorCode.invalidParams,
          "turnId must be a UUID",
        );
      }
      const activeTurn = activeTurns.get(ctx)?.get(turnId);
      if (activeTurn === undefined || !activeTurn.cancel()) {
        return { cancelled: false, reason: "no_active_turn" };
      }
      return { cancelled: true };
    },
  };
}
