import { describe, expect, test } from "vitest";
import {
  buildContextOverflowMessage,
  buildContinuationMessages,
  classifyLengthStop,
  CONTEXT_OVERFLOW_WINDOW_FRACTION,
  ContextWindowOverflowError,
  isBudgetRefusal,
  LENGTH_CONTINUATION_NUDGE,
} from "./length-recovery";
import type { WorkbenchMessage } from "./provider";

describe("classifyLengthStop", () => {
  test("output at the catalog output cap is output-budget exhaustion", () => {
    expect(
      classifyLengthStop(
        { contextWindow: 128_000, maxOutputTokens: 16_000 },
        { input: 4_000, output: 16_000 },
      ),
    ).toBe("output_budget_exhausted");
  });

  test("the output cap wins even at the window edge — the generator could not have continued", () => {
    expect(
      classifyLengthStop(
        { contextWindow: 8192, maxOutputTokens: 1024 },
        { input: 7168, output: 1024 },
      ),
    ).toBe("output_budget_exhausted");
  });

  test("filling the window with output short of the cap is context overflow", () => {
    expect(
      classifyLengthStop(
        { contextWindow: 8192, maxOutputTokens: 1024 },
        { input: 7900, output: 292 },
      ),
    ).toBe("context_overflow");
  });

  test("window evidence works without a declared output cap", () => {
    expect(
      classifyLengthStop(
        { contextWindow: 100 },
        { input: 90, output: 9 },
      ),
    ).toBe("context_overflow");
  });

  test("usage below the overflow fraction of the window is output-budget exhaustion", () => {
    expect(
      classifyLengthStop(
        { contextWindow: 100 },
        { input: 50, output: 10 },
      ),
    ).toBe("output_budget_exhausted");
    // Just under the threshold stays exhaustion; at it flips to overflow.
    const window = 1000;
    const threshold = window * CONTEXT_OVERFLOW_WINDOW_FRACTION;
    expect(
      classifyLengthStop({ contextWindow: window }, {
        input: threshold - 1,
        output: 0,
      }),
    ).toBe("output_budget_exhausted");
    expect(
      classifyLengthStop({ contextWindow: window }, {
        input: threshold,
        output: 0,
      }),
    ).toBe("context_overflow");
  });

  test("no catalog limits defaults to output-budget exhaustion (overflow needs positive evidence)", () => {
    expect(
      classifyLengthStop({}, { input: 1_000_000, output: 5 }),
    ).toBe("output_budget_exhausted");
  });
});

describe("buildContinuationMessages", () => {
  test("appends the partial assistant turn and the continuation nudge without mutating the input", () => {
    const messages: WorkbenchMessage[] = [
      { role: "user", content: "write a long report" },
    ];
    const continuation = buildContinuationMessages(messages, "partial repo");

    expect(messages).toHaveLength(1);
    expect(continuation).toEqual([
      { role: "user", content: "write a long report" },
      { role: "assistant", content: "partial repo" },
      { role: "user", content: LENGTH_CONTINUATION_NUDGE },
    ]);
  });
});

describe("context overflow failure", () => {
  test("the operator message names the condition and both ways out", () => {
    const message = buildContextOverflowMessage({
      modelSlug: "laguna-xs.2",
      contextWindow: 8192,
      inputTokens: 8000,
      outputTokens: 100,
    });

    expect(message).toContain("Context window overflow");
    expect(message).toContain("laguna-xs.2");
    expect(message).toContain("8192-token context window");
    expect(message).toContain("/model");
    expect(message).toContain("fresh session");
  });

  test("an unknown window still yields a complete message", () => {
    const message = buildContextOverflowMessage({
      modelSlug: "laguna-xs.2",
      inputTokens: 8000,
      outputTokens: 100,
    });

    expect(message).toContain("context window of laguna-xs.2");
    expect(message).toContain("/model");
  });

  test("ContextWindowOverflowError carries the structured details and a stable name", () => {
    const err = new ContextWindowOverflowError({
      modelSlug: "laguna-xs.2",
      contextWindow: 8192,
      inputTokens: 8000,
      outputTokens: 100,
    });

    expect(err.name).toBe("ContextWindowOverflowError");
    expect(err.details.contextWindow).toBe(8192);
    expect(err.message).toContain("/model");
  });
});

describe("isBudgetRefusal", () => {
  test("recognizes every envelope-refusal error by name", () => {
    for (
      const name of [
        "BudgetExceededError",
        "BudgetCeilingDeclinedError",
      ]
    ) {
      const err = new Error("refused");
      err.name = name;
      expect(isBudgetRefusal(err)).toBe(true);
    }
  });

  test("a runaway-anomaly halt is a hard stop, never a downgradeable refusal", () => {
    const err = new Error("halted");
    err.name = "RunawayAnomalyHaltError";
    expect(isBudgetRefusal(err)).toBe(false);
  });

  test("anything else is not a budget refusal", () => {
    expect(isBudgetRefusal(new Error("network down"))).toBe(false);
    expect(isBudgetRefusal(undefined)).toBe(false);
    expect(isBudgetRefusal("BudgetExceededError")).toBe(false);
  });
});
