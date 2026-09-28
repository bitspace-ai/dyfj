/**
 * The `openSession` stage (specs/01-architecture.md §5.1): create or continue
 * a session, fix the turn's identity, principal, budget and configuration,
 * announce the turn, and write its `session_start` event.
 *
 * `session_start` is an integrity event: if it cannot be written the turn
 * fails before any other stage runs, with nothing further recorded. The
 * session row itself is written by `recordNewSession` once the context
 * sources it lists are known.
 */
import {
  generateSpanId,
  generateTraceId,
  generateULID,
} from "../kernel/mod.ts";
import {
  buildWorkbenchSessionContent,
  buildWorkbenchSessionSlug,
  createWorkbenchSession,
  fetchWorkbenchSessionWorkspace,
  sessionStartEvent,
} from "../store/mod.ts";
import { BudgetTracker, fetchSpendBaselines } from "../budget/mod.ts";
import {
  AGENT_DEFAULTS,
  ANOMALY_DEFAULTS,
  BUDGET_DEFAULTS,
} from "../config/mod.ts";
import {
  type WorkbenchAuthContext,
  workspaceRootForTransport,
} from "../contract/mod.ts";
import { writeMaybe } from "./event-writes.ts";
import { isNextWorkMode } from "./route.ts";
import { emitRuntimeEvent } from "./runtime-events.ts";
import type { WorkbenchRuntimeInput } from "./runtime-types.ts";
import {
  commitEvent,
  type NativeTurnPorts,
  type TurnSession,
  type TurnState,
} from "./turn-state.ts";

// Hard ceiling for the startup-configured model<->tool iterations in a single
// turn. Bounds cost and guarantees termination if a model keeps requesting
// tools; on the final permitted step the runtime drops tools to force a
// concluding answer. The default is AGENT_DEFAULTS.maxToolSteps; no unlimited
// mode exists.
export const MAX_TOOL_STEPS = 64;

function effectiveMaxToolSteps(value: number | undefined): number {
  if (
    value === undefined || !Number.isFinite(value) || !Number.isInteger(value)
  ) {
    return AGENT_DEFAULTS.maxToolSteps;
  }
  return Math.min(MAX_TOOL_STEPS, Math.max(1, value));
}

// Direct CLI invocation is authenticated by the local OS session; transport
// layers (HTTP bearer auth) override this with the caller's real context.
const LOCAL_AUTH_CONTEXT: WorkbenchAuthContext = {
  transport: "loopback",
  authnStatus: "authenticated",
  authnMechanism: "local_user",
  authnIssuerRef: "local_os",
  authzBasis: "user_consent",
};

/** The turn's budget envelopes and anomaly multiples, in precedence order. */
function budgetPosture(
  input: WorkbenchRuntimeInput,
): Pick<TurnSession, "budgetConfig" | "anomalyConfig"> {
  return {
    // Precedence: per-turn override → boundary-resolved default (from the
    // declared config surface) → the declared BUDGET_DEFAULTS. The core reads
    // no env; the boundary (resolveRuntimeEnvDefaults) resolves DYFJ_BUDGET_*
    // once. The HTTP boundary only populates the per-turn overrides for
    // loopback callers.
    budgetConfig: {
      sessionLimitUsd: input.sessionLimitUsd ??
        input.defaultSessionBudgetUsd ?? BUDGET_DEFAULTS.sessionLimitUsd,
      perCallLimitUsd: input.perCallLimitUsd ??
        input.defaultPerCallBudgetUsd ?? BUDGET_DEFAULTS.perCallLimitUsd,
      dailyLimitUsd: input.dailyLimitUsd ??
        input.defaultDailyBudgetUsd ?? BUDGET_DEFAULTS.dailyLimitUsd,
    },
    // The multiples have no per-turn override lane (boundary-resolved config
    // or the declared defaults only); the dollar thresholds derive from
    // budgetConfig above, so they track the envelope in force — including an
    // explicit loopback per-turn budget override, which is the operator
    // speaking, not a request weakening the gate relative to the envelopes.
    anomalyConfig: {
      turnMultiple: input.anomalyTurnMultiple ?? ANOMALY_DEFAULTS.turnMultiple,
      scopeMultiple: input.anomalyScopeMultiple ??
        ANOMALY_DEFAULTS.scopeMultiple,
    },
  };
}

/**
 * The workspace the turn asked for, gated by transport. The `dyfj` client
 * sends its cwd only when CREATING a session; it is persisted on the session
 * row and read back here on resume. A loopback operator may steer the root;
 * remote callers are pinned to the server default, so a crafted workspace can
 * never aim the file tools at arbitrary host paths.
 */
async function requestedWorkspace(
  input: WorkbenchRuntimeInput,
  sessionId: string,
  resumingSession: boolean,
  authContext: WorkbenchAuthContext,
  ports: NativeTurnPorts,
): Promise<{ honored: string | undefined; lookupFailed: boolean }> {
  let requested = input.workspaceRoot;
  // A stored null means "this session never selected a workspace" and the
  // default root is legitimately its root. A FAILED lookup means the
  // session's selected workspace is unknown — the file tools still fall
  // back, but instruction elevation must treat it like a failed resolution
  // rather than silently rebinding authority to the fallback root.
  let lookupFailed = false;
  if (resumingSession && requested === undefined) {
    try {
      requested = (await fetchWorkbenchSessionWorkspace({
        sessionId,
        sessions: ports.store.sessions,
      })) ?? undefined;
    } catch {
      lookupFailed = true;
    }
  }
  return {
    honored: workspaceRootForTransport(requested, authContext.transport),
    lookupFailed,
  };
}

/** Open the turn: everything up to and including `session_start`. */
export async function openSession(
  input: WorkbenchRuntimeInput,
  ports: NativeTurnPorts,
): Promise<TurnSession> {
  const resumingSession = input.sessionId !== undefined;
  const sessionId = input.sessionId ?? generateULID();
  const traceId = generateTraceId();
  const startedAt = ports.clock.now();
  // Resolved before the BudgetTracker so its budget_summary event is
  // attributed to the same principal.
  const principalId = input.principalId ?? "user";
  const posture = budgetPosture(input);
  // Seed the envelopes with spend already on the books: this session's prior
  // turns and today's spend across all sessions. Injectable for tests.
  const fetchBaselines = input.fetchSpendBaselines ??
    ((id: string) => fetchSpendBaselines(ports.store.spend, id));
  const budget = new BudgetTracker(
    sessionId,
    traceId,
    posture.budgetConfig,
    principalId,
    await fetchBaselines(sessionId),
  );
  const authContext = input.authContext ?? LOCAL_AUTH_CONTEXT;
  // DYFJ_ROOT is resolved at the boundary; the core only falls back to the
  // process cwd when no root was supplied.
  const fallbackRoot = input.rootOverride ?? Deno.cwd();
  const workspace = await requestedWorkspace(
    input,
    sessionId,
    resumingSession,
    authContext,
    ports,
  );
  const isNextWork = isNextWorkMode(input.mode);
  const session: TurnSession = {
    mode: input.mode,
    prompt: input.prompt,
    resumingSession,
    sessionId,
    sessionSlug: buildWorkbenchSessionSlug(sessionId),
    traceId,
    turnRootSpanId: generateSpanId(),
    startedAt,
    principalId,
    authContext,
    authnEventFields: {
      authn_status: authContext.authnStatus,
      authn_mechanism: authContext.authnMechanism,
      authn_issuer_ref: authContext.authnIssuerRef,
    },
    ...posture,
    fetchBaselines,
    budget,
    isNextWork,
    usesRepoAskContext: input.mode === "ask" || isNextWork,
    workletId: isNextWork ? "next-work.v0" : undefined,
    maxToolSteps: effectiveMaxToolSteps(input.maxToolSteps),
    fallbackRoot,
    honoredWorkspace: workspace.honored,
    workspaceLookupFailed: workspace.lookupFailed,
    // Silent by default: narration renders only where a presenter is injected.
    log: input.log ?? (() => {}),
  };
  await announceTurn(session, input, ports);
  return session;
}

/** Narrate and emit the turn's start, then write `session_start`. */
async function announceTurn(
  session: TurnSession,
  input: WorkbenchRuntimeInput,
  ports: NativeTurnPorts,
): Promise<void> {
  session.log("DYFJ Workbench\n");
  await emitRuntimeEvent(input.onRuntimeEvent, {
    type: "sessionStart",
    sessionId: session.sessionId,
    traceId: session.traceId,
    mode: session.mode,
  });
  await emitRuntimeEvent(input.onRuntimeEvent, {
    type: "inputReceived",
    sessionId: session.sessionId,
    promptLength: session.prompt.length,
  });
  // Integrity: a failed write fails the turn.
  await writeMaybe(() =>
    commitEvent(
      ports.store,
      sessionStartEvent({
        event_id: generateULID(),
        session_id: session.sessionId,
        trace_id: session.traceId,
        span_id: session.turnRootSpanId,
        principal_id: session.principalId,
        principal_type: "human",
        action: "start",
        resource: "workbench_session",
        authz_basis: session.authContext.authzBasis,
        ...session.authnEventFields,
        // The operator's prompt rides on session_start so a conversation
        // transcript can be rebuilt from events alone (resume, inspector).
        content: session.prompt,
      }),
    ), false);
}

/**
 * Create the session row for a new session, bound to its workspace (honored
 * only for loopback; resumes read it back instead of the client re-sending
 * cwd). An integrity write: its failure fails the turn.
 */
export async function recordNewSession(
  state: TurnState,
  ports: NativeTurnPorts,
): Promise<void> {
  const { session } = state;
  if (session.resumingSession) return;
  await state.audit.writeIntegrity(() =>
    createWorkbenchSession({
      journal: ports.store.journal,
      sessionId: session.sessionId,
      slug: session.sessionSlug,
      taskDescription: session.prompt,
      workspace: session.honoredWorkspace,
      content: buildWorkbenchSessionContent({
        mode: session.mode,
        prompt: session.prompt,
        traceId: session.traceId,
        contextSources: state.contextSourceLines,
      }),
    })
  );
}
