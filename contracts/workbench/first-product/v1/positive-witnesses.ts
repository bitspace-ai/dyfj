export type PositiveWitnessSource =
  | { kind: "fixture"; id: string }
  | { kind: "probe"; id: string }
  | { kind: "package"; id: string };

export interface PositiveWitnessRequirement {
  branch: string;
  source: PositiveWitnessSource;
}

const baseline = (branch: string): PositiveWitnessRequirement => ({
  branch,
  source: { kind: "fixture", id: "first-product-baseline.json" },
});

const fixture = (branch: string, id: string): PositiveWitnessRequirement => ({
  branch,
  source: { kind: "fixture", id },
});

const probe = (branch: string, id: string): PositiveWitnessRequirement => ({
  branch,
  source: { kind: "probe", id },
});

const packageCheck = (
  branch: string,
  id: string,
): PositiveWitnessRequirement => ({
  branch,
  source: { kind: "package", id },
});

/**
 * Explicit positive evidence for every frozen EC and every allowed branch.
 * A non-base fixture must materially differ from its base, and an accept
 * probe must materially mutate the baseline, before the generator credits it.
 */
export const POSITIVE_WITNESS_TABLE: Record<
  string,
  readonly PositiveWitnessRequirement[]
> = {
  "EC-001": [
    baseline("persistent primary Room"),
    probe("additional ephemeral Room", "RP-31.allowed"),
  ],
  "EC-002": [baseline("stable opaque identities")],
  "EC-003": [baseline("automated summons blocked")],
  "EC-004": [baseline("effective Room authorship membership")],
  "EC-005": [baseline("membership basis resolves")],
  "EC-006": [
    baseline("always-on speak policy"),
    fixture("scheduled speak policy", "07-scheduled-speak-policy.json"),
    fixture(
      "operator-authorized summons exception",
      "06-operator-authorized-summons-exception.json",
    ),
  ],
  "EC-007": [baseline("main and Task-branch Threads reconcile")],
  "EC-008": [
    fixture("distinct AgentSpec behavior", "10-distinct-agent-behavior.json"),
  ],
  "EC-009": [
    fixture("distinct Task objective", "09-distinct-task-objective.json"),
  ],
  "EC-010": [baseline("approved envelope represented")],
  "EC-011": [baseline("Run required references")],
  "EC-012": [baseline("distinct Run attempts")],
  "EC-013": [baseline("Task and Run assignment agreement")],
  "EC-014": [
    fixture("narrowed successor grant", "59-narrowed-successor-run-grant.json"),
  ],
  "EC-015": [baseline("Run stays inside Task envelope")],
  "EC-016": [
    baseline("exclusive packet ownership"),
    probe("omitted packet reverse links", "RP-16.allowed"),
  ],
  "EC-017": [
    baseline("native Route runner"),
    fixture("external Route runner", "08-external-route-names-runner.json"),
    probe("native hosted Route", "RP-09.allowed"),
  ],
  "EC-018": [
    baseline("Route component dispositions"),
    fixture("external Route runner", "08-external-route-names-runner.json"),
    probe("applicable system harness", "RP-13.allowed"),
  ],
  "EC-019": [baseline("unique capability classifications")],
  "EC-020": [baseline("bidirectional RouteSession binding")],
  "EC-021": [
    baseline("execution RouteSession"),
    probe("inspection-only session", "RP-29.allowed"),
  ],
  "EC-022": [
    baseline("available required capabilities"),
    probe("inspection-only session", "RP-29.allowed"),
  ],
  "EC-023": [
    baseline("approval precedes reliance"),
    probe("inspection-only session", "RP-29.allowed"),
  ],
  "EC-024": [
    baseline("Finalize and halted control evidence"),
    probe("inspection-only session", "RP-29.allowed"),
  ],
  "EC-025": [baseline("ContextPacket digest")],
  "EC-026": [baseline("derived provenance and labels")],
  "EC-027": [
    fixture("distinct explicit grant scopes", "11-distinct-grant-scopes.json"),
  ],
  "EC-028": [baseline("effective grant principals and scope")],
  "EC-029": [
    fixture("narrowed successor grant", "59-narrowed-successor-run-grant.json"),
  ],
  "EC-030": [baseline("no private untrusted egress")],
  "EC-031": [baseline("lease expiry preserves identity")],
  "EC-032": [baseline("separate Task and Run state types")],
  "EC-033": [
    baseline("required Task progression"),
    fixture("waiting detour", "02-task-waiting-branch.json"),
    fixture("blocked detour", "03-task-blocked-branch.json"),
  ],
  "EC-034": [
    fixture("waiting returns to running", "02-task-waiting-branch.json"),
    fixture("blocked returns to running", "03-task-blocked-branch.json"),
  ],
  "EC-035": [
    baseline("interrupted Run recovery"),
    fixture(
      "operator-decided ending cites failed Run",
      "05-operator-decided-failed-run-ending.json",
    ),
  ],
  "EC-036": [
    fixture(
      "operator-decided ending cites failed Run",
      "05-operator-decided-failed-run-ending.json",
    ),
  ],
  "EC-037": [
    baseline("accepted then closed"),
    fixture("completed directly closed", "04-completed-directly-closed.json"),
  ],
  "EC-038": [baseline("event containment")],
  "EC-039": [baseline("transition-event pairing")],
  "EC-040": [baseline("sequence and durable commit order")],
  "EC-041": [baseline("separate claim sources")],
  "EC-042": [baseline("projection and derivation labels")],
  "EC-043": [baseline("complete event-family vocabulary")],
  "EC-044": [baseline("durable commit before acknowledgement")],
  "EC-045": [probe("declared inline writer cutover", "RP-15.allowed")],
  "EC-046": [baseline("immutable consequential artifact evidence")],
  "EC-047": [baseline("projection clearance")],
  "EC-048": [baseline("all receipt families")],
  "EC-049": [
    baseline("Run-participating turn"),
    probe("pure conversational turn", "RP-10.allowed"),
  ],
  "EC-050": [baseline("Run receipt subject evidence")],
  "EC-051": [baseline("interrupted Run receipt")],
  "EC-052": [baseline("separate completion facts")],
  "EC-053": [baseline("receipt subject reconciliation")],
  "EC-054": [baseline("pointer-only private payload")],
  "EC-055": [baseline("explicit deferrals")],
  "EC-056": [baseline("deferred capabilities unavailable")],
  "EC-057": [
    packageCheck("schema authoring audit", "package:schema-authoring-audit"),
  ],
  "EC-058": [
    packageCheck("exact fixed denominator", "package:fixed-denominator"),
  ],
  "EC-059": [
    packageCheck(
      "explicit branch witness table",
      "package:positive-witness-table",
    ),
  ],
  "EC-060": [
    packageCheck(
      "complete mutation requirements",
      "package:mutation-requirements",
    ),
  ],
  "EC-061": [
    packageCheck("public claim support trace", "package:public-claim-trace"),
  ],
};
