import { describe, expect, test } from "vitest";
import {
  assertPaidEscalationCanPrompt,
  type BudgetTallyInput,
  buildBudgetTallyLine,
  buildNextWorkBrief,
  buildPaidEscalationPreflightBanner,
  buildWorkbenchReceipt,
  formatMoney,
  isNextWorkMode,
  maybeBuildPaidEscalationPreflightBanner,
  type PaidEscalationPreflightInput,
  PaidInferenceRequiresTtyError,
  resolveWorkbenchInvocation,
  shouldPrintBudgetTally,
  validateNextWorkJson,
  type WorkbenchReceiptInput,
} from "./workbench";

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
  contextProfile: "beads-first",
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
    "bd ready <bd ready>",
  ],
  paidInferenceUsed: false,
  estimatedCostUsd: 0,
  workletId: "next-work.v0",
  validation: { ok: true, errors: [] },
};

const BASE_PREFLIGHT: PaidEscalationPreflightInput = {
  modelName: "Claude Sonnet",
  modelSlug: "claude-sonnet",
  tier: 1,
  routingReason: "explicit_tier",
  estimatedCostUsd: 0.0123456,
  sessionCostSoFarUsd: 0.05,
  sessionLimitUsd: 1,
  perCallLimitUsd: 0.1,
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

describe("formatMoney", () => {
  test("formats sub-cent model costs with six decimal places", () => {
    expect(formatMoney(0.0001234)).toBe("$0.000123");
  });

  test("formats zero as an explicit dollar amount", () => {
    expect(formatMoney(0)).toBe("$0.000000");
  });
});

describe("buildWorkbenchReceipt", () => {
  test("includes session and trace audit pointers", () => {
    const receipt = buildWorkbenchReceipt(BASE_RECEIPT);

    expect(receipt).toContain("Session: 01TESTSESSION00000000000000");
    expect(receipt).toContain("Trace:   0123456789abcdef0123456789abcdef");
  });

  test("includes model, tier, and routing reason", () => {
    const receipt = buildWorkbenchReceipt(BASE_RECEIPT);

    expect(receipt).toContain("Model:   Gemma 4 E2B (gemma4:e2b, tier 0)");
    expect(receipt).toContain("Route:   default");
  });

  test("includes token and cost totals", () => {
    const receipt = buildWorkbenchReceipt({
      ...BASE_RECEIPT,
      totalCostUsd: 0.0123456,
      totalTokensInput: 3000,
      totalTokensOutput: 1200,
      totalCalls: 2,
    });

    expect(receipt).toContain("Actual cost:    $0.012346");
    expect(receipt).toContain("Tokens:  3000 in, 1200 out");
    expect(receipt).toContain("Calls:   2");
  });

  test("includes model call timing breakdown when available", () => {
    const receipt = buildWorkbenchReceipt(BASE_RECEIPT);

    expect(receipt).toContain(
      "Timings: headers 10ms, TTFT 42ms, generation 8ms, TPOT 2ms/token, total 50ms",
    );
  });

  test("includes context budget allocation", () => {
    const receipt = buildWorkbenchReceipt(BASE_RECEIPT);

    expect(receipt).toContain("Context profile: beads-first");
    expect(receipt).toContain(
      "Context budget: 4000/5000 tokens; system 900/1000, active 2100/2500, Beads 1000/1000, headroom 500",
    );
  });

  test("includes context sources and paid inference posture", () => {
    const receipt = buildWorkbenchReceipt(BASE_RECEIPT);

    expect(receipt).toContain("Context sources:");
    expect(receipt).toContain("- AGENTS.md <AGENTS.md>");
    expect(receipt).toContain("- README.md Section 1 <README.md#section-1>");
    expect(receipt).toContain("- bd ready <bd ready>");
    expect(receipt).toContain("Paid inference used: no");
    expect(receipt).toContain("Estimated cost: $0.000000");
    expect(receipt).toContain("Actual cost:    $0.000000");
  });

  test("includes next-work experiment routing and validation fields", () => {
    const receipt = buildWorkbenchReceipt({
      ...BASE_RECEIPT,
      routingReason: "default_local_next_work",
      validation: {
        ok: false,
        errors: ["missing required field: rationale"],
      },
    });

    expect(receipt).toContain("Worklet: next-work.v0");
    expect(receipt).toContain("Route:   default_local_next_work");
    expect(receipt).toContain("Validation: failed");
    expect(receipt).toContain("- missing required field: rationale");
  });
});

describe("buildNextWorkBrief", () => {
  test("requests strict JSON for the next-work worklet without private context", () => {
    const brief = buildNextWorkBrief({
      workletId: "next-work.v0",
      contextProfile: "beads-first",
      prompt: "what should I work on next here?",
    });

    expect(brief).toContain("worklet_id: next-work.v0");
    expect(brief).toContain("context_profile: beads-first");
    expect(brief).toContain("Return strict JSON only");
    expect(brief).toContain('"recommendation"');
    expect(brief).toContain('"confidence"');
    expect(brief).not.toContain("dyfj-home");
  });
});

describe("validateNextWorkJson", () => {
  test("accepts a complete strict JSON next-work result", () => {
    const result = validateNextWorkJson(JSON.stringify({
      worklet_id: "next-work.v0",
      context_profile: "beads-first",
      recommendation: "Work dyfj-2fl.8.2 next.",
      rationale: "It is the ready routing experiment slice.",
      evidence: ["bd show dyfj-2fl.8.2"],
      risks: ["Local model output may drift."],
      next_commands: ["deno task test"],
      confidence: "medium",
    }));

    expect(result).toEqual({
      ok: true,
      value: {
        worklet_id: "next-work.v0",
        context_profile: "beads-first",
        recommendation: "Work dyfj-2fl.8.2 next.",
        rationale: "It is the ready routing experiment slice.",
        evidence: ["bd show dyfj-2fl.8.2"],
        risks: ["Local model output may drift."],
        next_commands: ["deno task test"],
        confidence: "medium",
      },
      errors: [],
    });
  });

  test("rejects prose or incomplete JSON before trusting the model result", () => {
    expect(validateNextWorkJson("Work on the routing bead next."))
      .toMatchObject({
        ok: false,
        errors: ["model output was not strict JSON"],
      });

    const incomplete = validateNextWorkJson(JSON.stringify({
      worklet_id: "next-work.v0",
      context_profile: "beads-first",
      recommendation: "Work dyfj-2fl.8.2 next.",
    }));

    expect(incomplete).toMatchObject({
      ok: false,
      errors: [
        "missing required field: rationale",
        "missing required field: evidence",
        "missing required field: risks",
        "missing required field: next_commands",
        "missing required field: confidence",
      ],
    });
  });
});

describe("buildPaidEscalationPreflightBanner", () => {
  test("shows paid escalation call shape before inference", () => {
    const banner = buildPaidEscalationPreflightBanner(BASE_PREFLIGHT);

    expect(banner).toContain("Paid inference preflight");
    expect(banner).toContain("Model:           Claude Sonnet (claude-sonnet)");
    expect(banner).toContain("Tier:            1");
    expect(banner).toContain("Route:           explicit_tier");
    expect(banner).toContain("Estimated cost:  $0.012346");
    expect(banner).toContain("Session spent:   $0.050000 / $1.000000");
    expect(banner).toContain("Session headroom: $0.950000");
    expect(banner).toContain("Per-call limit:  $0.100000");
  });

  test("Tier 0 remains prompt-free", () => {
    expect(maybeBuildPaidEscalationPreflightBanner({
      ...BASE_PREFLIGHT,
      tier: 0,
      estimatedCostUsd: 0,
    })).toBeNull();
  });
});

describe("assertPaidEscalationCanPrompt", () => {
  test("fails closed for paid inference without a TTY", () => {
    expect(() => assertPaidEscalationCanPrompt(false))
      .toThrow(PaidInferenceRequiresTtyError);
  });

  test("allows interactive paid consent prompts with a TTY", () => {
    expect(() => assertPaidEscalationCanPrompt(true)).not.toThrow();
  });
});

describe("resolveWorkbenchInvocation", () => {
  test("keeps generic ask separate from the measured next-work worklet", () => {
    expect(isNextWorkMode("ask")).toBe(false);
    expect(isNextWorkMode("next-work")).toBe(true);
  });

  test("treats next-work as the measured local-first worklet path", () => {
    const invocation = resolveWorkbenchInvocation(["next-work"], {});

    expect(invocation).toEqual({
      mode: "next-work",
      prompt: "what should I work on next here?",
      routingOptions: {},
    });
  });

  test("loads routing defaults from environment", () => {
    const invocation = resolveWorkbenchInvocation(["ask", "next?"], {
      DYFJ_WORKBENCH_MODEL: "qwen3:32b",
      DYFJ_WORKBENCH_HINT: "code",
      DYFJ_WORKBENCH_TIER: "0",
    });

    expect(invocation).toEqual({
      mode: "ask",
      prompt: "next?",
      routingOptions: {
        modelId: "qwen3:32b",
        hint: "code",
        tier: 0,
      },
    });
  });

  test("CLI routing flags override environment defaults", () => {
    const invocation = resolveWorkbenchInvocation(
      [
        "ask",
        "--model",
        "gemma4:e2b",
        "--tier",
        "0",
        "--hint",
        "reasoning",
        "next?",
      ],
      {
        DYFJ_WORKBENCH_MODEL: "qwen3:32b",
        DYFJ_WORKBENCH_HINT: "code",
        DYFJ_WORKBENCH_TIER: "1",
      },
    );

    expect(invocation.routingOptions).toEqual({
      modelId: "gemma4:e2b",
      hint: "reasoning",
      tier: 0,
    });
  });
});

describe("buildBudgetTallyLine", () => {
  test("shows turn and session cost and token totals", () => {
    const tally = buildBudgetTallyLine(BASE_TALLY);

    expect(tally).toBe(
      "Budget tally: $0.012346 this turn (300 in, 120 out) · " +
        "$0.034568 session (1300 in, 620 out, 3.5% of $1.000000)",
    );
  });
});

describe("shouldPrintBudgetTally", () => {
  test("default paid mode stays quiet before paid usage", () => {
    expect(
      shouldPrintBudgetTally("paid", { ...BASE_TALLY.session, paidCalls: 0 }),
    ).toBe(false);
  });

  test("default paid mode prints after paid usage", () => {
    expect(shouldPrintBudgetTally("paid", BASE_TALLY.session)).toBe(true);
  });

  test("on mode prints even without paid usage", () => {
    expect(
      shouldPrintBudgetTally("on", { ...BASE_TALLY.session, paidCalls: 0 }),
    ).toBe(true);
  });

  test("off mode always stays quiet", () => {
    expect(shouldPrintBudgetTally("off", BASE_TALLY.session)).toBe(false);
  });
});
