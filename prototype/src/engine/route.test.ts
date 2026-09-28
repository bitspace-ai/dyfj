import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { assertSpyCalls, spy } from "@std/testing/mock";
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

Deno.test("formatMoney formats sub-cent model costs with six decimal places", () => {
  assertEquals(formatMoney(0.0001234), "$0.000123");
});

Deno.test("formatMoney formats zero as an explicit dollar amount", () => {
  assertEquals(formatMoney(0), "$0.000000");
});

Deno.test("buildPaidEscalationPreflightBanner shows paid escalation call shape before inference", () => {
  const banner = buildPaidEscalationPreflightBanner(BASE_PREFLIGHT);

  assertStringIncludes(banner, "Paid inference preflight");
  assertStringIncludes(
    banner,
    "Model:           Claude Sonnet (claude-sonnet)",
  );
  assertStringIncludes(banner, "Tier:            1");
  assertStringIncludes(banner, "Route:           explicit_tier");
  assertStringIncludes(banner, "Estimated cost:  $0.012346");
  assertStringIncludes(banner, "Session spent:   $0.050000 / $1.000000");
  assertStringIncludes(banner, "Session headroom: $0.950000");
  assertStringIncludes(banner, "Per-call limit:  $0.100000");
});

Deno.test("maybeBuildPaidEscalationPreflightBanner keeps tier 0 prompt-free", () => {
  assertEquals(
    maybeBuildPaidEscalationPreflightBanner({
      ...BASE_PREFLIGHT,
      tier: 0,
      estimatedCostUsd: 0,
    }),
    null,
  );
});

Deno.test("isNextWorkMode keeps generic ask separate from the measured next-work worklet", () => {
  assertEquals(isNextWorkMode("ask"), false);
  assertEquals(isNextWorkMode("next-work"), true);
});

Deno.test("routeReasonForMode names the local next-work default and passes other reasons through", () => {
  assertEquals(
    routeReasonForMode("default", 0, true),
    "default_local_next_work",
  );
  assertEquals(routeReasonForMode("default", 0, false), "default");
  assertEquals(routeReasonForMode("default", 1, true), "default");
  assertEquals(
    routeReasonForMode("explicit_model_id", 0, true),
    "explicit_model_id",
  );
});

Deno.test("confirmPaidRoute passes tier 0 without asking", async () => {
  const confirm = spy(verdict({ decision: "deny" }));
  await confirmPaidRoute({ ...BASE_PREFLIGHT, tier: 0 }, confirm);
  assertSpyCalls(confirm, 0);
});

Deno.test("confirmPaidRoute shows the banner and resolves on approval", async () => {
  const confirm = spy(verdict({ decision: "approve" }));
  await confirmPaidRoute(BASE_PREFLIGHT, confirm);
  assertSpyCalls(confirm, 1);
  assertEquals(
    confirm.calls[0].args[0],
    buildPaidEscalationPreflightBanner(BASE_PREFLIGHT),
  );
});

Deno.test("confirmPaidRoute throws the declined verdict", async () => {
  const error = await assertRejects(
    () =>
      confirmPaidRoute(
        BASE_PREFLIGHT,
        verdict({ decision: "deny", reason: "operator declined" }),
      ),
    PaidEscalationDeclinedError,
  );
  assertEquals(error.verdict, {
    decision: "deny",
    reason: "operator declined",
  });
  assertEquals(
    error.message,
    "Paid inference consent declined: operator declined",
  );
});

Deno.test("confirmPaidRoute treats an escalate verdict as a refusal", async () => {
  const error = await assertRejects(
    () =>
      confirmPaidRoute(
        { ...BASE_PREFLIGHT, tier: 2 },
        verdict({ decision: "escalate" }),
      ),
    PaidEscalationDeclinedError,
  );
  assertEquals(error.message, "Paid inference escalation required");
});

Deno.test("confirmPaidRoute denies when no consent handler is configured", async () => {
  const error = await assertRejects(
    () => confirmPaidRoute(BASE_PREFLIGHT, undefined),
    PaidEscalationDeclinedError,
  );
  assertEquals(error.verdict, {
    decision: "deny",
    reason: "no consent handler configured",
  });
});
