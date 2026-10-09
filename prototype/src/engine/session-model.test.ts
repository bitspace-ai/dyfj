import { assertEquals, assertStrictEquals, assertThrows } from "@std/assert";
import {
  WorkbenchModelNotFoundError,
  WorkbenchModelNotRoutableError,
} from "../providers/mod.ts";
import { SessionModelUnavailableError } from "./errors.ts";
import type { WorkbenchRuntimeInput } from "./runtime-types.ts";
import {
  explainSessionModelFailure,
  sessionRouteReason,
  withSessionModel,
} from "./session-model.ts";

const recorded = (slug: string | null) => ({
  calls: [] as string[],
  latestSelectedModel(sessionId: string) {
    this.calls.push(sessionId);
    return Promise.resolve(slug);
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
  assertEquals(input.routingOptions, { fast: true, modelId: "hosted/big" });
  assertEquals(input.restoredSessionModel, "hosted/big");
  assertEquals(sessionRouteReason(input, "explicit_model_id"), "session_model");
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
    assertStrictEquals(await withSessionModel(input, reader), input);
    assertEquals(reader.calls, []);
    assertEquals(
      sessionRouteReason(input, "explicit_model_id"),
      "explicit_model_id",
    );
  }
});

Deno.test("a session with no recorded model resumes unchanged", async () => {
  const input = turn({ sessionId: "S1" });
  assertStrictEquals(await withSessionModel(input, recorded(null)), input);
});

Deno.test("a routing failure on the recorded model names it; others pass through", () => {
  const restored = turn({
    sessionId: "S1",
    restoredSessionModel: "gone/model",
  });
  const missing = assertThrows(
    () =>
      explainSessionModelFailure(
        restored,
        new WorkbenchModelNotFoundError("gone/model"),
      ),
    SessionModelUnavailableError,
  );
  assertEquals(missing.message.includes("not in the catalog"), true);
  assertThrows(
    () =>
      explainSessionModelFailure(
        restored,
        new WorkbenchModelNotRoutableError("gone/model"),
      ),
    SessionModelUnavailableError,
    "unpriced",
  );
  const other = new Error("boom");
  assertThrows(
    () => explainSessionModelFailure(restored, other),
    Error,
    "boom",
  );
  assertThrows(
    () =>
      explainSessionModelFailure(
        turn({}),
        new WorkbenchModelNotFoundError("x"),
      ),
    WorkbenchModelNotFoundError,
  );
});
