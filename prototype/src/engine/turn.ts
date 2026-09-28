/**
 * The turn entry (specs/01-architecture.md §5.1): run a resolved turn under
 * its session's lock, rebuild the resumed conversation inside that lock, and
 * hand the runtime its boundary-resolved config and the transport's ports.
 * Every transport runs the identical turn with identical clearance, money and
 * audit behavior; there is exactly one copy of that orchestration, and this
 * is it. Request validation is in `turn-request.ts`; session ownership is in
 * `session-owner.ts`.
 */
import type {
  Approver,
  FrameSink,
  WorkbenchRuntimeInput,
  WorkbenchRuntimeResult,
} from "./runtime-types.ts";
import { buildConversationMessages } from "../context/mod.ts";
import type { CommandDefinition } from "../tools/mod.ts";
import {
  type Env,
  type PermissionLevel,
  processEnv,
  resolveRuntimeEnvDefaults,
  type WorkbenchConfig,
} from "../config/mod.ts";
import type {
  HistoryOmissionProjection,
  WorkbenchAuthContext,
  WorkbenchSessionEvent,
} from "../contract/mod.ts";
import type { SessionOwners, TurnTicket } from "./session-owner.ts";
import { paidEscalationVerdict, type ResolvedTurn } from "./turn-request.ts";

export type TurnRuntime = (
  input: WorkbenchRuntimeInput,
) => Promise<WorkbenchRuntimeResult>;

export type FetchSessionEvents = (
  input: { sessionId: string; asOf?: string },
) => Promise<WorkbenchSessionEvent[]>;

/**
 * Rebuild the resume context (prior turns as conversation messages). Called
 * INSIDE the session's turn lock so the prior-event read happens after all earlier
 * same-session turns have settled — keeping the read-modify-append atomic per
 * session.
 */
async function buildResume(
  sessionId: string | undefined,
  fetchSessionEvents: FetchSessionEvents,
): Promise<
  Partial<
    Pick<
      WorkbenchRuntimeInput,
      | "sessionId"
      | "conversationMessages"
      | "priorExternalSessionId"
      | "historyOmission"
    >
  >
> {
  if (sessionId === undefined) return {};
  const priorEvents = await fetchSessionEvents({ sessionId });
  // The most recent external session this Workbench session ran against.
  // Carried as continuity evidence so a replacement native session can be
  // reported as succeeding a named predecessor rather than appearing from
  // nowhere.
  let priorExternalSessionId: string | undefined;
  for (const event of priorEvents) {
    if (event.runnerExternalSessionId !== null) {
      priorExternalSessionId = event.runnerExternalSessionId;
    }
  }
  let historyOmission: HistoryOmissionProjection | undefined;
  const conversationMessages = buildConversationMessages(priorEvents, {
    onOmission: (omission) => {
      historyOmission = omission;
    },
  });
  return {
    sessionId,
    conversationMessages,
    ...(historyOmission === undefined ? {} : { historyOmission }),
    ...(priorExternalSessionId === undefined ? {} : { priorExternalSessionId }),
  };
}

export interface ExecuteTurnDeps {
  /** The engine's session owners; the turn runs under its session's lock. */
  owners: SessionOwners;
  /**
   * The turn's cancel signal, admitted by `owners` before the call so the
   * transport can route a cancel request to it. Absent, the turn cannot be
   * cancelled.
   */
  ticket?: TurnTicket;
  /** Where the boundary-resolved runtime defaults are read. */
  env?: Env;
  authContext: WorkbenchAuthContext;
  loopback: boolean;
  runRuntime: TurnRuntime;
  fetchSessionEvents: FetchSessionEvents;
  /**
   * The transport's frame sink. A transport's `onRuntimeEvent` may return a
   * promise (the UDS seam returns its notify), so the runtime can await
   * delivery where that matters (the fail-closed safety signals).
   */
  frames?: FrameSink;
  /**
   * The transport's approval handlers: the UDS transport supplies duplex
   * round-trips for tool approval, ACP permission options, budget ceilings
   * and runaway anomalies; HTTP omits them, so the runtime fails closed.
   * Paid escalation is not the transport's to answer: `executeTurn` decides
   * it from the transport's paid verdict.
   */
  approver?: Omit<Approver, "confirmPaidEscalation">;
  externalMcpCommands?: readonly CommandDefinition[];
  /**
   * Engine default companion model (config ~/.dyfj/config.toml / env), loaded
   * once at the boundary and applied when a turn specifies no model/tier/hint.
   */
  defaultCompanionModel?: string | null;
  /** Operator permission posture (config), loaded once at the boundary. */
  permissionLevel?: PermissionLevel;
  /** Standing paid posture (config), applied when the request omits opt-in. */
  approvePaidDefault?: boolean;
  /**
   * Standing operator elevation of workspace AGENTS.md instructions
   * (config, default off). Loopback only — remote transports never inherit.
   */
  trustWorkspaceInstructions?: boolean;
  /** Engine budget defaults (config), resolved once at the boundary. */
  defaultSessionBudgetUsd?: number;
  defaultPerCallBudgetUsd?: number;
  defaultDailyBudgetUsd?: number;
  /** Runaway-anomaly hard-stop multiples (config), resolved once at the boundary. */
  anomalyTurnMultiple?: number;
  anomalyScopeMultiple?: number;
  /** Maximum model↔tool loop steps in one turn (config), resolved once at the boundary. */
  maxToolSteps?: number;
}

/** Thread the loaded engine config into executeTurn deps. */
export function engineConfigToTurnDeps(
  config: Pick<
    WorkbenchConfig,
    | "defaultCompanionModel"
    | "permissionLevel"
    | "approvePaidDefault"
    | "trustWorkspaceInstructions"
    | "defaultSessionBudgetUsd"
    | "defaultPerCallBudgetUsd"
    | "defaultDailyBudgetUsd"
    | "anomalyTurnMultiple"
    | "anomalyScopeMultiple"
    | "maxToolSteps"
  >,
): Pick<
  ExecuteTurnDeps,
  | "defaultCompanionModel"
  | "permissionLevel"
  | "approvePaidDefault"
  | "trustWorkspaceInstructions"
  | "defaultSessionBudgetUsd"
  | "defaultPerCallBudgetUsd"
  | "defaultDailyBudgetUsd"
  | "anomalyTurnMultiple"
  | "anomalyScopeMultiple"
  | "maxToolSteps"
> {
  return {
    defaultCompanionModel: config.defaultCompanionModel,
    permissionLevel: config.permissionLevel,
    approvePaidDefault: config.approvePaidDefault,
    trustWorkspaceInstructions: config.trustWorkspaceInstructions,
    defaultSessionBudgetUsd: config.defaultSessionBudgetUsd,
    defaultPerCallBudgetUsd: config.defaultPerCallBudgetUsd,
    defaultDailyBudgetUsd: config.defaultDailyBudgetUsd,
    anomalyTurnMultiple: config.anomalyTurnMultiple,
    anomalyScopeMultiple: config.anomalyScopeMultiple,
    maxToolSteps: config.maxToolSteps,
  };
}

/**
 * One operational stderr line per completed transport turn: routing and cost
 * facts only — no turn content, no memory or context-source names. Client
 * presentation belongs to clients; the receipt carries the full detail.
 */
export function formatTurnSummaryLine(result: WorkbenchRuntimeResult): string {
  if ("runner" in result) {
    return `[turn] session=${result.sessionId} runner=${result.runner.profile} protocol=${result.runner.protocol} cost_basis=${result.runner.costBasis}`;
  }
  const model = result.model?.slug ?? "unknown";
  const tokens = result.tokens
    ? `${result.tokens.input}in/${result.tokens.output}out`
    : "?";
  const cost = result.cost ? `$${result.cost.totalUsd.toFixed(6)}` : "$?";
  const paid = result.cost?.paidInferenceUsed ? "paid" : "local";
  return `[turn] session=${result.sessionId} model=${model} tokens=${tokens} cost=${cost} ${paid}`;
}

/**
 * Run a resolved turn: per-session lock → resume reconstruction → env-derived
 * runtime config → the runtime, with the paid-escalation verdict bound to the
 * caller's transport + opt-in. Identical for every transport; the caller only
 * supplies the streaming/event callbacks and the auth context.
 */
export function executeTurn(
  resolved: ResolvedTurn,
  deps: ExecuteTurnDeps,
): Promise<WorkbenchRuntimeResult> {
  return deps.owners.runTurn(resolved.sessionId, async () => {
    const resume = await buildResume(
      resolved.sessionId,
      deps.fetchSessionEvents,
    );
    const result = await runExecuteTurn(resolved, deps, resume);
    console.error(formatTurnSummaryLine(result));
    return result;
  });
}

function runExecuteTurn(
  resolved: ResolvedTurn,
  deps: ExecuteTurnDeps,
  resume: Awaited<ReturnType<typeof buildResume>>,
): Promise<WorkbenchRuntimeResult> {
  return deps.runRuntime({
    ...resolved.runtimeInput,
    ...resume,
    // The turn's cancel signal. Only a turn with a client turn id can be
    // cancelled by id, so only that turn reports its cancellation window
    // closing.
    ...(deps.ticket === undefined ? {} : {
      abortSignal: deps.ticket.signal,
      ...(resolved.runtimeInput.turnId === undefined
        ? {}
        : { cancellationWindow: deps.ticket }),
    }),
    // env-derived runtime config resolved at the boundary, not in the
    // core. A future headless driver supplies these from its own config.
    ...resolveRuntimeEnvDefaults(deps.env ?? processEnv),
    // engine default companion model, resolved once at the boundary from config
    defaultCompanionModel: deps.defaultCompanionModel,
    // workspace-instructions elevation: an explicit standing operator
    // decision (config, default off), honored for loopback turns only —
    // selecting a workspace alone never grants its AGENTS.md authority.
    trustWorkspaceInstructions: deps.loopback
      ? deps.trustWorkspaceInstructions ?? false
      : false,
    // operator permission posture, resolved once at the boundary from config
    permissionLevel: deps.permissionLevel,
    // config-file budget defaults override the env-only boundary resolver
    ...(deps.defaultSessionBudgetUsd !== undefined
      ? { defaultSessionBudgetUsd: deps.defaultSessionBudgetUsd }
      : {}),
    ...(deps.defaultPerCallBudgetUsd !== undefined
      ? { defaultPerCallBudgetUsd: deps.defaultPerCallBudgetUsd }
      : {}),
    ...(deps.defaultDailyBudgetUsd !== undefined
      ? { defaultDailyBudgetUsd: deps.defaultDailyBudgetUsd }
      : {}),
    ...(deps.anomalyTurnMultiple !== undefined
      ? { anomalyTurnMultiple: deps.anomalyTurnMultiple }
      : {}),
    ...(deps.anomalyScopeMultiple !== undefined
      ? { anomalyScopeMultiple: deps.anomalyScopeMultiple }
      : {}),
    ...(deps.maxToolSteps !== undefined
      ? { maxToolSteps: deps.maxToolSteps }
      : {}),
    authContext: deps.authContext,
    frames: deps.frames,
    externalMcpCommands: deps.externalMcpCommands,
    approver: {
      // mutating tools, ACP permission options, budget ceilings and runaway
      // anomalies go to the transport's handlers; absent => fail closed.
      confirmToolApproval: deps.approver?.confirmToolApproval,
      confirmExternalAgentPermission: deps.approver
        ?.confirmExternalAgentPermission,
      confirmBudgetCeiling: deps.approver?.confirmBudgetCeiling,
      confirmRunawayAnomaly: deps.approver?.confirmRunawayAnomaly,
      // paid inference is granted only to a loopback caller that
      // explicitly opted in this turn; remote callers are always denied.
      confirmPaidEscalation: () =>
        Promise.resolve(
          paidEscalationVerdict(deps.loopback, resolved.approvePaidInference),
        ),
    },
  });
}
