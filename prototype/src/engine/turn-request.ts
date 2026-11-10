/**
 * Turn request resolution: validate a transport-neutral turn request body
 * into runtime input, the resume session id, and the paid-inference opt-in.
 * The UDS handler passes its JSON-RPC params here; the per-session lock and
 * resume reconstruction happen later, in `executeTurn` (`turn.ts`).
 */
import { isAbsolute, win32 } from "node:path";
import process from "node:process";
import type { WorkbenchRoutingOptions } from "../providers/mod.ts";
import {
  type AdditionalRootRequest,
  CODEX_WORKSPACE_TRUST_REQUIRED,
  MAX_ADDITIONAL_ROOTS,
  type PaidEscalationVerdict,
  SESSION_ID_SHAPE,
} from "../contract/mod.ts";
import type { WorkbenchRuntimeInput } from "./runtime-types.ts";
import {
  AGENT_DEFAULTS,
  codexReasoningEffortRefusal,
  isCodexReasoningEffort,
} from "../config/mod.ts";

export interface TurnRequestBody {
  prompt?: unknown;
  turnId?: unknown;
  mode?: unknown;
  routingOptions?: unknown;
  sessionId?: unknown;
  workspace?: unknown;
  /** Extra roots beside the workspace: `[{ path, readOnly }]`. */
  additionalRoots?: unknown;
  runner?: unknown;
  // explicit per-turn paid-inference opt-in + per-turn budget override.
  // Both are honored only on the loopback transport (see resolveTurnFromBody /
  // the confirmPaidEscalation injection).
  approvePaidInference?: unknown;
  budget?: unknown;
  // the session's own tool-step limit, within the configured ceiling. A
  // remote caller may lower the limit but not raise it.
  maxToolSteps?: unknown;
  /**
   * The caller will not resume this turn's live external-agent handle.
   * Honored on the loopback transport only.
   */
  releaseExternalAgentSession?: unknown;
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
  "paid inference was not approved for this turn; to allow it, rerun with " +
  "--approve-paid (in the REPL, /model <slug> --approve-paid)";

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
  if ("reasoningEffort" in input) {
    if (!isCodexReasoningEffort(input.reasoningEffort)) {
      return {
        error: codexReasoningEffortRefusal("routingOptions.reasoningEffort"),
      };
    }
    output.reasoningEffort = input.reasoningEffort;
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
  const additionalRoots = parseAdditionalRoots(body.additionalRoots);
  if ("error" in additionalRoots) return additionalRoots;
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
  // The effort is not model routing: it configures the runner the request
  // names, and route resolution refuses it on a runner other than Codex.
  const { reasoningEffort: _effort, ...modelRouting } = routingOptions;
  if (body.runner !== undefined && Object.keys(modelRouting).length > 0) {
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
    ...(additionalRoots.roots.length === 0
      ? {}
      : { additionalRoots: additionalRoots.roots }),
  };
}

/**
 * The request's extra roots: an array of at most `MAX_ADDITIONAL_ROOTS`
 * `{ path: <absolute path>, readOnly?: boolean }` objects. The runtime admits
 * each one later, for a loopback caller only.
 */
/**
 * True when `path` names one location on its own: absolute, and on Windows
 * also carrying a drive or UNC prefix (`\\repo` and `D:repo` depend on the
 * caller's current drive or directory).
 */
function fullyQualified(path: string, platform: string): boolean {
  if (platform !== "win32") return isAbsolute(path);
  return win32.isAbsolute(path) && /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(path);
}

export function parseAdditionalRoots(
  value: unknown,
  platform: string = process.platform,
): { roots: AdditionalRootRequest[] } | { error: string } {
  if (value === undefined) return { roots: [] };
  if (!Array.isArray(value) || value.length > MAX_ADDITIONAL_ROOTS) {
    return {
      error:
        `additionalRoots must be an array of at most ${MAX_ADDITIONAL_ROOTS} roots`,
    };
  }
  const roots: AdditionalRootRequest[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { error: "additionalRoots entries must be objects" };
    }
    const { path, readOnly, ...rest } = entry as Record<string, unknown>;
    if (Object.keys(rest).length > 0) {
      return { error: "additionalRoots entries take only path and readOnly" };
    }
    if (typeof path !== "string" || !fullyQualified(path, platform)) {
      return { error: "additionalRoots paths must be absolute" };
    }
    if (readOnly !== undefined && typeof readOnly !== "boolean") {
      return { error: "additionalRoots readOnly must be a boolean" };
    }
    roots.push({ path, readOnly: readOnly === true });
  }
  return { roots };
}

export function parseBudgetOverride(
  value: unknown,
):
  | {
    sessionLimitUsd?: number;
    perCallLimitUsd?: number;
    dailyLimitUsd?: number;
    turnLimitUsd?: number;
    runawayStallUsd?: number;
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
    turnLimitUsd?: number;
    runawayStallUsd?: number;
  } = {};
  for (
    const key of [
      "sessionLimitUsd",
      "perCallLimitUsd",
      "dailyLimitUsd",
      "turnLimitUsd",
      "runawayStallUsd",
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
  /** The request's own tool-step limit, already checked against the ceiling. */
  maxToolSteps?: number;
  /**
   * Close this turn's idle external-agent handle before the session lock is
   * released. A one-shot client sets it; an interactive client does not.
   */
  releaseExternalAgentSession: boolean;
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
  /** The configured tool-step limit; a remote caller may not raise a turn above it. */
  maxToolSteps?: number;
  /** The highest tool-step limit a request may set. */
  maxToolStepsCeiling?: number;
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
      error: CODEX_WORKSPACE_TRUST_REQUIRED,
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
      if (budget.turnLimitUsd !== undefined) {
        runtimeInput.turnLimitUsd = budget.turnLimitUsd;
      }
      if (budget.runawayStallUsd !== undefined) {
        runtimeInput.runawayStallUsd = budget.runawayStallUsd;
      }
    }
  }

  const maxToolSteps = resolveMaxToolSteps(body.maxToolSteps, loopback, options);
  if (typeof maxToolSteps === "object") return maxToolSteps;

  let releaseExternalAgentSession = false;
  if (body.releaseExternalAgentSession !== undefined) {
    if (typeof body.releaseExternalAgentSession !== "boolean") {
      return {
        error: "releaseExternalAgentSession must be a boolean",
        status: 400,
      };
    }
    // A remote caller cannot release a local agent's live session.
    releaseExternalAgentSession = loopback &&
      body.releaseExternalAgentSession === true;
  }

  return {
    runtimeInput,
    sessionId,
    approvePaidInference,
    releaseExternalAgentSession,
    ...(maxToolSteps === undefined ? {} : { maxToolSteps }),
  };
}

/**
 * A request's own tool-step limit: an integer from 1 through the configured
 * ceiling. A value above the ceiling is refused, not clamped, so the caller
 * learns its setting did not hold. A remote caller may only lower the limit.
 */
function resolveMaxToolSteps(
  value: unknown,
  loopback: boolean,
  options: ResolveTurnOptions,
): number | undefined | { error: string; status: number } {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return { error: "maxToolSteps must be a positive integer", status: 400 };
  }
  const ceiling = options.maxToolStepsCeiling ??
    AGENT_DEFAULTS.maxToolStepsCeiling;
  if (value > ceiling) {
    return {
      error: `maxToolSteps ${value} is above the tool-step ceiling of ${ceiling}`,
      status: 400,
    };
  }
  const standing = options.maxToolSteps ?? AGENT_DEFAULTS.maxToolSteps;
  if (!loopback && value > standing) {
    return {
      error: "remote callers may not raise the tool-step limit",
      status: 403,
    };
  }
  return value;
}
