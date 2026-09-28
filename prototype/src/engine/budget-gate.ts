/**
 * The `budgetGate` stage (specs/01-architecture.md §5.1): select the turn's
 * model, then run every check that must pass before any spend — the runaway
 * anomaly hard stop, the budget-ceiling envelope, and the paid-escalation
 * preflight — and record the selection.
 *
 * The gates it builds stay with the turn: every later provider call (the
 * agent loop's and compression's) is checked against the same ceiling gate,
 * scoped to the session through its owner, and the same turn-scoped anomaly
 * gate.
 */
import { writeModelSelectedEvent } from "../utils.ts";
import { resolvePrincipalId } from "../config/mod.ts";
import {
  createRunawayAnomalyGate,
  createTurnBudgetCeilingGate,
  type RunawayAnomalyGate,
  type TurnBudgetCeilingGate,
} from "../budget/mod.ts";
import { estimateTextTokens, type WorkbenchModel } from "../providers/mod.ts";
import { writeMaybe } from "./event-writes.ts";
import { confirmPaidRoute, selectModelRoute } from "./route.ts";
import { emitRuntimeEvent } from "./runtime-events.ts";
import type { WorkbenchRuntimeInput } from "./runtime-types.ts";
import type { NativeTurnPorts, TurnState } from "./turn-state.ts";

/** The routed model and the gates every provider call this turn passes. */
export interface TurnRoute {
  /** The catalog the turn routed against; compression selects from it. */
  models: WorkbenchModel[];
  selected: WorkbenchModel;
  budgetCeilingGate: TurnBudgetCeilingGate;
  anomalyGate: RunawayAnomalyGate;
}

/** Run the stage: select, gate, preflight, record. */
export async function budgetGate(
  state: TurnState,
  input: WorkbenchRuntimeInput,
  ports: NativeTurnPorts,
): Promise<TurnRoute> {
  const { session } = state;
  const { models, selection, routingReason } = await selectModelRoute(
    ports.store.models,
    {
      mode: session.mode,
      routingOptions: input.routingOptions,
      defaultCompanionModel: input.defaultCompanionModel,
    },
  );
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
    // Scope-persistent: a confirmed overrun raises the envelope for its scope
    // (session marks per session id, the daily mark per local day) instead
    // of re-prompting next turn.
    budgetCeilingGate: createTurnBudgetCeilingGate(
      input.confirmBudgetCeiling,
      ports.budgetScopes.budgetScope(session.sessionId),
    ),
    // Turn-scoped: an approval covers the spend level it was shown (the entry
    // check and the first call's check see identical actuals); any recorded
    // increment re-prompts, and nothing survives the turn.
    anomalyGate: createRunawayAnomalyGate(input.confirmRunawayAnomaly),
  };
  await gateEntry(state, input, route);
  await recordSelection(state, input, ports, route, selection.considered);
  return route;
}

/**
 * The checks before the first call, in order: the anomaly hard stop, the
 * ceiling, then paid consent.
 */
async function gateEntry(
  state: TurnState,
  input: WorkbenchRuntimeInput,
  route: TurnRoute,
): Promise<void> {
  const { budget, anomalyConfig } = state.session;
  const { selected } = route;
  const preCall = budget.checkPreCall(
    selected.tier,
    selected.costInput,
    estimateTextTokens(`${state.systemPrompt}\n${state.modelPrompt}`),
  );
  // Hard stop BEFORE the soft ceiling confirm: a turn entered in an
  // anomalous state must halt first — otherwise the ceiling prompt records
  // its scope-period confirmation before the operator ever sees the halt,
  // and an aborted turn leaves that confirmation behind.
  await route.anomalyGate.ensureAllowed(
    budget.checkAnomaly(selected.tier, anomalyConfig),
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
  }, input.confirmPaidEscalation);
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
  await emitRuntimeEvent(input.onRuntimeEvent, {
    type: "modelSelected",
    sessionId: session.sessionId,
    modelSlug: selected.slug,
    tier: selected.tier,
    reason: state.routingReason,
  });
}
