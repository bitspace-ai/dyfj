/**
 * Component tests for the per-call gates and accounting of the agent loop's
 * provider calls (`observed-turn.ts`): every call is budget-gated before it
 * is made and recorded after, so multi-call turns aggregate their usage and
 * stop on actual spend. Whole turns run over the engine fakes; tool steps run
 * the real `list_files` tool on a temp workspace.
 */
import { assertAlmostEqual } from "../../testing/assertions/almost-equal.ts";
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import {
  chatReply,
  type EngineRun,
  engineServices,
  eventRows,
  pricedLocalModel,
  runTurn,
  tempWorkspace,
} from "../../testing/builders/engine.ts";
import type { ScriptedExchange } from "../../testing/fakes/scripted-http-transport.ts";
import type { RunawayAnomalyWarning } from "../budget/mod.ts";
import type { WorkbenchRuntimeEvent } from "../contract/mod.ts";
import type { ModelSeed } from "../store/mod.ts";
import type {
  NativeWorkbenchRuntimeResult,
  WorkbenchRuntimeInput,
} from "./runtime-types.ts";

/** A reply requesting one `list_files` call. */
function toolReply(
  id: string,
  usage: { prompt_tokens: number; completion_tokens: number; cost?: number },
): ScriptedExchange {
  return chatReply({
    toolCalls: [{ id, name: "list_files", arguments: { path: "." } }],
    usage,
  });
}

interface GatedRun {
  run: EngineRun;
  frames: WorkbenchRuntimeEvent[];
  result?: NativeWorkbenchRuntimeResult;
  error: unknown;
}

async function gatedTurn(
  exchanges: ScriptedExchange[],
  model: ModelSeed,
  input: Partial<WorkbenchRuntimeInput>,
): Promise<GatedRun> {
  await using root = await tempWorkspace({ "notes.md": "notes" });
  const run = engineServices(exchanges, { models: [model] });
  const frames: WorkbenchRuntimeEvent[] = [];
  try {
    const result = await runTurn(run, {
      prompt: "explore",
      rootOverride: root.root,
      defaultCompanionModel: model.slug,
      ...input,
      frames: {
        onRuntimeEvent: (event) => void frames.push(event),
        ...input.frames,
      },
    });
    return { run, frames, result, error: null };
  } catch (error) {
    return { run, frames, error };
  }
}

const APPROVE_PAID = () => Promise.resolve({ decision: "approve" as const });

test("budgets and records every provider call so the receipt aggregates the whole turn", async () => {
  const usage = { prompt_tokens: 10, completion_tokens: 2 };
  const free = pricedLocalModel({ costInput: 1, costOutput: 1 });
  const { run, result } = await gatedTurn(
    [
      toolReply("c1", usage),
      toolReply("c2", usage),
      chatReply({ content: "done", usage }),
    ],
    { ...free, tier: 0, cost_input: 0, cost_output: 0 },
    {},
  );
  // Three provider calls, each 10 in / 2 out → aggregated, not just the last.
  assert.deepStrictEqual(result?.tokens.input, 30);
  assert.deepStrictEqual(result?.tokens.output, 6);
  assert.deepStrictEqual(result?.tokens.totalCalls, 3);
  const rows = await eventRows(run, result!.sessionId);
  const response = rows.find((row) => row.event_type === "model_response");
  assert.partialDeepStrictEqual(response ?? {}, {
    tokens_input: "30",
    tokens_output: "6",
  });
});

/** A tier-1 OpenRouter row; the catalog estimate for 10 in / 2 out is $0.0000054. */
const ROUTED: ModelSeed = {
  slug: "deepseek/deepseek-v4.1-flash",
  display_name: "DeepSeek V4.1 Flash",
  provider: "openrouter",
  api: "openai-completions",
  base_url: "https://openrouter.ai/api/v1",
  tier: 1,
  context_window: 32_768,
  max_output_tokens: 4_096,
  cost_input: 0.3,
  cost_output: 1.2,
  capabilities: ["text", "code"],
};

async function routedTurn(exchanges: ScriptedExchange[]) {
  await using root = await tempWorkspace({ "notes.md": "notes" });
  const run = engineServices(exchanges, {
    models: [ROUTED],
    env: { OPENROUTER_API_KEY: "test-key-not-real" },
  });
  const result = await runTurn(run, {
    prompt: "explore",
    rootOverride: root.root,
    defaultCompanionModel: ROUTED.slug,
    approver: { confirmPaidEscalation: APPROVE_PAID },
  });
  const rows = await eventRows(run, result.sessionId);
  return {
    result,
    response: rows.find((row) => row.event_type === "model_response"),
  };
}

test("a turn whose every call OpenRouter billed records the billed total as billed", async () => {
  const usage = { prompt_tokens: 10, completion_tokens: 2, cost: 0.000004 };
  const { result, response } = await routedTurn([
    toolReply("c1", usage),
    chatReply({ content: "done", usage }),
  ]);
  assertAlmostEqual(result.cost.totalUsd, 0.000008, 1e-12);
  assert.strictEqual(result.cost.basis, "provider_billed");
  assert.partialDeepStrictEqual(response ?? {}, {
    cost_total: "0.000008",
    cost_basis: "provider_billed",
  });
});

test("a turn with any estimated call records its total as an estimate", async () => {
  const { result, response } = await routedTurn([
    toolReply("c1", { prompt_tokens: 10, completion_tokens: 2, cost: 0.000004 }),
    chatReply({
      content: "done",
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    }),
  ]);
  assert.strictEqual(result.cost.basis, "catalog_estimate");
  assert.partialDeepStrictEqual(response ?? {}, {
    cost_basis: "catalog_estimate",
  });
});

test("re-confirms budget ceiling when a later same-size call crosses the session limit", async () => {
  // $15/Mtok input, so one reported input token records $0.000015.
  const priced = pricedLocalModel({ costInput: 15, costOutput: 75 });
  const usage = { prompt_tokens: 1, completion_tokens: 0 };
  const confirmBudgetCeiling = mock.fn(APPROVE_PAID);
  const { run, result } = await gatedTurn(
    [
      toolReply("c1", usage),
      chatReply({ content: "done", usage }),
    ],
    priced,
    {
      defaultPerCallBudgetUsd: 0.00001,
      defaultSessionBudgetUsd: 0.00003,
      approver: {
        confirmPaidEscalation: APPROVE_PAID,
        confirmBudgetCeiling,
      },
    },
  );
  assert.equal(confirmBudgetCeiling.mock.callCount(), 2);
  assert.deepStrictEqual(run.transport.requests.length, 2);
  assert.deepStrictEqual(result?.text, "done");
});

/** Priced so each completion token records $0.01; input is ~free. */
const PER_TOKEN = pricedLocalModel({ costInput: 0.000001, costOutput: 10_000 });

test("rejects an over-budget follow-up call before invoking the provider (tier 1)", async () => {
  // Every reply wants another tool step; the loop must stop on budget, not
  // the step cap. Step 0 spends $0.03, over the $0.02 session limit, so the
  // first follow-up is rejected before a second provider call.
  const usage = { prompt_tokens: 10, completion_tokens: 3 };
  const { run, frames, result } = await gatedTurn(
    Array.from({ length: 4 }, (_, i) => toolReply(`c${i}`, usage)),
    PER_TOKEN,
    {
      defaultSessionBudgetUsd: 0.02,
      approver: {
        confirmPaidEscalation: APPROVE_PAID,
      },
    },
  );
  assert.deepStrictEqual(result?.text, "");
  assert.partialDeepStrictEqual(frames.at(-1)!, {
    type: "turnFailed",
    errorName: "BudgetExceededError",
  });
  assert.deepStrictEqual(run.transport.requests.length, 1);
});

// Estimates are ~0 (input nearly free) so the estimate-based ceiling stays
// silent and only the anomaly gate — which reads ACTUAL recorded spend — is
// exercised. Per-call limit $0.10 × turnMultiple 3 → the turn halts once its
// actual spend passes $0.30; each call records $0.12.
const ANOMALY = {
  defaultPerCallBudgetUsd: 0.10,
  anomalyTurnMultiple: 3,
  anomalyScopeMultiple: 2,
  approver: { confirmPaidEscalation: APPROVE_PAID },
};
const TWELVE_CENTS = { prompt_tokens: 10, completion_tokens: 12 };

test("halts a multi-call turn on ACTUAL accumulated spend, failing closed without a handler", async () => {
  const { run, error } = await gatedTurn(
    [
      toolReply("c1", TWELVE_CENTS),
      toolReply("c2", TWELVE_CENTS),
      toolReply("c3", TWELVE_CENTS),
      chatReply({ content: "never reached", usage: TWELVE_CENTS }),
    ],
    PER_TOKEN,
    ANOMALY,
  );
  assert.deepStrictEqual(error instanceof Error, true);
  assert.deepStrictEqual(
    (error as Error).message.includes("Runaway spend anomaly"),
    true,
  );
  // Calls 1-3 ran ($0.36 recorded); the halt fired BEFORE call 4.
  assert.deepStrictEqual(run.transport.requests.length, 3);
});

test("an approval admits one call only — the next anomalous call prompts again", async () => {
  const confirmRunawayAnomaly = mock.fn((_: RunawayAnomalyWarning) =>
    APPROVE_PAID()
  );
  const { run, result } = await gatedTurn(
    [
      toolReply("c1", TWELVE_CENTS), // pre-check: $0
      toolReply("c2", TWELVE_CENTS), // pre-check: $0.12
      toolReply("c3", TWELVE_CENTS), // pre-check: $0.24
      toolReply("c4", TWELVE_CENTS), // pre-check: $0.36 → prompt 1
      chatReply({ content: "done", usage: TWELVE_CENTS }), // $0.48 → prompt 2
    ],
    PER_TOKEN,
    {
      ...ANOMALY,
      approver: { ...ANOMALY.approver, confirmRunawayAnomaly },
    },
  );
  assert.deepStrictEqual(result?.text, "done");
  assert.deepStrictEqual(run.transport.requests.length, 5);
  // Never persists: BOTH anomalous pre-checks prompted, unlike the ceiling
  // gate's scope-period coverage where the first approval would have
  // silenced the second.
  assert.equal(confirmRunawayAnomaly.mock.callCount(), 2);
  const first = confirmRunawayAnomaly.mock.calls[0].arguments[0];
  assert.deepStrictEqual(first.trigger, "turn_spend");
  assertAlmostEqual(first.turnSpentUsd, 0.36);
});
