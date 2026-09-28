/**
 * Component tests for the per-call gates and accounting of the agent loop's
 * provider calls (`observed-turn.ts`): every call is budget-gated before it
 * is made and recorded after, so multi-call turns aggregate their usage and
 * stop on actual spend. Whole turns run over the engine fakes; tool steps run
 * the real `list_files` tool on a temp workspace.
 */
import {
  assertAlmostEquals,
  assertEquals,
  assertObjectMatch,
} from "@std/assert";
import { assertSpyCalls, spy } from "@std/testing/mock";
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
  usage: { prompt_tokens: number; completion_tokens: number },
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

Deno.test("budgets and records every provider call so the receipt aggregates the whole turn", async () => {
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
  assertEquals(result?.tokens.input, 30);
  assertEquals(result?.tokens.output, 6);
  assertEquals(result?.tokens.totalCalls, 3);
  const rows = await eventRows(run, result!.sessionId);
  const response = rows.find((row) => row.event_type === "model_response");
  assertObjectMatch(response ?? {}, {
    tokens_input: "30",
    tokens_output: "6",
  });
});

Deno.test("re-confirms budget ceiling when a later same-size call crosses the session limit", async () => {
  // $15/Mtok input, so one reported input token records $0.000015.
  const priced = pricedLocalModel({ costInput: 15, costOutput: 75 });
  const usage = { prompt_tokens: 1, completion_tokens: 0 };
  const confirmBudgetCeiling = spy(APPROVE_PAID);
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
  assertSpyCalls(confirmBudgetCeiling, 2);
  assertEquals(run.transport.requests.length, 2);
  assertEquals(result?.text, "done");
});

/** Priced so each completion token records $0.01; input is ~free. */
const PER_TOKEN = pricedLocalModel({ costInput: 0.000001, costOutput: 10_000 });

Deno.test("rejects an over-budget follow-up call before invoking the provider (tier 1)", async () => {
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
  assertEquals(result?.text, "");
  assertObjectMatch(frames.at(-1)!, {
    type: "turnFailed",
    errorName: "BudgetExceededError",
  });
  assertEquals(run.transport.requests.length, 1);
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

Deno.test("halts a multi-call turn on ACTUAL accumulated spend, failing closed without a handler", async () => {
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
  assertEquals(error instanceof Error, true);
  assertEquals(
    (error as Error).message.includes("Runaway spend anomaly"),
    true,
  );
  // Calls 1-3 ran ($0.36 recorded); the halt fired BEFORE call 4.
  assertEquals(run.transport.requests.length, 3);
});

Deno.test("an approval admits one call only — the next anomalous call prompts again", async () => {
  const confirmRunawayAnomaly = spy((_: RunawayAnomalyWarning) =>
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
  assertEquals(result?.text, "done");
  assertEquals(run.transport.requests.length, 5);
  // Never persists: BOTH anomalous pre-checks prompted, unlike the ceiling
  // gate's scope-period coverage where the first approval would have
  // silenced the second.
  assertSpyCalls(confirmRunawayAnomaly, 2);
  const first = confirmRunawayAnomaly.calls[0].args[0];
  assertEquals(first.trigger, "turn_spend");
  assertAlmostEquals(first.turnSpentUsd, 0.36);
});
