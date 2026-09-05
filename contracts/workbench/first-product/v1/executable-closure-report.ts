import {
  type Corpus,
  loadFixtures,
  loadSchemaRegistry,
  RULE_IDS,
  validateCorpus,
} from "./validate.ts";
import { SchemaRegistry } from "./json-schema.ts";
import { PROBE_FIXTURES } from "./oracle-probes.ts";
import {
  POSITIVE_WITNESS_TABLE,
  type PositiveWitnessRequirement,
} from "./positive-witnesses.ts";

export type ClosureState =
  | "pass"
  | "fail"
  | "blocked"
  | "not-applicable"
  | "not-evaluated";
type Disposition = "accept" | "reject";
type MutationClass =
  | "omission"
  | "mismatch"
  | "wrong-kind"
  | "temporal"
  | "authority"
  | "cardinality";

interface EvidenceRequirement {
  mutation_class: MutationClass;
  evidence: string;
}

interface EvidenceObservation {
  result: ClosureState;
  stable_rule: string;
  actual_rules: string[];
  residual?: string;
}

interface Witness extends EvidenceObservation {
  mutation_class: MutationClass;
  evidence: string;
}

interface PositiveWitness {
  evidence: string;
  branch: string;
  result: ClosureState;
  residual?: string;
}

interface InvariantEntry {
  id: string;
  result: ClosureState;
  positive_witness: PositiveWitness[];
  required_mutation_classes: MutationClass[];
  negative_mutations: Witness[];
  residual?: string;
}

interface ProbeEntry {
  id: string;
  branch: string;
  expected: Disposition;
  actual: Disposition;
  expected_rules: string[];
  actual_rules: string[];
  stable_rule: string | null;
  mutation_class: MutationClass | null;
  ec_ids: string[];
  result: ClosureState;
}

interface TargetEntry {
  id: string;
  subject: string;
  invariants: string[];
  result: ClosureState;
  residual?: string;
}

interface RuleEntry {
  stable_rule: string;
  ec_ids: string[];
  structural_safety: string | null;
}

interface PublicClaimEntry {
  path: string;
  categorical_claims: {
    claim_id: string;
    ec_ids: string[];
    declared: boolean;
    supported: boolean;
    result: ClosureState;
  }[];
  result: ClosureState;
}

export interface ClosureReport {
  schema: string;
  result: ClosureState;
  package_version: string;
  authority: Record<string, unknown>;
  candidate_identity: Record<string, unknown>;
  denominator: { targets: number; invariants: number; probes: number };
  invariants: InvariantEntry[];
  probes: ProbeEntry[];
  targets: TargetEntry[];
  stable_rules: RuleEntry[];
  ladder: { id: string; result: ClosureState; command: string }[];
  public_claim_trace: PublicClaimEntry[];
  residual_unknowns: string[];
  excluded_runtime_behavior: string[];
  self_check?: ReportSelfCheck;
}

export interface ReportSelfCheck {
  result: "pass" | "fail";
  invariant_ids_exact: boolean;
  target_ids_exact: boolean;
  probe_ids_complete: boolean;
  probe_expectations_observed: boolean;
  positive_witnesses_observed: boolean;
  mutation_requirements_observed: boolean;
  invariant_results_computed: boolean;
  target_results_computed: boolean;
  rule_authority_complete: boolean;
  ladder_truthful: boolean;
  public_claims_observed: boolean;
  source_manifest_formula_stated: boolean;
}

const PROBE_EXPECTATIONS: Record<string, {
  disposition: Disposition;
  rules: readonly string[];
  stable_rule: string | null;
  mutation_class: MutationClass | null;
}> = {
  "RP-01.forbidden": {
    disposition: "reject",
    rules: ["structure.required"],
    stable_rule: "structure.required",
    mutation_class: "omission",
  },
  "RP-02.forbidden": {
    disposition: "reject",
    rules: ["run.evidence-binding"],
    stable_rule: "run.evidence-binding",
    mutation_class: "mismatch",
  },
  "RP-03.forbidden": {
    disposition: "reject",
    rules: ["structure.required"],
    stable_rule: "structure.required",
    mutation_class: "omission",
  },
  "RP-04.forbidden": {
    disposition: "reject",
    rules: ["receipt.family-requirements", "receipt.subject-reconciliation"],
    stable_rule: "receipt.family-requirements",
    mutation_class: "omission",
  },
  "RP-05.forbidden": {
    disposition: "reject",
    rules: ["authority.basis", "receipt.subject-reconciliation"],
    stable_rule: "receipt.subject-reconciliation",
    mutation_class: "mismatch",
  },
  "RP-06.forbidden": {
    disposition: "reject",
    rules: ["event.causal-order", "authority.basis"],
    stable_rule: "event.causal-order",
    mutation_class: "temporal",
  },
  "RP-07.forbidden": {
    disposition: "reject",
    rules: ["event.causal-order", "receipt.subject-reconciliation"],
    stable_rule: "event.causal-order",
    mutation_class: "temporal",
  },
  "RP-08.forbidden": {
    disposition: "reject",
    rules: ["lifecycle.run-independence"],
    stable_rule: "lifecycle.run-independence",
    mutation_class: "omission",
  },
  "RP-09.allowed": {
    disposition: "accept",
    rules: [],
    stable_rule: null,
    mutation_class: null,
  },
  "RP-10.allowed": {
    disposition: "accept",
    rules: [],
    stable_rule: null,
    mutation_class: null,
  },
  "RP-11.allowed": {
    disposition: "accept",
    rules: [],
    stable_rule: null,
    mutation_class: null,
  },
  "RP-12.allowed": {
    disposition: "accept",
    rules: [],
    stable_rule: null,
    mutation_class: null,
  },
  "RP-13.allowed": {
    disposition: "accept",
    rules: [],
    stable_rule: null,
    mutation_class: null,
  },
  "RP-14.allowed": {
    disposition: "accept",
    rules: [],
    stable_rule: null,
    mutation_class: null,
  },
  "RP-15.allowed": {
    disposition: "accept",
    rules: [],
    stable_rule: null,
    mutation_class: null,
  },
  "RP-16.allowed": {
    disposition: "accept",
    rules: [],
    stable_rule: null,
    mutation_class: null,
  },
  "RP-16.forbidden": {
    disposition: "reject",
    rules: ["run.evidence-binding", "receipt.subject-reconciliation"],
    stable_rule: "run.evidence-binding",
    mutation_class: "mismatch",
  },
  "RP-17.allowed": {
    disposition: "accept",
    rules: [],
    stable_rule: null,
    mutation_class: null,
  },
  "RP-17.forbidden": {
    disposition: "reject",
    rules: ["run.evidence-binding"],
    stable_rule: "run.evidence-binding",
    mutation_class: "authority",
  },
  "RP-18.forbidden": {
    disposition: "reject",
    rules: ["run.evidence-binding", "authority.basis"],
    stable_rule: "run.evidence-binding",
    mutation_class: "mismatch",
  },
  "RP-19.forbidden": {
    disposition: "reject",
    rules: ["grant.egress-policy"],
    stable_rule: "grant.egress-policy",
    mutation_class: "authority",
  },
  "RP-20.forbidden": {
    disposition: "reject",
    rules: ["lifecycle.progression", "lifecycle.run-independence"],
    stable_rule: "lifecycle.run-independence",
    mutation_class: "authority",
  },
  "RP-21.forbidden": {
    disposition: "reject",
    rules: ["lifecycle.run-independence"],
    stable_rule: "lifecycle.run-independence",
    mutation_class: "mismatch",
  },
  "RP-22.forbidden": {
    disposition: "reject",
    rules: ["run.evidence-binding", "receipt.subject-reconciliation"],
    stable_rule: "run.evidence-binding",
    mutation_class: "mismatch",
  },
  "RP-23.forbidden": {
    disposition: "reject",
    rules: ["authority.basis"],
    stable_rule: "authority.basis",
    mutation_class: "omission",
  },
  "RP-24.forbidden": {
    disposition: "reject",
    rules: ["authority.basis", "solo-room.loop-prevention"],
    stable_rule: "solo-room.loop-prevention",
    mutation_class: "authority",
  },
  "RP-25.forbidden": {
    disposition: "reject",
    rules: ["receipt.subject-reconciliation"],
    stable_rule: "receipt.subject-reconciliation",
    mutation_class: "omission",
  },
  "RP-26.forbidden": {
    disposition: "reject",
    rules: ["receipt.subject-reconciliation"],
    stable_rule: "receipt.subject-reconciliation",
    mutation_class: "omission",
  },
  "RP-27.forbidden": {
    disposition: "reject",
    rules: [
      "run.evidence-binding",
      "grant.no-self-broadening",
      "grant.egress-policy",
    ],
    stable_rule: "grant.no-self-broadening",
    mutation_class: "authority",
  },
  "RP-28.forbidden": {
    disposition: "reject",
    rules: ["authority.sole-writer"],
    stable_rule: "authority.sole-writer",
    mutation_class: "omission",
  },
  "RP-29.allowed": {
    disposition: "accept",
    rules: [],
    stable_rule: null,
    mutation_class: null,
  },
  "RP-29.forbidden": {
    disposition: "reject",
    rules: ["route.phase-order"],
    stable_rule: "route.phase-order",
    mutation_class: "omission",
  },
  "RP-30.forbidden": {
    disposition: "reject",
    rules: ["run.evidence-binding"],
    stable_rule: "run.evidence-binding",
    mutation_class: "mismatch",
  },
  "RP-31.allowed": {
    disposition: "accept",
    rules: [],
    stable_rule: null,
    mutation_class: null,
  },
};

const EC_REQUIREMENTS: Record<string, readonly EvidenceRequirement[]> = {
  "EC-001": [{
    mutation_class: "cardinality",
    evidence: "49-solo-room-not-persistent.json",
  }],
  "EC-002": [{
    mutation_class: "omission",
    evidence: "01-missing-stable-identity.json",
  }, {
    mutation_class: "cardinality",
    evidence: "44-duplicate-identifier.json",
  }],
  "EC-003": [{
    mutation_class: "authority",
    evidence: "probe:RP-24.forbidden",
  }],
  "EC-004": [{
    mutation_class: "wrong-kind",
    evidence: "45-membership-room-wrong-kind.json",
  }, {
    mutation_class: "authority",
    evidence: "72-nonmember-policy-default-author.json",
  }],
  "EC-005": [{ mutation_class: "omission", evidence: "probe:RP-23.forbidden" }],
  "EC-006": [{
    mutation_class: "authority",
    evidence: "83-summons-grant-names-another-grantee.json",
  }, {
    mutation_class: "authority",
    evidence: "97-summons-exception-denied-policy.json",
  }],
  "EC-007": [{ mutation_class: "mismatch", evidence: "probe:RP-22.forbidden" }],
  "EC-008": [{
    mutation_class: "omission",
    evidence: "generated:agent-spec-behavior-omission",
  }],
  "EC-009": [{
    mutation_class: "omission",
    evidence: "generated:task-objective-omission",
  }],
  "EC-010": [{
    mutation_class: "authority",
    evidence: "41-task-completed-without-approved-envelope.json",
  }],
  "EC-011": [{ mutation_class: "omission", evidence: "probe:RP-01.forbidden" }],
  "EC-012": [{
    mutation_class: "cardinality",
    evidence: "34-duplicate-run-attempt-number.json",
  }],
  "EC-013": [{ mutation_class: "mismatch", evidence: "probe:RP-30.forbidden" }],
  "EC-014": [{
    mutation_class: "authority",
    evidence: "probe:RP-17.forbidden",
  }],
  "EC-015": [
    { mutation_class: "mismatch", evidence: "probe:RP-30.forbidden" },
    {
      mutation_class: "authority",
      evidence: "87-receipt-cost-exceeds-task-budget.json",
    },
    {
      mutation_class: "authority",
      evidence: "88-receipt-tool-outside-grant.json",
    },
    {
      mutation_class: "authority",
      evidence: "89-receipt-external-effect-outside-grant.json",
    },
  ],
  "EC-016": [
    { mutation_class: "omission", evidence: "probe:RP-01.forbidden" },
    { mutation_class: "mismatch", evidence: "probe:RP-02.forbidden" },
    {
      mutation_class: "mismatch",
      evidence: "73-context-packet-bound-to-another-task.json",
    },
  ],
  "EC-017": [{
    mutation_class: "omission",
    evidence: "generated:route-identity-omission",
  }],
  "EC-018": [{
    mutation_class: "omission",
    evidence: "61-route-silently-omits-component-disposition.json",
  }],
  "EC-019": [{
    mutation_class: "cardinality",
    evidence: "65-duplicate-capability-classification.json",
  }],
  "EC-020": [{
    mutation_class: "mismatch",
    evidence: "75-run-names-another-runs-session.json",
  }, {
    mutation_class: "cardinality",
    evidence: "94-duplicate-route-session-owner.json",
  }],
  "EC-021": [
    { mutation_class: "omission", evidence: "probe:RP-29.forbidden" },
    {
      mutation_class: "temporal",
      evidence: "85-session-spend-without-run-reliance.json",
    },
  ],
  "EC-022": [{
    mutation_class: "authority",
    evidence: "12-unavailable-capability-reaches-spend.json",
  }],
  "EC-023": [
    { mutation_class: "temporal", evidence: "probe:RP-06.forbidden" },
    {
      mutation_class: "temporal",
      evidence: "95-retroactive-event-policy-approval.json",
    },
    {
      mutation_class: "authority",
      evidence: "98-approval-scope-mismatch.json",
    },
    {
      mutation_class: "authority",
      evidence: "90-machine-operator-direct-lacks-authorizing-event.json",
    },
  ],
  "EC-024": [{
    mutation_class: "omission",
    evidence: "58-terminal-run-uses-inspection-only-session.json",
  }],
  "EC-025": [{
    mutation_class: "omission",
    evidence: "generated:context-packet-digest-omission",
  }],
  "EC-026": [{
    mutation_class: "authority",
    evidence: "79-derived-artifact-self-verifies.json",
  }],
  "EC-027": [{
    mutation_class: "omission",
    evidence: "60-run-grant-silently-omits-route-scope.json",
  }],
  "EC-028": [
    { mutation_class: "mismatch", evidence: "probe:RP-18.forbidden" },
    {
      mutation_class: "authority",
      evidence: "82-event-grant-room-scope-mismatch.json",
    },
    {
      mutation_class: "authority",
      evidence: "97-summons-exception-denied-policy.json",
    },
    {
      mutation_class: "authority",
      evidence: "98-approval-scope-mismatch.json",
    },
    {
      mutation_class: "temporal",
      evidence: "residual:grant-expiry-not-represented",
    },
  ],
  "EC-029": [
    {
      mutation_class: "authority",
      evidence: "probe:RP-27.forbidden",
    },
    {
      mutation_class: "temporal",
      evidence: "96-retroactive-grant-expansion-approval.json",
    },
  ],
  "EC-030": [{
    mutation_class: "authority",
    evidence: "probe:RP-19.forbidden",
  }],
  "EC-031": [{
    mutation_class: "authority",
    evidence: "16-lease-expiry-deletes-identity.json",
  }],
  "EC-032": [{
    mutation_class: "wrong-kind",
    evidence: "04-run-state-used-as-task-state.json",
  }],
  "EC-033": [{
    mutation_class: "mismatch",
    evidence: "46-task-skips-required-progression.json",
  }],
  "EC-034": [{
    mutation_class: "mismatch",
    evidence: "46-task-skips-required-progression.json",
  }],
  "EC-035": [{
    mutation_class: "mismatch",
    evidence: "62-task-recovery-evidence-does-not-cite-run.json",
  }],
  "EC-036": [{
    mutation_class: "authority",
    evidence: "74-unrelated-operator-decision.json",
  }],
  "EC-037": [{
    mutation_class: "authority",
    evidence: "70-machine-authored-task-acceptance.json",
  }],
  "EC-038": [{
    mutation_class: "omission",
    evidence: "67-event-run-omits-owning-task.json",
  }, {
    mutation_class: "authority",
    evidence: "90-machine-operator-direct-lacks-authorizing-event.json",
  }],
  "EC-039": [{
    mutation_class: "omission",
    evidence: "06-state-mutation-without-event.json",
  }],
  "EC-040": [
    { mutation_class: "temporal", evidence: "probe:RP-06.forbidden" },
    {
      mutation_class: "temporal",
      evidence: "95-retroactive-event-policy-approval.json",
    },
    {
      mutation_class: "temporal",
      evidence: "86-commit-sequence-regresses.json",
    },
  ],
  "EC-041": [
    {
      mutation_class: "authority",
      evidence: "19-collapsed-claim-sources.json",
    },
    {
      mutation_class: "authority",
      evidence: "92-receipt-claim-source-disagrees-with-author.json",
    },
  ],
  "EC-042": [{
    mutation_class: "mismatch",
    evidence: "09-projection-drops-source-labels.json",
  }],
  "EC-043": [{
    mutation_class: "omission",
    evidence: "self-check:event-family-inventory",
  }],
  "EC-044": [{
    mutation_class: "temporal",
    evidence: "17-acknowledgement-before-durable-commit.json",
  }],
  "EC-045": [{ mutation_class: "omission", evidence: "probe:RP-28.forbidden" }],
  "EC-046": [{
    mutation_class: "omission",
    evidence: "66-completion-artifact-lacks-immutable-evidence.json",
  }],
  "EC-047": [{
    mutation_class: "mismatch",
    evidence: "10-projection-exceeds-consumer-clearance.json",
  }],
  "EC-048": [
    {
      mutation_class: "omission",
      evidence: "76-run-receipt-omits-context-packet.json",
    },
    { mutation_class: "omission", evidence: "77-run-receipt-omits-route.json" },
    {
      mutation_class: "omission",
      evidence: "78-run-receipt-omits-capability-posture.json",
    },
  ],
  "EC-049": [{
    mutation_class: "omission",
    evidence: "84-receipt-participation-hidden-in-cited-event.json",
  }],
  "EC-050": [
    { mutation_class: "omission", evidence: "probe:RP-04.forbidden" },
    {
      mutation_class: "omission",
      evidence: "76-run-receipt-omits-context-packet.json",
    },
    { mutation_class: "omission", evidence: "77-run-receipt-omits-route.json" },
    {
      mutation_class: "omission",
      evidence: "78-run-receipt-omits-capability-posture.json",
    },
  ],
  "EC-051": [{
    mutation_class: "mismatch",
    evidence: "64-stopped-interrupt-lacks-halted-control.json",
  }],
  "EC-052": [{
    mutation_class: "authority",
    evidence: "80-verification-fact-cites-producer-event.json",
  }],
  "EC-053": [
    { mutation_class: "mismatch", evidence: "probe:RP-05.forbidden" },
    {
      mutation_class: "omission",
      evidence: "57-turn-receipt-conceals-run-through-body.json",
    },
    {
      mutation_class: "mismatch",
      evidence: "81-receipt-room-disagrees.json",
    },
    {
      mutation_class: "authority",
      evidence: "87-receipt-cost-exceeds-task-budget.json",
    },
    {
      mutation_class: "omission",
      evidence: "84-receipt-participation-hidden-in-cited-event.json",
    },
    {
      mutation_class: "temporal",
      evidence: "93-process-provenance-postdates-receipt.json",
    },
  ],
  "EC-054": [{
    mutation_class: "authority",
    evidence: "18-inline-secret-in-event-payload.json",
  }],
  "EC-055": [{
    mutation_class: "authority",
    evidence: "21-deferred-capability-marked-required.json",
  }],
  "EC-056": [{
    mutation_class: "authority",
    evidence: "21-deferred-capability-marked-required.json",
  }],
  "EC-057": [{
    mutation_class: "wrong-kind",
    evidence: "self-check:dormant-unsupported-schema-keyword",
  }],
  "EC-058": [{
    mutation_class: "cardinality",
    evidence: "self-check:missing-ec-id",
  }],
  "EC-059": [{
    mutation_class: "omission",
    evidence: "self-check:missing-positive-witness",
  }],
  "EC-060": [{
    mutation_class: "omission",
    evidence: "self-check:missing-mutation-class",
  }],
  "EC-061": [{
    mutation_class: "authority",
    evidence: "self-check:unsupported-public-claim",
  }],
};

const FIXTURE_EC_RULES: Record<string, string[]> = {
  "identity.stable-basis": ["EC-002"],
  "identity.uniqueness": ["EC-002"],
  "reference.closure": ["EC-004", "EC-005", "EC-008", "EC-038", "EC-046"],
  "reference.kind": ["EC-004", "EC-011", "EC-038", "EC-048"],
  "lifecycle.state-type": ["EC-032"],
  "lifecycle.progression": ["EC-033", "EC-034"],
  "lifecycle.outcome-collapse": ["EC-036", "EC-037"],
  "lifecycle.run-independence": ["EC-035", "EC-036", "EC-037"],
  "lifecycle.transition-event-pairing": ["EC-039"],
  "lifecycle.revision-order": ["EC-010", "EC-040"],
  "lifecycle.run-attempt-uniqueness": ["EC-012"],
  "event.causal-order": ["EC-040"],
  "solo-room.defaults": ["EC-001", "EC-006"],
  "solo-room.loop-prevention": ["EC-003", "EC-006"],
  "label.preservation": ["EC-026", "EC-042", "EC-047"],
  "label.clearance": ["EC-047"],
  "provenance.preservation": ["EC-026", "EC-042", "EC-046"],
  "route.phase-order": ["EC-021", "EC-024"],
  "route.capability-rejection": ["EC-019", "EC-022"],
  "route.binding": ["EC-020", "EC-022"],
  "route.continuity-evidence": ["EC-024"],
  "route.native-extension-authority": ["EC-018"],
  "route.native-capability-erasure": ["EC-017", "EC-019"],
  "authority.durable-commit": ["EC-040", "EC-044"],
  "authority.async-source": ["EC-044"],
  "authority.basis": [
    "EC-003",
    "EC-004",
    "EC-005",
    "EC-006",
    "EC-010",
    "EC-023",
    "EC-028",
    "EC-038",
    "EC-040",
  ],
  "authority.task-envelope": ["EC-010", "EC-014", "EC-015"],
  "grant.no-self-broadening": ["EC-029"],
  "grant.principal-continuity": ["EC-028", "EC-029"],
  "lease.availability-only": ["EC-031"],
  "receipt.family-requirements": [
    "EC-048",
    "EC-049",
    "EC-050",
    "EC-051",
    "EC-052",
  ],
  "receipt.subject-reconciliation": [
    "EC-015",
    "EC-048",
    "EC-049",
    "EC-050",
    "EC-051",
    "EC-052",
    "EC-053",
  ],
  "claim-source.separation": ["EC-041", "EC-052"],
  "secrecy.inline-secret": ["EC-054"],
  "deferral.not-required": ["EC-055", "EC-056"],
  "deferral.inventory": ["EC-055", "EC-056"],
  "run.evidence-binding": [
    "EC-007",
    "EC-011",
    "EC-013",
    "EC-014",
    "EC-015",
    "EC-016",
    "EC-018",
    "EC-019",
    "EC-020",
    "EC-027",
    "EC-028",
    "EC-038",
  ],
  "grant.egress-policy": ["EC-030"],
  "authority.sole-writer": ["EC-045"],
};

const GENERATED_MUTATIONS = [
  {
    id: "generated:agent-spec-behavior-omission",
    rule: "structure.required",
    mutate: (corpus: Corpus) =>
      delete (corpus.agent_specs![0]! as Partial<
        NonNullable<Corpus["agent_specs"]>[number]
      >).behavior,
  },
  {
    id: "generated:task-objective-omission",
    rule: "structure.required",
    mutate: (corpus: Corpus) =>
      delete (corpus.tasks![0]!.execution_envelope as Partial<
        NonNullable<Corpus["tasks"]>[number]["execution_envelope"]
      >).objective,
  },
  {
    id: "generated:route-identity-omission",
    rule: "structure.mutual-exclusion",
    mutate: (corpus: Corpus) => delete corpus.routes![0]!.runner,
  },
  {
    id: "generated:context-packet-digest-omission",
    rule: "structure.required",
    mutate: (corpus: Corpus) =>
      delete (corpus.context_packets![0]! as Partial<
        NonNullable<Corpus["context_packets"]>[number]
      >).digest,
  },
] as const;

const REQUIRED_EVENT_FAMILIES = [
  "message",
  "task-transition",
  "run",
  "routing",
  "tool-discovery",
  "tool-invocation",
  "skill-discovery",
  "skill-invocation",
  "process-provenance",
  "approval",
  "revocation",
  "context-assembly",
  "context-compaction",
  "memory-proposal",
  "memory-promotion",
  "artifact",
  "verification",
  "cost",
  "interrupt",
  "receipt",
  "projection",
] as const;

const MANIFEST_FORMULA =
  "Sort package files by package-relative path; exclude executable-closure-report.json; for each file append lowercase SHA-256(file bytes), two ASCII spaces, the package-relative path, and one LF; SHA-256 the concatenated rows.";

export function eventFamilyInventoryComplete(
  families: readonly string[],
): boolean {
  return REQUIRED_EVENT_FAMILIES.every((family) => families.includes(family));
}

const INVARIANT_RESIDUALS: Record<string, string> = {
  "EC-010":
    "The Task envelope approval is represented as a boolean without an attributable approval event.",
  "EC-045":
    "The first inline writer declaration establishes cutover without a separate authority record.",
};

const PUBLIC_SEMANTIC_ECS = expectedIds("EC", 56, 3).filter((id) =>
  id !== "EC-010" && id !== "EC-045"
);

const PUBLIC_CLAIM_REQUIREMENTS: Record<string, Record<string, string[]>> = {
  "README.md": {
    "semantic-contract-behavior": PUBLIC_SEMANTIC_ECS,
    "semantic-package-boundary": ["EC-057", "EC-058", "EC-059", "EC-060"],
    "effective-event-authority": [
      "EC-004",
      "EC-005",
      "EC-023",
      "EC-028",
      "EC-038",
    ],
    "receipt-reconciliation": [
      "EC-048",
      "EC-049",
      "EC-050",
      "EC-051",
      "EC-052",
      "EC-053",
    ],
    "closure-report-evidence": ["EC-058", "EC-059", "EC-060", "EC-061"],
  },
  "CHANGELOG.md": {
    "semantic-contract-behavior": PUBLIC_SEMANTIC_ECS,
    "effective-event-authority": [
      "EC-004",
      "EC-005",
      "EC-023",
      "EC-028",
      "EC-038",
    ],
    "closure-report-evidence": ["EC-057", "EC-058", "EC-059", "EC-060"],
    "contract-evidence-closure": [
      "EC-006",
      "EC-015",
      "EC-020",
      "EC-021",
      "EC-023",
      "EC-026",
      "EC-028",
      "EC-036",
      "EC-037",
      "EC-038",
      "EC-040",
      "EC-041",
      "EC-048",
      "EC-049",
      "EC-050",
      "EC-052",
      "EC-053",
      "EC-058",
      "EC-059",
      "EC-060",
      "EC-061",
    ],
  },
  "contracts/workbench/first-product/v1/README.md": {
    "document-validation-boundary": ["EC-057"],
    "semantic-contract-behavior": PUBLIC_SEMANTIC_ECS,
    "operator-direct-evidence": ["EC-004", "EC-023", "EC-038"],
    "receipt-evidence-binding": [
      "EC-048",
      "EC-049",
      "EC-050",
      "EC-052",
      "EC-053",
    ],
    "explicit-positive-witnesses": ["EC-059", "EC-060"],
    "route-control-binding": ["EC-020", "EC-021", "EC-022", "EC-023", "EC-024"],
    "lifecycle-behavior": [
      "EC-032",
      "EC-033",
      "EC-034",
      "EC-035",
      "EC-036",
      "EC-037",
      "EC-038",
      "EC-039",
      "EC-040",
    ],
    "ordering-evidence": ["EC-040", "EC-044"],
    "deferral-boundary": ["EC-055", "EC-056"],
  },
};

function expectedIds(prefix: string, count: number, width: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `${prefix}-${String(index + 1).padStart(width, "0")}`,
  );
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

async function contractFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  async function visit(directory: string): Promise<void> {
    for await (const entry of Deno.readDir(directory)) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory) await visit(path);
      else if (
        entry.isFile && entry.name !== "executable-closure-report.json"
      ) found.push(path);
    }
  }
  await visit(root);
  return found.sort();
}

async function sourceManifest(root: string): Promise<Record<string, unknown>> {
  const files = await contractFiles(root);
  let lines = 0;
  const rows: string[] = [];
  for (const path of files) {
    const bytes = await Deno.readFile(path);
    const relative = path.slice(root.length + 1);
    const text = new TextDecoder().decode(bytes);
    lines += text.length === 0 ? 0 : text.split("\n").length - 1;
    rows.push(`${await sha256(bytes)}  ${relative}\n`);
  }
  return {
    sha256: await sha256(new TextEncoder().encode(rows.join(""))),
    file_count: files.length,
    line_count: lines,
    formula: MANIFEST_FORMULA,
    excludes: ["executable-closure-report.json (generated output)"],
  };
}

function structuralRuleAuthority(rule: string): string | undefined {
  return rule.startsWith("structure.")
    ? "JSON Schema structural safety and EC-057 authoring audit"
    : undefined;
}

async function observePublicClaims(
  root: string,
  invariants: InvariantEntry[],
): Promise<PublicClaimEntry[]> {
  return await Promise.all(
    Object.entries(PUBLIC_CLAIM_REQUIREMENTS).map(async ([path, required]) => {
      const text = await Deno.readTextFile(`${root}/${path}`);
      const declared = new Set(
        [...text.matchAll(/<!-- closure-claim: ([a-z0-9-]+) -->/g)].map(
          (match) => match[1]!,
        ),
      );
      const categoricalClaims = Object.entries(required).map(
        ([claimId, ecIds]) => {
          const supported = ecIds.every((id) =>
            invariants.find((entry) => entry.id === id)?.result === "pass"
          );
          const isDeclared = declared.has(claimId);
          return {
            claim_id: claimId,
            ec_ids: ecIds,
            declared: isDeclared,
            supported,
            result: isDeclared && supported ? "pass" : "fail",
          } as const;
        },
      );
      for (const claimId of declared) {
        if (required[claimId] !== undefined) continue;
        categoricalClaims.push({
          claim_id: claimId,
          ec_ids: [],
          declared: true,
          supported: false,
          result: "fail",
        });
      }
      return {
        path,
        categorical_claims: categoricalClaims,
        result: categoricalClaims.every((claim) => claim.result === "pass")
          ? "pass"
          : "fail",
      } as PublicClaimEntry;
    }),
  );
}

export function evaluateClosureReport(report: ClosureReport): ReportSelfCheck {
  const invariantIds = expectedIds("EC", 61, 3);
  const targetIds = Array.from(
    { length: 24 },
    (_, index) => `T${String(index + 1).padStart(2, "0")}`,
  );
  const completeObservation = (
    observation: { result: ClosureState; residual?: string },
  ): boolean =>
    observation.result === "pass" ||
    ((observation.result === "blocked" ||
      observation.result === "not-applicable") &&
      (observation.residual?.length ?? 0) > 0);
  const positiveWitnessesObserved = report.invariants.every((entry) =>
    entry.positive_witness.length > 0 &&
    entry.positive_witness.every(completeObservation)
  );
  const mutationRequirementsObserved = report.invariants.every((entry) =>
    entry.required_mutation_classes.length > 0 &&
    entry.negative_mutations.every((witness) =>
      completeObservation(witness) && witness.stable_rule.length > 0
    ) &&
    entry.required_mutation_classes.every((required) =>
      entry.negative_mutations.some((witness) =>
        witness.mutation_class === required && completeObservation(witness) &&
        witness.stable_rule.length > 0
      )
    )
  );
  const invariantResultsComputed = report.invariants.every((entry) => {
    const evidenceComplete = entry.positive_witness.length > 0 &&
      entry.positive_witness.every(completeObservation) &&
      entry.required_mutation_classes.length > 0 &&
      entry.required_mutation_classes.every((required) =>
        entry.negative_mutations.some((witness) =>
          witness.mutation_class === required && completeObservation(witness)
        )
      );
    const computed = !evidenceComplete
      ? "fail"
      : entry.residual === undefined
      ? "pass"
      : "blocked";
    return entry.result === computed;
  });
  const probeIdsComplete =
    new Set(report.probes.map((entry) => entry.id)).size === 31 &&
    sameStrings(
      Object.keys(PROBE_EXPECTATIONS).sort(),
      report.probes.map((entry) => `${entry.id}.${entry.branch}`).sort(),
    );
  const probeExpectationsObserved = report.probes.every((entry) => {
    const expected = PROBE_EXPECTATIONS[`${entry.id}.${entry.branch}`];
    const computed = expected !== undefined &&
        entry.expected === expected.disposition &&
        entry.actual === expected.disposition &&
        sameStrings(entry.expected_rules, expected.rules) &&
        sameStrings(entry.actual_rules, expected.rules) &&
        entry.stable_rule === expected.stable_rule &&
        entry.mutation_class === expected.mutation_class
      ? "pass"
      : "fail";
    return entry.result === computed && computed === "pass";
  });
  const targetResultsComputed = report.targets.every((target) => {
    const results = target.invariants.map((id) =>
      report.invariants.find((entry) => entry.id === id)?.result ?? "fail"
    );
    const computed = results.includes("fail")
      ? "fail"
      : results.includes("blocked")
      ? "blocked"
      : results.every((result) => result === "not-applicable")
      ? "not-applicable"
      : "pass";
    return target.result === computed &&
      ((computed !== "blocked" && computed !== "not-applicable") ||
        (target.residual?.length ?? 0) > 0);
  });
  const checks = {
    invariant_ids_exact: sameStrings(
      report.invariants.map((entry) => entry.id),
      invariantIds,
    ),
    target_ids_exact: sameStrings(
      report.targets.map((entry) => entry.id),
      targetIds,
    ),
    probe_ids_complete: probeIdsComplete,
    probe_expectations_observed: probeExpectationsObserved,
    positive_witnesses_observed: positiveWitnessesObserved,
    mutation_requirements_observed: mutationRequirementsObserved,
    invariant_results_computed: invariantResultsComputed,
    target_results_computed: targetResultsComputed,
    rule_authority_complete: report.stable_rules.length === RULE_IDS.length &&
      report.stable_rules.every((entry) =>
        entry.ec_ids.length > 0 || entry.structural_safety !== null
      ) &&
      report.invariants.every((invariant) =>
        invariant.negative_mutations.every((witness) => {
          if (witness.actual_rules.length !== 1) return true;
          const authority = report.stable_rules.find((entry) =>
            entry.stable_rule === witness.actual_rules[0]
          );
          return authority !== undefined &&
            (authority.structural_safety !== null ||
              authority.ec_ids.includes(invariant.id));
        })
      ),
    ladder_truthful: report.ladder.length === 8 &&
      report.ladder.every((entry) =>
        entry.id === "public-claim-trace"
          ? entry.result === "pass"
          : entry.result === "not-evaluated"
      ),
    public_claims_observed: report.public_claim_trace.length === 3 &&
      report.public_claim_trace.every((entry) =>
        entry.result === "pass" && entry.categorical_claims.length > 0 &&
        entry.categorical_claims.every((claim) =>
          claim.declared && claim.supported && claim.result === "pass"
        )
      ),
    source_manifest_formula_stated:
      (report.candidate_identity.contract_source_manifest as
        | Record<string, unknown>
        | undefined)?.formula === MANIFEST_FORMULA,
  };
  return {
    result: Object.values(checks).every(Boolean) ? "pass" : "fail",
    ...checks,
  };
}

export async function buildClosureReport(
  root = Deno.cwd(),
): Promise<ClosureReport> {
  const packageRoot = `${root}/contracts/workbench/first-product/v1`;
  const manifest = JSON.parse(
    await Deno.readTextFile(`${packageRoot}/executable-closure-manifest.json`),
  ) as {
    package_version: string;
    authority_semantics_sha256: string;
    authority_record_sha256: string;
    denominator: { targets: number; invariants: number; probes: number };
    invariants: string[];
    targets: { id: string; subject: string; invariants: string[] }[];
  };
  const invariantIds = expectedIds("EC", 61, 3);
  const registry = await loadSchemaRegistry();
  const baseline = JSON.parse(
    await Deno.readTextFile(
      `${packageRoot}/fixtures/positive/first-product-baseline.json`,
    ),
  ) as Corpus;
  const baselineResult = validateCorpus(registry, baseline);
  const observations = new Map<string, EvidenceObservation>();
  const positiveFixtures = await loadFixtures("positive");
  const negativeFixtures = await loadFixtures("negative");
  const fixtureByName = new Map(
    [...positiveFixtures, ...negativeFixtures].map((fixture) => [
      fixture.name,
      fixture,
    ]),
  );

  for (const fixture of negativeFixtures) {
    const expectation = (fixture.document as Corpus).expectation;
    const result = validateCorpus(registry, fixture.document);
    const acceptedAsExpected = expectation.outcome === "accept" &&
      result.accepted && result.rules.length === 0;
    const rejectedAsExpected = expectation.outcome === "reject" &&
      !result.accepted && expectation.rule !== undefined &&
      sameStrings(result.rules, [expectation.rule]);
    if (!acceptedAsExpected && !rejectedAsExpected) {
      throw new Error(
        `${fixture.name}: fixture expectation did not match observed validator output (${
          result.rules.join(",") || "accept"
        })`,
      );
    }
    observations.set(fixture.name, {
      result: "pass",
      stable_rule: expectation.rule ?? "accepted-control",
      actual_rules: result.rules,
    });
  }
  observations.set("residual:grant-expiry-not-represented", {
    result: "not-applicable",
    residual:
      "CapabilityGrant expiry is not represented by the frozen first-product schema.",
    stable_rule: "authority.basis",
    actual_rules: [],
  });

  for (const mutation of GENERATED_MUTATIONS) {
    const corpus = structuredClone(baseline);
    mutation.mutate(corpus);
    const result = validateCorpus(registry, corpus);
    observations.set(mutation.id, {
      result: !result.accepted && result.rules.includes(mutation.rule)
        ? "pass"
        : "fail",
      stable_rule: mutation.rule,
      actual_rules: result.rules,
    });
  }

  const probeResults: ProbeEntry[] = [];
  for (const fixture of PROBE_FIXTURES) {
    const key = `${fixture.id}.${fixture.branch}`;
    const expected = PROBE_EXPECTATIONS[key];
    if (expected === undefined) {
      throw new Error(`probe expected-rule table omits ${key}`);
    }
    const corpus = structuredClone(baseline);
    const beforeMutation = JSON.stringify(corpus);
    fixture.mutate(corpus);
    const mutationIsDistinct = JSON.stringify(corpus) !== beforeMutation;
    const result = validateCorpus(registry, corpus);
    const actual: Disposition = result.accepted ? "accept" : "reject";
    const passed = fixture.expected === expected.disposition &&
      actual === expected.disposition &&
      sameStrings(result.rules, expected.rules) &&
      (expected.stable_rule === null ||
        result.rules.includes(expected.stable_rule));
    const entry: ProbeEntry = {
      id: fixture.id,
      branch: fixture.branch,
      expected: expected.disposition,
      actual,
      expected_rules: [...expected.rules],
      actual_rules: result.rules,
      stable_rule: expected.stable_rule,
      mutation_class: expected.mutation_class,
      ec_ids: fixture.ec,
      result: passed ? "pass" : "fail",
    };
    probeResults.push(entry);
    observations.set(`probe:${key}`, {
      result: entry.result === "pass" &&
          (expected.disposition === "reject" || mutationIsDistinct)
        ? "pass"
        : "fail",
      stable_rule: expected.stable_rule ?? "accepted-control",
      actual_rules: result.rules,
    });
  }
  if (
    !sameStrings(
      Object.keys(PROBE_EXPECTATIONS).sort(),
      probeResults.map((entry) => `${entry.id}.${entry.branch}`).sort(),
    )
  ) throw new Error("probe expected-rule table and preserved branches differ");

  const eventSchema = registry.document(
    "urn:dyfj:contracts:workbench:first-product:v1:events",
  ) as Record<string, unknown>;
  const definitions = eventSchema["$defs"] as Record<string, unknown>;
  const eventFamilies =
    (definitions["event_family"] as Record<string, unknown>)[
      "enum"
    ] as string[];
  const eventFamilyComplete = eventFamilyInventoryComplete(eventFamilies);
  const omissionsRejected = REQUIRED_EVENT_FAMILIES.every((omitted) => {
    const mutated = eventFamilies.filter((family) => family !== omitted);
    return mutated.length < eventFamilies.length &&
      !eventFamilyInventoryComplete(mutated);
  });
  observations.set("self-check:event-family-inventory", {
    result: eventFamilyComplete && omissionsRejected ? "pass" : "fail",
    stable_rule: "closure.self-check",
    actual_rules: [],
  });
  let unsupportedRejected = false;
  try {
    new SchemaRegistry([{
      $id: "urn:dyfj:contracts:self-check",
      type: "object",
      properties: { dormant: { type: "string", format: "email" } },
    }]);
  } catch (error) {
    unsupportedRejected = error instanceof Error &&
      error.message.includes("unsupported schema keyword");
  }
  observations.set("self-check:dormant-unsupported-schema-keyword", {
    result: unsupportedRejected ? "pass" : "fail",
    stable_rule: "closure.self-check",
    actual_rules: [],
  });
  const tableComplete = sameStrings(
    Object.keys(POSITIVE_WITNESS_TABLE),
    invariantIds,
  ) && invariantIds.every((id) => POSITIVE_WITNESS_TABLE[id]!.length > 0);
  const mutationTableComplete = sameStrings(
    Object.keys(EC_REQUIREMENTS),
    invariantIds,
  ) && invariantIds.every((id) => EC_REQUIREMENTS[id]!.length > 0);
  const packageObservations = new Map<string, ClosureState>([
    ["package:schema-authoring-audit", unsupportedRejected ? "pass" : "fail"],
    [
      "package:fixed-denominator",
      manifest.denominator.invariants === 61 &&
        sameStrings(manifest.invariants ?? invariantIds, invariantIds)
        ? "pass"
        : "fail",
    ],
    ["package:positive-witness-table", tableComplete ? "pass" : "fail"],
    ["package:mutation-requirements", mutationTableComplete ? "pass" : "fail"],
    ["package:public-claim-trace", "pass"],
  ]);
  for (
    const id of [
      "self-check:missing-ec-id",
      "self-check:missing-positive-witness",
      "self-check:missing-mutation-class",
      "self-check:unsupported-public-claim",
    ]
  ) {
    observations.set(id, {
      result: "pass",
      stable_rule: "closure.self-check",
      actual_rules: [],
    });
  }

  const positiveWitnesses = new Map<string, PositiveWitness[]>();
  const observePositive = async (
    requirement: PositiveWitnessRequirement,
  ): Promise<PositiveWitness> => {
    const evidence = `${requirement.source.kind}:${requirement.source.id}`;
    if (requirement.source.kind === "package") {
      return {
        evidence,
        branch: requirement.branch,
        result: packageObservations.get(requirement.source.id) ?? "fail",
      };
    }
    if (requirement.source.kind === "probe") {
      const observation = observations.get(`probe:${requirement.source.id}`);
      return {
        evidence,
        branch: requirement.branch,
        result: observation?.result ?? "fail",
      };
    }
    const fixture = fixtureByName.get(requirement.source.id);
    const result = fixture === undefined
      ? undefined
      : validateCorpus(registry, fixture.document);
    let distinct = requirement.source.id === "first-product-baseline.json";
    if (fixture !== undefined && !distinct) {
      const rawPath = `${packageRoot}/fixtures/${fixture.kind}/${fixture.name}`;
      const raw = JSON.parse(await Deno.readTextFile(rawPath)) as {
        fixture_kind?: string;
        base?: string;
        mutations?: unknown[];
      };
      const base = raw.base === undefined
        ? undefined
        : fixtureByName.get(raw.base);
      distinct = raw.fixture_kind === "derived-corpus" &&
        (raw.mutations?.length ?? 0) > 0 && base !== undefined &&
        JSON.stringify(base.document) !== JSON.stringify(fixture.document);
    }
    return {
      evidence,
      branch: requirement.branch,
      result: result?.accepted === true && distinct ? "pass" : "fail",
    };
  };
  for (const id of invariantIds) {
    positiveWitnesses.set(
      id,
      await Promise.all(
        (POSITIVE_WITNESS_TABLE[id] ?? []).map(observePositive),
      ),
    );
  }

  const observationComplete = (observation: EvidenceObservation): boolean =>
    observation.result === "pass" ||
    ((observation.result === "blocked" ||
      observation.result === "not-applicable") &&
      (observation.residual?.length ?? 0) > 0);
  const invariants: InvariantEntry[] = invariantIds.map((id) => {
    const requirements = EC_REQUIREMENTS[id] ?? [];
    const positive = positiveWitnesses.get(id) ?? [];
    const negative = requirements.map((requirement): Witness => {
      const observation = observations.get(requirement.evidence);
      return {
        mutation_class: requirement.mutation_class,
        evidence: requirement.evidence,
        result: observation?.result ?? "fail",
        stable_rule: observation?.stable_rule ?? "",
        actual_rules: observation?.actual_rules ?? [],
        residual: observation?.residual,
      };
    });
    const requiredMutationClasses = [
      ...new Set(requirements.map((requirement) => requirement.mutation_class)),
    ];
    const evidenceComplete = positive.length > 0 &&
      positive.every((witness) => witness.result === "pass") &&
      requiredMutationClasses.length > 0 &&
      requiredMutationClasses.every((required) =>
        negative.some((witness) =>
          witness.mutation_class === required &&
          observationComplete(witness)
        )
      );
    const residual = INVARIANT_RESIDUALS[id];
    const result = !evidenceComplete
      ? "fail"
      : residual === undefined
      ? "pass"
      : "blocked";
    return {
      id,
      result,
      positive_witness: positive,
      required_mutation_classes: requiredMutationClasses,
      negative_mutations: negative,
      residual,
    };
  });
  const publicClaims = await observePublicClaims(root, invariants);
  const publicClaimsPass = publicClaims.every((entry) =>
    entry.result === "pass"
  );
  const publicClaimWitness = invariants.find((entry) => entry.id === "EC-061")
    ?.positive_witness.find((entry) =>
      entry.evidence === "package:package:public-claim-trace"
    );
  if (publicClaimWitness !== undefined) {
    publicClaimWitness.result = publicClaimsPass ? "pass" : "fail";
  }
  const ec061 = invariants.find((entry) => entry.id === "EC-061");
  if (ec061 !== undefined && !publicClaimsPass) ec061.result = "fail";

  const targets: TargetEntry[] = manifest.targets.map((target) => {
    const results = target.invariants.map((id) =>
      invariants.find((entry) => entry.id === id)?.result ?? "fail"
    );
    const result = results.includes("fail")
      ? "fail"
      : results.includes("blocked")
      ? "blocked"
      : results.every((entry) => entry === "not-applicable")
      ? "not-applicable"
      : "pass";
    const residual = result === "blocked" || result === "not-applicable"
      ? target.invariants.flatMap((id) => {
        const entry = invariants.find((candidate) => candidate.id === id);
        return entry?.residual === undefined ? [] : [entry.residual];
      }).join(" ")
      : undefined;
    return { ...target, result, residual };
  });
  const rules: RuleEntry[] = RULE_IDS.map((rule) => ({
    stable_rule: rule,
    ec_ids: FIXTURE_EC_RULES[rule] ?? [],
    structural_safety: structuralRuleAuthority(rule) ?? null,
  }));
  const report: ClosureReport = {
    schema: "dyfj.workbench.first-product.executable-closure-report/v1",
    result: "fail",
    package_version: manifest.package_version,
    authority: {
      public_reference: manifest.package_version,
      authority_record_digest: "recorded privately",
    },
    candidate_identity: {
      contract_source_manifest: await sourceManifest(packageRoot),
    },
    denominator: manifest.denominator,
    invariants,
    probes: probeResults,
    targets,
    stable_rules: rules,
    ladder: [
      [
        "focused-tests",
        "deno test --allow-read=. contracts/workbench/first-product/v1/validate.test.ts contracts/workbench/first-product/v1/executable-closure.test.ts contracts/workbench/first-product/v1/executable-closure-report.test.ts",
      ],
      ["format-check", "deno fmt --check (changed files)"],
      ["diff-check", "git diff --check"],
      ["fast-aggregate", "deno task test:fast"],
      ["full-aggregate", "deno task test"],
      [
        "dependency-inspection",
        "dependency.policy aggregate lane plus final diff inspection",
      ],
      ["secret-scan", "secret.tree and secret.diff aggregate lanes"],
      [
        "public-claim-trace",
        "README.md, CHANGELOG.md, and package README categorical claims mapped to supporting EC results",
      ],
    ].map(([id, command]) => ({
      id,
      command,
      result: id === "public-claim-trace"
        ? (publicClaimsPass ? "pass" : "fail")
        : "not-evaluated" as ClosureState,
    })),
    public_claim_trace: publicClaims,
    residual_unknowns: [
      "Runtime conformance has not been evaluated.",
      "Exceptional Task source-edge exhaustiveness remains deferred.",
      INVARIANT_RESIDUALS["EC-045"]!,
      INVARIANT_RESIDUALS["EC-010"]!,
      "Event at timestamps are non-authoritative; ordering authority is event sequence and durable commit sequence.",
      "The frozen executable-closure manifest contains private authority digests; replacing them requires an operator-approved versioned re-freeze.",
    ],
    excluded_runtime_behavior: [
      "persistence",
      "database or migration behavior",
      "routing and provider calls",
      "adapter and native-session execution",
      "process control",
      "user interfaces",
      "publication and deployment",
    ],
  };
  const bootstrap = evaluateClosureReport(report);
  if (bootstrap.result !== "pass") {
    const failedProbes = report.probes.filter((entry) =>
      entry.result !== "pass"
    ).map((entry) => `${entry.id}.${entry.branch}`);
    const failedPositive = report.invariants.flatMap((entry) =>
      entry.positive_witness.filter((witness) => witness.result !== "pass").map(
        (witness) => `${entry.id}:${witness.evidence}`,
      )
    );
    const failedMutations = report.invariants.flatMap((entry) =>
      entry.negative_mutations.filter((witness) =>
        !observationComplete(witness)
      ).map((witness) => `${entry.id}:${witness.evidence}`)
    );
    const failedClaims = report.public_claim_trace.flatMap((entry) =>
      entry.categorical_claims.filter((claim) => claim.result !== "pass").map(
        (claim) => `${entry.path}:${claim.claim_id}`,
      )
    );
    throw new Error(
      `closure report bootstrap self-check failed: ${
        JSON.stringify(bootstrap)
      } probes=${failedProbes.join(",")} positive=${
        failedPositive.join(",")
      } mutations=${failedMutations.join(",")} claims=${
        failedClaims.join(",")
      }`,
    );
  }
  const selfCheckMutations: {
    evidence: string;
    mutate(report: ClosureReport): void;
  }[] = [
    {
      evidence: "self-check:missing-ec-id",
      mutate: (candidate) => candidate.invariants.splice(0, 1),
    },
    {
      evidence: "self-check:missing-positive-witness",
      mutate: (candidate) => candidate.invariants[0]!.positive_witness = [],
    },
    {
      evidence: "self-check:missing-mutation-class",
      mutate: (candidate) => candidate.invariants[0]!.negative_mutations = [],
    },
    {
      evidence: "self-check:unsupported-public-claim",
      mutate: (candidate) => {
        const claim = candidate.public_claim_trace[0]!.categorical_claims[0]!;
        claim.supported = false;
        claim.result = "fail";
        candidate.public_claim_trace[0]!.result = "fail";
      },
    },
  ];
  for (const check of selfCheckMutations) {
    const mutated = structuredClone(report);
    check.mutate(mutated);
    const observed = evaluateClosureReport(mutated).result === "fail"
      ? "pass"
      : "fail";
    const witness = report.invariants.flatMap((entry) =>
      entry.negative_mutations
    ).find((entry) => entry.evidence === check.evidence);
    if (witness !== undefined) witness.result = observed;
  }
  for (const entry of report.invariants) {
    const evidenceComplete = entry.positive_witness.length > 0 &&
      entry.positive_witness.every((witness) => witness.result === "pass") &&
      entry.required_mutation_classes.every((required) =>
        entry.negative_mutations.some((witness) =>
          witness.mutation_class === required &&
          observationComplete(witness)
        )
      );
    entry.result = !evidenceComplete
      ? "fail"
      : entry.residual === undefined
      ? "pass"
      : "blocked";
  }
  for (const target of report.targets) {
    const results = target.invariants.map((id) =>
      report.invariants.find((entry) => entry.id === id)?.result ?? "fail"
    );
    target.result = results.includes("fail")
      ? "fail"
      : results.includes("blocked")
      ? "blocked"
      : results.every((entry) => entry === "not-applicable")
      ? "not-applicable"
      : "pass";
  }
  report.self_check = evaluateClosureReport(report);
  report.result = report.self_check.result;
  if (report.result !== "pass") {
    const failedInvariants = report.invariants.filter((entry) =>
      entry.result === "fail"
    ).map((entry) => entry.id);
    const failedClaims = report.public_claim_trace.flatMap((entry) =>
      entry.categorical_claims.filter((claim) => claim.result !== "pass").map(
        (claim) => `${entry.path}:${claim.claim_id}`,
      )
    );
    throw new Error(
      `closure report self-check failed: ${
        JSON.stringify(report.self_check)
      } invariants=${failedInvariants.join(",")} claims=${
        failedClaims.join(",")
      }`,
    );
  }
  return report;
}

interface ReportArguments {
  outputPath?: string;
  comparePath?: string;
}

export function parseReportArguments(args: readonly string[]): ReportArguments {
  const parsed: ReportArguments = {};
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    const value = args[index + 1];
    if (argument !== "--output-path" && argument !== "--compare-path") {
      throw new Error(
        `executable closure report: unknown argument ${argument}`,
      );
    }
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`executable closure report: ${argument} requires a path`);
    }
    const key = argument === "--output-path" ? "outputPath" : "comparePath";
    if (parsed[key] !== undefined) {
      throw new Error(`executable closure report: duplicate ${argument}`);
    }
    parsed[key] = value;
    index++;
  }
  if (
    parsed.outputPath !== undefined &&
    parsed.comparePath !== undefined
  ) {
    throw new Error(
      "executable closure report: --output-path and --compare-path are mutually exclusive",
    );
  }
  return parsed;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

if (import.meta.main) {
  const root = Deno.cwd();
  const arguments_ = parseReportArguments(Deno.args);
  const report = await buildClosureReport(root);
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (arguments_.comparePath !== undefined) {
    const committed = await Deno.readFile(arguments_.comparePath);
    if (!bytesEqual(new TextEncoder().encode(serialized), committed)) {
      throw new Error(
        "executable closure report mismatch: committed report differs from fresh regeneration",
      );
    }
  } else {
    const output = arguments_.outputPath ??
      `${root}/contracts/workbench/first-product/v1/executable-closure-report.json`;
    await Deno.writeTextFile(output, serialized);
  }
  console.log(
    "executable closure report: pass (61 EC, 31 RP, 24 targets; public-claim trace pass; 7 external ladder steps not evaluated)",
  );
}
