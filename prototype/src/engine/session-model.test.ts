import { captureThrow } from "../../testing/assertions/captured.ts";
import assert from "node:assert/strict";
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
import {
  explainSessionModelFailure,
  sessionRouteReason,
  withSessionModel,
} from "./session-model.ts";

const recorded = (slug: string | null, runner?: string) => ({
  calls: [] as string[],
  latestRun(sessionId: string): Promise<SessionLastRun | null> {
    this.calls.push(sessionId);
    if (runner !== undefined) {
      return Promise.resolve({ kind: "runner", profile: runner });
    }
    return Promise.resolve(slug === null ? null : { kind: "model", slug });
  },
});

function turn(fields: Partial<WorkbenchRuntimeInput>): WorkbenchRuntimeInput {
  return { mode: "turn", prompt: "hi", routingOptions: {}, ...fields };
}

Deno.test("a resumed turn with no routing of its own takes the recorded model", async () => {
  const input = await withSessionModel(
    turn({ sessionId: "S1", routingOptions: { fast: true } }),
    recorded("hosted/big"),
  );
  assert.deepStrictEqual(input.routingOptions, { fast: true, modelId: "hosted/big" });
  assert.deepStrictEqual(input.restoredSessionModel, "hosted/big");
  assert.deepStrictEqual(sessionRouteReason(input, "explicit_model_id"), "session_model");
});

Deno.test("an explicit model, tier, hint or runner, or a new session, is left alone", async () => {
  const cases: WorkbenchRuntimeInput[] = [
    turn({ sessionId: "S1", routingOptions: { modelId: "m" } }),
    turn({ sessionId: "S1", routingOptions: { tier: 1 } }),
    turn({ sessionId: "S1", routingOptions: { hint: "code" } }),
    turn({ sessionId: "S1", runner: { kind: "acp", profile: "fixture" } }),
    turn({}),
  ];
  for (const input of cases) {
    const reader = recorded("hosted/big");
    assert.strictEqual(await withSessionModel(input, reader), input);
    assert.deepStrictEqual(reader.calls, []);
    assert.deepStrictEqual(
      sessionRouteReason(input, "explicit_model_id"),
      "explicit_model_id",
    );
  }
});

Deno.test("a session with no recorded model resumes unchanged", async () => {
  const input = turn({ sessionId: "S1" });
  assert.strictEqual(await withSessionModel(input, recorded(null)), input);
});

Deno.test("a routing failure on the recorded model names it; others pass through", () => {
  const restored = turn({
    sessionId: "S1",
    restoredSessionModel: "gone/model",
  });
  const missing = captureThrow(
    () =>
      explainSessionModelFailure(
        restored,
        new WorkbenchModelNotFoundError("gone/model"),
      ),
    SessionModelUnavailableError,
  );
  assert.deepStrictEqual(missing.message.includes("not in the catalog"), true);
  assert.throws(() =>
      explainSessionModelFailure(
        restored,
        new WorkbenchModelNotRoutableError("gone/model"),
      ), (error: unknown) => error instanceof SessionModelUnavailableError && error.message.includes("unpriced"));
  const other = new Error("boom");
  assert.throws(() => explainSessionModelFailure(restored, other), (error: unknown) => error instanceof Error && error.message.includes("boom"));
  assert.throws(
    () =>
      explainSessionModelFailure(
        turn({}),
        new WorkbenchModelNotFoundError("x"),
      ),
    WorkbenchModelNotFoundError,
  );
});

Deno.test("a session that last ran on an external-agent runner refuses a bare resume", async () => {
  await assert.rejects(() =>
      withSessionModel(
        turn({ sessionId: "S1" }),
        recorded(null, "codex-chatgpt"),
      ), (error: unknown) => error instanceof SessionRunnerNotRestorableError && error.message.includes("codex-chatgpt"));
  // An explicit model is the operator's choice and needs no lookup.
  const explicit = turn({ sessionId: "S1", routingOptions: { modelId: "m" } });
  assert.strictEqual(
    await withSessionModel(explicit, recorded(null, "codex-chatgpt")),
    explicit,
  );
});
