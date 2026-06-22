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
  | { sessionLimitUsd?: number; perCallLimitUsd?: number }
  | { error: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { error: "budget must be an object" };
  }
  const record = value as Record<string, unknown>;
  const out: { sessionLimitUsd?: number; perCallLimitUsd?: number } = {};
  for (const key of ["sessionLimitUsd", "perCallLimitUsd"] as const) {
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
 * Deliberately does NOT read the session's prior events: transcript
 * reconstruction is deferred into the per-session lock (see `buildResume` /
 * `executeTurn`) so a resumed turn reads the latest committed events only after
 * all earlier same-session turns have appended theirs. Reading here (before the
 * lock) let a second same-session turn build a stale transcript — a TOCTOU on
 * the audit log (review finding).
 */
export function resolveTurnFromBody(
  body: TurnRequestBody,
  loopback: boolean,
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
  if (
    body.approvePaidInference !== undefined &&
    typeof body.approvePaidInference !== "boolean"
  ) {
    return { error: "approvePaidInference must be a boolean", status: 400 };
  }
  const approvePaidInference = body.approvePaidInference === true;

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
  return withSessionTurnLock(resolved.sessionId, async () => {
    const resume = await buildResume(
      resolved.sessionId,
      deps.fetchSessionEvents,
    );
    return deps.runRuntime({
      ...resolved.runtimeInput,
      ...resume,
      // env-derived runtime config resolved at the boundary, not in the
      // core. A future headless driver supplies these from its own config.
      ...resolveRuntimeEnvDefaults(),
      authContext: deps.authContext,
      onTextDelta: deps.onTextDelta,
      onRuntimeEvent: deps.onRuntimeEvent,
      // mutating tools run only after operator approval; the transport
      // supplies the approver (UDS = duplex round-trip), else the runtime denies.
      confirmToolApproval: deps.confirmToolApproval,
      // paid inference is granted only to a loopback caller that
      // explicitly opted in this turn; remote callers are always denied.
      confirmPaidEscalation: () =>
        Promise.resolve(
          paidEscalationVerdict(deps.loopback, resolved.approvePaidInference),
        ),
    });
  });
}
