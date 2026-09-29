// The `turn` namespace: `turn` runs one agentic turn on this connection and
// `turn/cancel` cancels it. Approvals go to the connected client as
// server-initiated `approval` requests; text deltas and runtime events go
// back as `stream` notifications.

import {
  budgetCeilingApprovalRequest,
  type BudgetCeilingVerdict,
  runawayAnomalyApprovalRequest,
} from "../../budget/mod.ts";
import type { Env, PermissionLevel } from "../../config/mod.ts";
import {
  type AcpPermissionSelection,
  isSupersedingRetryStarted,
  type TurnStreamFrame,
  type WorkbenchAuthContext,
} from "../../contract/mod.ts";
import {
  engineConfigToTurnDeps,
  executeTurn,
  type ExecuteTurnDeps,
  type FrameSink,
  isValidTurnId,
  resolveTurnFromBody,
  type SessionOwners,
  type TurnRequestBody,
  type TurnRuntime,
  type TurnTicket,
} from "../../engine/mod.ts";
import type {
  CommandDefinition,
  ToolApprovalVerdict,
} from "../../tools/mod.ts";
import {
  type RpcContext,
  RpcError,
  RpcErrorCode,
  type RpcHandlers,
} from "../../transport/mod.ts";
import {
  approvalWasAborted,
  rejectedAcpPermissionSelection,
  terminalAcpToolKind,
  toAcpPermissionSelection,
  toApprovalVerdict,
  toBudgetCeilingVerdict,
} from "./approval.ts";
import type { FetchSessionEvents } from "./events.ts";
import { asRecord } from "./params.ts";

/** The engine posture a turn inherits when its request does not set it. */
export interface TurnPosture {
  /** Loaded engine config; when present, the loose fields below are unused. */
  engineConfig?: Parameters<typeof engineConfigToTurnDeps>[0];
  defaultCompanionModel?: string | null;
  permissionLevel?: PermissionLevel;
}

export interface TurnHandlerDeps extends TurnPosture {
  /** The engine's session owners, shared with the runtime the turns run. */
  owners: SessionOwners;
  runRuntime: TurnRuntime;
  fetchSessionEvents: FetchSessionEvents;
  /** Boot-discovered external MCP commands available to each turn. */
  externalMcpCommands?: readonly CommandDefinition[];
  /** Where the turn's env-derived defaults are read; the process env when omitted. */
  env?: Env;
}

// UDS is the canonical loopback transport: a connection is authenticated by the
// OS as the local user via the socket's filesystem permissions (the 0700 parent
// dir owned by the operator), and carries full loopback clearance. Paid
// escalation and budget overrides therefore remain available — but, exactly as
// on the HTTP loopback path, only with an explicit per-turn opt-in in the params
//; the shared turn core enforces that, not this binding.
const UDS_LOOPBACK_AUTH: WorkbenchAuthContext = {
  transport: "loopback",
  authnStatus: "authenticated",
  authnMechanism: "local_user",
  authnIssuerRef: "local_os",
  authzBasis: "policy:loopback-uds",
};

function resolveEngineTurnDeps(
  options: TurnPosture,
): ReturnType<typeof engineConfigToTurnDeps> {
  if (options.engineConfig !== undefined) {
    return engineConfigToTurnDeps(options.engineConfig);
  }
  return {
    defaultCompanionModel: options.defaultCompanionModel,
    permissionLevel: options.permissionLevel,
  };
}

type TurnApprover = NonNullable<ExecuteTurnDeps["approver"]>;

// The turn's approver: each decision goes to the connected client as a
// server-initiated `approval` request, bounded by the turn's cancel signal.
function clientApprover(ctx: RpcContext, activeTurn: TurnTicket): TurnApprover {
  const abortIfApprovalWasInterrupted = (response: unknown): void => {
    if (!approvalWasAborted(response)) return;
    activeTurn.abort();
    throw activeTurn.signal.reason;
  };
  const rejectStaleApprovalAfterCancellation = (): void => {
    if (activeTurn.signal.aborted) {
      throw activeTurn.signal.reason;
    }
  };
  const requestApproval = (
    request: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> =>
    ctx.request(
      "approval",
      request,
      signal === undefined
        ? activeTurn.signal
        : AbortSignal.any([activeTurn.signal, signal]),
    );
  return {
    // mid-turn approval over the duplex channel — the server asks
    // the connected client to approve a mutating tool or budget ceiling;
    // the client's response is the verdict. A failed request (no client
    // approver, dropped connection) denies, fail-closed.
    confirmToolApproval: (request, signal) =>
      requestApproval(request, signal).then(
        (response) => {
          abortIfApprovalWasInterrupted(response);
          rejectStaleApprovalAfterCancellation();
          return toApprovalVerdict(response);
        },
        (): ToolApprovalVerdict => {
          rejectStaleApprovalAfterCancellation();
          return {
            decision: "deny",
            reason: "approval request failed (no client approver?)",
          };
        },
      ),
    confirmExternalAgentPermission: (prompt, signal) =>
      requestApproval({
        kind: "external_agent_permission",
        title: prompt.toolCall.title,
        arguments: {
          "ACP tool": prompt.toolCall.name ?? "(not supplied)",
          "ACP kind": terminalAcpToolKind(prompt.toolCall.kind),
          "Requested input": prompt.toolCall.inputSummary,
        },
        options: prompt.options,
      }, signal).then(
        (response) => {
          abortIfApprovalWasInterrupted(response);
          rejectStaleApprovalAfterCancellation();
          return toAcpPermissionSelection(response, prompt);
        },
        (): AcpPermissionSelection => {
          rejectStaleApprovalAfterCancellation();
          return rejectedAcpPermissionSelection(prompt);
        },
      ),
    confirmBudgetCeiling: (warning) =>
      requestApproval(budgetCeilingApprovalRequest(warning)).then(
        (response) => {
          abortIfApprovalWasInterrupted(response);
          rejectStaleApprovalAfterCancellation();
          return toBudgetCeilingVerdict(response);
        },
        (): BudgetCeilingVerdict => {
          rejectStaleApprovalAfterCancellation();
          return {
            decision: "deny",
            reason: "budget ceiling approval failed (no client approver?)",
          };
        },
      ),
    confirmRunawayAnomaly: (warning) =>
      requestApproval(runawayAnomalyApprovalRequest(warning))
        .then(
          (response) => {
            abortIfApprovalWasInterrupted(response);
            rejectStaleApprovalAfterCancellation();
            return toBudgetCeilingVerdict(
              response,
              "operator declined the anomaly halt",
            );
          },
          (): BudgetCeilingVerdict => {
            rejectStaleApprovalAfterCancellation();
            return {
              decision: "deny",
              reason: "anomaly halt approval failed (no client approver?)",
            };
          },
        ),
  };
}

// The turn's frame sink: text deltas and runtime events go back to the
// connected client as `stream` notifications.
function streamFrames(ctx: RpcContext): FrameSink {
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
        { t: "delta", text } satisfies TurnStreamFrame,
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
        { t: "event", event } satisfies TurnStreamFrame,
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
  const { owners, runRuntime, fetchSessionEvents } = deps;
  const engineDeps = resolveEngineTurnDeps(deps);
  const activeTurns = new Map<RpcContext, Map<string, TurnTicket>>();

  return {
    turn: async (params, ctx) => {
      const resolved = resolveTurnFromBody(
        asRecord(params) as TurnRequestBody,
        true,
        {
          approvePaidDefault: engineDeps.approvePaidDefault,
          trustWorkspaceInstructions: engineDeps.trustWorkspaceInstructions,
        },
      );
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
      try {
        return await executeTurn(resolved, {
          owners,
          ticket: activeTurn,
          ...(deps.env === undefined ? {} : { env: deps.env }),
          authContext: UDS_LOOPBACK_AUTH,
          loopback: true,
          runRuntime,
          fetchSessionEvents,
          ...engineDeps,
          externalMcpCommands: deps.externalMcpCommands,
          approver: clientApprover(ctx, activeTurn),
          frames: streamFrames(ctx),
        });
      } finally {
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
