// The turn core: resolve a turn request and run it over the engine's shared
// turn entry, with the approver and frame sink its caller passes in. It holds
// no reference to an RPC connection, so a turn the runtime starts itself can
// run with no client attached. The `turn` RPC (`turn.ts`) is one caller: it
// passes an approver and a sink that reach the connected client.

import type { Env, PermissionLevel } from "../../config/mod.ts";
import { DomainError, type WorkbenchAuthContext } from "../../contract/mod.ts";
import {
  describeErrorForLog,
  engineConfigToTurnDeps,
  executeTurn,
  type FrameSink,
  type ResolvedTurn,
  resolveTurnFromBody,
  type SessionOwners,
  type TurnRequestBody,
  type TurnRuntime,
  type TurnTicket,
  UnexpectedTurnError,
  type WorkbenchRuntimeResult,
} from "../../engine/mod.ts";
import type { CommandDefinition } from "../../tools/mod.ts";
import type { TurnApprover } from "./approval.ts";
import type { FetchSessionEvents } from "./events.ts";

export type { TurnApprover } from "./approval.ts";

/** The engine posture a turn inherits when its request does not set it. */
export interface TurnPosture {
  /** Loaded engine config; when present, the loose fields below are unused. */
  engineConfig?: Parameters<typeof engineConfigToTurnDeps>[0];
  defaultCompanionModel?: string | null;
  permissionLevel?: PermissionLevel;
}

export interface TurnCoreDeps extends TurnPosture {
  /** The engine's session owners, shared with the runtime the turns run. */
  owners: SessionOwners;
  runRuntime: TurnRuntime;
  fetchSessionEvents: FetchSessionEvents;
  /** Boot-discovered external MCP commands available to each turn. */
  externalMcpCommands?: readonly CommandDefinition[];
  /** Where the turn's env-derived defaults are read; the process env when omitted. */
  env?: Env;
  /**
   * Close an idle external-agent handle for the session a one-shot turn just
   * ran. The composition root passes the session map. Absent, the request's
   * release flag does not free a slot.
   */
  releaseExternalAgentSession?: (sessionId: string) => Promise<void>;
  /**
   * The runtime's parked approvals. A turn that names a session with an
   * approval waiting is refused: text sent to that session must never stand
   * in for the operator's answer, which only `approvals/answer` gives.
   */
  parkedApprovals?: { hasPending(sessionId: string): boolean };
  /**
   * Sessions with a turn the runtime started itself in flight. A turn naming
   * one while it is marked is refused rather than queued behind it, where the
   * operator's prompt would wait on an approval it has to answer.
   */
  headlessSessions?: { has(sessionId: string): boolean };
}


/**
 * What the caller of one turn supplies. The caller admits the ticket from the
 * shared owners, so it can route a cancel to it; the approver answers the
 * turn's decisions; the sink receives its text deltas and runtime events.
 */
export interface TurnSeams {
  ticket: TurnTicket;
  approver: TurnApprover;
  frames: FrameSink;
}

export interface TurnCore {
  /** Resolve a request body against the engine posture. */
  resolve(body: TurnRequestBody): ResolvedTurn | { error: string };
  /** Run a resolved turn with the caller's seams; the result is the receipt. */
  run(resolved: ResolvedTurn, seams: TurnSeams): Promise<WorkbenchRuntimeResult>;
}

// UDS is the canonical loopback transport: a connection is authenticated by the
// OS as the local user via the socket's filesystem permissions (the 0700 parent
// dir owned by the operator), and carries full loopback clearance. Paid
// escalation and budget overrides therefore remain available — but, exactly as
// on the HTTP loopback path, only with an explicit per-turn opt-in in the params
//; the shared turn core enforces that, not this binding. This core runs every
// turn under this posture: the `turn` RPC's and the runtime's headless turns
// (`../headless-turn.ts`).
export const UDS_LOOPBACK_AUTH: WorkbenchAuthContext = {
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

/**
 * Why a turn naming a session whose running turn is waiting for the
 * operator's approval is refused. Its text is not delivered: an answer is
 * given only through `approvals/answer`.
 */
function sessionAwaitingApproval(sessionId: string): string {
  return `session ${sessionId} is waiting for approval; nothing was sent. ` +
    `Answer it from the session: dyfj --session ${sessionId}`;
}

/**
 * Why a turn naming a session that is running a turn the runtime started is
 * refused. Queued behind it, the prompt would wait on that turn's approvals
 * while holding the client that has to answer them.
 */
function sessionRunningHeadless(sessionId: string): string {
  return `session ${sessionId} is running a turn the runtime started; ` +
    `nothing was sent. Its approvals are asked in the session: ` +
    `dyfj --session ${sessionId}`;
}

export function buildTurnCore(deps: TurnCoreDeps): TurnCore {
  const { owners, runRuntime, fetchSessionEvents } = deps;
  const engineDeps = resolveEngineTurnDeps(deps);

  return {
    resolve: (body) => {
      const resolved = resolveTurnFromBody(body, true, {
        approvePaidDefault: engineDeps.approvePaidDefault,
        trustWorkspaceInstructions: engineDeps.trustWorkspaceInstructions,
        maxToolSteps: engineDeps.maxToolSteps,
        maxToolStepsCeiling: engineDeps.maxToolStepsCeiling,
      });
      // Refused before the caller admits it, so nothing is queued behind the
      // waiting turn.
      if ("error" in resolved || resolved.sessionId === undefined) {
        return resolved;
      }
      if (deps.parkedApprovals?.hasPending(resolved.sessionId) === true) {
        return { error: sessionAwaitingApproval(resolved.sessionId) };
      }
      if (deps.headlessSessions?.has(resolved.sessionId) === true) {
        return { error: sessionRunningHeadless(resolved.sessionId) };
      }
      return resolved;
    },
    run: async (resolved, { ticket, approver, frames }) => {
      try {
        return await executeTurn(resolved, {
          owners,
          ticket,
          ...(deps.env === undefined ? {} : { env: deps.env }),
          authContext: UDS_LOOPBACK_AUTH,
          loopback: true,
          runRuntime,
          fetchSessionEvents,
          ...engineDeps,
          externalMcpCommands: deps.externalMcpCommands,
          approver,
          frames,
          ...(deps.releaseExternalAgentSession === undefined
            ? {}
            : {
              releaseExternalAgentSession: deps.releaseExternalAgentSession,
            }),
        });
      } catch (error) {
        // A DomainError states its condition and crosses the wire as its
        // message. Anything else would reach the caller as `[Error, N bytes]`
        // with no next step: this is the one seam every turn crosses, so the
        // log gets its class here, and its code when it has one, and the
        // caller a stated condition.
        if (error instanceof DomainError) throw error;
        console.error(`[turn-error] ${describeErrorForLog(error)}`);
        throw new UnexpectedTurnError(error);
      }
    },
  };
}
