/**
 * The `budgetGate` stage (specs/01-architecture.md §5.1): select the turn's
 * model, then run every check that must pass before any spend — the spend
 * check over every limit, and the paid-escalation preflight — and record the
 * selection.
 *
 * The spend check it builds stays with the turn: every later provider call
 * (the agent loop's and compression's) is checked against the same gate,
 * whose turn and runaway marks last the turn and whose per-call, session and
 * daily marks are scoped to the session and day through its owner.
 */
import { resolvePrincipalId } from "../config/mod.ts";
import {
  createTurnBudgetCeilingGate,
  type TurnBudgetCeilingGate,
} from "../budget/mod.ts";
import { estimateTextTokens, type WorkbenchModel } from "../providers/mod.ts";
import { writeModelSelectedEvent } from "../store/mod.ts";
import { writeMaybe } from "./event-writes.ts";
import { confirmPaidRoute, selectModelRoute } from "./route.ts";
import { emitRuntimeEvent } from "./runtime-events.ts";
import {
  explainSessionModelFailure,
  sessionRouteReason,
} from "./session-model.ts";
import type { WorkbenchRuntimeInput } from "./runtime-types.ts";
import type { NativeTurnPorts, TurnState } from "./turn-state.ts";

/** The routed model and the gates every provider call this turn passes. */
export interface TurnRoute {
  /** The catalog the turn routed against; compression selects from it. */
  models: WorkbenchModel[];
  selected: WorkbenchModel;
  budgetCeilingGate: TurnBudgetCeilingGate;
}

/** Run the stage: select, gate, preflight, record. */
export async function budgetGate(
  state: TurnState,
  input: WorkbenchRuntimeInput,
  ports: NativeTurnPorts,
): Promise<TurnRoute> {
  const { session } = state;
  const { models, selection, routingReason: selectedReason } =
    await selectModelRoute(
      ports.store.models,
      {
        mode: session.mode,
        routingOptions: input.routingOptions,
        defaultCompanionModel: input.defaultCompanionModel,
      },
    ).catch((error) => explainSessionModelFailure(input, error));
  const routingReason = sessionRouteReason(input, selectedReason);
  const selected = selection.selected;
  state.selectedForReceipt = {
    displayName: selected.displayName,
    slug: selected.slug,
    tier: selected.tier,
    provider: selected.provider,
    api: selected.api,
  };
  state.routingReason = routingReason;
  state.selectedForEvents = {
    slug: selected.slug,
    provider: selected.provider,
    api: selected.api,
  };
  const route: TurnRoute = {
    models,
    selected,
    // Scope-persistent: an approved overrun raises the limit for its scope
    // (per-call and session marks per session id, the daily mark per local
    // day) instead of re-prompting next turn; turn and runaway marks last
    // this turn.
    budgetCeilingGate: createTurnBudgetCeilingGate(
      input.approver?.confirmBudgetCeiling,
      ports.budgetScopes.budgetScope(session.sessionId),
    ),
  };
  await gateEntry(state, input, route);
  await recordSelection(state, input, ports, route, selection.considered);
  return route;
}

/** The checks before the first call, in order: the spend check, then paid consent. */
async function gateEntry(
  state: TurnState,
  input: WorkbenchRuntimeInput,
  route: TurnRoute,
): Promise<void> {
  const { budget } = state.session;
  const { selected } = route;
  const preCall = budget.checkPreCall(
    selected.tier,
    selected.costInput,
    estimateTextTokens(`${state.systemPrompt}\n${state.modelPrompt}`),
  );
  await route.budgetCeilingGate.ensureAllowed(preCall);
  state.estimatedCostUsd = preCall.estimatedCost;

  await confirmPaidRoute({
    modelName: selected.displayName,
    modelSlug: selected.slug,
    tier: selected.tier,
    routingReason: state.routingReason,
    estimatedCostUsd: preCall.estimatedCost,
    sessionCostSoFarUsd: preCall.sessionCostSoFar,
    sessionLimitUsd: preCall.sessionLimitUsd,
    perCallLimitUsd: preCall.perCallLimitUsd,
  }, input.approver?.confirmPaidEscalation);
}

/** The best-effort `model_selected` event and the `modelSelected` frame. */
async function recordSelection(
  state: TurnState,
  input: WorkbenchRuntimeInput,
  ports: NativeTurnPorts,
  route: TurnRoute,
  considered: string[],
): Promise<void> {
  const { session } = state;
  const { selected } = route;
  await writeMaybe(
    () =>
      writeModelSelectedEvent(ports.store.journal, {
        selected: selected.slug,
        considered,
        reason: state.routingReason,
        sessionId: session.sessionId,
        traceId: session.traceId,
        provider: selected.provider,
        api: selected.api,
        durationMs: ports.clock.now() - session.startedAt,
        parentSpanId: session.turnRootSpanId,
        // The environment's principal, as the event has always carried, read
        // through the turn's env port.
        principalId: resolvePrincipalId(ports.env),
        authnFields: session.authnEventFields,
      }),
    true,
    state.audit.noteSkippedEventWrite,
  );
  await emitRuntimeEvent(input.frames?.onRuntimeEvent, {
    type: "modelSelected",
    sessionId: session.sessionId,
    modelSlug: selected.slug,
    tier: selected.tier,
    reason: state.routingReason,
  });
}
