/**
 * Unit tests for the `loadTranscript` stage after the real earlier stages:
 * which history the first call carries, and when it is left untouched. The
 * compression paths are covered by `compression.component.test.ts`.
 */
import { assertEquals } from "@std/assert";
import {
  enginePorts,
  LOCAL_MODEL,
  tempWorkspace,
} from "../../testing/builders/engine.ts";
import type { WorkbenchMessage } from "../providers/mod.ts";
import type { ModelSeed } from "../store/mod.ts";
import { createCommandRegistry } from "../tools/mod.ts";
import { budgetGate } from "./budget-gate.ts";
import { buildContext } from "./build-context.ts";
import { loadTranscript } from "./load-transcript.ts";
import { openSession } from "./open-session.ts";
import type { RoutedTurn } from "./routed-turn.ts";
import type { WorkbenchRuntimeInput } from "./runtime-types.ts";
import { newTurnState } from "./turn-state.ts";

const HISTORY: WorkbenchMessage[] = [
  { role: "user", content: "earlier question" },
  { role: "assistant", content: "earlier answer" },
];

async function routed(
  input: Partial<WorkbenchRuntimeInput>,
  model: ModelSeed,
  root: string,
): Promise<RoutedTurn> {
  const fakes = enginePorts({ models: [model] });
  const full: WorkbenchRuntimeInput = {
    mode: "turn",
    prompt: "now",
    routingOptions: {},
    rootOverride: root,
    defaultCompanionModel: model.slug,
    ...input,
  };
  const session = await openSession(full, fakes.ports);
  const state = newTurnState(session, createCommandRegistry());
  await buildContext(state, full, fakes.ports);
  const route = await budgetGate(state, full, fakes.ports);
  return {
    state,
    input: full,
    ports: fakes.ports,
    route,
    observed: {} as RoutedTurn["observed"],
  };
}

Deno.test("a companion turn carries its history, then the current prompt", async () => {
  await using root = await tempWorkspace();
  const turn = await routed(
    { conversationMessages: HISTORY },
    { ...LOCAL_MODEL, context_window: 1_000_000 },
    root.root,
  );
  assertEquals(await loadTranscript(turn), [
    ...HISTORY,
    { role: "user", content: "now" },
  ]);
});

Deno.test("ask and next-work turns carry no history", async () => {
  await using root = await tempWorkspace({ "README.md": "ROOT" });
  for (const mode of ["ask", "next-work"] as const) {
    const turn = await routed(
      { mode, conversationMessages: HISTORY },
      LOCAL_MODEL,
      root.root,
    );
    const messages = await loadTranscript(turn);
    assertEquals(messages.length, 1);
    assertEquals(messages[0].content, turn.state.modelPrompt);
  }
});

Deno.test("a model without a known window never triggers proactive compression", async () => {
  await using root = await tempWorkspace();
  const unknownWindow = {
    ...LOCAL_MODEL,
    context_window: undefined,
  } as unknown as ModelSeed;
  const turn = await routed(
    { conversationMessages: HISTORY },
    unknownWindow,
    root.root,
  );
  // No provider call is made: the stage never reaches the compressor.
  assertEquals(await loadTranscript(turn), [
    ...HISTORY,
    { role: "user", content: "now" },
  ]);
});
