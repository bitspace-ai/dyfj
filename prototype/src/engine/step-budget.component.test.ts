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
  for (let index = 0; index < 128; index++) {
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

test("a productive turn runs past 64 steps toward the default ceiling of 128", async () => {
  // The bound the issue is about: 64 steps of genuine progress used to end the
  // turn there. With the default ceiling at 128 and 16-step chunks, step 64
  // is inside an extension the turn already earned.
  const steps: ScriptedExchange[] = [
    ...Array.from({ length: 100 }, (_, index) => productiveStep(index)),
    chatReply({ content: "explored everything" }),
  ];
  const { frames, result, error } = await loopTurn(steps, {
    prompt: "work through the notes",
    maxToolSteps: 32,
    maxToolStepsCeiling: 128,
  });
  assert.strictEqual(error, null);
  assert.ok(
    (result?.agent.toolStepsUsed ?? 0) > 64,
    `the turn stopped at ${result?.agent.toolStepsUsed} steps`,
  );
  assert.strictEqual(result?.agent.toolStepsUsed, 100);
  assert.strictEqual(result?.agent.limitReached, false);
  // One extension per chunk reached: 32 -> 48 -> ... -> 112 covers step 100.
  const extensions = frames.filter((f) => f.type === "stepBudgetExtended");
  assert.deepStrictEqual(
    extensions.map((f) => [f.from, f.to]),
    [[32, 48], [48, 64], [64, 80], [80, 96], [96, 112]],
  );
});

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
  // Soft budget 2: the unproductive second step buys no chunk, so the turn
  // ends there instead of running on to 12.
  assert.strictEqual(result?.agent.toolStepsUsed, 2);
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

test("with extension off a fixed-limit turn records no step-budget decision", async () => {
  // The fixed limit must behave as it always did: no `step_budget` event, no
  // `(stopped: limit)` receipt suffix. The turn ends on the limit itself.
  const steps = Array.from({ length: 6 }, (_, index) => productiveStep(index));
  const loop = await loopTurn(steps, {
    prompt: "work through the notes",
    maxToolSteps: 2,
    maxToolStepsCeiling: 8,
    stepExtension: false,
  });
  assert.strictEqual(loop.error, null);
  assert.strictEqual(loop.result?.agent.toolStepsUsed, 2);
  assert.strictEqual(loop.result?.agent.maxToolSteps, 2);
  assert.strictEqual(loop.result?.agent.limitReached, true);
  assert.strictEqual(loop.result?.agent.softToolSteps, undefined);
  assert.strictEqual(loop.result?.agent.stepStopReason, undefined);
  assert.deepStrictEqual(await stepBudgetRows(loop), []);
  assert.deepStrictEqual(
    loop.frames.filter((f) => f.type === "stepBudgetExtended"),
    [],
  );
  assert.deepStrictEqual(
    loop.frames.filter((f) => f.type === "stepBudgetStopped"),
    [],
  );
  // The receipt reads as the fixed-limit receipt always did.
  assert.match(String(loop.result?.receipt), /Tool steps: 2\/2 \(limit reached/);
  assert.strictEqual(
    String(loop.result?.receipt).includes("stopped:"),
    false,
    String(loop.result?.receipt),
  );
});

test("a session's own tool-step limit is a hard cap that does not extend", async () => {
  // `--tool-steps N` / `/steps N` are the operator's predictable override: the
  // turn stops at N whatever its progress, and only the configured default
  // extends toward the ceiling.
  const steps = Array.from({ length: 12 }, (_, index) => productiveStep(index));
  const loop = await loopTurn(steps, {
    prompt: "work through the notes",
    maxToolSteps: 4,
    maxToolStepsCeiling: 64,
    toolStepsOverride: true,
  });
  assert.strictEqual(loop.error, null);
  assert.strictEqual(loop.result?.agent.toolStepsUsed, 4);
  assert.strictEqual(loop.result?.agent.maxToolSteps, 4);
  assert.strictEqual(loop.result?.agent.limitReached, true);
  assert.strictEqual(loop.result?.agent.stepStopReason, undefined);
  assert.deepStrictEqual(
    loop.frames.filter((f) => f.type === "stepBudgetExtended"),
    [],
  );
  assert.deepStrictEqual(await stepBudgetRows(loop), []);
});

test("the receipt names a stall stop in one parenthetical, without claiming a limit", async () => {
  // A stall stop at 3 of 12 steps is not a limit being reached, and the receipt
  // is read by a human who should not be told otherwise.
  const steps = Array.from({ length: 6 }, (_, index) =>
    toolReply([{
      id: `s${index}`,
      name: "read_file",
      arguments: { path: `missing-${index}.md` },
    }])
  );
  const { result, error } = await loopTurn(steps, {
    prompt: "loop without progress",
    maxToolSteps: 2,
    maxToolStepsCeiling: 12,
  });
  assert.strictEqual(error, null);
  assert.strictEqual(result?.agent.stepStopReason, "stall");
  const line = String(result?.receipt)
    .split("\n")
    .find((text) => text.startsWith("Tool steps:")) ?? "";
  // One parenthetical, no claim that a limit was reached, and the handoff
  // marker folded in rather than appended as a second group.
  assert.match(line, /\(soft 2, stopped: stall/);
  assert.strictEqual(line.includes("limit reached"), false, line);
  assert.strictEqual(line.split("(").length, 2, line);
});

test("a stall handoff names the step the turn stopped at, not its limit", async () => {
  // Soft 4, ceiling 12: steps 1-3 make progress, step 4 is unproductive and
  // arrives at the limit with nothing to extend, so the turn ends at 4 of 4.
  // The handoff must say 4, and must say one unproductive step ended the turn.
  const steps = [
    ...Array.from({ length: 3 }, (_, index) => productiveStep(index)),
    ...Array.from({ length: 3 }, (_, index) =>
      toolReply([{
        id: `x${index}`,
        name: "read_file",
        arguments: { path: `missing-${index}.md` },
      }])
    ),
  ];
  const { run, result, error } = await loopTurn(steps, {
    prompt: "stall at the limit",
    maxToolSteps: 4,
    maxToolStepsCeiling: 12,
  });
  assert.strictEqual(error, null);
  assert.strictEqual(result?.agent.toolStepsUsed, 4);
  assert.strictEqual(result?.agent.stepStopReason, "stall");
  const handoff = JSON.stringify(run.transport.requests.at(-1)?.body);
  assert.ok(
    handoff.includes("tool use ended at 4 steps"),
    `expected the handoff to name step 4, got ${handoff}`,
  );
  assert.ok(
    handoff.includes("one tool step added nothing new"),
    `expected the streak-1 wording, got ${handoff}`,
  );
  assert.strictEqual(handoff.includes("consecutive"), false, handoff);
});

test("a two-step stall handoff names the step it stopped at, not the limit", async () => {
  // Soft 8, ceiling 32: eight productive steps extend the limit to 12, and two
  // unproductive steps then end the turn at 10 — inside a chunk that runs to
  // 12. The handoff must name step 10 and may not claim a 12-step limit.
  const steps = [
    ...Array.from({ length: 8 }, (_, index) => productiveStep(index)),
    ...Array.from({ length: 4 }, (_, index) =>
      toolReply([{
        id: `x${index}`,
        name: "read_file",
        arguments: { path: `missing-${index}.md` },
      }])
    ),
  ];
  const { run, result, error } = await loopTurn(steps, {
    prompt: "stall mid-chunk",
    maxToolSteps: 8,
    maxToolStepsCeiling: 32,
  });
  assert.strictEqual(error, null);
  assert.strictEqual(result?.agent.toolStepsUsed, 10);
  assert.strictEqual(result?.agent.maxToolSteps, 12);
  assert.strictEqual(result?.agent.stepStopReason, "stall");
  const handoff = JSON.stringify(run.transport.requests.at(-1)?.body);
  assert.ok(
    handoff.includes("tool use ended at 10 steps"),
    `expected the handoff to name step 10, got ${handoff}`,
  );
  assert.ok(
    handoff.includes("2 consecutive tool steps added nothing new"),
    `expected the streak-2 wording, got ${handoff}`,
  );
  assert.strictEqual(handoff.includes("12 steps"), false, handoff);
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
