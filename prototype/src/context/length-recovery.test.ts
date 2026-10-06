import {
  assertEquals,
  assertStrictEquals,
  assertStringIncludes,
} from "@std/assert";
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
  assertStrictEquals(
    classifyLengthStop(
      { contextWindow: 128_000, maxOutputTokens: 16_000 },
      { input: 4_000, output: 16_000 },
    ),
    "output_budget_exhausted",
  );
});

Deno.test("classifyLengthStop: the output cap wins even at the window edge — the generator could not have continued", () => {
  assertStrictEquals(
    classifyLengthStop(
      { contextWindow: 8192, maxOutputTokens: 1024 },
      { input: 7168, output: 1024 },
    ),
    "output_budget_exhausted",
  );
});

Deno.test("classifyLengthStop: filling the window with output short of the cap is context overflow", () => {
  assertStrictEquals(
    classifyLengthStop(
      { contextWindow: 8192, maxOutputTokens: 1024 },
      { input: 7900, output: 292 },
    ),
    "context_overflow",
  );
});

Deno.test("classifyLengthStop: window evidence works without a declared output cap", () => {
  assertStrictEquals(
    classifyLengthStop(
      { contextWindow: 100 },
      { input: 90, output: 9 },
    ),
    "context_overflow",
  );
});

Deno.test("classifyLengthStop: usage below the overflow fraction of the window is output-budget exhaustion", () => {
  assertStrictEquals(
    classifyLengthStop(
      { contextWindow: 100 },
      { input: 50, output: 10 },
    ),
    "output_budget_exhausted",
  );
  // Just under the threshold stays exhaustion; at it flips to overflow.
  const window = 1000;
  const threshold = window * CONTEXT_OVERFLOW_WINDOW_FRACTION;
  assertStrictEquals(
    classifyLengthStop({ contextWindow: window }, {
      input: threshold - 1,
      output: 0,
    }),
    "output_budget_exhausted",
  );
  assertStrictEquals(
    classifyLengthStop({ contextWindow: window }, {
      input: threshold,
      output: 0,
    }),
    "context_overflow",
  );
});

Deno.test("classifyLengthStop: no catalog limits defaults to output-budget exhaustion (overflow needs positive evidence)", () => {
  assertStrictEquals(
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

  assertEquals(messages.length, 1);
  assertEquals(continuation, [
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

  assertStringIncludes(message, "Context window overflow");
  assertStringIncludes(message, "laguna-xs.2");
  assertStringIncludes(message, "8192-token context window");
  assertStringIncludes(message, "/model");
  assertStringIncludes(message, "fresh session");
});

Deno.test("context overflow failure: an unknown window still yields a complete message", () => {
  const message = buildContextOverflowMessage({
    modelSlug: "laguna-xs.2",
    inputTokens: 8000,
    outputTokens: 100,
  });

  assertStringIncludes(message, "context window of laguna-xs.2");
  assertStringIncludes(message, "/model");
});

Deno.test("context overflow failure: ContextWindowOverflowError carries the structured details and a stable name", () => {
  const err = new ContextWindowOverflowError({
    modelSlug: "laguna-xs.2",
    contextWindow: 8192,
    inputTokens: 8000,
    outputTokens: 100,
  });

  assertStrictEquals(err.name, "ContextWindowOverflowError");
  assertStrictEquals(err.details.contextWindow, 8192);
  assertStringIncludes(err.message, "/model");
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
    assertStrictEquals(isBudgetRefusal(err), true);
  }
});

Deno.test("isBudgetRefusal: a runaway-anomaly halt is a hard stop, never a downgradeable refusal", () => {
  const err = new Error("halted");
  err.name = "RunawayAnomalyHaltError";
  assertStrictEquals(isBudgetRefusal(err), false);
});

Deno.test("isBudgetRefusal: anything else is not a budget refusal", () => {
  assertStrictEquals(isBudgetRefusal(new Error("network down")), false);
  assertStrictEquals(isBudgetRefusal(undefined), false);
  assertStrictEquals(isBudgetRefusal("BudgetExceededError"), false);
});

Deno.test("buildContextOverflowMessage: a request refused before sending names the input budget, not a total that cannot add up", () => {
  const message = buildContextOverflowMessage({
    modelSlug: "hosted-200k",
    contextWindow: 200_000,
    inputTokens: 140_000,
    outputTokens: 0,
    inputBudgetTokens: 129_200,
  });
  assertStringIncludes(message, "200000-token context window");
  assertStringIncludes(
    message,
    "~140000 input tokens against an input budget of 129200",
  );
  assertStringIncludes(message, "it was not sent");
  assertEquals(message.includes("0 output tokens"), false);
  assertStringIncludes(message, "/model");
});
