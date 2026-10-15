/**
 * Unit tests for the `budgetGate` stage after a real `openSession` and
 * `buildContext`: model selection into the turn state, the entry gates in
 * order, and the `model_selected` record.
 */
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import {
  type EngineFakes,
  enginePorts,
  pricedLocalModel,
  tempWorkspace,
} from "../../testing/builders/engine.ts";
import {
  BudgetCeilingDeclinedError,
  RunawayAnomalyHaltError,
} from "../budget/mod.ts";
import type { WorkbenchRuntimeEvent } from "../contract/mod.ts";
import { createCommandRegistry } from "../tools/mod.ts";
import { budgetGate } from "./budget-gate.ts";
import { buildContext } from "./build-context.ts";
import { PaidEscalationDeclinedError } from "./errors.ts";
import { openSession } from "./open-session.ts";
import type { WorkbenchRuntimeInput } from "./runtime-types.ts";
import { newTurnState, type TurnState } from "./turn-state.ts";

const PRICED = pricedLocalModel({ costInput: 15, costOutput: 75 });

/** Open a turn, build its context, and return it ready for the gate. */
async function contextReady(
  input: Partial<WorkbenchRuntimeInput>,
  fakes: EngineFakes,
  root: string,
): Promise<{ state: TurnState; input: WorkbenchRuntimeInput }> {
  const full: WorkbenchRuntimeInput = {
    mode: "turn",
    prompt: "explore",
    routingOptions: {},
    rootOverride: root,
    ...input,
  };
  const session = await openSession(full, fakes.ports);
  const state = newTurnState(session, createCommandRegistry());
  await buildContext(state, full, fakes.ports);
  return { state, input: full };
}

async function selectedRows(fakes: EngineFakes, sessionId: string) {
  const rows = await fakes.store.events.bySession({
    sessionId,
    limit: 50,
    order: "asc",
  });
  return rows.filter((row) => row.event_type === "model_selected");
}

test("budgetGate routes a free local turn and records the selection", async () => {
  await using root = await tempWorkspace();
  const fakes = enginePorts();
  const frames: WorkbenchRuntimeEvent[] = [];
  const { state, input } = await contextReady(
    {
      defaultCompanionModel: "local-chat",
      frames: {
        onRuntimeEvent: (event) => void frames.push(event),
      },
    },
    fakes,
    root.root,
  );

  const route = await budgetGate(state, input, fakes.ports);

  assert.deepStrictEqual(route.selected.slug, "local-chat");
  assert.deepStrictEqual(state.selectedForReceipt?.slug, "local-chat");
  assert.deepStrictEqual(state.selectedForEvents, {
    slug: "local-chat",
    provider: "ollama",
    api: "openai-completions",
  });
  assert.deepStrictEqual(state.estimatedCostUsd, 0);
  const [selected] = await selectedRows(fakes, state.session.sessionId);
  assert.partialDeepStrictEqual(selected, { model_id: "local-chat" });
  assert.deepStrictEqual(frames.at(-1), {
    type: "modelSelected",
    sessionId: state.session.sessionId,
    modelSlug: "local-chat",
    tier: 0,
    reason: state.routingReason,
  });
});

test("budgetGate asks paid consent with the preflight banner, and a decline stops the turn", async () => {
  await using root = await tempWorkspace();
  const fakes = enginePorts({ models: [PRICED] });
  const banners: string[] = [];
  const { state, input } = await contextReady(
    {
      defaultCompanionModel: PRICED.slug,
      approver: {
        confirmPaidEscalation: (banner) => {
          banners.push(banner);
          return Promise.resolve({
            decision: "deny",
            reason: "operator declined",
          });
        },
      },
    },
    fakes,
    root.root,
  );

  const error = await budgetGate(state, input, fakes.ports).catch((e) => e);
  assert.ok(error instanceof PaidEscalationDeclinedError);
  assert.deepStrictEqual(banners.length, 1);
  assert.ok(banners[0].startsWith("Paid inference preflight"));
  // The selection is on the receipt, but nothing was recorded as selected.
  assert.deepStrictEqual(state.selectedForReceipt?.slug, PRICED.slug);
  assert.deepStrictEqual(
    await selectedRows(fakes, state.session.sessionId),
    [],
  );
});

test("budgetGate confirms a ceiling overrun before paid consent, and a decline stops the turn", async () => {
  await using root = await tempWorkspace();
  const fakes = enginePorts({ models: [PRICED] });
  const confirmPaidEscalation = mock.fn(() =>
    Promise.resolve({ decision: "approve" as const })
  );
  const { state, input } = await contextReady(
    {
      defaultCompanionModel: PRICED.slug,
      defaultPerCallBudgetUsd: 0.00001,
      approver: {
        confirmPaidEscalation,
        confirmBudgetCeiling: () =>
          Promise.resolve({ decision: "deny", reason: "too much" }),
      },
    },
    fakes,
    root.root,
  );

  await assert.rejects(
    () => budgetGate(state, input, fakes.ports),
    BudgetCeilingDeclinedError,
  );
  assert.equal(confirmPaidEscalation.mock.callCount(), 0);
});

test("budgetGate halts an anomalous entry before the ceiling prompt can record a confirmation", async () => {
  await using root = await tempWorkspace();
  const fakes = enginePorts({
    models: [pricedLocalModel({ costInput: 0.000001, costOutput: 10_000 })],
  });
  const confirmBudgetCeiling = mock.fn(() =>
    Promise.resolve({ decision: "approve" as const })
  );
  fakes.ports.fetchSpendBaselines = () =>
    Promise.resolve({
      sessionSpentUsd: 2.5,
      sessionSpentTodayUsd: 2.5,
      dailyOtherSessionsUsd: 0,
    });
  const { state, input } = await contextReady(
    {
      defaultCompanionModel: "local-priced",
      defaultSessionBudgetUsd: 1,
      anomalyScopeMultiple: 2,
      approver: {
        confirmPaidEscalation: () => Promise.resolve({ decision: "approve" }),
        confirmBudgetCeiling,
      },
    },
    fakes,
    root.root,
  );

  await assert.rejects(
    () => budgetGate(state, input, fakes.ports),
    RunawayAnomalyHaltError,
  );
  assert.equal(confirmBudgetCeiling.mock.callCount(), 0);
});

test("an approved ceiling overrun persists for the session through its owner's budget scope", async () => {
  await using root = await tempWorkspace();
  const fakes = enginePorts({ models: [PRICED] });
  const confirmBudgetCeiling = mock.fn(() =>
    Promise.resolve({ decision: "approve" as const })
  );
  const turn = {
    defaultCompanionModel: PRICED.slug,
    defaultPerCallBudgetUsd: 0.00001,
    sessionId: "01TEST00000000000000000001",
    approver: {
      confirmPaidEscalation: () =>
        Promise.resolve({ decision: "approve" as const }),
      confirmBudgetCeiling,
    },
  };
  const first = await contextReady(turn, fakes, root.root);
  await budgetGate(first.state, first.input, fakes.ports);
  const second = await contextReady(turn, fakes, root.root);
  await budgetGate(second.state, second.input, fakes.ports);
  // The first turn's confirmation raised the session's per-call mark, so the
  // second turn at the same estimate is not asked again.
  assert.equal(confirmBudgetCeiling.mock.callCount(), 1);
  const marks = fakes.ports.budgetScopes.budgetScope(turn.sessionId);
  assert.ok((marks.per_call_limit ?? 0) > 0.00001);
});
