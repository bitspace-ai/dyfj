/**
 * Unit tests for `failTurn`, the final stage's failure classification: it
 * branches on the error's real class (instanceof), never on its writable
 * `.name`, so a foreign error cannot claim a class and ride its treatment.
 */
import { assert, assertEquals } from "@std/assert";
import { stub } from "@std/testing/mock";
import { enginePorts } from "../../testing/builders/engine.ts";
import { ContextWindowOverflowError } from "../context/mod.ts";
import type { WorkbenchRuntimeEvent } from "../contract/mod.ts";
import { failTurn } from "./finalize.ts";
import { openSession } from "./open-session.ts";
import type { WorkbenchRuntimeInput } from "./runtime-types.ts";
import { newTurnState } from "./turn-state.ts";
import { createCommandRegistry } from "../tools/mod.ts";

/** Fail an opened turn with `err`; returns its error row, frames and log. */
async function failWith(err: unknown) {
  const { ports, store } = enginePorts();
  const frames: WorkbenchRuntimeEvent[] = [];
  const logged: string[] = [];
  const input: WorkbenchRuntimeInput = {
    mode: "turn",
    prompt: "probe",
    routingOptions: {},
    onRuntimeEvent: (event) => void frames.push(event),
    log: (...parts: unknown[]) => void logged.push(parts.map(String).join(" ")),
  };
  const state = newTurnState(
    await openSession(input, ports),
    createCommandRegistry(),
  );
  const consoleError = stub(console, "error");
  try {
    await failTurn(state, input, ports, err);
  } finally {
    consoleError.restore();
  }
  const rows = await store.events.bySession({
    sessionId: state.session.sessionId,
    limit: 100,
    order: "asc",
  });
  return {
    error: rows.find((row) => row.event_type === "error"),
    frames,
    logged,
    turnError: state.turnError,
  };
}

Deno.test("a foreign Error named after ContextWindowOverflowError does not get its raw message written", async () => {
  const hugePayload = "SELECT ".repeat(20_000);
  const spoofed = new Error(hugePayload);
  spoofed.name = "ContextWindowOverflowError";
  const { error, frames, logged, turnError } = await failWith(spoofed);
  assert(error !== undefined);
  // A real ContextWindowOverflowError writes stop_reason "length"; the
  // spoofed foreign error falls through to the generic branch instead, which
  // writes "error" — proof the instanceof check, not the name, decided.
  assertEquals(error.stop_reason, "error");
  assertEquals(String(error.content).includes(hugePayload), false);
  assertEquals(logged.join("\n").includes(hugePayload), false);
  assertEquals(JSON.stringify(frames).includes(hugePayload), false);
  assertEquals(turnError, spoofed);
});

Deno.test("a real ContextWindowOverflowError is recorded as a length stop", async () => {
  const overflow = new ContextWindowOverflowError({
    modelSlug: "local-chat",
    contextWindow: 8192,
    inputTokens: 8000,
    outputTokens: 100,
  });
  const { error, logged, turnError } = await failWith(overflow);
  assertEquals(error?.stop_reason, "length");
  assert(logged.some((line) => line.includes("/model")));
  assertEquals(turnError, overflow);
});
