/**
 * A resumed session's route (specs/01-architecture.md §5.1, ahead of
 * `resolveRoute`). Each provider call is recorded as a `provider_call` event.
 * A later turn that names its session but no model, tier or hint of its own
 * routes to the model of the latest call that completed, the model the
 * session last ran on; a model a turn only selected does not count. So a
 * session built on one model is not resumed on another whose context window
 * its history may overflow. A recorded model that can no longer be routed
 * refuses the turn; there is no fallback to the configured default.
 */
import {
  WorkbenchModelNotFoundError,
  WorkbenchModelNotRoutableError,
} from "../providers/mod.ts";
import type { SessionLastRun } from "../store/mod.ts";
import {
  SessionModelUnavailableError,
  SessionRunnerNotRestorableError,
} from "./errors.ts";
import type { WorkbenchRuntimeInput } from "./runtime-types.ts";

/** Where what the session last ran on is read: the event log. */
export interface SessionModelReader {
  latestRun(sessionId: string): Promise<SessionLastRun | null>;
}

/** The route reason a turn on its session's recorded model reports. */
export const SESSION_MODEL_ROUTE_REASON = "session_model";

/**
 * The route reason to report: a selection the engine made explicit from the
 * session's recorded model says so, rather than claiming the caller chose it.
 */
export function sessionRouteReason(
  input: WorkbenchRuntimeInput,
  reason: string,
): string {
  return input.restoredSessionModel !== undefined &&
      reason === "explicit_model_id"
    ? SESSION_MODEL_ROUTE_REASON
    : reason;
}

/**
 * `input`, routed to its session's recorded model when the turn resumes a
 * session and makes no routing choice of its own. A turn with an explicit
 * model, tier, hint or runner, a new session, and a session with no recorded
 * model are returned unchanged. A session whose last turn ran on an
 * external-agent runner refuses: the runner's own model is not recorded, and
 * routing its history to an older native model would send it somewhere the
 * operator did not choose. A failed lookup rejects: the turn cannot tell
 * which model its session needs.
 */
export async function withSessionModel(
  input: WorkbenchRuntimeInput,
  events: SessionModelReader,
): Promise<WorkbenchRuntimeInput> {
  const routing = input.routingOptions ?? {};
  if (
    input.sessionId === undefined || input.runner !== undefined ||
    routing.modelId !== undefined || routing.tier !== undefined ||
    routing.hint !== undefined
  ) {
    return input;
  }
  const last = await events.latestRun(input.sessionId);
  if (last === null) return input;
  if (last.kind === "runner") {
    throw new SessionRunnerNotRestorableError(last.profile);
  }
  const recorded = last.slug;
  return {
    ...input,
    routingOptions: { ...routing, modelId: recorded },
    restoredSessionModel: recorded,
  };
}

/**
 * Rethrow a routing failure for a turn on its session's recorded model as
 * the refusal that names it; any other error is rethrown unchanged.
 */
export function explainSessionModelFailure(
  input: WorkbenchRuntimeInput,
  error: unknown,
): never {
  const slug = input.restoredSessionModel;
  if (slug !== undefined) {
    if (error instanceof WorkbenchModelNotFoundError) {
      throw new SessionModelUnavailableError(slug, "not in the catalog");
    }
    if (error instanceof WorkbenchModelNotRoutableError) {
      throw new SessionModelUnavailableError(slug, "unpriced");
    }
  }
  throw error;
}
