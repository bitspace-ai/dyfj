/**
 * Component tests for the spend check (BIT-785): whole native turns over the
 * engine fakes, priced so each scripted call costs exactly what a recorded
 * turn's call cost. The model is priced at $1 per million input tokens and
 * scripts no output tokens, so a call reporting N prompt tokens costs N / 1e6.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, mock } from "node:test";
import {
  chatReply,
  engineServices,
  pricedLocalModel,
  runTurn,
} from "../../testing/builders/engine.ts";
import type { ScriptedExchange } from "../../testing/fakes/scripted-http-transport.ts";
import type { BudgetCeilingWarning } from "../budget/mod.ts";
import type { WorkbenchRuntimeInput } from "./runtime-types.ts";

const PRICED = pricedLocalModel({ costInput: 1, costOutput: 1 });

/**
 * A synthetic implementation turn: 24 calls whose cost rises as the context
 * grows, then levels off, $1.29 in all. Under the old guards (a runaway halt
 * at three times a $0.10 per-call limit, a $1.00 session limit) a turn of
 * this shape stopped three times.
 */
const TURN_CALL_COSTS = [
  0.010, 0.010, 0.015, 0.020, 0.030, 0.035, 0.040, 0.045, 0.050, 0.055,
  0.070, 0.070, 0.070, 0.070, 0.070, 0.070, 0.070, 0.070, 0.070, 0.070,
  0.070, 0.070, 0.070, 0.070,
];

const usage = (costUsd: number) => ({
  prompt_tokens: Math.round(costUsd * 1_000_000),
  completion_tokens: 0,
});

/** A call that asks for one tool and costs `costUsd`. */
function toolCall(
  id: string,
  name: string,
  args: unknown,
  costUsd: number,
): ScriptedExchange {
  return chatReply({
    toolCalls: [{ id, name, arguments: args }],
    usage: usage(costUsd),
  });
}

const approve = () => Promise.resolve({ decision: "approve" as const });

interface SpendRun {
  error: unknown;
  text?: string;
  requests: number;
  ceilingPrompts: BudgetCeilingWarning[];
  /** The turn's log lines. */
  logs: string[];
}

/**
 * Run one priced turn in a workspace holding `files`. Every spend prompt is
 * counted; `decide` answers the ceiling prompts (approve when omitted).
 * `interactive: false` passes no spend handlers at all.
 */
async function spendTurn(
  exchanges: ScriptedExchange[],
  files: string[],
  options: {
    decide?: (w: BudgetCeilingWarning) => Promise<
      { decision: "approve" } | { decision: "deny"; reason?: string }
    >;
    interactive?: boolean;
    input?: Partial<WorkbenchRuntimeInput>;
  } = {},
): Promise<SpendRun> {
  const root = await mkdtemp(join(tmpdir(), "spend-replay-"));
  try {
    for (const file of files) await writeFile(join(root, file), `${file}\n`);
  } catch (err) {
    await rm(root, { recursive: true });
    throw err;
  }
  const run = engineServices(exchanges, { models: [PRICED] });
  const ceilingPrompts: BudgetCeilingWarning[] = [];
  const interactive = options.interactive ?? true;
  const approver: WorkbenchRuntimeInput["approver"] = {
    confirmPaidEscalation: approve,
    ...(interactive
      ? {
        confirmBudgetCeiling: (warning: BudgetCeilingWarning) => {
          ceilingPrompts.push(warning);
          return (options.decide ?? approve)(warning);
        },
      }
      : {}),
  };
  const log = mock.method(console, "log", () => {});
  const warn = mock.method(console, "warn", () => {});
  const error = mock.method(console, "error", () => {});
  const lines: string[] = [];
  const logs = () => [...lines];
  try {
    const result = await runTurn(run, {
      prompt: "implement the leaf",
      rootOverride: root,
      defaultCompanionModel: PRICED.slug,
      approver,
      frames: { log: (...parts: unknown[]) => void lines.push(parts.join(" ")) },
      ...options.input,
    });
    return {
      error: null,
      text: result.text,
      requests: run.transport.requests.length,
      ceilingPrompts,
      logs: logs(),
    };
  } catch (err) {
    return {
      error: err,
      requests: run.transport.requests.length,
      ceilingPrompts,
      logs: logs(),
    };
  } finally {
    log.mock.restore();
    warn.mock.restore();
    error.mock.restore();
    await rm(root, { recursive: true });
  }
}

/** The turn: each call reads a new file; the last call answers. */
function implementationTurn(): { exchanges: ScriptedExchange[]; files: string[] } {
  const steps = TURN_CALL_COSTS.length - 1;
  const files = Array.from({ length: steps }, (_, i) => `f${i + 1}.txt`);
  const exchanges = files.map((file, i) =>
    toolCall(`c${i + 1}`, "read_file", { path: file }, TURN_CALL_COSTS[i])
  );
  exchanges.push(chatReply({
    content: "done",
    usage: usage(TURN_CALL_COSTS[steps]),
  }));
  return { exchanges, files };
}

/**
 * A runaway: every call names read_file with arguments it rejects, so each
 * call fails and no step makes tool progress, at $0.07 a call. The arguments
 * differ each time, so the loop's repeat detection does not end the turn.
 */
function runawayTurn(calls = 12): ScriptedExchange[] {
  return Array.from(
    { length: calls },
    (_, i) => toolCall(`m${i + 1}`, "read_file", { file: `f${i + 1}` }, 0.07),
  );
}

describe("a typical implementation turn under the default spend limits", () => {
  it("runs all 24 calls to the end without a spend prompt", async () => {
    const { exchanges, files } = implementationTurn();
    const run = await spendTurn(exchanges, files);
    assert.strictEqual(run.error, null);
    assert.strictEqual(run.text, "done");
    assert.strictEqual(run.requests, 24);
    assert.strictEqual(run.ceilingPrompts.length, 0);
  });
});

describe("a runaway turn under the default spend limits", () => {
  it("prompts once, naming the runaway check, after $0.50 with no tool progress", async () => {
    const run = await spendTurn(runawayTurn(), []);
    assert.strictEqual(run.ceilingPrompts.length, 1);
    const [warning] = run.ceilingPrompts;
    assert.strictEqual(warning.reason, "runaway_stall");
    // Seven failed calls ($0.49) stay under the limit; the eighth passes it.
    assert.ok(warning.stallCostSoFarUsd > 0.5, String(warning.stallCostSoFarUsd));
    assert.ok(warning.stallCostSoFarUsd < 0.6, String(warning.stallCostSoFarUsd));
    assert.strictEqual(warning.runawayStallUsd, 0.5);
    assert.ok(
      warning.raisesToUsd.runaway_stall! >= 2 * warning.stallCostSoFarUsd,
    );
  });

  it("a declined prompt ends the turn with no further provider call", async () => {
    const run = await spendTurn(runawayTurn(), [], {
      decide: () => Promise.resolve({ decision: "deny", reason: "runaway" }),
    });
    assert.strictEqual(run.ceilingPrompts.length, 1);
    // Eight calls ran; the check stopped the ninth before it was sent.
    assert.strictEqual(run.requests, 8);
  });

  it("fails closed with no spend handler", async () => {
    const run = await spendTurn(runawayTurn(), [], { interactive: false });
    // The turn ends as a refused spend, the way every limit ends one.
    assert.strictEqual(run.requests, 8);
    assert.ok(
      run.logs.some((line) =>
        line.includes("Budget exceeded") && line.includes("runaway_stall")
      ),
      run.logs.join("\n"),
    );
  });
});

describe("one set of figures", () => {
  it("a turn limit set for the turn prompts once per doubling, stating each raise", async () => {
    const { exchanges, files } = implementationTurn();
    const run = await spendTurn(exchanges, files, {
      input: { turnLimitUsd: 0.2 },
    });
    assert.strictEqual(run.error, null);
    // $1.29 against a $0.20 limit doubled at each approval: three crossings.
    assert.strictEqual(run.ceilingPrompts.length, 3);
    for (const prompt of run.ceilingPrompts) {
      assert.deepStrictEqual(prompt.crossedScopes, ["turn_limit"]);
      assert.strictEqual(prompt.turnLimitUsd, 0.2);
      // One session, one turn: the prompt's session figure is the turn's.
      assert.strictEqual(prompt.sessionCostSoFarUsd, prompt.turnCostSoFarUsd);
    }
    // Each prompt comes only once spend passes the level the last one raised.
    for (let i = 1; i < run.ceilingPrompts.length; i++) {
      const prev = run.ceilingPrompts[i - 1];
      const next = run.ceilingPrompts[i];
      assert.ok(
        next.turnCostSoFarUsd + next.estimatedCostUsd >
          prev.raisesToUsd.turn_limit!,
      );
    }
  });
});
