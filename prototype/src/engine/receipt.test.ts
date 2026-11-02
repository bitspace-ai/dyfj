import assert from "node:assert/strict";
import { test } from "node:test";
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
    paidCalls: 2,
    sessionLimitUsd: 1,
  },
};

test("buildWorkbenchReceipt: includes session and trace audit pointers", () => {
  const receipt = buildWorkbenchReceipt(BASE_RECEIPT);

  assert.ok(
    receipt.includes("Session: 01TESTSESSION00000000000000"),
    `expected ${
      JSON.stringify(receipt)
    } to include "Session: 01TESTSESSION00000000000000"`,
  );
  assert.ok(
    receipt.includes("Trace:   0123456789abcdef0123456789abcdef"),
    `expected ${
      JSON.stringify(receipt)
    } to include "Trace:   0123456789abcdef0123456789abcdef"`,
  );
});

test("buildWorkbenchReceipt: includes model, tier, and routing reason", () => {
  const receipt = buildWorkbenchReceipt(BASE_RECEIPT);

  assert.ok(
    receipt.includes("Model:   Gemma 4 E2B (gemma4:e2b, tier 0)"),
    `expected ${
      JSON.stringify(receipt)
    } to include "Model:   Gemma 4 E2B (gemma4:e2b, tier 0)"`,
  );
  assert.ok(
    receipt.includes("Route:   default"),
    `expected ${JSON.stringify(receipt)} to include "Route:   default"`,
  );
});

test("buildWorkbenchReceipt: marks a catalog-estimated cost, not a billed one", () => {
  const estimated = buildWorkbenchReceipt({
    ...BASE_RECEIPT,
    totalCostUsd: 0.0123456,
    costBasis: "catalog_estimate",
  });
  assert.ok(estimated.includes("Actual cost:    ~$0.012346 (catalog estimate)"));
  const billed = buildWorkbenchReceipt({
    ...BASE_RECEIPT,
    totalCostUsd: 0.0123456,
    costBasis: "provider_billed",
  });
  assert.ok(billed.includes("Actual cost:    $0.012346 (billed)"));
  const free = buildWorkbenchReceipt({
    ...BASE_RECEIPT,
    totalCostUsd: 0,
    costBasis: "catalog_estimate",
  });
  assert.ok(free.includes("Actual cost:    $0.000000\n"));
});

test("buildWorkbenchReceipt: includes token and cost totals", () => {
  const receipt = buildWorkbenchReceipt({
    ...BASE_RECEIPT,
    totalCostUsd: 0.0123456,
    totalTokensInput: 3000,
    totalTokensOutput: 1200,
    totalCalls: 2,
  });

  assert.ok(
    receipt.includes("Actual cost:    $0.012346"),
    `expected ${
      JSON.stringify(receipt)
    } to include "Actual cost:    $0.012346"`,
  );
  assert.ok(
    receipt.includes("Tokens:  3000 in, 1200 out"),
    `expected ${
      JSON.stringify(receipt)
    } to include "Tokens:  3000 in, 1200 out"`,
  );
  assert.ok(
    receipt.includes("Calls:   2"),
    `expected ${JSON.stringify(receipt)} to include "Calls:   2"`,
  );
});

test("buildWorkbenchReceipt: includes configured agent-step usage and limit status", () => {
  assert.ok(
    buildWorkbenchReceipt(BASE_RECEIPT).includes("Tool steps: 12/32"),
    `expected buildWorkbenchReceipt(BASE_RECEIPT) to include "Tool steps: 12/32"`,
  );
  assert.ok(
    buildWorkbenchReceipt({
      ...BASE_RECEIPT,
      agent: { toolStepsUsed: 2, maxToolSteps: 2, limitReached: true },
    }).includes("Tool steps: 2/2 (limit reached)"),
    `expected buildWorkbenchReceipt({
      ...BASE_RECEIPT,
      agent: { toolStepsUsed: 2, maxToolSteps: 2, limitReached: true },
    }) to include "Tool steps: 2/2 (limit reached)"`,
  );
});

test("buildWorkbenchReceipt: reports reasoning tokens only when the provider reported some", () => {
  // Absent/zero: no reasoning fragment — most providers never report them.
  assert.deepStrictEqual(
    buildWorkbenchReceipt(BASE_RECEIPT).includes("reasoning"),
    false,
  );
  assert.deepStrictEqual(
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
  assert.ok(
    receipt.includes("Tokens:  3000 in, 1200 out, 256 reasoning"),
    `expected ${
      JSON.stringify(receipt)
    } to include "Tokens:  3000 in, 1200 out, 256 reasoning"`,
  );
});

const LENGTH_STOP = {
  ...BASE_RECEIPT,
  stopReason: "length" as const,
};

test("buildWorkbenchReceipt: a reasoning-only length stop names the output limit", () => {
  // The report's motivating case: the model spent its whole output budget on
  // reasoning, so the turn ended with an empty reply and nothing said why.
  const receipt = buildWorkbenchReceipt({
    ...LENGTH_STOP,
    totalTokensOutput: 0,
    totalReasoningTokens: 10,
  });
  assert.ok(
    receipt.includes("Stop:    output limit reached (0 out, 10 reasoning)"),
    JSON.stringify(receipt),
  );
});

test("buildWorkbenchReceipt: a length stop with output still names the limit", () => {
  const receipt = buildWorkbenchReceipt({
    ...LENGTH_STOP,
    totalTokensOutput: 50,
    totalReasoningTokens: 0,
  });
  assert.ok(
    receipt.includes("Stop:    output limit reached (50 out)"),
    JSON.stringify(receipt),
  );
});

test("buildWorkbenchReceipt: a normal stop adds no stop line", () => {
  const receipt = buildWorkbenchReceipt({
    ...BASE_RECEIPT,
    stopReason: "stop",
  });
  assert.ok(!receipt.includes("Stop:"), JSON.stringify(receipt));
});

test("buildWorkbenchReceipt: includes model call timing breakdown when available", () => {
  const receipt = buildWorkbenchReceipt(BASE_RECEIPT);

  assert.ok(
    receipt.includes(
      "Timings: headers 10ms, TTFT 42ms, generation 8ms, TPOT 2ms/token, total 50ms",
    ),
    `expected ${
      JSON.stringify(receipt)
    } to include "Timings: headers 10ms, TTFT 42ms, generation 8ms, TPOT 2ms/token, total 50ms"`,
  );
});

test("buildWorkbenchReceipt: includes context budget allocation", () => {
  const receipt = buildWorkbenchReceipt(BASE_RECEIPT);

  assert.ok(
    receipt.includes("Context profile: compact"),
    `expected ${JSON.stringify(receipt)} to include "Context profile: compact"`,
  );
  assert.ok(
    receipt.includes(
      "Context budget: 4000/5000 tokens; system 900/1000, active 2100/2500, memory 1000/1000, headroom 500",
    ),
    `expected ${
      JSON.stringify(receipt)
    } to include "Context budget: 4000/5000 tokens; system 900/1000, active 2100/2500, memory 1000/1000, headroom 500"`,
  );
});

test("buildWorkbenchReceipt: includes context sources and paid inference posture", () => {
  const receipt = buildWorkbenchReceipt(BASE_RECEIPT);

  assert.ok(
    receipt.includes("Context sources:"),
    `expected ${JSON.stringify(receipt)} to include "Context sources:"`,
  );
  assert.ok(
    receipt.includes("- AGENTS.md <AGENTS.md>"),
    `expected ${JSON.stringify(receipt)} to include "- AGENTS.md <AGENTS.md>"`,
  );
  assert.ok(
    receipt.includes("- README.md Section 1 <README.md#section-1>"),
    `expected ${
      JSON.stringify(receipt)
    } to include "- README.md Section 1 <README.md#section-1>"`,
  );
  assert.ok(
    receipt.includes(
      "- notes/workbench-mvp-loop.md <notes/workbench-mvp-loop.md>",
    ),
    `expected ${
      JSON.stringify(receipt)
    } to include "- notes/workbench-mvp-loop.md <notes/workbench-mvp-loop.md>"`,
  );
  assert.ok(
    receipt.includes("Paid inference used: no"),
    `expected ${JSON.stringify(receipt)} to include "Paid inference used: no"`,
  );
  assert.ok(
    receipt.includes("Estimated cost: $0.000000"),
    `expected ${
      JSON.stringify(receipt)
    } to include "Estimated cost: $0.000000"`,
  );
  assert.ok(
    receipt.includes("Actual cost:    $0.000000"),
    `expected ${
      JSON.stringify(receipt)
    } to include "Actual cost:    $0.000000"`,
  );
});

test("buildWorkbenchReceipt: includes next-work experiment routing and validation fields", () => {
  const receipt = buildWorkbenchReceipt({
    ...BASE_RECEIPT,
    routingReason: "default_local_next_work",
    validation: {
      ok: false,
      errors: ["missing required field: rationale"],
    },
  });

  assert.ok(
    receipt.includes("Worklet: next-work.v0"),
    `expected ${JSON.stringify(receipt)} to include "Worklet: next-work.v0"`,
  );
  assert.ok(
    receipt.includes("Route:   default_local_next_work"),
    `expected ${
      JSON.stringify(receipt)
    } to include "Route:   default_local_next_work"`,
  );
  assert.ok(
    receipt.includes("Validation: failed"),
    `expected ${JSON.stringify(receipt)} to include "Validation: failed"`,
  );
  assert.ok(
    receipt.includes("- missing required field: rationale"),
    `expected ${
      JSON.stringify(receipt)
    } to include "- missing required field: rationale"`,
  );
});

test("buildBudgetTallyLine: shows the turn's cost and tokens and the session's cost", () => {
  const tally = buildBudgetTallyLine(BASE_TALLY);

  assert.deepStrictEqual(
    tally,
    "Budget tally: $0.012346 this turn (300 in, 120 out) · " +
      "$0.034568 session (3.5% of $1.000000)",
  );
});

test("shouldPrintBudgetTally: default paid mode stays quiet before paid usage", () => {
  assert.deepStrictEqual(
    shouldPrintBudgetTally("paid", { ...BASE_TALLY.session, paidCalls: 0 }),
    false,
  );
});

test("shouldPrintBudgetTally: default paid mode prints after paid usage", () => {
  assert.deepStrictEqual(
    shouldPrintBudgetTally("paid", BASE_TALLY.session),
    true,
  );
});

test("shouldPrintBudgetTally: on mode prints even without paid usage", () => {
  assert.deepStrictEqual(
    shouldPrintBudgetTally("on", { ...BASE_TALLY.session, paidCalls: 0 }),
    true,
  );
});

test("shouldPrintBudgetTally: off mode always stays quiet", () => {
  assert.deepStrictEqual(
    shouldPrintBudgetTally("off", BASE_TALLY.session),
    false,
  );
});

test("buildWorkbenchReceipt: counts the tool calls that ran without a prompt", () => {
  assert.equal(buildWorkbenchReceipt(BASE_RECEIPT).includes("Auto-approved"), false);
  const receipt = buildWorkbenchReceipt({
    ...BASE_RECEIPT,
    agent: {
      ...BASE_RECEIPT.agent,
      autoApprovals: { allowlist: 2, sessionGrant: 1 },
    },
  });
  assert.ok(
    receipt.includes("Auto-approved: 3 (allowlist 2, session grant 1)"),
    receipt,
  );
});
