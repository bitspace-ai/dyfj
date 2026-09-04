import {
  buildClosureReport,
  type ClosureState,
  evaluateClosureReport,
} from "./executable-closure-report.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const STATES = new Set<ClosureState>([
  "pass",
  "fail",
  "blocked",
  "not-applicable",
  "not-evaluated",
]);

function isComplete(
  entry: { result: ClosureState; residual?: string },
): boolean {
  return entry.result === "pass" ||
    ((entry.result === "blocked" || entry.result === "not-applicable") &&
      (entry.residual?.length ?? 0) > 0);
}

Deno.test("the generated report computes the fixed EC, RP, and target denominators", async () => {
  const report = await buildClosureReport();

  assert(
    report.invariants.length === 61,
    "report does not contain 61 EC entries",
  );
  assert(
    new Set(report.invariants.map((entry) => entry.id)).size === 61,
    "EC ids are duplicated",
  );
  assert(
    report.invariants.every((entry) =>
      entry.result === "pass" ||
      (entry.result === "blocked" && (entry.residual?.length ?? 0) > 0)
    ),
    "an EC is neither passing nor explicitly blocked",
  );
  assert(
    report.invariants.filter((entry) => entry.result === "blocked").map(
      (entry) => entry.id,
    ).join(",") === "EC-010,EC-045",
    "the explicit invariant residual set changed",
  );
  assert(
    report.invariants.every((entry) =>
      entry.positive_witness.length > 0 &&
      entry.positive_witness.every((witness) => witness.result === "pass")
    ),
    "an EC lacks an observed positive witness",
  );
  assert(
    report.invariants.every((entry) =>
      entry.required_mutation_classes.length > 0 &&
      entry.required_mutation_classes.every((required) =>
        entry.negative_mutations.some((witness) =>
          witness.mutation_class === required && isComplete(witness) &&
          witness.stable_rule.length > 0
        )
      )
    ),
    "an EC lacks an observed required mutation class",
  );
  assert(
    new Set(report.probes.map((entry) => entry.id)).size === 31,
    "RP denominator is incomplete",
  );
  assert(
    report.probes.every((entry) =>
      entry.result === "pass" &&
      entry.actual_rules.join(",") === entry.expected_rules.join(",")
    ),
    "an RP disposition or expected-rule set mismatched",
  );
  assert(report.targets.length === 24, "target denominator is incomplete");
  assert(
    report.targets.every((entry) =>
      entry.result === "pass" ||
      (entry.result === "blocked" && (entry.residual?.length ?? 0) > 0)
    ),
    "a target rollup is neither passing nor explicitly blocked",
  );
  assert(
    report.ladder.every((entry) =>
      entry.id === "public-claim-trace"
        ? entry.result === "pass"
        : entry.result === "not-evaluated"
    ),
    "the generator asserted a ladder result it did not execute",
  );
  assert(
    report.self_check?.result === "pass",
    "report self-check is not passing",
  );
  assert(report.result === "pass", "report result is not passing");

  const serialized = JSON.stringify(report);
  for (const state of serialized.match(/"result":"([^"]+)"/g) ?? []) {
    const value = state.slice(10, -1) as ClosureState;
    assert(STATES.has(value), `unsupported closure state ${value}`);
  }
});

Deno.test("the report self-check fails on mutated evidence and computed results", async () => {
  const report = await buildClosureReport();

  const missingId = structuredClone(report);
  missingId.invariants.splice(0, 1);
  assert(
    evaluateClosureReport(missingId).result === "fail",
    "missing EC id did not fail the report",
  );

  const missingPositive = structuredClone(report);
  missingPositive.invariants[0]!.positive_witness = [];
  assert(
    evaluateClosureReport(missingPositive).result === "fail",
    "missing positive witness did not fail the report",
  );

  const missingMutation = structuredClone(report);
  missingMutation.invariants[0]!.negative_mutations = [];
  assert(
    evaluateClosureReport(missingMutation).result === "fail",
    "missing mutation class did not fail the report",
  );

  const unrelatedProbeRule = structuredClone(report);
  unrelatedProbeRule.probes.find((entry) => entry.expected === "reject")!
    .actual_rules = ["authority.basis"];
  assert(
    evaluateClosureReport(unrelatedProbeRule).result === "fail",
    "unrelated probe rejection did not fail the report",
  );

  const assertedTarget = structuredClone(report);
  assertedTarget.targets[0]!.result = "fail";
  assert(
    evaluateClosureReport(assertedTarget).result === "fail",
    "asserted target result did not fail the report",
  );

  const unsupportedClaim = structuredClone(report);
  unsupportedClaim.public_claim_trace[0]!.categorical_claims[0]!.supported =
    false;
  unsupportedClaim.public_claim_trace[0]!.categorical_claims[0]!.result =
    "fail";
  unsupportedClaim.public_claim_trace[0]!.result = "fail";
  assert(
    evaluateClosureReport(unsupportedClaim).result === "fail",
    "unsupported public claim did not fail the report",
  );
});
