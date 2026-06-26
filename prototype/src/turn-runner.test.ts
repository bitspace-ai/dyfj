import { describe, expect, test } from "vitest";
import {
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
