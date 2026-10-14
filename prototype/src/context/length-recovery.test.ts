import assert from "node:assert/strict";
import { it } from "@std/testing/bdd";
import {
  buildContextOverflowMessage,
  buildContinuationMessages,
  classifyLengthStop,
  CONTEXT_OVERFLOW_WINDOW_FRACTION,
  ContextWindowOverflowError,
  isBudgetRefusal,
  LENGTH_CONTINUATION_NUDGE,
} from "./length-recovery.ts";
import type { WorkbenchMessage } from "../providers/mod.ts";

// --- classifyLengthStop ---

Deno.test("classifyLengthStop: output at the catalog output cap is output-budget exhaustion", () => {
  assert.strictEqual(
    classifyLengthStop(
      { contextWindow: 128_000, maxOutputTokens: 16_000 },
      { input: 4_000, output: 16_000 },
    ),
    "output_budget_exhausted",
  );
});

Deno.test("classifyLengthStop: the output cap wins even at the window edge — the generator could not have continued", () => {
  assert.strictEqual(
    classifyLengthStop(
      { contextWindow: 8192, maxOutputTokens: 1024 },
      { input: 7168, output: 1024 },
    ),
    "output_budget_exhausted",
  );
});

Deno.test("classifyLengthStop: filling the window with output short of the cap is context overflow", () => {
  assert.strictEqual(
    classifyLengthStop(
      { contextWindow: 8192, maxOutputTokens: 1024 },
      { input: 7900, output: 292 },
    ),
    "context_overflow",
  );
});

Deno.test("classifyLengthStop: window evidence works without a declared output cap", () => {
  assert.strictEqual(
    classifyLengthStop(
      { contextWindow: 100 },
      { input: 90, output: 9 },
    ),
    "context_overflow",
  );
});

Deno.test("classifyLengthStop: usage below the overflow fraction of the window is output-budget exhaustion", () => {
  assert.strictEqual(
    classifyLengthStop(
      { contextWindow: 100 },
      { input: 50, output: 10 },
    ),
    "output_budget_exhausted",
  );
  // Just under the threshold stays exhaustion; at it flips to overflow.
  const window = 1000;
  const threshold = window * CONTEXT_OVERFLOW_WINDOW_FRACTION;
  assert.strictEqual(
    classifyLengthStop({ contextWindow: window }, {
      input: threshold - 1,
      output: 0,
    }),
    "output_budget_exhausted",
  );
  assert.strictEqual(
    classifyLengthStop({ contextWindow: window }, {
      input: threshold,
      output: 0,
    }),
    "context_overflow",
  );
});

Deno.test("classifyLengthStop: no catalog limits defaults to output-budget exhaustion (overflow needs positive evidence)", () => {
  assert.strictEqual(
    classifyLengthStop({}, { input: 1_000_000, output: 5 }),
    "output_budget_exhausted",
  );
});

// --- buildContinuationMessages ---

Deno.test("buildContinuationMessages: appends the partial assistant turn and the continuation nudge without mutating the input", () => {
  const messages: WorkbenchMessage[] = [
    { role: "user", content: "write a long report" },
  ];
  const continuation = buildContinuationMessages(messages, "partial repo");

  assert.deepStrictEqual(messages.length, 1);
  assert.deepStrictEqual(continuation, [
    { role: "user", content: "write a long report" },
    { role: "assistant", content: "partial repo" },
    { role: "user", content: LENGTH_CONTINUATION_NUDGE },
  ]);
});

// --- context overflow failure ---

Deno.test("context overflow failure: the operator message names the condition and both ways out", () => {
  const message = buildContextOverflowMessage({
    modelSlug: "laguna-xs.2",
    contextWindow: 8192,
    inputTokens: 8000,
    outputTokens: 100,
  });

  assert.ok(
    message.includes("Context window overflow"),
    `expected ${JSON.stringify(message)} to include "Context window overflow"`,
  );
  assert.ok(
    message.includes("laguna-xs.2"),
    `expected ${JSON.stringify(message)} to include "laguna-xs.2"`,
  );
  assert.ok(
    message.includes("8192-token context window"),
    `expected ${
      JSON.stringify(message)
    } to include "8192-token context window"`,
  );
  assert.ok(
    message.includes("/model"),
    `expected ${JSON.stringify(message)} to include "/model"`,
  );
  assert.ok(
    message.includes("fresh session"),
    `expected ${JSON.stringify(message)} to include "fresh session"`,
  );
});

Deno.test("context overflow failure: an unknown window still yields a complete message", () => {
  const message = buildContextOverflowMessage({
    modelSlug: "laguna-xs.2",
    inputTokens: 8000,
    outputTokens: 100,
  });

  assert.ok(
    message.includes("context window of laguna-xs.2"),
    `expected ${
      JSON.stringify(message)
    } to include "context window of laguna-xs.2"`,
  );
  assert.ok(
    message.includes("/model"),
    `expected ${JSON.stringify(message)} to include "/model"`,
  );
});

Deno.test("context overflow failure: ContextWindowOverflowError carries the structured details and a stable name", () => {
  const err = new ContextWindowOverflowError({
    modelSlug: "laguna-xs.2",
    contextWindow: 8192,
    inputTokens: 8000,
    outputTokens: 100,
  });

  assert.strictEqual(err.name, "ContextWindowOverflowError");
  assert.strictEqual(err.details.contextWindow, 8192);
  assert.ok(
    err.message.includes("/model"),
    `expected ${JSON.stringify(err.message)} to include "/model"`,
  );
});

// --- isBudgetRefusal ---

Deno.test("isBudgetRefusal: recognizes every envelope-refusal error by name", () => {
  for (
    const name of [
      "BudgetExceededError",
      "BudgetCeilingDeclinedError",
    ]
  ) {
    const err = new Error("refused");
    err.name = name;
    assert.strictEqual(isBudgetRefusal(err), true);
  }
});

Deno.test("isBudgetRefusal: a runaway-anomaly halt is a hard stop, never a downgradeable refusal", () => {
  const err = new Error("halted");
  err.name = "RunawayAnomalyHaltError";
  assert.strictEqual(isBudgetRefusal(err), false);
});

Deno.test("isBudgetRefusal: anything else is not a budget refusal", () => {
  assert.strictEqual(isBudgetRefusal(new Error("network down")), false);
  assert.strictEqual(isBudgetRefusal(undefined), false);
  assert.strictEqual(isBudgetRefusal("BudgetExceededError"), false);
});

Deno.test("buildContextOverflowMessage: a request refused before sending names the input budget, not a total that cannot add up", () => {
  const message = buildContextOverflowMessage({
    modelSlug: "hosted-200k",
    contextWindow: 200_000,
    inputTokens: 140_000,
    outputTokens: 0,
    inputBudgetTokens: 129_200,
  });
  assert.ok(
    message.includes("200000-token context window"),
    `expected ${
      JSON.stringify(message)
    } to include "200000-token context window"`,
  );
  assert.ok(
    message.includes("~140000 input tokens against an input budget of 129200"),
    `expected ${
      JSON.stringify(message)
    } to include "~140000 input tokens against an input budget of 129200"`,
  );
  assert.ok(
    message.includes("it was not sent"),
    `expected ${JSON.stringify(message)} to include "it was not sent"`,
  );
  assert.deepStrictEqual(message.includes("0 output tokens"), false);
  assert.ok(
    message.includes("/model"),
    `expected ${JSON.stringify(message)} to include "/model"`,
  );
});

// Own enumerable properties, in order, are what JSON.stringify and error
// serialization see, so the order each constructor gives them is pinned.
it("ContextWindowOverflowError keeps its own properties and message", () => {
  const details = { modelSlug: "m", inputTokens: 1, outputTokens: 1 };
  const err = new ContextWindowOverflowError(details);
  assert.deepStrictEqual(Object.keys(err), ["details", "name"]);
  assert.strictEqual(err.details, details);
  assert.strictEqual(err.message, buildContextOverflowMessage(details));
  assert.strictEqual(err.cause, undefined);
});
