import { captureRejection } from "../../testing/assertions/captured.ts";
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { PaidEscalationVerdict } from "../contract/mod.ts";
import { PaidEscalationDeclinedError } from "./errors.ts";
import {
  buildPaidEscalationPreflightBanner,
  confirmPaidRoute,
  formatMoney,
  isNextWorkMode,
  maybeBuildPaidEscalationPreflightBanner,
  type PaidEscalationPreflightInput,
  routeReasonForMode,
} from "./route.ts";

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

function verdict(
  value: PaidEscalationVerdict,
): (banner: string) => Promise<PaidEscalationVerdict> {
  return () => Promise.resolve(value);
}

test("formatMoney formats sub-cent model costs with six decimal places", () => {
  assert.deepStrictEqual(formatMoney(0.0001234), "$0.000123");
});

test("formatMoney formats zero as an explicit dollar amount", () => {
  assert.deepStrictEqual(formatMoney(0), "$0.000000");
});

test("buildPaidEscalationPreflightBanner shows paid escalation call shape before inference", () => {
  const banner = buildPaidEscalationPreflightBanner(BASE_PREFLIGHT);

  assert.ok(
    banner.includes("Paid inference preflight"),
    `expected ${JSON.stringify(banner)} to include "Paid inference preflight"`,
  );
  assert.ok(
    banner.includes("Model:           Claude Sonnet (claude-sonnet)"),
    `expected ${
      JSON.stringify(banner)
    } to include "Model:           Claude Sonnet (claude-sonnet)"`,
  );
  assert.ok(
    banner.includes("Tier:            1"),
    `expected ${JSON.stringify(banner)} to include "Tier:            1"`,
  );
  assert.ok(
    banner.includes("Route:           explicit_tier"),
    `expected ${
      JSON.stringify(banner)
    } to include "Route:           explicit_tier"`,
  );
  assert.ok(
    banner.includes("Estimated cost:  $0.012346"),
    `expected ${
      JSON.stringify(banner)
    } to include "Estimated cost:  $0.012346"`,
  );
  assert.ok(
    banner.includes("Session spent:   $0.050000 / $1.000000"),
    `expected ${
      JSON.stringify(banner)
    } to include "Session spent:   $0.050000 / $1.000000"`,
  );
  assert.ok(
    banner.includes("Session headroom: $0.950000"),
    `expected ${
      JSON.stringify(banner)
    } to include "Session headroom: $0.950000"`,
  );
  assert.ok(
    banner.includes("Per-call limit:  $0.100000"),
    `expected ${
      JSON.stringify(banner)
    } to include "Per-call limit:  $0.100000"`,
  );
});

test("maybeBuildPaidEscalationPreflightBanner keeps tier 0 prompt-free", () => {
  assert.deepStrictEqual(
    maybeBuildPaidEscalationPreflightBanner({
      ...BASE_PREFLIGHT,
      tier: 0,
      estimatedCostUsd: 0,
    }),
    null,
  );
});

test("isNextWorkMode keeps generic ask separate from the measured next-work worklet", () => {
  assert.deepStrictEqual(isNextWorkMode("ask"), false);
  assert.deepStrictEqual(isNextWorkMode("next-work"), true);
});

test("routeReasonForMode names the local next-work default and passes other reasons through", () => {
  assert.deepStrictEqual(
    routeReasonForMode("default", 0, true),
    "default_local_next_work",
  );
  assert.deepStrictEqual(routeReasonForMode("default", 0, false), "default");
  assert.deepStrictEqual(routeReasonForMode("default", 1, true), "default");
  assert.deepStrictEqual(
    routeReasonForMode("explicit_model_id", 0, true),
    "explicit_model_id",
  );
});

test("confirmPaidRoute passes tier 0 without asking", async () => {
  const confirm = mock.fn(verdict({ decision: "deny" }));
  await confirmPaidRoute({ ...BASE_PREFLIGHT, tier: 0 }, confirm);
  assert.equal(confirm.mock.callCount(), 0);
});

test("confirmPaidRoute shows the banner and resolves on approval", async () => {
  const confirm = mock.fn(verdict({ decision: "approve" }));
  await confirmPaidRoute(BASE_PREFLIGHT, confirm);
  assert.equal(confirm.mock.callCount(), 1);
  assert.deepStrictEqual(
    confirm.mock.calls[0].arguments[0],
    buildPaidEscalationPreflightBanner(BASE_PREFLIGHT),
  );
});

test("confirmPaidRoute throws the declined verdict", async () => {
  const error = await captureRejection(
    () =>
      confirmPaidRoute(
        BASE_PREFLIGHT,
        verdict({ decision: "deny", reason: "operator declined" }),
      ),
    PaidEscalationDeclinedError,
  );
  assert.deepStrictEqual(error.verdict, {
    decision: "deny",
    reason: "operator declined",
  });
  assert.deepStrictEqual(
    error.message,
    "Paid inference consent declined: operator declined",
  );
});

test("confirmPaidRoute treats an escalate verdict as a refusal", async () => {
  const error = await captureRejection(
    () =>
      confirmPaidRoute(
        { ...BASE_PREFLIGHT, tier: 2 },
        verdict({ decision: "escalate" }),
      ),
    PaidEscalationDeclinedError,
  );
  assert.deepStrictEqual(error.message, "Paid inference escalation required");
});

test("confirmPaidRoute denies when no consent handler is configured", async () => {
  const error = await captureRejection(
    () => confirmPaidRoute(BASE_PREFLIGHT, undefined),
    PaidEscalationDeclinedError,
  );
  assert.deepStrictEqual(error.verdict, {
    decision: "deny",
    reason: "no consent handler configured",
  });
});
