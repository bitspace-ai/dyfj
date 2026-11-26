/**
 * Component tests for the progress-aware tool-step budget (BIT-992): whole
 * native turns where the scripted provider keeps requesting tools, so the
 * step budget — not the model — decides where the turn ends.
 *
 * A productive turn (each step reads a path it has not read yet) must run past
 * its soft step budget toward the safety ceiling; a stalled turn (the same
 * call every step) must stop early; the ceiling must still bound the most
 * productive turn; and spent dollar budgets must stop the turn before any
 * extension.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  chatReply,
  type EngineRun,
  engineServices,
  eventRows,
  pricedLocalModel,
  runTurn,
} from "../../testing/builders/engine.ts";
import type { ModelSeed } from "../store/mod.ts";

/** An approver that says yes to everything: the paid opt-in and the ceiling. */
const approvePaid = () => Promise.resolve({ decision: "approve" as const });
import type { ScriptedExchange } from "../../testing/fakes/scripted-http-transport.ts";
import type { WorkbenchRuntimeEvent } from "../contract/mod.ts";
import type {
  NativeWorkbenchRuntimeResult,
  WorkbenchRuntimeInput,
} from "./runtime-types.ts";

type ToolCall = { id: string; name: string; arguments: unknown };

const HANDOFF_REPLY =
  "**Done:** explored.\n**Next:** keep going.\n**Uncommitted state:** none known.";

function toolReply(calls: ToolCall[], text = ""): ScriptedExchange {
  return chatReply({ content: text, toolCalls: calls });
}

/** A read of a distinct path per step: genuine forward progress. */
function productiveStep(index: number, text = ""): ScriptedExchange {
  return toolReply([{
    id: `p${index}`,
    name: "read_file",
    arguments: { path: `notes-${index}.md` },
  }], text);
}

/** A turn that keeps requesting tools, and the run it produced. */
interface LoopRun {
  run: EngineRun;
  frames: WorkbenchRuntimeEvent[];
  result?: NativeWorkbenchRuntimeResult;
  error: unknown;
  root: string;
}

async function loopTurn(
  exchanges: ScriptedExchange[],
  input: Partial<WorkbenchRuntimeInput> = {},
  models?: ModelSeed[],
): Promise<LoopRun> {
  const root = await mkdtemp(join(tmpdir(), "engine-step-budget-"));
  // Every path a productive step reads exists, so the tool succeeds.
  for (let index = 0; index < 40; index++) {
    await writeFile(`${root}/notes-${index}.md`, `note ${index}\n`);
  }
  const run = engineServices(exchanges, models === undefined ? {} : { models });
  const frames: WorkbenchRuntimeEvent[] = [];
  try {
    const result = await runTurn(run, {
      prompt: "explore",
      rootOverride: root,
      ...input,
      frames: {
        onRuntimeEvent: (event) => void frames.push(event),
        ...input.frames,
      },
    });
    return { run, frames, result, error: null, root };
  } catch (error) {
    return { run, frames, error, root };
  } finally {
    await rm(root, { recursive: true });
  }
}

async function stepBudgetRows(loop: LoopRun) {
  const sessionId = loop.frames.find((f) => f.type === "sessionStart")
    ?.sessionId;
  const rows = await eventRows(loop.run, sessionId!);
  return rows.filter((row) => row.event_type === "step_budget");
}

test("a productive turn runs past its soft step budget instead of stopping there", async () => {
  const steps = Array.from({ length: 12 }, (_, index) =>
    productiveStep(index, index === 11 ? HANDOFF_REPLY : "")
  );
  const { run, frames, result, error } = await loopTurn(steps, {
    prompt: "work through the notes",
    maxToolSteps: 2,
    maxToolStepsCeiling: 8,
  });
  assert.strictEqual(error, null);
  // The turn passed its soft budget of 2 and stopped at the ceiling of 8,
  // not at the soft limit.
  assert.strictEqual(result?.agent.toolStepsUsed, 8);
  assert.strictEqual(result?.agent.maxToolSteps, 8);
  assert.strictEqual(result?.agent.limitReached, true);
  assert.ok(run.transport.requests.length >= 9);
  // The extension is announced as it happens: the first one starts at the
  // soft limit, and every later one starts where the previous one ended.
  const extensions = frames.filter((f) => f.type === "stepBudgetExtended");
  assert.ok(extensions.length > 0, "no extension was announced");
  assert.deepStrictEqual(
    { from: extensions[0]!.from, softLimit: extensions[0]!.softLimit },
    { from: 2, softLimit: 2 },
  );
  assert.ok(extensions.every((f) => f.to > f.from));
  assert.ok(
    frames.some((f) => f.type === "toolStepLimitReached" && f.maxSteps === 8),
  );
});

test("a stalled turn stops early, well inside its safety ceiling", async () => {
  // Distinct paths, every one of them missing: each call is new (so the repeat
  // guard never fires) and every one fails, so no step makes progress.
  const steps = Array.from({ length: 10 }, (_, index) =>
    toolReply([{
      id: `s${index}`,
      name: "read_file",
      arguments: { path: `missing-${index}.md` },
    }])
  );
  const { frames, result, error } = await loopTurn(steps, {
    prompt: "loop without progress",
    maxToolSteps: 2,
    maxToolStepsCeiling: 12,
  });
  assert.strictEqual(error, null);
  // Soft budget 2, then the stall tolerance: the turn ends at 3 steps, not 12.
  assert.strictEqual(result?.agent.toolStepsUsed, 3);
  assert.strictEqual(result?.agent.limitReached, true);
  assert.strictEqual(result?.agent.stepStopReason, "stall");
  assert.ok(
    frames.some((f) => f.type === "stepBudgetStopped" && f.reason === "stall"),
  );
});

test("the safety ceiling bounds even the most productive turn", async () => {
  const steps = Array.from({ length: 20 }, (_, index) => productiveStep(index));
  const { result, error } = await loopTurn(steps, {
    prompt: "keep going forever",
    maxToolSteps: 1,
    maxToolStepsCeiling: 3,
  });
  assert.strictEqual(error, null);
  assert.strictEqual(result?.agent.toolStepsUsed, 3);
  assert.strictEqual(result?.agent.maxToolSteps, 3);
  assert.strictEqual(result?.agent.stepStopReason, "ceiling");
});

test("a spent turn budget stops the turn before any extension", async () => {
  // A priced model and a turn limit the first call already crosses: once the
  // operator approves that call, the turn has no headroom left, so the step
  // budget stops rather than extending, even though the step made progress.
  const priced = pricedLocalModel({ costInput: 15, costOutput: 75 });
  const steps = Array.from({ length: 8 }, (_, index) => productiveStep(index));
  const run = await loopTurn(
    steps,
    {
      prompt: "work through the notes",
      defaultCompanionModel: priced.slug,
      maxToolSteps: 1,
      maxToolStepsCeiling: 8,
      defaultTurnBudgetUsd: 0.000001,
      approver: {
        confirmPaidEscalation: approvePaid,
        confirmBudgetCeiling: approvePaid,
      },
    },
    [priced],
  );
  assert.strictEqual(run.error, null);
  assert.strictEqual(run.result?.agent.toolStepsUsed, 1);
  assert.strictEqual(run.result?.agent.limitReached, true);
  assert.strictEqual(run.result?.agent.stepStopReason, "budget");
  assert.deepStrictEqual(
    run.frames.some((f) => f.type === "stepBudgetExtended"),
    false,
  );
});

test("step-budget decisions are recorded in the durable event log", async () => {
  const steps = Array.from({ length: 8 }, (_, index) => productiveStep(index));
  const loop = await loopTurn(steps, {
    prompt: "work through the notes",
    maxToolSteps: 2,
    maxToolStepsCeiling: 4,
  });
  const rows = await stepBudgetRows(loop);
  assert.ok(rows.length >= 2, `expected step_budget rows, got ${rows.length}`);
  const decisions = rows.map((row) => JSON.parse(String(row.content)));
  assert.ok(decisions.some((entry) => entry.decision === "extended"));
  assert.ok(decisions.some((entry) => entry.decision === "stop"));
  for (const entry of decisions) {
    assert.strictEqual(entry.softLimit, 2);
    assert.strictEqual(entry.ceiling, 4);
  }
});

test("the receipt reports the effective step policy", async () => {
  const steps = Array.from({ length: 8 }, (_, index) => productiveStep(index));
  const { result } = await loopTurn(steps, {
    prompt: "work through the notes",
    maxToolSteps: 2,
    maxToolStepsCeiling: 4,
  });
  assert.match(String(result?.receipt), /Tool steps: 4\/4 \(/);
  assert.match(String(result?.receipt), /soft 2/);
});
