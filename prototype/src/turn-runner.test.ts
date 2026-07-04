import { describe, expect, test } from "vitest";
import {
  formatTurnSummaryLine,
  PAID_ESCALATION_NOT_APPROVED,
  PAID_ESCALATION_REMOTE_DENIED,
  paidEscalationVerdict,
  resolveTurnFromBody,
} from "./turn-runner";

describe("resolveTurnFromBody paid posture", () => {
  test("explicit approvePaidInference true opts in", () => {
    const resolved = resolveTurnFromBody(
      { prompt: "hi", approvePaidInference: true },
      true,
    );
    expect(resolved).toMatchObject({ approvePaidInference: true });
  });

  test("explicit approvePaidInference false overrides standing default", () => {
    const resolved = resolveTurnFromBody(
      { prompt: "hi", approvePaidInference: false },
      true,
      { approvePaidDefault: true },
    );
    expect(resolved).toMatchObject({ approvePaidInference: false });
  });

  test("loopback inherits approvePaidDefault when the request omits opt-in", () => {
    const resolved = resolveTurnFromBody(
      { prompt: "hi" },
      true,
      { approvePaidDefault: true },
    );
    expect(resolved).toMatchObject({ approvePaidInference: true });
  });

  test("non-loopback never inherits the standing default", () => {
    const resolved = resolveTurnFromBody(
      { prompt: "hi" },
      false,
      { approvePaidDefault: true },
    );
    expect(resolved).toMatchObject({ approvePaidInference: false });
  });

  test("loopback without standing default stays off", () => {
    const resolved = resolveTurnFromBody({ prompt: "hi" }, true);
    expect(resolved).toMatchObject({ approvePaidInference: false });
  });
});

describe("paidEscalationVerdict", () => {
  test("remote callers are always denied", () => {
    expect(paidEscalationVerdict(false, true)).toEqual({
      decision: "deny",
      reason: PAID_ESCALATION_REMOTE_DENIED,
    });
  });

  test("loopback without opt-in is denied", () => {
    expect(paidEscalationVerdict(true, false)).toEqual({
      decision: "deny",
      reason: PAID_ESCALATION_NOT_APPROVED,
    });
  });
});

describe("formatTurnSummaryLine", () => {
  test("carries routing and cost facts, never content", () => {
    const line = formatTurnSummaryLine({
      sessionId: "01ABC",
      model: { slug: "claude-opus-4-8" },
      tokens: { input: 87, output: 70 },
      cost: { totalUsd: 0.008498, paidInferenceUsed: true },
      text: "SECRET turn content that must not be logged",
      // deno-lint-ignore no-explicit-any
    } as any);
    expect(line).toBe(
      "[turn] session=01ABC model=claude-opus-4-8 tokens=87in/70out cost=$0.008498 paid",
    );
    expect(line).not.toContain("SECRET");
  });

  test("degrades gracefully on partial results", () => {
    // deno-lint-ignore no-explicit-any
    const line = formatTurnSummaryLine({ sessionId: "01X" } as any);
    expect(line).toBe("[turn] session=01X model=unknown tokens=? cost=$? local");
  });
});
