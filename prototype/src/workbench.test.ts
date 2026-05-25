import { describe, expect, test } from "vitest";
import {
  buildBudgetTallyLine,
  buildPaidEscalationPreflightBanner,
  buildWorkbenchReceipt,
  formatMoney,
  maybeBuildPaidEscalationPreflightBanner,
  shouldPrintBudgetTally,
  type BudgetTallyInput,
  type PaidEscalationPreflightInput,
  type WorkbenchReceiptInput,
} from "./workbench";

const BASE_RECEIPT: WorkbenchReceiptInput = {
  sessionId: "01TESTSESSION00000000000000",
  traceId: "0123456789abcdef0123456789abcdef",
  modelName: "Gemma 4 27B",
  modelSlug: "gemma4",
  tier: 0,
  routingReason: "default",
  totalCostUsd: 0,
  totalTokensInput: 1234,
  totalTokensOutput: 567,
  totalCalls: 1,
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

    expect(receipt).toContain("Model:   Gemma 4 27B (gemma4, tier 0)");
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

    expect(receipt).toContain("Cost:    $0.012346");
    expect(receipt).toContain("Tokens:  3000 in, 1200 out");
    expect(receipt).toContain("Calls:   2");
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

describe("buildBudgetTallyLine", () => {
  test("shows turn and session cost and token totals", () => {
    const tally = buildBudgetTallyLine(BASE_TALLY);

    expect(tally).toBe(
      "Budget tally: $0.012346 this turn (300 in, 120 out) · " +
      "$0.034568 session (1300 in, 620 out, 3.5% of $1.000000)"
    );
  });
});

describe("shouldPrintBudgetTally", () => {
  test("default paid mode stays quiet before paid usage", () => {
    expect(shouldPrintBudgetTally("paid", { ...BASE_TALLY.session, paidCalls: 0 })).toBe(false);
  });

  test("default paid mode prints after paid usage", () => {
    expect(shouldPrintBudgetTally("paid", BASE_TALLY.session)).toBe(true);
  });

  test("on mode prints even without paid usage", () => {
    expect(shouldPrintBudgetTally("on", { ...BASE_TALLY.session, paidCalls: 0 })).toBe(true);
  });

  test("off mode always stays quiet", () => {
    expect(shouldPrintBudgetTally("off", BASE_TALLY.session)).toBe(false);
  });
});
