import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  type BudgetTallyInput,
  buildBudgetTallyLine,
  buildWorkbenchReceipt,
  shouldPrintBudgetTally,
  type WorkbenchReceiptInput,
} from "./receipt.ts";

const BASE_RECEIPT: WorkbenchReceiptInput = {
  sessionId: "01TESTSESSION00000000000000",
  traceId: "0123456789abcdef0123456789abcdef",
  modelName: "Gemma 4 E2B",
  modelSlug: "gemma4:e2b",
  tier: 0,
  routingReason: "default",
  totalCostUsd: 0,
  totalTokensInput: 1234,
  totalTokensOutput: 567,
  totalCalls: 1,
  contextBudget: {
    totalTokens: 5000,
    usedTokens: 4000,
    headroomTokens: 500,
    byBucket: {
      system: { limitTokens: 1000, usedTokens: 900 },
      active_repo: { limitTokens: 2500, usedTokens: 2100 },
      derived_memory: { limitTokens: 1000, usedTokens: 1000 },
    },
  },
  contextProfile: "compact",
  timings: {
    responseHeadersMs: 10,
    timeToFirstTokenMs: 42,
    generationMs: 8,
    timePerOutputTokenMs: 2,
    totalMs: 50,
  },
  contextSources: [
    "AGENTS.md <AGENTS.md>",
    "README.md Section 1 <README.md#section-1>",
    "notes/workbench-mvp-loop.md <notes/workbench-mvp-loop.md>",
  ],
  paidInferenceUsed: false,
  estimatedCostUsd: 0,
  workletId: "next-work.v0",
  validation: { ok: true, errors: [] },
  agent: { toolStepsUsed: 12, maxToolSteps: 32, limitReached: false },
};

const BASE_TALLY: BudgetTallyInput = {
  turn: {
    tokensInput: 300,
    tokensOutput: 120,
    costUsd: 0.0123456,
    tier: 1,
  },
  session: {
    totalCostUsd: 0.0345678,
    totalTokensInput: 1300,
    totalTokensOutput: 620,
    paidCalls: 2,
    sessionLimitUsd: 1,
  },
};

Deno.test("buildWorkbenchReceipt: includes session and trace audit pointers", () => {
  const receipt = buildWorkbenchReceipt(BASE_RECEIPT);

  assertStringIncludes(receipt, "Session: 01TESTSESSION00000000000000");
  assertStringIncludes(receipt, "Trace:   0123456789abcdef0123456789abcdef");
});

Deno.test("buildWorkbenchReceipt: includes model, tier, and routing reason", () => {
  const receipt = buildWorkbenchReceipt(BASE_RECEIPT);

  assertStringIncludes(receipt, "Model:   Gemma 4 E2B (gemma4:e2b, tier 0)");
  assertStringIncludes(receipt, "Route:   default");
});

Deno.test("buildWorkbenchReceipt: includes token and cost totals", () => {
  const receipt = buildWorkbenchReceipt({
    ...BASE_RECEIPT,
    totalCostUsd: 0.0123456,
    totalTokensInput: 3000,
    totalTokensOutput: 1200,
    totalCalls: 2,
  });

  assertStringIncludes(receipt, "Actual cost:    $0.012346");
  assertStringIncludes(receipt, "Tokens:  3000 in, 1200 out");
  assertStringIncludes(receipt, "Calls:   2");
});

Deno.test("buildWorkbenchReceipt: includes configured agent-step usage and limit status", () => {
  assertStringIncludes(
    buildWorkbenchReceipt(BASE_RECEIPT),
    "Tool steps: 12/32",
  );
  assertStringIncludes(
    buildWorkbenchReceipt({
      ...BASE_RECEIPT,
      agent: { toolStepsUsed: 2, maxToolSteps: 2, limitReached: true },
    }),
    "Tool steps: 2/2 (limit reached)",
  );
});

Deno.test("buildWorkbenchReceipt: reports reasoning tokens only when the provider reported some", () => {
  // Absent/zero: no reasoning fragment — most providers never report them.
  assertEquals(
    buildWorkbenchReceipt(BASE_RECEIPT).includes("reasoning"),
    false,
  );
  assertEquals(
    buildWorkbenchReceipt({ ...BASE_RECEIPT, totalReasoningTokens: 0 })
      .includes("reasoning"),
    false,
  );

  const receipt = buildWorkbenchReceipt({
    ...BASE_RECEIPT,
    totalTokensInput: 3000,
    totalTokensOutput: 1200,
    totalReasoningTokens: 256,
  });
  assertStringIncludes(receipt, "Tokens:  3000 in, 1200 out, 256 reasoning");
});

Deno.test("buildWorkbenchReceipt: includes model call timing breakdown when available", () => {
  const receipt = buildWorkbenchReceipt(BASE_RECEIPT);

  assertStringIncludes(
    receipt,
    "Timings: headers 10ms, TTFT 42ms, generation 8ms, TPOT 2ms/token, total 50ms",
  );
});

Deno.test("buildWorkbenchReceipt: includes context budget allocation", () => {
  const receipt = buildWorkbenchReceipt(BASE_RECEIPT);

  assertStringIncludes(receipt, "Context profile: compact");
  assertStringIncludes(
    receipt,
    "Context budget: 4000/5000 tokens; system 900/1000, active 2100/2500, memory 1000/1000, headroom 500",
  );
});

Deno.test("buildWorkbenchReceipt: includes context sources and paid inference posture", () => {
  const receipt = buildWorkbenchReceipt(BASE_RECEIPT);

  assertStringIncludes(receipt, "Context sources:");
  assertStringIncludes(receipt, "- AGENTS.md <AGENTS.md>");
  assertStringIncludes(receipt, "- README.md Section 1 <README.md#section-1>");
  assertStringIncludes(
    receipt,
    "- notes/workbench-mvp-loop.md <notes/workbench-mvp-loop.md>",
  );
  assertStringIncludes(receipt, "Paid inference used: no");
  assertStringIncludes(receipt, "Estimated cost: $0.000000");
  assertStringIncludes(receipt, "Actual cost:    $0.000000");
});

Deno.test("buildWorkbenchReceipt: includes next-work experiment routing and validation fields", () => {
  const receipt = buildWorkbenchReceipt({
    ...BASE_RECEIPT,
    routingReason: "default_local_next_work",
    validation: {
      ok: false,
      errors: ["missing required field: rationale"],
    },
  });

  assertStringIncludes(receipt, "Worklet: next-work.v0");
  assertStringIncludes(receipt, "Route:   default_local_next_work");
  assertStringIncludes(receipt, "Validation: failed");
  assertStringIncludes(receipt, "- missing required field: rationale");
});

Deno.test("buildBudgetTallyLine: shows turn and session cost and token totals", () => {
  const tally = buildBudgetTallyLine(BASE_TALLY);

  assertEquals(
    tally,
    "Budget tally: $0.012346 this turn (300 in, 120 out) · " +
      "$0.034568 session (1300 in, 620 out, 3.5% of $1.000000)",
  );
});

Deno.test("shouldPrintBudgetTally: default paid mode stays quiet before paid usage", () => {
  assertEquals(
    shouldPrintBudgetTally("paid", { ...BASE_TALLY.session, paidCalls: 0 }),
    false,
  );
});

Deno.test("shouldPrintBudgetTally: default paid mode prints after paid usage", () => {
  assertEquals(shouldPrintBudgetTally("paid", BASE_TALLY.session), true);
});

Deno.test("shouldPrintBudgetTally: on mode prints even without paid usage", () => {
  assertEquals(
    shouldPrintBudgetTally("on", { ...BASE_TALLY.session, paidCalls: 0 }),
    true,
  );
});

Deno.test("shouldPrintBudgetTally: off mode always stays quiet", () => {
  assertEquals(shouldPrintBudgetTally("off", BASE_TALLY.session), false);
});
