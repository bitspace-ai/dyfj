/**
 * Turn request resolution: validate a transport-neutral turn request body
 * into runtime input, the resume session id, and the paid-inference opt-in.
 * The UDS handler passes its JSON-RPC params here; the per-session lock and
 * resume reconstruction happen later, in `executeTurn` (`turn.ts`).
 */
import type { WorkbenchRoutingOptions } from "../providers/mod.ts";
import {
  type PaidEscalationVerdict,
  SESSION_ID_SHAPE,
} from "../contract/mod.ts";
import type { WorkbenchRuntimeInput } from "./runtime-types.ts";

export interface TurnRequestBody {
  prompt?: unknown;
  turnId?: unknown;
  mode?: unknown;
  routingOptions?: unknown;
  sessionId?: unknown;
  workspace?: unknown;
  runner?: unknown;
  // explicit per-turn paid-inference opt-in + per-turn budget override.
  // Both are honored only on the loopback transport (see resolveTurnFromBody /
  // the confirmPaidEscalation injection).
  approvePaidInference?: unknown;
  budget?: unknown;
}

const TURN_ID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidTurnId(value: unknown): value is string {
  return typeof value === "string" && TURN_ID_SHAPE.test(value);
}

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
  if ("fast" in input) {
    if (typeof input.fast !== "boolean") {
      return { error: "routingOptions.fast must be a boolean" };
    }
    output.fast = input.fast;
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
  if (
    body.turnId !== undefined &&
    !isValidTurnId(body.turnId)
  ) {
    return { error: "turnId must be a UUID" };
  }
  if (
    body.runner !== undefined && body.runner !== "fixture" &&
    body.runner !== "codex-chatgpt"
  ) {
    return { error: "runner must be fixture or codex-chatgpt" };
  }
  if (body.runner !== undefined && Object.keys(routingOptions).length > 0) {
    return { error: "runner cannot be combined with model routing options" };
  }
  return {
    mode,
    prompt: body.prompt,
    routingOptions,
    ...(body.runner === "fixture" || body.runner === "codex-chatgpt"
      ? { runner: { kind: "acp" as const, profile: body.runner } }
      : {}),
    ...(typeof body.turnId === "string" ? { turnId: body.turnId } : {}),
    // Honored only for a loopback operator; the runtime applies that gate.
    ...(typeof body.workspace === "string"
      ? { workspaceRoot: body.workspace }
      : {}),
  };
}

export function parseBudgetOverride(
  value: unknown,
):
  | {
    sessionLimitUsd?: number;
    perCallLimitUsd?: number;
    dailyLimitUsd?: number;
  }
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
    const key of [
      "sessionLimitUsd",
      "perCallLimitUsd",
      "dailyLimitUsd",
    ] as const
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
  /** Standing operator trust required before Codex may read workspace config. */
  trustWorkspaceInstructions?: boolean;
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
  if (runtimeInput.runner !== undefined && !loopback) {
    return {
      error: "external local runners are not available to remote callers",
      status: 403,
    };
  }
  if (
    runtimeInput.runner?.profile === "codex-chatgpt" &&
    options.trustWorkspaceInstructions !== true
  ) {
    return {
      error: "codex-chatgpt requires explicit workspace trust",
      status: 403,
    };
  }
  if (options.trustWorkspaceInstructions === true) {
    runtimeInput.trustWorkspaceInstructions = true;
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
