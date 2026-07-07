// Shared turn execution core. The security-sensitive turn path —
// request resolution, per-session serialization, resume
// reconstruction, paid-escalation gating, and the runtime invocation —
// lifted out of the HTTP driver so EVERY transport (HTTP/SSE in http.ts, the
// JSON-RPC/UDS server in uds-server.ts) runs the IDENTICAL turn with identical
// clearance behavior. There must be exactly one copy of the money/audit/clearance
// orchestration; this is it.

import {
  type PaidEscalationVerdict,
  resolveRuntimeEnvDefaults,
  type WorkbenchAuthContext,
  type WorkbenchRuntimeEvent,
  type WorkbenchRuntimeInput,
  type WorkbenchRuntimeResult,
} from "./workbench";
import { type WorkbenchRoutingOptions } from "./provider";
import {
  buildConversationMessages,
  type WorkbenchSessionEvent,
} from "./sessions";
import type { ConfirmToolApproval } from "./commands";
import type { ConfirmBudgetCeiling } from "./budget";
import type { PermissionLevel, WorkbenchConfig } from "./config";

export type WorkbenchHttpRuntime = (
  input: WorkbenchRuntimeInput,
) => Promise<WorkbenchRuntimeResult>;

export type FetchSessionEvents = (
  input: { sessionId: string; asOf?: string },
) => Promise<WorkbenchSessionEvent[]>;

export interface TurnRequestBody {
  prompt?: unknown;
  mode?: unknown;
  routingOptions?: unknown;
  sessionId?: unknown;
  workspace?: unknown;
  // explicit per-turn paid-inference opt-in + per-turn budget override.
  // Both are honored only on the loopback transport (see resolveTurnFromBody /
  // the confirmPaidEscalation injection).
  approvePaidInference?: unknown;
  budget?: unknown;
}

const SESSION_ID_SHAPE = /^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/;

// paid inference requires BOTH a loopback transport AND that the
// operator explicitly opts in per turn. Remote callers are denied outright; a
// loopback caller that did not opt in is denied with the second reason.
export const PAID_ESCALATION_REMOTE_DENIED =
  "paid inference is not available to remote callers";
export const PAID_ESCALATION_NOT_APPROVED =
  "paid inference was not approved for this turn";

export function paidEscalationVerdict(
  loopback: boolean,
  approved: boolean,
): PaidEscalationVerdict {
  if (loopback && approved) return { decision: "approve" };
  return {
    decision: "deny",
    reason: loopback
      ? PAID_ESCALATION_NOT_APPROVED
      : PAID_ESCALATION_REMOTE_DENIED,
  };
}

/**
 * Per-session turn serialization. Two concurrent turns for the same
 * session would split-brain the append-only event log — each reads the prior
 * events and appends its own — and race the shared Dolt pool. Chain same-session
 * turns so they run one at a time: the operator's second turn runs after the
 * first rather than being dropped. New turns (no sessionId) target fresh
 * sessions and never collide, so they run immediately without serialization.
 */
const sessionTurnChains = new Map<string, Promise<unknown>>();

export function withSessionTurnLock<T>(
  sessionId: string | undefined,
  run: () => Promise<T>,
): Promise<T> {
  if (sessionId === undefined) return run();
  const prior = sessionTurnChains.get(sessionId) ?? Promise.resolve();
  // Run after the prior turn settles, whether it resolved or rejected.
  const result = prior.then(run, run);
  const settled = result.then(() => {}, () => {});
  sessionTurnChains.set(sessionId, settled);
  void settled.finally(() => {
    // Drop the chain once this turn is the tail, so the map does not grow.
    if (sessionTurnChains.get(sessionId) === settled) {
      sessionTurnChains.delete(sessionId);
    }
  });
  return result;
}

function parseRoutingOptions(
  value: unknown,
): WorkbenchRoutingOptions | { error: string } {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { error: "routingOptions must be an object" };
  }
  const input = value as Record<string, unknown>;
  const output: WorkbenchRoutingOptions = {};
  if ("modelId" in input) {
    if (typeof input.modelId !== "string") {
      return { error: "routingOptions.modelId must be a string" };
    }
    output.modelId = input.modelId;
  }
  if ("tier" in input) {
    if (input.tier !== 0 && input.tier !== 1 && input.tier !== 2) {
      return { error: "routingOptions.tier must be 0, 1, or 2" };
    }
    output.tier = input.tier;
  }
  if ("hint" in input) {
    if (
      input.hint !== "code" && input.hint !== "chat" &&
      input.hint !== "reasoning"
    ) {
      return { error: "routingOptions.hint must be code, chat, or reasoning" };
    }
    output.hint = input.hint;
  }
  return output;
}

function buildRuntimeInputFromJson(
  body: TurnRequestBody,
): WorkbenchRuntimeInput | { error: string } {
  if (typeof body.prompt !== "string" || body.prompt.trim().length === 0) {
    return { error: "prompt must be a non-empty string" };
  }
  const mode = body.mode ?? "turn";
  if (mode !== "turn" && mode !== "ask" && mode !== "next-work") {
    return { error: "mode must be turn, ask, or next-work" };
  }
  const routingOptions = parseRoutingOptions(body.routingOptions);
  if ("error" in routingOptions) return routingOptions;
  if (body.workspace !== undefined && typeof body.workspace !== "string") {
    return { error: "workspace must be a string" };
  }
  return {
    mode,
    prompt: body.prompt,
    routingOptions,
    // Honored only for a loopback operator; the runtime applies that gate.
    ...(typeof body.workspace === "string"
      ? { workspaceRoot: body.workspace }
      : {}),
  };
}

export function parseBudgetOverride(
  value: unknown,
):
  | { sessionLimitUsd?: number; perCallLimitUsd?: number; dailyLimitUsd?: number }
  | { error: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { error: "budget must be an object" };
  }
  const record = value as Record<string, unknown>;
  const out: {
    sessionLimitUsd?: number;
    perCallLimitUsd?: number;
    dailyLimitUsd?: number;
  } = {};
  for (
    const key of ["sessionLimitUsd", "perCallLimitUsd", "dailyLimitUsd"] as const
  ) {
    const raw = record[key];
    if (raw === undefined) continue;
    // A fat-finger guard, not a security control — consent is the binding money
    // gate. Reject non-positive / non-finite / absurd values.
    if (
      typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0 || raw > 1000
    ) {
      return { error: `budget.${key} must be a positive number up to 1000` };
    }
    out[key] = raw;
  }
  return out;
}

export interface ResolvedTurn {
  runtimeInput: WorkbenchRuntimeInput;
  sessionId: string | undefined;
  approvePaidInference: boolean;
}

/**
 * Resolve a parsed turn request body into runtime input plus the validated
 * resume sessionId and paid opt-in. Transport-neutral: the HTTP handler parses
 * the Request body, the UDS handler passes its JSON-RPC params — both call this.
 *
 * Transcript reconstruction belongs inside the per-session lock (see
 * `buildResume` / `executeTurn`) so a resumed turn reads the latest committed
 * events only after all earlier same-session turns have appended theirs.
 * Reading before the lock let a second same-session turn build a stale
 * transcript — a TOCTOU on the audit log (review finding).
 */
export interface ResolveTurnOptions {
  /** Standing paid posture when the request omits approvePaidInference (loopback only). */
  approvePaidDefault?: boolean;
}

export function resolveTurnFromBody(
  body: TurnRequestBody,
  loopback: boolean,
  options: ResolveTurnOptions = {},
): ResolvedTurn | { error: string; status: number } {
  const runtimeInput = buildRuntimeInputFromJson(body);
  if ("error" in runtimeInput) {
    return { error: runtimeInput.error, status: 400 };
  }

  let sessionId: string | undefined;
  if (body.sessionId !== undefined) {
    if (
      typeof body.sessionId !== "string" ||
      !SESSION_ID_SHAPE.test(body.sessionId)
    ) {
      return { error: "invalid session id", status: 400 };
    }
    sessionId = body.sessionId;
  }

  // validate the explicit per-turn paid-inference opt-in. Whether it
  // actually grants approval is decided at the confirmPaidEscalation injection,
  // which additionally requires the loopback transport.
  let approvePaidInference: boolean;
  if (body.approvePaidInference !== undefined) {
    if (typeof body.approvePaidInference !== "boolean") {
      return { error: "approvePaidInference must be a boolean", status: 400 };
    }
    approvePaidInference = body.approvePaidInference === true;
  } else if (loopback) {
    approvePaidInference = options.approvePaidDefault === true;
  } else {
    approvePaidInference = false;
  }

  // per-turn budget override, applied only on the loopback transport so
  // a remote caller can never raise the spend cap. (Malformed values still 400
  // regardless of transport.)
  if (body.budget !== undefined) {
    const budget = parseBudgetOverride(body.budget);
    if ("error" in budget) {
      return { error: budget.error, status: 400 };
    }
    if (loopback) {
      if (budget.sessionLimitUsd !== undefined) {
        runtimeInput.sessionLimitUsd = budget.sessionLimitUsd;
      }
      if (budget.perCallLimitUsd !== undefined) {
        runtimeInput.perCallLimitUsd = budget.perCallLimitUsd;
      }
      if (budget.dailyLimitUsd !== undefined) {
        runtimeInput.dailyLimitUsd = budget.dailyLimitUsd;
      }
    }
  }

  return { runtimeInput, sessionId, approvePaidInference };
}

/**
 * Rebuild the resume context (prior turns as conversation messages). Called
 * INSIDE `withSessionTurnLock` so the prior-event read happens after all earlier
 * same-session turns have settled — keeping the read-modify-append atomic per
 * session.
 */
async function buildResume(
  sessionId: string | undefined,
  fetchSessionEvents: FetchSessionEvents,
): Promise<Pick<WorkbenchRuntimeInput, "sessionId" | "conversationMessages">> {
  if (sessionId === undefined) return {};
  const priorEvents = await fetchSessionEvents({ sessionId });
  return {
    sessionId,
    conversationMessages: buildConversationMessages(priorEvents),
  };
}

export interface ExecuteTurnDeps {
  authContext: WorkbenchAuthContext;
  loopback: boolean;
  runRuntime: WorkbenchHttpRuntime;
  fetchSessionEvents: FetchSessionEvents;
  onTextDelta?: (delta: string) => void;
  onRuntimeEvent?: (event: WorkbenchRuntimeEvent) => void;
  /**
   * Mutating-tool approval handler. The UDS transport supplies a
   * duplex round-trip; HTTP omits it, so the runtime defaults to deny.
   */
  confirmToolApproval?: ConfirmToolApproval;
  /**
   * Engine default companion model (config ~/.dyfj/config.toml / env), loaded
   * once at the boundary and applied when a turn specifies no model/tier/hint.
   */
  defaultCompanionModel?: string | null;
  /** Operator permission posture (config), loaded once at the boundary. */
  permissionLevel?: PermissionLevel;
  /** Standing paid posture (config), applied when the request omits opt-in. */
  approvePaidDefault?: boolean;
  /** Engine budget defaults (config), resolved once at the boundary. */
  defaultSessionBudgetUsd?: number;
  defaultPerCallBudgetUsd?: number;
  defaultDailyBudgetUsd?: number;
  /**
   * Warn-then-confirm handler when projected spend crosses a budget ceiling.
   * The UDS transport supplies a duplex round-trip; HTTP omits it, so the
   * runtime fails closed when a ceiling would be exceeded.
   */
  confirmBudgetCeiling?: ConfirmBudgetCeiling;
}

/** Thread the loaded engine config into executeTurn deps. */
export function engineConfigToTurnDeps(
  config: Pick<
    WorkbenchConfig,
    | "defaultCompanionModel"
    | "permissionLevel"
    | "approvePaidDefault"
    | "defaultSessionBudgetUsd"
    | "defaultPerCallBudgetUsd"
    | "defaultDailyBudgetUsd"
  >,
): Pick<
  ExecuteTurnDeps,
  | "defaultCompanionModel"
  | "permissionLevel"
  | "approvePaidDefault"
  | "defaultSessionBudgetUsd"
  | "defaultPerCallBudgetUsd"
  | "defaultDailyBudgetUsd"
> {
  return {
    defaultCompanionModel: config.defaultCompanionModel,
    permissionLevel: config.permissionLevel,
    approvePaidDefault: config.approvePaidDefault,
    defaultSessionBudgetUsd: config.defaultSessionBudgetUsd,
    defaultPerCallBudgetUsd: config.defaultPerCallBudgetUsd,
    defaultDailyBudgetUsd: config.defaultDailyBudgetUsd,
  };
}

/**
 * Run a resolved turn: per-session lock → resume reconstruction → env-derived
 * runtime config → the runtime, with the paid-escalation verdict bound to the
 * caller's transport + opt-in. Identical for every transport; the caller only
 * supplies the streaming/event callbacks and the auth context.
 */
/**
 * One operational stderr line per completed transport turn: routing and cost
 * facts only — no turn content, no memory or context-source names. Client
 * presentation belongs to clients; the receipt carries the full detail.
 */
export function formatTurnSummaryLine(result: WorkbenchRuntimeResult): string {
  const model = result.model?.slug ?? "unknown";
  const tokens = result.tokens
    ? `${result.tokens.input}in/${result.tokens.output}out`
    : "?";
  const cost = result.cost ? `$${result.cost.totalUsd.toFixed(6)}` : "$?";
  const paid = result.cost?.paidInferenceUsed ? "paid" : "local";
  return `[turn] session=${result.sessionId} model=${model} tokens=${tokens} cost=${cost} ${paid}`;
}

export function executeTurn(
  resolved: ResolvedTurn,
  deps: ExecuteTurnDeps,
): Promise<WorkbenchRuntimeResult> {
  return withSessionTurnLock(resolved.sessionId, async () => {
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
    // env-derived runtime config resolved at the boundary, not in the
    // core. A future headless driver supplies these from its own config.
    ...resolveRuntimeEnvDefaults(),
    // engine default companion model, resolved once at the boundary from config
    defaultCompanionModel: deps.defaultCompanionModel,
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
    authContext: deps.authContext,
    onTextDelta: deps.onTextDelta,
    onRuntimeEvent: deps.onRuntimeEvent,
    // mutating tools run only after operator approval; the transport
    // supplies the approver (UDS = duplex round-trip), else the runtime denies.
    confirmToolApproval: deps.confirmToolApproval,
    // budget ceiling warn-then-confirm; absent => fail closed at the ceiling.
    confirmBudgetCeiling: deps.confirmBudgetCeiling,
    // paid inference is granted only to a loopback caller that
    // explicitly opted in this turn; remote callers are always denied.
    confirmPaidEscalation: () =>
      Promise.resolve(
        paidEscalationVerdict(deps.loopback, resolved.approvePaidInference),
      ),
  });
}
