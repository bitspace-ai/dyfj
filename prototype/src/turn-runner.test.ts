import { describe, expect, test } from "vitest";
import {
  formatTurnSummaryLine,
  PAID_ESCALATION_NOT_APPROVED,
  PAID_ESCALATION_REMOTE_DENIED,
  paidEscalationVerdict,
  resolveTurnFromBody,
} from "./turn-runner";

describe("resolveTurnFromBody paid posture", () => {
  test("selects the fixture runner only for a loopback turn", () => {
    expect(resolveTurnFromBody({ prompt: "hi", runner: "fixture" }, true))
      .toMatchObject({
        runtimeInput: { runner: { kind: "acp", profile: "fixture" } },
      });
    expect(resolveTurnFromBody({ prompt: "hi", runner: "fixture" }, false))
      .toMatchObject({ status: 403 });
  });

  test("selects the Codex ChatGPT-authenticated runner only for a trusted loopback workspace", () => {
    expect(resolveTurnFromBody(
      {
        prompt: "hi",
        runner: "codex-chatgpt",
      },
      true,
      { trustWorkspaceInstructions: true },
    )).toMatchObject({
      runtimeInput: {
        runner: { kind: "acp", profile: "codex-chatgpt" },
        trustWorkspaceInstructions: true,
      },
    });
    expect(resolveTurnFromBody(
      {
        prompt: "hi",
        runner: "codex-chatgpt",
      },
      true,
      { trustWorkspaceInstructions: false },
    )).toMatchObject({
      status: 403,
      error: "codex-chatgpt requires explicit workspace trust",
    });
    expect(resolveTurnFromBody(
      {
        prompt: "hi",
        runner: "codex-chatgpt",
      },
      false,
      { trustWorkspaceInstructions: true },
    )).toMatchObject({
      status: 403,
    });
  });

  test("keeps the Codex ChatGPT route single-turn", () => {
    expect(resolveTurnFromBody(
      {
        prompt: "hi",
        runner: "codex-chatgpt",
        sessionId: "01ABCDEF0123456789ABCDEF01",
      },
      true,
      { trustWorkspaceInstructions: true },
    )).toMatchObject({
      status: 400,
      error: "codex-chatgpt does not support session resume",
    });
  });

  test("keeps external runner selection distinct from model routing", () => {
    expect(resolveTurnFromBody({
      prompt: "hi",
      runner: "fixture",
      routingOptions: { modelId: "not-a-runner" },
    }, true)).toMatchObject({
      status: 400,
      error: "runner cannot be combined with model routing options",
    });
  });

  test("carries a valid client turn id into the runtime input", () => {
    const turnId = "123e4567-e89b-42d3-a456-426614174000";
    const resolved = resolveTurnFromBody({ prompt: "hi", turnId }, true);
    expect(resolved).toMatchObject({ runtimeInput: { turnId } });
  });

  test("rejects a malformed turn id", () => {
    expect(resolveTurnFromBody({ prompt: "hi", turnId: "turn-1" }, true))
      .toMatchObject({ status: 400, error: "turnId must be a UUID" });
  });

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
  test("reports external runner evidence without inventing model or USD facts", () => {
    const line = formatTurnSummaryLine({
      sessionId: "01ACP",
      runner: { profile: "fixture", protocol: "acp", costBasis: "local_free" },
    } as any);
    expect(line).toBe(
      "[turn] session=01ACP runner=fixture protocol=acp cost_basis=local_free",
    );
    expect(line).not.toContain("model=");
    expect(line).not.toContain("cost=$");
  });

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
    expect(line).toBe(
      "[turn] session=01X model=unknown tokens=? cost=$? local",
    );
  });
});
