/**
 * Cross-document semantic rules for the Workbench first-product contract
 * package.
 *
 * Structural validation (`json-schema.ts`) decides whether a corpus has the
 * right shape. These rules decide whether a structurally valid corpus is
 * *semantically* admissible: reference closure, identity stability, Task and
 * Run lifecycle separation, state-and-event pairing, label and claim-source
 * preservation, route control ordering and binding, effective authorization
 * basis, durable-commit ordering before acknowledgement, receipt subject
 * reconciliation, receipt family requirements, and explicit deferral.
 *
 * Authority here is *effective*, not syntactic. Naming a grant is not
 * authorization: the grant must resolve, its grantee must be the event's
 * author, a denied policy basis cannot carry authority, an
 * `allowed-with-approval` basis must resolve to a human-authored approval
 * event, and a Task reaches completion only under its approved envelope.
 * Receipt fields are likewise reconciled against the entities and history
 * they claim to describe, read at the sequence of the receipt's commit event
 * rather than against final corpus state.
 *
 * Boundaries this file deliberately keeps:
 *
 * - It is a validator, not a runtime. There is no policy engine, no
 *   information-flow lattice, no persistence, and no route adapter here. The
 *   label comparisons are fixed ordinal checks over the declared label
 *   vocabulary, not a general lattice evaluation.
 * - It encodes the required Task and Run progression and the required
 *   Run-to-Task independence only. The exhaustive exceptional-state graph is
 *   not settled architecture, so an `exceptional` transition is checked for
 *   target class (it must not be collapsed into completion, acceptance, or
 *   closure) and never against an invented edge list.
 * - Diagnostics carry a stable rule id, a JSON pointer, a code-authored
 *   detail string, and at most an entity id that already passed the
 *   identifier pattern. No fixture payload value is ever echoed.
 *
 * Rule precedence: at most one diagnostic is reported per lifecycle
 * transition, evaluated most-specific-first (run independence, then outcome
 * collapse, then required progression), so a fixture that demonstrates one
 * violation is not also reported under a derived one.
 */

export const SEMANTIC_RULE_IDS = [
  "identity.stable-basis",
  "identity.uniqueness",
  "reference.closure",
  "reference.kind",
  "lifecycle.state-type",
  "lifecycle.progression",
  "lifecycle.outcome-collapse",
  "lifecycle.run-independence",
  "lifecycle.transition-event-pairing",
  "lifecycle.revision-order",
  "lifecycle.run-attempt-uniqueness",
  "event.causal-order",
  "solo-room.defaults",
  "solo-room.loop-prevention",
  "label.preservation",
  "label.clearance",
  "provenance.preservation",
  "route.phase-order",
  "route.capability-rejection",
  "route.binding",
  "route.continuity-evidence",
  "route.native-extension-authority",
  "route.native-capability-erasure",
  "authority.durable-commit",
  "authority.async-source",
  "authority.basis",
  "authority.task-envelope",
  "grant.no-self-broadening",
  "grant.principal-continuity",
  "lease.availability-only",
  "receipt.family-requirements",
  "receipt.subject-reconciliation",
  "claim-source.separation",
  "secrecy.inline-secret",
  "deferral.not-required",
  "deferral.inventory",
  "run.evidence-binding",
  "grant.egress-policy",
  "authority.sole-writer",
] as const;

export type SemanticRuleId = (typeof SEMANTIC_RULE_IDS)[number];

export interface SemanticDiagnostic {
  rule: SemanticRuleId;
  path: string;
  detail: string;
  entity?: string;
}

// ---------------------------------------------------------------------------
// Corpus shape. These interfaces describe a corpus that already passed
// structural validation; they are consumer types, not a second source of
// truth for the contract.
// ---------------------------------------------------------------------------

export type Visibility = "operator-only" | "room" | "workbench";
export type Sensitivity = "low" | "moderate" | "high" | "restricted";
export type IntegrityClass =
  | "untrusted"
  | "unverified"
  | "attested"
  | "verified";
export type ClaimSource =
  | "workbench-observed"
  | "runner-reported"
  | "independently-verified"
  | "operator-accepted";

export interface Labels {
  integrity_class: IntegrityClass;
  secrecy_tags: string[];
  visibility: Visibility;
  sensitivity: Sensitivity;
}

export interface Clearance {
  cleared_secrecy_tags: string[];
  cleared_visibility: Visibility;
  cleared_sensitivity: Sensitivity;
}

export interface EvidenceItem {
  kind: string;
  event?: string;
  artifact?: string;
  context_packet?: string;
  run?: string;
  digest?: string;
  note?: string;
}

export interface PolicyBasis {
  policy_id: string;
  decision: string;
  approval_event?: string;
}

export interface PayloadField {
  name: string;
  representation: "inline-value" | "pointer" | "digest" | "redacted";
  secrecy_tags: string[];
  inline_value?: string;
  reference?: string;
  digest?: string;
}

export interface Payload {
  fields: PayloadField[];
}

export interface Transition {
  from: string;
  to: string;
  revision: number;
  event: string;
  progression_class: "required" | "exceptional";
}

export interface Room {
  id: string;
  identity_basis: string;
  revision: number;
  room_class: string;
  persistence: "persistent" | "ephemeral";
  profile?: string;
  labels: Labels;
}

export interface Participant {
  id: string;
  identity_basis: string;
  revision: number;
  participant_class: "human" | "digital";
  independent_of: string[];
  agent_spec?: string;
}

export interface SpeakRule {
  policy: "always-on" | "mention" | "scheduled";
  mention_match?: { kind: string; token: string };
  schedule?: { kind: string; expression: string };
  loop_prevention: {
    automated_summons: "blocked" | "operator-authorized-exception";
    exception_grant?: string;
  };
}

export interface RoomMembership {
  id: string;
  identity_basis: string;
  revision: number;
  room: string;
  participant: string;
  present: boolean;
  may_author: boolean;
  may_speak: boolean;
  speak_rule: SpeakRule;
}

export interface Thread {
  id: string;
  identity_basis: string;
  revision: number;
  room: string;
  thread_class: "main" | "task-branch";
  task?: string;
}

export interface AgentSpec {
  id: string;
  identity_basis: string;
  revision: number;
  spec_version: number;
  participant: string;
  behavior: string[];
  posture: { autonomy: string; escalation: string };
  tools: string[];
  guardrails: string[];
}

export interface TaskExecutionEnvelope {
  objective: string;
  context_scope: string;
  assigned_agent_spec: string;
  posture: { autonomy: string; escalation: string };
  route_requirements: {
    execution_lane: string;
    required_capabilities?: string[];
  };
  tools: string[];
  workspace: "none" | "read-only" | "read-write";
  budget: { currency: string; limit_minor_units: number };
  guardrails: string[];
}

export interface Task {
  id: string;
  identity_basis: string;
  revision: number;
  room: string;
  thread: string;
  state: string;
  envelope: { approved: boolean; grant: string };
  execution_envelope: TaskExecutionEnvelope;
  completion_criteria: string[];
  verification_contract: { method: string; required_evidence: string[] };
  transitions: Transition[];
}

export interface Run {
  id: string;
  identity_basis: string;
  revision: number;
  task: string;
  agent_spec: string;
  route: string;
  route_session: string;
  context_packet: string;
  capability_grant: string;
  attempt: number;
  state: string;
  transitions: Transition[];
}

export interface NativeExtension {
  capability: string;
  authority: "native-runner" | "workbench" | "shared-contract";
  portability: "native-only" | "route-specific" | "portable";
  opacity: "governable" | "observable" | "opaque";
}

export interface RouteSpec {
  id: string;
  identity_basis: string;
  revision: number;
  execution_lane: "native" | "external";
  access_modality: string;
  runner?: string;
  provider?: string;
  model: string;
  adapter: string;
  policy_basis: PolicyBasis;
  cost_basis: { kind: string; currency?: string };
  system_harness?: string;
  tool_vocabulary?: string[];
  context_reasoning_policy?: string;
  authentication_posture?: string;
  inference_posture?: string;
  component_dispositions?: Partial<
    Record<
      | "runner"
      | "provider"
      | "system_harness"
      | "tool_vocabulary"
      | "context_reasoning_policy"
      | "authentication_posture"
      | "inference_posture",
      "not-applicable" | "opaque"
    >
  >;
  native_extensions?: NativeExtension[];
}

export interface RouteCapabilityReport {
  id: string;
  identity_basis: string;
  revision: number;
  route: string;
  capabilities: {
    capability: string;
    classification: "governable" | "observable" | "opaque" | "unavailable";
    required: boolean;
  }[];
}

export type RoutePhaseName =
  | "inspect"
  | "prepare"
  | "start-or-resume"
  | "stream"
  | "control"
  | "finalize";

export interface RoutePhase {
  phase: RoutePhaseName;
  sequence: number;
  outcome: "accepted" | "rejected" | "completed" | "halted";
  spend_or_action: boolean;
  capability_report?: string;
}

export interface RouteSession {
  id: string;
  identity_basis: string;
  revision: number;
  route: string;
  run: string;
  phases: RoutePhase[];
  continuity: {
    class: "new" | "warm-reused" | "durably-resumed" | "reconstructed";
    evidence: EvidenceItem[];
  };
}

export interface ContextEntry {
  entry_id: string;
  source: {
    kind: "artifact" | "event" | "thread" | "task" | "external";
    reference?: string;
    external?: Record<string, unknown>;
    source_revision?: number;
  };
  digest: string;
  selection_reason: string;
  claim_source: ClaimSource;
  labels: Labels;
  rendered_section?: { bounded_characters: number; redacted: boolean };
}

export interface ContextPacket {
  id: string;
  identity_basis: string;
  revision: number;
  task?: string;
  run?: string;
  route_neutral: true;
  digest: string;
  entries: ContextEntry[];
  compaction?: { source_packet: string; strategy: string };
}

export interface GrantScope {
  tools: string[];
  resources: string[];
  workspace: "none" | "read-only" | "read-write";
  network: "none" | "loopback" | "operator-approved-hosts";
  budget: { currency: string; limit_minor_units: number };
  approvals: string[];
  external_impact: "none" | "reversible" | "irreversible";
  destination_classes: string[];
  provider_scope?: string[];
  route_scope?: string[];
  task_scope?: string;
  room_scope?: string;
  secrecy_integrity_authorization?: {
    authorized_secrecy_tags: string[];
    minimum_integrity_class: IntegrityClass;
  };
  scope_dispositions?: Partial<
    Record<
      | "provider_scope"
      | "route_scope"
      | "task_scope"
      | "room_scope"
      | "secrecy_integrity_authorization",
      "not-applicable" | "opaque"
    >
  >;
}

export interface CapabilityGrant {
  id: string;
  identity_basis: string;
  revision: number;
  grantor: string;
  grantee: string;
  delegable: boolean;
  supersedes?: string;
  approval_event?: string;
  policy_basis: PolicyBasis;
  scope: GrantScope;
}

export interface RegistrationLease {
  id: string;
  identity_basis: string;
  revision: number;
  subject: {
    kind: "route" | "tool" | "skill" | "native-session" | "agent-process";
    reference: string;
  };
  state: "active" | "expired";
  expires_at: string;
  availability_only: true;
  effects_on_expiry: string[];
}

export interface ArtifactRef {
  id: string;
  identity_basis: string;
  revision: number;
  artifact_class: string;
  authoritative_ref: {
    kind: "internal" | "external";
    reference?: string;
    external?: Record<string, unknown>;
  };
  snapshot?: { digest: string; version_evidence: Record<string, unknown> };
  derived_from?: string[];
  derivation?: {
    kind: string;
    claim_source: ClaimSource;
    verified_by?: string;
  };
  supersedes?: string;
  correctable: boolean;
  labels: Labels;
}

export interface StateTransitionRecord {
  entity_kind: "task" | "run";
  entity: string;
  from: string;
  to: string;
  entity_revision: number;
  progression_class: "required" | "exceptional";
  caused_by_run?: string;
  operator_decision?: string;
  evidence: EvidenceItem[];
}

export interface WorkbenchEvent {
  id: string;
  identity_basis: string;
  schema_version: string;
  workbench_instance: string;
  room: string;
  thread?: string;
  task?: string;
  run?: string;
  trace: string;
  author: string;
  author_class: "human" | "machine";
  authorizer?: string;
  observers?: string[];
  family: string;
  type: string;
  at: string;
  sequence: number;
  authorization_basis: {
    kind: string;
    grant?: string;
    membership?: string;
    authorizing_event?: string;
  };
  policy_basis: PolicyBasis;
  claim_source: ClaimSource;
  labels: Labels;
  payload?: Payload;
  artifact_ref?: string;
  context_packet?: string;
  causal_parents: string[];
  supersedes?: string;
  integrity_evidence?: EvidenceItem[];
  state_transition?: StateTransitionRecord;
  durable_commit?: {
    atomic: boolean;
    state_committed: boolean;
    event_committed: boolean;
    commit_sequence: number;
    evidence: EvidenceItem[];
  };
  acknowledgement?: {
    acknowledged: boolean;
    sequence: number;
    audience: string;
  };
  asynchronous?: boolean;
  authoritative_source?: string;
  writer_id?: string;
  triggers_automated_summons?: boolean;
  summons_exception_grant?: string;
  extensions?: Record<string, unknown>[];
}

export interface Projection {
  id: string;
  identity_basis: string;
  revision: number;
  family: "conversation" | "activity" | "status" | "inspector";
  source_packets: string[];
  source_events: string[];
  source_labels: Labels;
  consumer_clearance: Clearance;
  output_digest: string;
  rebuildable: true;
  grants_authority: false;
}

export interface Fact {
  state: string;
  claim_source: ClaimSource;
  evidence: EvidenceItem[];
}

export interface ReceiptBody {
  route?: { route: string; reason: string };
  context_packet?: { reference: string; revision: number; digest: string };
  projection?: { reference: string; revision: number };
  projected_payload_digest?: string;
  capability_posture?: {
    report: string;
    report_revision: number;
    unavailable_required: boolean;
  };
  usage?: { input_tokens: number; output_tokens: number };
  cost?: { currency: string; amount_minor_units: number; basis: string };
  terminal_reason?: string;
  task_revision?: number;
  run_revision?: number;
  route_evidence?: EvidenceItem[];
  process_provenance?: string;
  tools_and_effects?: {
    tool: string;
    effect: string;
    claim_source: ClaimSource;
  }[];
  artifacts?: string[];
  verification?: Fact;
  preserved_state?: { kind: string; note: string };
  outcome?: string;
  remaining_authority?: { grant: string; still_effective: boolean };
  changes?: string[];
  unresolved_risks?: string[];
  facts?: {
    agent_reported_completion: Fact;
    workbench_observed_effects: Fact;
    independent_verification: Fact;
    operator_acceptance: Fact;
    closure: Fact;
  };
}

export interface Receipt {
  id: string;
  identity_basis: string;
  revision: number;
  schema_version: string;
  family: "turn" | "run" | "interrupt" | "completion";
  room: string;
  task?: string;
  run?: string;
  commit_event: string;
  attribution: {
    author: string;
    authorizer?: string;
    claim_source: ClaimSource;
  };
  labels: Labels;
  payload?: Payload;
  evidence: EvidenceItem[];
  observed_effects: {
    effect: string;
    claim_source: ClaimSource;
    note?: string;
  }[];
  uncertainty: { kind: string; note: string };
  current_state?: {
    entity_kind: "task" | "run";
    entity: string;
    state: string;
    revision: number;
  };
  next_action: string;
  body: ReceiptBody;
}

export interface Deferral {
  id: string;
  capability: string;
  status: "deferred";
  required: boolean;
  implemented: boolean;
  authoritative: boolean;
  routable: boolean;
  reserved_identifier?: string;
  note: string;
}

export interface Corpus {
  schema: string;
  package_version: string;
  profile: "first-product-solo-operator" | "focused-rule-fixture";
  title?: string;
  proves?: string[];
  expectation: { outcome: "accept" | "reject"; rule?: string; note?: string };
  rooms?: Room[];
  participants?: Participant[];
  room_memberships?: RoomMembership[];
  threads?: Thread[];
  agent_specs?: AgentSpec[];
  tasks?: Task[];
  runs?: Run[];
  routes?: RouteSpec[];
  route_capability_reports?: RouteCapabilityReport[];
  route_sessions?: RouteSession[];
  context_packets?: ContextPacket[];
  capability_grants?: CapabilityGrant[];
  registration_leases?: RegistrationLease[];
  artifacts?: ArtifactRef[];
  events?: WorkbenchEvent[];
  projections?: Projection[];
  receipts?: Receipt[];
  deferrals?: Deferral[];
}

// ---------------------------------------------------------------------------
// Contract vocabulary
// ---------------------------------------------------------------------------

export const TASK_STATES = [
  "task:proposed",
  "task:ready",
  "task:running",
  "task:waiting",
  "task:blocked",
  "task:completed",
  "task:accepted",
  "task:closed",
  "task:interrupted",
  "task:failed",
  "task:rejected",
  "task:superseded",
  "task:abandoned",
] as const;

export const RUN_STATES = [
  "run:pending",
  "run:running",
  "run:completed",
  "run:interrupted",
  "run:failed",
  "run:superseded",
  "run:abandoned",
] as const;

// The required progression, and only the required progression. Every edge
// here is stated by the accepted first-product contract: the proposed →
// ready → running → (waiting | blocked) → completed → (accepted | closed)
// spine, plus the explicit rule that a failed or interrupted Run returns its
// Task to `ready` or `waiting` rather than ending it.
const REQUIRED_TASK_EDGES = new Set([
  "task:proposed>task:ready",
  "task:ready>task:running",
  "task:running>task:waiting",
  "task:running>task:blocked",
  "task:running>task:completed",
  "task:waiting>task:running",
  "task:waiting>task:ready",
  "task:blocked>task:running",
  "task:blocked>task:ready",
  "task:completed>task:accepted",
  "task:accepted>task:closed",
  // Conditional edges: allowed in the graph, but gated below on the causal
  // or attributable evidence the accepted contract requires.
  "task:running>task:ready",
  "task:completed>task:closed",
]);

const REQUIRED_RUN_EDGES = new Set([
  "run:pending>run:running",
  "run:running>run:completed",
]);

// Outcomes that must stay explicit. An `exceptional` transition may target
// one of these; it may never be recorded as completion, acceptance, or
// closure.
const EXCEPTIONAL_STATES = new Set([
  "task:interrupted",
  "task:failed",
  "task:rejected",
  "task:superseded",
  "task:abandoned",
  "run:interrupted",
  "run:failed",
  "run:superseded",
  "run:abandoned",
]);

const CLOSING_STATES = new Set([
  "task:completed",
  "task:accepted",
  "task:closed",
  "run:completed",
]);

const ENDING_TASK_STATES = new Set([
  "task:interrupted",
  "task:failed",
  "task:closed",
  "task:rejected",
  "task:superseded",
  "task:abandoned",
]);

const FAILED_RUN_STATES = new Set([
  "run:failed",
  "run:interrupted",
  "run:abandoned",
  "run:superseded",
]);

const TERMINAL_RUN_STATES = new Set([
  "run:completed",
  "run:interrupted",
  "run:failed",
  "run:superseded",
  "run:abandoned",
]);

// Route control order. Phases run in the declared order; streaming and
// control may interleave, and `finalize` ends the session.
const ALLOWED_PHASE_EDGES = new Set([
  "inspect>prepare",
  "prepare>start-or-resume",
  "prepare>finalize",
  "start-or-resume>stream",
  "start-or-resume>control",
  "start-or-resume>finalize",
  "stream>stream",
  "stream>control",
  "stream>finalize",
  "control>stream",
  "control>control",
  "control>finalize",
]);

const CONTINUITY_EVIDENCE: Record<string, string[]> = {
  "new": ["fresh-session-established"],
  "warm-reused": ["warm-process-handle", "prior-run"],
  "durably-resumed": ["durable-session-record", "resume-token-accepted"],
  "reconstructed": ["context-packet-rebuild", "source-packet"],
};

const AUTHORITY_BEARING_FAMILIES = new Set([
  "approval",
  "revocation",
  "interrupt",
  "artifact",
  "receipt",
]);

const REBUILDABLE_FAMILIES = new Set([
  "projection",
  "cost",
  "process-provenance",
]);

const SUMMONS_EXCEPTION_APPROVAL = "automated-summons-exception";

// First-product deferrals. Every one must be recorded as deferred in the
// first-product profile, and none may be marked required, implemented,
// routable, or authoritative anywhere in the corpus.
export const REQUIRED_DEFERRALS = [
  "child-agents-and-recursive-delegation",
  "durable-promoted-memory-across-rooms",
  "memory-claim-implementation",
  "peer-synchronization-or-distributed-consensus",
  "external-messaging-bridges",
  "additional-center-surfaces",
  "online-self-modification-or-optimizer-promotion",
  "route-feature-parity",
  "new-distributed-deployment-topology",
] as const;

const SENSITIVITY_RANK: Record<Sensitivity, number> = {
  low: 0,
  moderate: 1,
  high: 2,
  restricted: 3,
};

const VISIBILITY_RANK: Record<Visibility, number> = {
  "operator-only": 0,
  "room": 1,
  "workbench": 2,
};

const INTEGRITY_RANK: Record<IntegrityClass, number> = {
  untrusted: 0,
  unverified: 1,
  attested: 2,
  verified: 3,
};

export type EntityKind =
  | "room"
  | "participant"
  | "room_membership"
  | "thread"
  | "agent_spec"
  | "task"
  | "run"
  | "route"
  | "route_capability_report"
  | "route_session"
  | "context_packet"
  | "capability_grant"
  | "registration_lease"
  | "artifact"
  | "event"
  | "projection"
  | "receipt"
  | "deferral";

interface Reference {
  path: string;
  id: string;
  kinds: EntityKind[];
}

interface Index {
  kinds: Map<string, EntityKind>;
  rooms: Map<string, Room>;
  participants: Map<string, Participant>;
  memberships: Map<string, RoomMembership>;
  threads: Map<string, Thread>;
  specs: Map<string, AgentSpec>;
  tasks: Map<string, Task>;
  runs: Map<string, Run>;
  routes: Map<string, RouteSpec>;
  reports: Map<string, RouteCapabilityReport>;
  sessions: Map<string, RouteSession>;
  packets: Map<string, ContextPacket>;
  grants: Map<string, CapabilityGrant>;
  artifacts: Map<string, ArtifactRef>;
  events: Map<string, WorkbenchEvent>;
  projections: Map<string, Projection>;
  receipts: Map<string, Receipt>;
}

function list<T>(value: T[] | undefined): T[] {
  return value ?? [];
}

function labelsOf(entries: Labels[]): Labels | undefined {
  if (entries.length === 0) return undefined;
  const tags = new Set<string>();
  let sensitivity: Sensitivity = "low";
  let visibility: Visibility = "workbench";
  let integrity: IntegrityClass = "verified";
  for (const label of entries) {
    for (const tag of label.secrecy_tags) tags.add(tag);
    if (SENSITIVITY_RANK[label.sensitivity] > SENSITIVITY_RANK[sensitivity]) {
      sensitivity = label.sensitivity;
    }
    if (VISIBILITY_RANK[label.visibility] < VISIBILITY_RANK[visibility]) {
      visibility = label.visibility;
    }
    if (INTEGRITY_RANK[label.integrity_class] < INTEGRITY_RANK[integrity]) {
      integrity = label.integrity_class;
    }
  }
  return {
    integrity_class: integrity,
    secrecy_tags: [...tags].sort(),
    visibility,
    sensitivity,
  };
}

/**
 * Label preservation: derived labels may be stricter than their sources but
 * never weaker. Secrecy tags are carried forward, sensitivity may only rise,
 * visibility may only narrow, and integrity may only fall — a stronger
 * integrity claim needs separate verified authority, which the caller checks.
 */
function weakensLabels(derived: Labels, sources: Labels): string | undefined {
  for (const tag of sources.secrecy_tags) {
    if (!derived.secrecy_tags.includes(tag)) return "dropped secrecy tag";
  }
  if (
    SENSITIVITY_RANK[derived.sensitivity] <
      SENSITIVITY_RANK[sources.sensitivity]
  ) {
    return "lowered sensitivity";
  }
  if (
    VISIBILITY_RANK[derived.visibility] > VISIBILITY_RANK[sources.visibility]
  ) {
    return "broadened visibility";
  }
  if (
    INTEGRITY_RANK[derived.integrity_class] >
      INTEGRITY_RANK[sources.integrity_class]
  ) {
    return "strengthened integrity class";
  }
  return undefined;
}

function buildIndex(corpus: Corpus): Index {
  const index: Index = {
    kinds: new Map(),
    rooms: new Map(),
    participants: new Map(),
    memberships: new Map(),
    threads: new Map(),
    specs: new Map(),
    tasks: new Map(),
    runs: new Map(),
    routes: new Map(),
    reports: new Map(),
    sessions: new Map(),
    packets: new Map(),
    grants: new Map(),
    artifacts: new Map(),
    events: new Map(),
    projections: new Map(),
    receipts: new Map(),
  };
  const register = (kind: EntityKind, id: string): void => {
    if (!index.kinds.has(id)) index.kinds.set(id, kind);
  };
  for (const room of list(corpus.rooms)) {
    register("room", room.id);
    index.rooms.set(room.id, room);
  }
  for (const participant of list(corpus.participants)) {
    register("participant", participant.id);
    index.participants.set(participant.id, participant);
  }
  for (const membership of list(corpus.room_memberships)) {
    register("room_membership", membership.id);
    index.memberships.set(membership.id, membership);
  }
  for (const thread of list(corpus.threads)) {
    register("thread", thread.id);
    index.threads.set(thread.id, thread);
  }
  for (const spec of list(corpus.agent_specs)) {
    register("agent_spec", spec.id);
    index.specs.set(spec.id, spec);
  }
  for (const task of list(corpus.tasks)) {
    register("task", task.id);
    index.tasks.set(task.id, task);
  }
  for (const run of list(corpus.runs)) {
    register("run", run.id);
    index.runs.set(run.id, run);
  }
  for (const route of list(corpus.routes)) {
    register("route", route.id);
    index.routes.set(route.id, route);
  }
  for (const report of list(corpus.route_capability_reports)) {
    register("route_capability_report", report.id);
    index.reports.set(report.id, report);
  }
  for (const session of list(corpus.route_sessions)) {
    register("route_session", session.id);
    index.sessions.set(session.id, session);
  }
  for (const packet of list(corpus.context_packets)) {
    register("context_packet", packet.id);
    index.packets.set(packet.id, packet);
  }
  for (const grant of list(corpus.capability_grants)) {
    register("capability_grant", grant.id);
    index.grants.set(grant.id, grant);
  }
  for (const lease of list(corpus.registration_leases)) {
    register("registration_lease", lease.id);
  }
  for (const artifact of list(corpus.artifacts)) {
    register("artifact", artifact.id);
    index.artifacts.set(artifact.id, artifact);
  }
  for (const event of list(corpus.events)) {
    register("event", event.id);
    index.events.set(event.id, event);
  }
  for (const projection of list(corpus.projections)) {
    register("projection", projection.id);
    index.projections.set(projection.id, projection);
  }
  for (const receipt of list(corpus.receipts)) {
    register("receipt", receipt.id);
    index.receipts.set(receipt.id, receipt);
  }
  for (const deferral of list(corpus.deferrals)) {
    register("deferral", deferral.id);
  }
  return index;
}

function evidenceReferences(
  items: EvidenceItem[] | undefined,
  path: string,
): Reference[] {
  const references: Reference[] = [];
  list(items).forEach((item, position) => {
    const base = `${path}/${position}`;
    if (item.event) {
      references.push({
        path: `${base}/event`,
        id: item.event,
        kinds: ["event"],
      });
    }
    if (item.artifact) {
      references.push({
        path: `${base}/artifact`,
        id: item.artifact,
        kinds: ["artifact"],
      });
    }
    if (item.context_packet) {
      references.push({
        path: `${base}/context_packet`,
        id: item.context_packet,
        kinds: ["context_packet"],
      });
    }
    if (item.run) {
      references.push({ path: `${base}/run`, id: item.run, kinds: ["run"] });
    }
  });
  return references;
}

function collectReferences(corpus: Corpus): Reference[] {
  const references: Reference[] = [];
  const add = (
    path: string,
    id: string | undefined,
    ...kinds: EntityKind[]
  ) => {
    if (id === undefined) return;
    references.push({ path, id, kinds });
  };

  list(corpus.participants).forEach((participant, i) => {
    add(`/participants/${i}/agent_spec`, participant.agent_spec, "agent_spec");
  });
  list(corpus.room_memberships).forEach((membership, i) => {
    const base = `/room_memberships/${i}`;
    add(`${base}/room`, membership.room, "room");
    add(`${base}/participant`, membership.participant, "participant");
    add(
      `${base}/speak_rule/loop_prevention/exception_grant`,
      membership.speak_rule.loop_prevention.exception_grant,
      "capability_grant",
    );
  });
  list(corpus.threads).forEach((thread, i) => {
    add(`/threads/${i}/room`, thread.room, "room");
    add(`/threads/${i}/task`, thread.task, "task");
  });
  list(corpus.agent_specs).forEach((spec, i) => {
    add(`/agent_specs/${i}/participant`, spec.participant, "participant");
  });
  list(corpus.tasks).forEach((task, i) => {
    const base = `/tasks/${i}`;
    add(`${base}/room`, task.room, "room");
    add(`${base}/thread`, task.thread, "thread");
    add(`${base}/envelope/grant`, task.envelope.grant, "capability_grant");
    add(
      `${base}/execution_envelope/assigned_agent_spec`,
      task.execution_envelope.assigned_agent_spec,
      "agent_spec",
    );
    task.transitions.forEach((transition, j) => {
      add(`${base}/transitions/${j}/event`, transition.event, "event");
    });
  });
  list(corpus.runs).forEach((run, i) => {
    const base = `/runs/${i}`;
    add(`${base}/task`, run.task, "task");
    add(`${base}/agent_spec`, run.agent_spec, "agent_spec");
    add(`${base}/route`, run.route, "route");
    add(`${base}/route_session`, run.route_session, "route_session");
    add(`${base}/context_packet`, run.context_packet, "context_packet");
    add(`${base}/capability_grant`, run.capability_grant, "capability_grant");
    run.transitions.forEach((transition, j) => {
      add(`${base}/transitions/${j}/event`, transition.event, "event");
    });
  });
  list(corpus.route_capability_reports).forEach((report, i) => {
    add(`/route_capability_reports/${i}/route`, report.route, "route");
  });
  list(corpus.route_sessions).forEach((session, i) => {
    const base = `/route_sessions/${i}`;
    add(`${base}/route`, session.route, "route");
    add(`${base}/run`, session.run, "run");
    session.phases.forEach((phase, j) => {
      add(
        `${base}/phases/${j}/capability_report`,
        phase.capability_report,
        "route_capability_report",
      );
    });
    references.push(
      ...evidenceReferences(
        session.continuity.evidence,
        `${base}/continuity/evidence`,
      ),
    );
  });
  list(corpus.context_packets).forEach((packet, i) => {
    const base = `/context_packets/${i}`;
    add(`${base}/task`, packet.task, "task");
    add(`${base}/run`, packet.run, "run");
    add(
      `${base}/compaction/source_packet`,
      packet.compaction?.source_packet,
      "context_packet",
    );
    packet.entries.forEach((entry, j) => {
      const kind = entry.source.kind;
      if (kind === "external") return;
      const expected: EntityKind = kind === "artifact"
        ? "artifact"
        : kind === "event"
        ? "event"
        : kind === "thread"
        ? "thread"
        : "task";
      add(
        `${base}/entries/${j}/source/reference`,
        entry.source.reference,
        expected,
      );
    });
  });
  list(corpus.capability_grants).forEach((grant, i) => {
    const base = `/capability_grants/${i}`;
    add(`${base}/grantor`, grant.grantor, "participant");
    add(`${base}/grantee`, grant.grantee, "participant");
    add(`${base}/supersedes`, grant.supersedes, "capability_grant");
    add(`${base}/approval_event`, grant.approval_event, "event");
    add(
      `${base}/policy_basis/approval_event`,
      grant.policy_basis.approval_event,
      "event",
    );
    list(grant.scope.route_scope).forEach((route, j) => {
      add(`${base}/scope/route_scope/${j}`, route, "route");
    });
    add(`${base}/scope/task_scope`, grant.scope.task_scope, "task");
    add(`${base}/scope/room_scope`, grant.scope.room_scope, "room");
  });
  list(corpus.registration_leases).forEach((lease, i) => {
    const base = `/registration_leases/${i}/subject/reference`;
    switch (lease.subject.kind) {
      case "route":
        add(base, lease.subject.reference, "route");
        break;
      case "native-session":
        add(base, lease.subject.reference, "route_session");
        break;
      case "agent-process":
        add(base, lease.subject.reference, "agent_spec");
        break;
      default:
        // Tool and skill registrations name a declared capability rather than
        // a durable entity; closure for those is checked against the declared
        // agent tool surface.
        break;
    }
  });
  list(corpus.artifacts).forEach((artifact, i) => {
    const base = `/artifacts/${i}`;
    if (artifact.authoritative_ref.kind === "internal") {
      add(
        `${base}/authoritative_ref/reference`,
        artifact.authoritative_ref.reference,
        "artifact",
        "event",
      );
    }
    list(artifact.derived_from).forEach((source, j) => {
      add(`${base}/derived_from/${j}`, source, "artifact", "context_packet");
    });
    add(
      `${base}/derivation/verified_by`,
      artifact.derivation?.verified_by,
      "event",
    );
    add(`${base}/supersedes`, artifact.supersedes, "artifact");
  });
  list(corpus.events).forEach((event, i) => {
    const base = `/events/${i}`;
    add(`${base}/room`, event.room, "room");
    add(`${base}/thread`, event.thread, "thread");
    add(`${base}/task`, event.task, "task");
    add(`${base}/run`, event.run, "run");
    add(`${base}/author`, event.author, "participant");
    add(`${base}/authorizer`, event.authorizer, "participant");
    list(event.observers).forEach((observer, j) => {
      add(`${base}/observers/${j}`, observer, "participant");
    });
    add(`${base}/artifact_ref`, event.artifact_ref, "artifact");
    add(`${base}/context_packet`, event.context_packet, "context_packet");
    event.causal_parents.forEach((parent, j) => {
      add(`${base}/causal_parents/${j}`, parent, "event");
    });
    add(`${base}/supersedes`, event.supersedes, "event");
    add(
      `${base}/authorization_basis/grant`,
      event.authorization_basis.grant,
      "capability_grant",
    );
    add(
      `${base}/authorization_basis/membership`,
      event.authorization_basis.membership,
      "room_membership",
    );
    add(
      `${base}/authorization_basis/authorizing_event`,
      event.authorization_basis.authorizing_event,
      "event",
    );
    add(
      `${base}/policy_basis/approval_event`,
      event.policy_basis.approval_event,
      "event",
    );
    add(
      `${base}/summons_exception_grant`,
      event.summons_exception_grant,
      "capability_grant",
    );
    add(`${base}/authoritative_source`, event.authoritative_source, "event");
    references.push(
      ...evidenceReferences(
        event.integrity_evidence,
        `${base}/integrity_evidence`,
      ),
    );
    const transition = event.state_transition;
    if (transition) {
      add(
        `${base}/state_transition/entity`,
        transition.entity,
        transition.entity_kind === "task" ? "task" : "run",
      );
      add(
        `${base}/state_transition/caused_by_run`,
        transition.caused_by_run,
        "run",
      );
      add(
        `${base}/state_transition/operator_decision`,
        transition.operator_decision,
        "event",
      );
      references.push(
        ...evidenceReferences(
          transition.evidence,
          `${base}/state_transition/evidence`,
        ),
      );
    }
    references.push(
      ...evidenceReferences(
        event.durable_commit?.evidence,
        `${base}/durable_commit/evidence`,
      ),
    );
  });
  list(corpus.projections).forEach((projection, i) => {
    const base = `/projections/${i}`;
    projection.source_packets.forEach((packet, j) => {
      add(`${base}/source_packets/${j}`, packet, "context_packet");
    });
    projection.source_events.forEach((event, j) => {
      add(`${base}/source_events/${j}`, event, "event");
    });
  });
  list(corpus.receipts).forEach((receipt, i) => {
    const base = `/receipts/${i}`;
    add(`${base}/room`, receipt.room, "room");
    add(`${base}/task`, receipt.task, "task");
    add(`${base}/run`, receipt.run, "run");
    add(`${base}/commit_event`, receipt.commit_event, "event");
    add(
      `${base}/attribution/author`,
      receipt.attribution.author,
      "participant",
    );
    add(
      `${base}/attribution/authorizer`,
      receipt.attribution.authorizer,
      "participant",
    );
    if (receipt.current_state !== undefined) {
      add(
        `${base}/current_state/entity`,
        receipt.current_state.entity,
        receipt.current_state.entity_kind === "task" ? "task" : "run",
      );
    }
    references.push(
      ...evidenceReferences(receipt.evidence, `${base}/evidence`),
    );
    const body = receipt.body;
    add(`${base}/body/route/route`, body.route?.route, "route");
    add(
      `${base}/body/context_packet/reference`,
      body.context_packet?.reference,
      "context_packet",
    );
    add(
      `${base}/body/projection/reference`,
      body.projection?.reference,
      "projection",
    );
    add(
      `${base}/body/capability_posture/report`,
      body.capability_posture?.report,
      "route_capability_report",
    );
    add(`${base}/body/process_provenance`, body.process_provenance, "event");
    list(body.artifacts).forEach((artifact, j) => {
      add(`${base}/body/artifacts/${j}`, artifact, "artifact");
    });
    add(
      `${base}/body/remaining_authority/grant`,
      body.remaining_authority?.grant,
      "capability_grant",
    );
    references.push(
      ...evidenceReferences(body.route_evidence, `${base}/body/route_evidence`),
    );
    references.push(
      ...evidenceReferences(
        body.verification?.evidence,
        `${base}/body/verification/evidence`,
      ),
    );
    for (const [name, fact] of Object.entries(body.facts ?? {})) {
      references.push(
        ...evidenceReferences(
          fact.evidence,
          `${base}/body/facts/${name}/evidence`,
        ),
      );
    }
  });
  return references;
}

/**
 * Runs every cross-document rule over a corpus that already passed
 * structural validation. Diagnostics are returned in a deterministic order:
 * rules run in a fixed sequence and each rule walks its collections in
 * document order.
 */
export function checkSemantics(corpus: Corpus): SemanticDiagnostic[] {
  const found: SemanticDiagnostic[] = [];
  const report = (
    rule: SemanticRuleId,
    path: string,
    detail: string,
    entity?: string,
  ): void => {
    found.push(
      entity === undefined
        ? { rule, path, detail }
        : { rule, path, detail, entity },
    );
  };
  const index = buildIndex(corpus);

  checkIdentity(corpus, report);
  checkReferences(corpus, index, report);
  checkContainmentAndAuthorship(corpus, index, report);
  checkLifecycle(corpus, index, report);
  checkEventOrdering(corpus, index, report);
  checkSoloRoom(corpus, index, report);
  checkLabels(corpus, index, report);
  checkRouteControl(corpus, index, report);
  checkRunBinding(corpus, index, report);
  checkAuthority(corpus, index, report);
  checkAuthorizationBasis(corpus, index, report);
  checkGrantsAndLeases(corpus, index, report);
  checkGrantEgress(corpus, index, report);
  checkSoleWriter(corpus, report);
  checkReceipts(corpus, index, report);
  checkReceiptReconciliation(corpus, index, report);
  checkSecrecy(corpus, report);
  checkDeferrals(corpus, report);
  return found;
}

type Report = (
  rule: SemanticRuleId,
  path: string,
  detail: string,
  entity?: string,
) => void;

function checkContainmentAndAuthorship(
  corpus: Corpus,
  index: Index,
  report: Report,
): void {
  list(corpus.tasks).forEach((task, i) => {
    const thread = index.threads.get(task.thread);
    if (thread && thread.room !== task.room) {
      report(
        "run.evidence-binding",
        `/tasks/${i}/room`,
        "task and its thread belong to different rooms",
        task.id,
      );
    }
    if (thread?.task !== undefined && thread.task !== task.id) {
      report(
        "run.evidence-binding",
        `/tasks/${i}/thread`,
        "task-linked thread names another task",
        task.id,
      );
    }
  });

  list(corpus.events).forEach((event, i) => {
    const base = `/events/${i}`;
    const participant = index.participants.get(event.author);
    const resolvedClass = participant?.participant_class === "digital"
      ? "machine"
      : participant?.participant_class;
    if (resolvedClass !== undefined && event.author_class !== resolvedClass) {
      report(
        "authority.basis",
        `${base}/author_class`,
        "event author class disagrees with the resolved participant class",
        event.id,
      );
    }

    const task = event.task === undefined
      ? undefined
      : index.tasks.get(event.task);
    if (task && event.room !== task.room) {
      report(
        "run.evidence-binding",
        `${base}/room`,
        "event and its task belong to different rooms",
        event.id,
      );
    }
    const thread = event.thread === undefined
      ? undefined
      : index.threads.get(event.thread);
    if (thread && thread.room !== event.room) {
      report(
        "run.evidence-binding",
        `${base}/thread`,
        "event and its thread belong to different rooms",
        event.id,
      );
    }

    const run = event.run === undefined ? undefined : index.runs.get(event.run);
    if (run && event.task !== run.task) {
      report(
        "run.evidence-binding",
        `${base}/task`,
        "event and its run name different tasks",
        event.id,
      );
    }
    if (thread?.task !== undefined && event.task !== thread.task) {
      report(
        "run.evidence-binding",
        `${base}/task`,
        "event and its task-linked thread name different tasks",
        event.id,
      );
    }

    const membership = list(corpus.room_memberships).find((candidate) =>
      candidate.room === event.room && candidate.participant === event.author &&
      candidate.present && candidate.may_author
    );
    if (membership === undefined) {
      report(
        "authority.basis",
        `${base}/author`,
        "event author holds no effective authorship membership in the event room",
        event.id,
      );
    } else if (event.family === "message" && !membership.may_speak) {
      report(
        "authority.basis",
        `${base}/author`,
        "message author holds no effective permission to speak in the event room",
        event.id,
      );
    }

    const basis = event.authorization_basis;
    if (basis.kind === "membership") {
      const cited = basis.membership === undefined
        ? undefined
        : index.memberships.get(basis.membership);
      if (cited?.id !== membership?.id) {
        report(
          "authority.basis",
          `${base}/authorization_basis/membership`,
          "membership-authorized event names no effective matching membership",
          event.id,
        );
      }
    }
    if (basis.kind === "operator-direct" && event.author_class === "machine") {
      const authorizing = basis.authorizing_event === undefined
        ? undefined
        : index.events.get(basis.authorizing_event);
      const attributable = authorizing !== undefined &&
        index.participants.get(authorizing.author)?.participant_class ===
          "human" &&
        event.authorizer === authorizing.author &&
        authorizing.sequence < event.sequence &&
        ((event.task !== undefined && authorizing.task === event.task) ||
          authorizing.room === event.room);
      if (!attributable) {
        report(
          "authority.basis",
          `${base}/authorization_basis/authorizing_event`,
          "machine direct authority names no preceding attributable human authorizing event for its Task or Room",
          event.id,
        );
      }
    }
    if (
      basis.kind === "policy-default" &&
      (event.policy_basis.decision === "denied" ||
        (event.policy_basis.decision === "allowed-with-approval" &&
          (() => {
            const approval = resolvedHumanApproval(event.policy_basis, index);
            return approval === undefined ||
              approval.sequence >= event.sequence ||
              !approvalMatchesScope(approval, event.task, event.room);
          })()))
    ) {
      report(
        "authority.basis",
        `${base}/policy_basis`,
        "default policy authority names no effective policy basis",
        event.id,
      );
    }
  });
}

function checkIdentity(corpus: Corpus, report: Report): void {
  const seen = new Map<string, string>();
  const visit = (path: string, id: string, basis?: string): void => {
    const previous = seen.get(id);
    if (previous !== undefined) {
      report("identity.uniqueness", path, "identifier is already in use", id);
    } else {
      seen.set(id, path);
    }
    if (basis !== undefined && basis !== "assigned-opaque") {
      report(
        "identity.stable-basis",
        path,
        "stable identity is derived from an ephemeral implementation detail",
        id,
      );
    }
  };
  const collections: [string, { id: string; identity_basis?: string }[]][] = [
    ["rooms", list(corpus.rooms)],
    ["participants", list(corpus.participants)],
    ["room_memberships", list(corpus.room_memberships)],
    ["threads", list(corpus.threads)],
    ["agent_specs", list(corpus.agent_specs)],
    ["tasks", list(corpus.tasks)],
    ["runs", list(corpus.runs)],
    ["routes", list(corpus.routes)],
    ["route_capability_reports", list(corpus.route_capability_reports)],
    ["route_sessions", list(corpus.route_sessions)],
    ["context_packets", list(corpus.context_packets)],
    ["capability_grants", list(corpus.capability_grants)],
    ["registration_leases", list(corpus.registration_leases)],
    ["artifacts", list(corpus.artifacts)],
    ["events", list(corpus.events)],
    ["projections", list(corpus.projections)],
    ["receipts", list(corpus.receipts)],
    ["deferrals", list(corpus.deferrals)],
  ];
  for (const [name, entries] of collections) {
    entries.forEach((entry, i) => {
      visit(`/${name}/${i}/id`, entry.id, entry.identity_basis);
    });
  }
}

function checkReferences(corpus: Corpus, index: Index, report: Report): void {
  for (const reference of collectReferences(corpus)) {
    const kind = index.kinds.get(reference.id);
    if (kind === undefined) {
      report(
        "reference.closure",
        reference.path,
        "reference does not resolve within the corpus and is not marked external",
        reference.id,
      );
      continue;
    }
    if (!reference.kinds.includes(kind)) {
      report(
        "reference.kind",
        reference.path,
        "reference resolves to an entity of the wrong kind",
        reference.id,
      );
    }
  }
  // External context sources must carry their external authority record, and
  // corpus-internal sources must carry a reference.
  list(corpus.context_packets).forEach((packet, i) => {
    packet.entries.forEach((entry, j) => {
      const path = `/context_packets/${i}/entries/${j}/source`;
      if (entry.source.kind === "external") {
        if (entry.source.external === undefined) {
          report(
            "reference.closure",
            path,
            "external context source is missing its authoritative reference record",
            packet.id,
          );
        }
      } else if (entry.source.reference === undefined) {
        report(
          "reference.closure",
          path,
          "context source names no reference and is not marked external",
          packet.id,
        );
      }
    });
  });
  list(corpus.artifacts).forEach((artifact, i) => {
    const path = `/artifacts/${i}/authoritative_ref`;
    if (
      artifact.authoritative_ref.kind === "external" &&
      artifact.authoritative_ref.external === undefined
    ) {
      report(
        "reference.closure",
        path,
        "external artifact reference is missing its authoritative reference record",
        artifact.id,
      );
    }
    if (
      artifact.authoritative_ref.kind === "internal" &&
      artifact.authoritative_ref.reference === undefined
    ) {
      report(
        "reference.closure",
        path,
        "internal artifact reference names no corpus entity",
        artifact.id,
      );
    }
  });
  const declaredTools = new Set<string>();
  for (const spec of list(corpus.agent_specs)) {
    for (const tool of spec.tools) declaredTools.add(tool);
  }
  list(corpus.registration_leases).forEach((lease, i) => {
    if (lease.subject.kind !== "tool" && lease.subject.kind !== "skill") return;
    if (!declaredTools.has(lease.subject.reference)) {
      report(
        "reference.closure",
        `/registration_leases/${i}/subject/reference`,
        "lease names a tool or skill that no agent specification declares",
        lease.id,
      );
    }
  });
}

function stateKind(state: string): "task" | "run" | "unknown" {
  if ((TASK_STATES as readonly string[]).includes(state)) return "task";
  if ((RUN_STATES as readonly string[]).includes(state)) return "run";
  return "unknown";
}

function isHumanOperatorEvent(
  event: WorkbenchEvent | undefined,
  index: Index,
): boolean {
  return event !== undefined &&
    index.participants.get(event.author)?.participant_class === "human" &&
    event.claim_source === "operator-accepted";
}

function isBoundTaskOperatorDecision(
  decision: WorkbenchEvent | undefined,
  task: string,
  ending: WorkbenchEvent,
  afterSequence: number,
  index: Index,
): boolean {
  return isHumanOperatorEvent(decision, index) &&
    (decision!.family === "approval" ||
      decision!.family === "task-transition") &&
    decision!.id !== ending.id && decision!.task === task &&
    decision!.sequence > afterSequence && decision!.sequence <= ending.sequence;
}

function citesRunOutcome(
  transition: StateTransitionRecord,
  run: Run,
  index: Index,
): boolean {
  return transition.evidence.some((item) => {
    if (item.run === run.id) return true;
    if (item.event === undefined) return false;
    const evidence = index.events.get(item.event)?.state_transition;
    return evidence?.entity_kind === "run" && evidence.entity === run.id &&
      FAILED_RUN_STATES.has(evidence.to);
  });
}

function checkLifecycle(corpus: Corpus, index: Index, report: Report): void {
  const entities: {
    kind: "task" | "run";
    path: string;
    id: string;
    state: string;
    revision: number;
    transitions: Transition[];
  }[] = [];
  list(corpus.tasks).forEach((task, i) => {
    entities.push({
      kind: "task",
      path: `/tasks/${i}`,
      id: task.id,
      state: task.state,
      revision: task.revision,
      transitions: task.transitions,
    });
  });
  const attempts = new Set<string>();
  list(corpus.runs).forEach((run, i) => {
    entities.push({
      kind: "run",
      path: `/runs/${i}`,
      id: run.id,
      state: run.state,
      revision: run.revision,
      transitions: run.transitions,
    });
    // A Run is one attempt by one agent through one route, and a Task may
    // retain many. The attempt number is what tells two retained attempts
    // apart, so it is unique per Task across the whole corpus.
    const attempt = `${run.task}>${run.attempt}`;
    if (attempts.has(attempt)) {
      report(
        "lifecycle.run-attempt-uniqueness",
        `/runs/${i}/attempt`,
        "another run of the same task already records this attempt number",
        run.id,
      );
    }
    attempts.add(attempt);
  });

  for (const entity of entities) {
    if (stateKind(entity.state) !== entity.kind) {
      report(
        "lifecycle.state-type",
        `${entity.path}/state`,
        "entity carries a state belonging to the other lifecycle type",
        entity.id,
      );
    }
    entity.transitions.forEach((transition, j) => {
      const path = `${entity.path}/transitions/${j}`;
      for (
        const [field, state] of [["from", transition.from], [
          "to",
          transition.to,
        ]]
      ) {
        if (stateKind(state!) !== entity.kind) {
          report(
            "lifecycle.state-type",
            `${path}/${field}`,
            "transition names a state belonging to the other lifecycle type",
            entity.id,
          );
        }
      }
      if (transition.revision !== j + 2) {
        report(
          "lifecycle.revision-order",
          `${path}/revision`,
          "transition revision does not follow the entity revision sequence",
          entity.id,
        );
      }
      if (j > 0 && entity.transitions[j - 1]!.to !== transition.from) {
        report(
          "lifecycle.progression",
          `${path}/from`,
          "transition does not continue from the previous recorded state",
          entity.id,
        );
      }
    });
    const last = entity.transitions.at(-1);
    const expectedState = last?.to ??
      (entity.kind === "task" ? "task:proposed" : "run:pending");
    if (entity.state !== expectedState) {
      report(
        "lifecycle.transition-event-pairing",
        `${entity.path}/state`,
        "current state was mutated without a paired transition and event",
        entity.id,
      );
    }
    const expectedRevision = last?.revision ?? 1;
    if (entity.revision !== expectedRevision) {
      report(
        "lifecycle.revision-order",
        `${entity.path}/revision`,
        "entity revision does not match its last recorded transition",
        entity.id,
      );
    }
    if (entity.transitions.length > 0) {
      const first = entity.transitions[0]!;
      const origin = entity.kind === "task" ? "task:proposed" : "run:pending";
      if (first.from !== origin) {
        report(
          "lifecycle.progression",
          `${entity.path}/transitions/0/from`,
          "first transition does not start from the entity origin state",
          entity.id,
        );
      }
    }

    // Entity-recorded mutation must have its attributable event, and the
    // event must agree with the recorded mutation in every field.
    entity.transitions.forEach((transition, j) => {
      const path = `${entity.path}/transitions/${j}`;
      const event = index.events.get(transition.event);
      if (!event) return; // reference closure already reported this.
      const recorded = event.state_transition;
      if (!recorded) {
        report(
          "lifecycle.transition-event-pairing",
          `${path}/event`,
          "paired event records no state transition",
          entity.id,
        );
        return;
      }
      const agrees = recorded.entity === entity.id &&
        recorded.entity_kind === entity.kind &&
        recorded.from === transition.from &&
        recorded.to === transition.to &&
        recorded.entity_revision === transition.revision &&
        recorded.progression_class === transition.progression_class;
      if (!agrees) {
        report(
          "lifecycle.transition-event-pairing",
          `${path}/event`,
          "paired event does not agree with the recorded state mutation",
          entity.id,
        );
      }
    });
  }

  // Every event-claimed transition must exist as a recorded entity mutation,
  // and each is judged most-specific-rule-first.
  list(corpus.events).forEach((event, i) => {
    const transition = event.state_transition;
    if (!transition) return;
    const path = `/events/${i}/state_transition`;
    const entity = transition.entity_kind === "task"
      ? index.tasks.get(transition.entity)
      : index.runs.get(transition.entity);
    if (
      stateKind(transition.from) !== transition.entity_kind ||
      stateKind(transition.to) !== transition.entity_kind
    ) {
      report(
        "lifecycle.state-type",
        path,
        "event transition names a state belonging to the other lifecycle type",
        event.id,
      );
      return;
    }
    if (!entity) return; // reference closure already reported this.
    const matched = entity.transitions.some((candidate) =>
      candidate.from === transition.from &&
      candidate.to === transition.to &&
      candidate.revision === transition.entity_revision &&
      candidate.event === event.id
    );
    if (!matched) {
      report(
        "lifecycle.transition-event-pairing",
        path,
        "event claims a state mutation the entity does not record",
        event.id,
      );
      return;
    }
    const causedBy = transition.caused_by_run
      ? index.runs.get(transition.caused_by_run)
      : undefined;
    const runCausedEnding = transition.entity_kind === "task" &&
      causedBy !== undefined && FAILED_RUN_STATES.has(causedBy.state) &&
      (CLOSING_STATES.has(transition.to) ||
        ENDING_TASK_STATES.has(transition.to));
    const causingTerminalSequence = causedBy?.transitions.reduce(
      (latest, step) =>
        Math.max(latest, index.events.get(step.event)?.sequence ?? 0),
      0,
    ) ?? 0;
    if (
      runCausedEnding &&
      (!isBoundTaskOperatorDecision(
        transition.operator_decision === undefined
          ? undefined
          : index.events.get(transition.operator_decision),
        transition.entity,
        event,
        causingTerminalSequence,
        index,
      ) || !citesRunOutcome(transition, causedBy, index))
    ) {
      report(
        "lifecycle.run-independence",
        path,
        "a failed, interrupted, abandoned, or superseded run ends its task without causal evidence and a separate human operator decision",
        event.id,
      );
      return;
    }
    if (transition.progression_class === "exceptional") {
      if (CLOSING_STATES.has(transition.to)) {
        report(
          "lifecycle.outcome-collapse",
          `${path}/to`,
          "an exceptional outcome is recorded as completion, acceptance, or closure",
          event.id,
        );
        return;
      }
      if (!EXCEPTIONAL_STATES.has(transition.to)) {
        report(
          "lifecycle.progression",
          `${path}/to`,
          "an exceptional transition targets a required-progression state",
          event.id,
        );
      }
      return;
    }
    const edge = `${transition.from}>${transition.to}`;
    const allowed = transition.entity_kind === "task"
      ? REQUIRED_TASK_EDGES
      : REQUIRED_RUN_EDGES;
    if (!allowed.has(edge)) {
      report(
        "lifecycle.progression",
        path,
        "transition is not part of the required lifecycle progression",
        event.id,
      );
      return;
    }
    if (
      transition.entity_kind === "task" && edge === "task:running>task:ready"
    ) {
      if (
        causedBy === undefined || !FAILED_RUN_STATES.has(causedBy.state) ||
        !citesRunOutcome(transition, causedBy, index)
      ) {
        report(
          "lifecycle.run-independence",
          path,
          "a task returns to ready without evidence of the failed, interrupted, abandoned, or superseded run",
          event.id,
        );
      }
      return;
    }
    if (
      transition.entity_kind === "task" &&
      (edge === "task:completed>task:accepted" ||
        edge === "task:accepted>task:closed") &&
      !isHumanOperatorEvent(event, index)
    ) {
      report(
        "lifecycle.run-independence",
        path,
        "task acceptance or closure lacks human operator provenance",
        event.id,
      );
      return;
    }
    if (
      transition.entity_kind === "task" && edge === "task:completed>task:closed"
    ) {
      const decision = transition.operator_decision
        ? index.events.get(transition.operator_decision)
        : undefined;
      const task = index.tasks.get(transition.entity);
      const completedSequence = task?.transitions.reduce((latest, step) => {
        if (step.to !== "task:completed") return latest;
        return Math.max(latest, index.events.get(step.event)?.sequence ?? 0);
      }, 0) ?? 0;
      if (
        !isBoundTaskOperatorDecision(
          decision,
          transition.entity,
          event,
          completedSequence,
          index,
        )
      ) {
        report(
          "lifecycle.progression",
          path,
          "a task closes directly from completed without an explicit attributable operator decision",
          event.id,
        );
      }
      return;
    }
  });

  // Every unsuccessful terminal run must leave a recorded causal consequence
  // on its task rather than being silently absorbed.
  list(corpus.runs).forEach((run, i) => {
    if (!FAILED_RUN_STATES.has(run.state)) return;
    const hasConsequence = list(corpus.events).some((event) => {
      const transition = event.state_transition;
      return transition !== undefined &&
        transition.entity_kind === "task" &&
        transition.entity === run.task &&
        transition.caused_by_run === run.id;
    });
    if (!hasConsequence) {
      report(
        "lifecycle.run-independence",
        `/runs/${i}/state`,
        "a failed, interrupted, abandoned, or superseded run has no recorded causal consequence on its task",
        run.id,
      );
    }
  });
}

function checkEventOrdering(
  corpus: Corpus,
  index: Index,
  report: Report,
): void {
  const sequences = new Set<number>();
  list(corpus.events).forEach((event, i) => {
    const base = `/events/${i}`;
    if (sequences.has(event.sequence)) {
      report(
        "event.causal-order",
        `${base}/sequence`,
        "event sequence is already used by another event",
        event.id,
      );
    }
    sequences.add(event.sequence);
    event.causal_parents.forEach((parent, j) => {
      const resolved = index.events.get(parent);
      if (resolved && resolved.sequence >= event.sequence) {
        report(
          "event.causal-order",
          `${base}/causal_parents/${j}`,
          "causal parent does not precede its child",
          event.id,
        );
      }
    });
    const superseded = event.supersedes
      ? index.events.get(event.supersedes)
      : undefined;
    if (superseded && superseded.sequence >= event.sequence) {
      report(
        "event.causal-order",
        `${base}/supersedes`,
        "superseded event does not precede the superseding event",
        event.id,
      );
    }
  });
  const ordered = (
    path: string,
    id: string,
    transitions: Transition[],
  ): void => {
    let previous = 0;
    transitions.forEach((transition, j) => {
      const event = index.events.get(transition.event);
      if (!event) return;
      if (event.sequence <= previous) {
        report(
          "event.causal-order",
          `${path}/transitions/${j}/event`,
          "transition events are not recorded in increasing sequence",
          id,
        );
      }
      previous = event.sequence;
    });
  };
  list(corpus.tasks).forEach((task, i) =>
    ordered(`/tasks/${i}`, task.id, task.transitions)
  );
  list(corpus.runs).forEach((run, i) =>
    ordered(`/runs/${i}`, run.id, run.transitions)
  );

  let previousCommitSequence = 0;
  for (
    const event of [...list(corpus.events)].sort((a, b) =>
      a.sequence - b.sequence
    )
  ) {
    const commitSequence = event.durable_commit?.commit_sequence;
    if (commitSequence === undefined) continue;
    if (commitSequence < previousCommitSequence) {
      report(
        "event.causal-order",
        `/events/${
          list(corpus.events).indexOf(event)
        }/durable_commit/commit_sequence`,
        "durable commit sequence regresses in event-sequence order",
        event.id,
      );
    }
    previousCommitSequence = Math.max(previousCommitSequence, commitSequence);
  }
}

function checkSoloRoom(corpus: Corpus, index: Index, report: Report): void {
  const profiled = list(corpus.rooms).filter((room) =>
    room.profile === "first-product-solo-operator"
  );
  if (
    corpus.profile === "first-product-solo-operator" && profiled.length !== 1
  ) {
    report(
      "solo-room.defaults",
      "/rooms",
      "the first-product profile requires exactly one persistent operator room",
    );
  }
  for (const room of profiled) {
    const path = `/rooms/${list(corpus.rooms).indexOf(room)}`;
    if (room.persistence !== "persistent") {
      report(
        "solo-room.defaults",
        `${path}/persistence`,
        "the first-product operator room must be persistent",
        room.id,
      );
    }
    const memberships = list(corpus.room_memberships).filter((membership) =>
      membership.room === room.id
    );
    const humans = memberships.filter((membership) =>
      index.participants.get(membership.participant)?.participant_class ===
        "human"
    );
    const digitals = memberships.filter((membership) =>
      index.participants.get(membership.participant)?.participant_class ===
        "digital"
    );
    if (humans.length !== 1 || digitals.length !== 1) {
      report(
        "solo-room.defaults",
        "/room_memberships",
        "the first-product room requires one operator and one primary-agent membership",
        room.id,
      );
      continue;
    }
    const operator = humans[0]!;
    const agent = digitals[0]!;
    if (!operator.present || !operator.may_author || !operator.may_speak) {
      report(
        "solo-room.defaults",
        `/room_memberships/${list(corpus.room_memberships).indexOf(operator)}`,
        "the operator membership must be present with authorship and speak permission",
        operator.id,
      );
    }
    if (!agent.present || agent.speak_rule.policy !== "always-on") {
      report(
        "solo-room.defaults",
        `/room_memberships/${
          list(corpus.room_memberships).indexOf(agent)
        }/speak_rule`,
        "the primary-agent membership must be present and use the always-on speak rule",
        agent.id,
      );
    }
  }

  const exceptionGrants = new Map<string, CapabilityGrant>();
  for (const grant of list(corpus.capability_grants)) {
    if (grant.scope.approvals.includes(SUMMONS_EXCEPTION_APPROVAL)) {
      const grantor = index.participants.get(grant.grantor);
      if (grantor?.participant_class === "human") {
        exceptionGrants.set(grant.id, grant);
      }
    }
  }
  const hasEffectivePolicy = (
    grant: CapabilityGrant,
    summoningEvent?: WorkbenchEvent,
  ): boolean => {
    if (grant.policy_basis.decision === "denied") return false;
    if (grant.policy_basis.decision !== "allowed-with-approval") return true;
    const approval = resolvedHumanApproval(grant.policy_basis, index);
    if (
      approval === undefined ||
      !approvalMatchesScope(
        approval,
        grant.scope.task_scope,
        grant.scope.room_scope,
      )
    ) return false;
    return summoningEvent === undefined ||
      (approval.sequence < summoningEvent.sequence &&
        approvalMatchesScope(
          approval,
          summoningEvent.task,
          summoningEvent.room,
        ));
  };
  list(corpus.room_memberships).forEach((membership, i) => {
    const prevention = membership.speak_rule.loop_prevention;
    if (prevention.automated_summons !== "operator-authorized-exception") {
      return;
    }
    const grant = prevention.exception_grant === undefined
      ? undefined
      : exceptionGrants.get(prevention.exception_grant);
    if (grant === undefined || grant.grantee !== membership.participant) {
      report(
        "solo-room.loop-prevention",
        `/room_memberships/${i}/speak_rule/loop_prevention`,
        "an automated-summons exception names no operator-authorized grant",
        membership.id,
      );
    } else if (!hasEffectivePolicy(grant)) {
      report(
        "authority.basis",
        `/room_memberships/${i}/speak_rule/loop_prevention/exception_grant`,
        "an automated-summons exception relies on an ineffective grant policy basis",
        membership.id,
      );
    }
  });
  list(corpus.events).forEach((event, i) => {
    const resolved = index.participants.get(event.author);
    if (resolved?.participant_class !== "digital") return;
    if (event.triggers_automated_summons !== true) return;
    const grant = event.summons_exception_grant === undefined
      ? undefined
      : exceptionGrants.get(event.summons_exception_grant);
    if (grant === undefined || grant.grantee !== event.author) {
      report(
        "solo-room.loop-prevention",
        `/events/${i}/triggers_automated_summons`,
        "a machine-authored event summons another agent with no operator-authorized exception",
        event.id,
      );
    } else if (!hasEffectivePolicy(grant, event)) {
      report(
        "authority.basis",
        `/events/${i}/summons_exception_grant`,
        "a machine-authored summons relies on an ineffective or retroactively approved exception grant",
        event.id,
      );
    }
  });
}

function packetLabels(packet: ContextPacket): Labels | undefined {
  return labelsOf(packet.entries.map((entry) => entry.labels));
}

/**
 * Labels of whatever a governed reference names. Artifacts, events, and
 * context packets are the three label-bearing things a reference can reach;
 * anything else contributes no labels rather than a silently empty set.
 */
function referencedLabels(id: string, index: Index): Labels | undefined {
  const artifact = index.artifacts.get(id);
  if (artifact) return artifact.labels;
  const event = index.events.get(id);
  if (event) return event.labels;
  const packet = index.packets.get(id);
  return packet ? packetLabels(packet) : undefined;
}

/** Labels of every artifact an evidence list names. */
function evidenceArtifactLabels(
  items: EvidenceItem[] | undefined,
  index: Index,
): Labels[] {
  const labels: Labels[] = [];
  for (const item of list(items)) {
    if (item.artifact === undefined) continue;
    const artifact = index.artifacts.get(item.artifact);
    if (artifact) labels.push(artifact.labels);
  }
  return labels;
}

function checkLabels(corpus: Corpus, index: Index, report: Report): void {
  // Every governed content edge in the corpus: what a derived thing may not
  // weaken relative to the sources it drew from. Reported once per edge.
  const preserves = (
    derived: Labels,
    sources: Labels[],
    rule: SemanticRuleId,
    path: string,
    subject: string,
    what: string,
  ): void => {
    const combined = labelsOf(sources);
    if (!combined) return;
    const weakened = weakensLabels(derived, combined);
    if (weakened) report(rule, path, `${what} ${weakened}`, subject);
  };

  list(corpus.context_packets).forEach((packet, i) => {
    packet.entries.forEach((entry, j) => {
      const kind = entry.source.kind;
      if (kind !== "artifact" && kind !== "event") return;
      if (entry.source.reference === undefined) return;
      const source = referencedLabels(entry.source.reference, index);
      if (!source) return;
      preserves(
        entry.labels,
        [source],
        "label.preservation",
        `/context_packets/${i}/entries/${j}/labels`,
        packet.id,
        "context entry",
      );
    });
  });

  list(corpus.artifacts).forEach((artifact, i) => {
    if (artifact.authoritative_ref.kind !== "internal") return;
    const reference = artifact.authoritative_ref.reference;
    if (reference === undefined) return;
    const source = referencedLabels(reference, index);
    if (!source) return;
    preserves(
      artifact.labels,
      [source],
      "label.preservation",
      `/artifacts/${i}/labels`,
      artifact.id,
      "artifact",
    );
  });

  list(corpus.events).forEach((event, i) => {
    const sources: Labels[] = [
      ...evidenceArtifactLabels(event.integrity_evidence, index),
      ...evidenceArtifactLabels(event.state_transition?.evidence, index),
      ...evidenceArtifactLabels(event.durable_commit?.evidence, index),
    ];
    if (event.artifact_ref !== undefined) {
      const artifact = index.artifacts.get(event.artifact_ref);
      if (artifact) sources.push(artifact.labels);
    }
    preserves(
      event.labels,
      sources,
      "label.preservation",
      `/events/${i}/labels`,
      event.id,
      "event",
    );
  });

  list(corpus.receipts).forEach((receipt, i) => {
    const sources: Labels[] = evidenceArtifactLabels(receipt.evidence, index);
    const packetReference = receipt.body.context_packet?.reference;
    if (packetReference !== undefined) {
      const packet = index.packets.get(packetReference);
      const labels = packet ? packetLabels(packet) : undefined;
      if (labels) sources.push(labels);
    }
    for (const id of list(receipt.body.artifacts)) {
      const artifact = index.artifacts.get(id);
      if (artifact) sources.push(artifact.labels);
    }
    sources.push(
      ...evidenceArtifactLabels(receipt.body.route_evidence, index),
      ...evidenceArtifactLabels(receipt.body.verification?.evidence, index),
    );
    for (const fact of Object.values(receipt.body.facts ?? {})) {
      sources.push(...evidenceArtifactLabels(fact.evidence, index));
    }
    preserves(
      receipt.labels,
      sources,
      "label.preservation",
      `/receipts/${i}/labels`,
      receipt.id,
      "receipt",
    );
  });

  list(corpus.context_packets).forEach((packet, i) => {
    const compaction = packet.compaction;
    if (!compaction) return;
    const source = index.packets.get(compaction.source_packet);
    if (!source) return;
    const sourceLabels = packetLabels(source);
    const derivedLabels = packetLabels(packet);
    if (!sourceLabels || !derivedLabels) return;
    const weakened = weakensLabels(derivedLabels, sourceLabels);
    if (weakened) {
      report(
        "label.preservation",
        `/context_packets/${i}/entries`,
        `compacted context ${weakened} relative to its source packet`,
        packet.id,
      );
    }
  });

  list(corpus.artifacts).forEach((artifact, i) => {
    const sources = list(artifact.derived_from);
    if (sources.length === 0) return;
    const base = `/artifacts/${i}`;
    if (!artifact.derivation) {
      report(
        "provenance.preservation",
        `${base}/derivation`,
        "derived artifact records no derivation provenance",
        artifact.id,
      );
      return;
    }
    if (!artifact.correctable) {
      report(
        "provenance.preservation",
        `${base}/correctable`,
        "derived artifact is not correctable",
        artifact.id,
      );
    }
    const sourceLabels: Labels[] = [];
    for (const source of sources) {
      const sourceArtifact = index.artifacts.get(source);
      if (sourceArtifact) {
        sourceLabels.push(sourceArtifact.labels);
        continue;
      }
      const packet = index.packets.get(source);
      const derived = packet ? packetLabels(packet) : undefined;
      if (derived) sourceLabels.push(derived);
    }
    const combined = labelsOf(sourceLabels);
    if (!combined) return;
    const producer = artifact.authoritative_ref.kind === "internal" &&
        artifact.authoritative_ref.reference !== undefined
      ? index.events.get(artifact.authoritative_ref.reference)?.author
      : undefined;
    const verification = artifact.derivation.verified_by === undefined
      ? undefined
      : index.events.get(artifact.derivation.verified_by);
    const verified = verification !== undefined &&
      verification.family === "verification" &&
      verification.claim_source === "independently-verified" &&
      verification.author !== producer;
    if (
      artifact.derivation.verified_by !== undefined &&
      artifact.derivation.claim_source === "independently-verified" &&
      !verified
    ) {
      report(
        "provenance.preservation",
        `${base}/derivation/verified_by`,
        "derived artifact verification does not resolve to an independent verification event",
        artifact.id,
      );
    }
    const comparable: Labels = verified
      ? { ...combined, integrity_class: artifact.labels.integrity_class }
      : combined;
    const weakened = weakensLabels(artifact.labels, comparable);
    if (weakened) {
      report(
        "label.preservation",
        `${base}/labels`,
        `derived artifact ${weakened} relative to its sources`,
        artifact.id,
      );
    }
  });

  list(corpus.events).forEach((event, i) => {
    if (!event.context_packet) return;
    const packet = index.packets.get(event.context_packet);
    const sourceLabels = packet ? packetLabels(packet) : undefined;
    if (!sourceLabels) return;
    const weakened = weakensLabels(event.labels, sourceLabels);
    if (weakened) {
      report(
        "label.preservation",
        `/events/${i}/labels`,
        `event ${weakened} relative to the context packet it carries`,
        event.id,
      );
    }
  });

  list(corpus.projections).forEach((projection, i) => {
    const base = `/projections/${i}`;
    if (
      projection.source_packets.length === 0 &&
      projection.source_events.length === 0
    ) {
      report(
        "provenance.preservation",
        `${base}/source_events`,
        "projection names no source packet or event",
        projection.id,
      );
      return;
    }
    const sourceLabels: Labels[] = [];
    for (const packetId of projection.source_packets) {
      const packet = index.packets.get(packetId);
      const labels = packet ? packetLabels(packet) : undefined;
      if (labels) sourceLabels.push(labels);
    }
    for (const eventId of projection.source_events) {
      const event = index.events.get(eventId);
      if (event) sourceLabels.push(event.labels);
    }
    const combined = labelsOf(sourceLabels);
    if (combined) {
      const weakened = weakensLabels(projection.source_labels, combined);
      if (weakened) {
        report(
          "label.preservation",
          `${base}/source_labels`,
          `projection ${weakened} relative to its sources`,
          projection.id,
        );
      }
    }
    const clearance = projection.consumer_clearance;
    const labels = projection.source_labels;
    for (const tag of labels.secrecy_tags) {
      if (!clearance.cleared_secrecy_tags.includes(tag)) {
        report(
          "label.clearance",
          `${base}/consumer_clearance/cleared_secrecy_tags`,
          "consumer clearance does not cover a source secrecy tag",
          projection.id,
        );
        break;
      }
    }
    if (
      SENSITIVITY_RANK[clearance.cleared_sensitivity] <
        SENSITIVITY_RANK[labels.sensitivity]
    ) {
      report(
        "label.clearance",
        `${base}/consumer_clearance/cleared_sensitivity`,
        "consumer clearance is below the source sensitivity",
        projection.id,
      );
    }
    if (
      VISIBILITY_RANK[clearance.cleared_visibility] >
        VISIBILITY_RANK[labels.visibility]
    ) {
      report(
        "label.clearance",
        `${base}/consumer_clearance/cleared_visibility`,
        "projection is rendered for an audience broader than its source visibility",
        projection.id,
      );
    }
  });

  list(corpus.receipts).forEach((receipt, i) => {
    const reference = receipt.body.projection?.reference;
    if (!reference) return;
    const projection = index.projections.get(reference);
    if (!projection) return;
    const weakened = weakensLabels(receipt.labels, projection.source_labels);
    if (weakened) {
      report(
        "label.preservation",
        `/receipts/${i}/labels`,
        `receipt ${weakened} relative to the projection it reports`,
        receipt.id,
      );
    }
  });
}

function checkRouteControl(corpus: Corpus, index: Index, report: Report): void {
  list(corpus.route_capability_reports).forEach((entry, i) => {
    const seen = new Set<string>();
    entry.capabilities.forEach((capability, j) => {
      if (seen.has(capability.capability)) {
        report(
          "route.capability-rejection",
          `/route_capability_reports/${i}/capabilities/${j}/capability`,
          "capability report records the same capability more than once",
          entry.id,
        );
      }
      seen.add(capability.capability);
    });
  });

  list(corpus.routes).forEach((route, i) => {
    const base = `/routes/${i}`;
    const extensions = list(route.native_extensions);
    if (extensions.length > 0 && route.execution_lane !== "native") {
      report(
        "route.native-extension-authority",
        `${base}/native_extensions`,
        "only a native execution lane may declare native capability extensions",
        route.id,
      );
    }
    extensions.forEach((extension, j) => {
      if (
        extension.authority === "native-runner" &&
        extension.portability === "portable"
      ) {
        report(
          "route.native-extension-authority",
          `${base}/native_extensions/${j}/portability`,
          "a native-runner capability is claimed as portable across routes",
          route.id,
        );
      }
      if (
        extension.authority === "shared-contract" &&
        extension.opacity === "opaque"
      ) {
        report(
          "route.native-extension-authority",
          `${base}/native_extensions/${j}/opacity`,
          "an opaque capability is claimed under shared-contract authority",
          route.id,
        );
      }
    });
    if (extensions.length === 0) return;
    list(corpus.route_capability_reports).forEach((reportEntry, k) => {
      if (reportEntry.route !== route.id) return;
      const covered = new Set(
        reportEntry.capabilities.map((capability) => capability.capability),
      );
      for (const extension of extensions) {
        if (!covered.has(extension.capability)) {
          report(
            "route.native-capability-erasure",
            `/route_capability_reports/${k}/capabilities`,
            "capability report omits a declared native capability of its route",
            reportEntry.id,
          );
          break;
        }
      }
    });
  });

  list(corpus.route_sessions).forEach((session, i) => {
    const base = `/route_sessions/${i}`;
    const phases = session.phases;
    let previousSequence = 0;
    phases.forEach((phase, j) => {
      const path = `${base}/phases/${j}`;
      if (phase.sequence <= previousSequence) {
        report(
          "route.phase-order",
          `${path}/sequence`,
          "route phases are not recorded in increasing sequence",
          session.id,
        );
      }
      previousSequence = phase.sequence;
      if (j === 0) {
        if (phase.phase !== "inspect") {
          report(
            "route.phase-order",
            `${path}/phase`,
            "a route session must open with the inspect phase",
            session.id,
          );
        }
        return;
      }
      const edge = `${phases[j - 1]!.phase}>${phase.phase}`;
      if (!ALLOWED_PHASE_EDGES.has(edge)) {
        report(
          "route.phase-order",
          `${path}/phase`,
          "route phase transition is not part of the declared control order",
          session.id,
        );
      }
      if (phases[j - 1]!.phase === "finalize") {
        report(
          "route.phase-order",
          `${path}/phase`,
          "a route phase follows the finalize phase",
          session.id,
        );
      }
    });

    // Route binding: a session, the Run it serves, and the capability report
    // its preparation reads must all name the same route, and a Run that
    // names a session must name this one. Cross-route evidence is not
    // evidence about this session.
    const run = index.runs.get(session.run);
    if (run) {
      if (run.route !== session.route) {
        report(
          "route.binding",
          `${base}/route`,
          "route session and the run it serves name different routes",
          session.id,
        );
      }
      if (run.route_session !== undefined && run.route_session !== session.id) {
        report(
          "route.binding",
          `${base}/run`,
          "the run this session serves names a different route session",
          session.id,
        );
      }
    }

    const inspectionOnly = phases.length === 1 &&
      phases[0]?.phase === "inspect";
    if (
      inspectionOnly && run &&
      (run.state !== "run:pending" ||
        list(corpus.receipts).some((receipt) => receipt.run === run.id))
    ) {
      report(
        "route.phase-order",
        `${base}/phases`,
        "inspection-only route evidence accompanies execution or terminal claims",
        session.id,
      );
    }
    if (
      run?.state !== undefined && run.state !== "run:pending" &&
      !phases.some((phase) => phase.phase === "start-or-resume")
    ) {
      report(
        "route.phase-order",
        `${base}/phases`,
        "a non-pending run has no execution-start phase",
        session.id,
      );
    }
    if (run && TERMINAL_RUN_STATES.has(run.state)) {
      const finalized = phases.some((phase) => phase.phase === "finalize");
      const haltedInterrupt = run.state === "run:interrupted" &&
        phases.some((phase) =>
          phase.phase === "control" && phase.outcome === "halted"
        );
      if (!finalized && !haltedInterrupt) {
        report(
          "route.phase-order",
          `${base}/phases`,
          "a terminal run has neither Finalize evidence nor a halted interrupt control phase",
          session.id,
        );
      }
    }

    const prepare = phases.find((phase) => phase.phase === "prepare");
    const preparedReport = prepare?.capability_report !== undefined
      ? index.reports.get(prepare.capability_report)
      : undefined;
    if (prepare && preparedReport && preparedReport.route !== session.route) {
      report(
        "route.binding",
        `${base}/phases/${phases.indexOf(prepare)}/capability_report`,
        "preparation reads a capability report for another route",
        session.id,
      );
    }

    const spending = phases.filter((phase) => phase.spend_or_action);
    if (
      spending.length > 0 && run !== undefined &&
      preparedReport !== undefined && run.route === session.route &&
      preparedReport?.capabilities.some((capability) =>
          capability.required && capability.classification === "unavailable"
        ) !== true &&
      (CONTINUITY_EVIDENCE[session.continuity.class] ?? []).every((kind) =>
        session.continuity.evidence.some((item) => item.kind === kind)
      ) &&
      !run.transitions.some((transition) =>
        transition.from === "run:pending" && transition.to === "run:running"
      )
    ) {
      report(
        "route.phase-order",
        `${base}/phases`,
        "route session reaches spend or action without a pending-to-running reliance event",
        session.id,
      );
    }
    for (const phase of spending) {
      const position = phases.indexOf(phase);
      if (phase.phase === "inspect" || phase.phase === "prepare") {
        report(
          "route.capability-rejection",
          `${base}/phases/${position}/spend_or_action`,
          "inspection or preparation claims spend or action authority",
          session.id,
        );
        continue;
      }
      if (
        !prepare || prepare.outcome !== "accepted" ||
        prepare.sequence >= phase.sequence
      ) {
        report(
          "route.capability-rejection",
          `${base}/phases/${position}/spend_or_action`,
          "spend or action is reached without an accepted preparation phase",
          session.id,
        );
      }
    }
    if (
      spending.length > 0 && prepare && prepare.capability_report === undefined
    ) {
      report(
        "route.capability-rejection",
        `${base}/phases/${phases.indexOf(prepare)}/capability_report`,
        "preparation reached spend or action without reading its own capability report",
        session.id,
      );
    }
    // Only the report preparation actually read decides the posture. Falling
    // back to some other phase's report would let an unread inspection
    // report stand in for the one that had to reject.
    const capabilityReport = preparedReport;
    if (capabilityReport) {
      const unavailable = capabilityReport.capabilities.some((capability) =>
        capability.required && capability.classification === "unavailable"
      );
      if (unavailable) {
        if (prepare && prepare.outcome !== "rejected") {
          report(
            "route.capability-rejection",
            `${base}/phases/${phases.indexOf(prepare)}/outcome`,
            "preparation accepted a route with an unavailable required capability",
            session.id,
          );
        }
        if (spending.length > 0) {
          report(
            "route.capability-rejection",
            `${base}/phases`,
            "a route with an unavailable required capability reached spend or action",
            session.id,
          );
        }
      }
    }

    const continuity = session.continuity;
    const required = CONTINUITY_EVIDENCE[continuity.class] ?? [];
    const kinds = new Set(continuity.evidence.map((item) => item.kind));
    for (const kind of required) {
      if (!kinds.has(kind)) {
        report(
          "route.continuity-evidence",
          `${base}/continuity/evidence`,
          "continuity claim is not supported by the evidence its class requires",
          session.id,
        );
        break;
      }
    }
  });
}

/**
 * Run evidence binding: a Run's ContextPacket is exclusive to it, and a
 * Run's agent specification agrees with the specification its Task assigned.
 * `context_packet` and `capability_grant` are structurally required on every
 * Run; this rule reconciles what the required references must agree on.
 */
function supersedesTransitively(
  grant: CapabilityGrant,
  ancestor: string,
  index: Index,
): boolean {
  const visited = new Set<string>();
  let current: CapabilityGrant | undefined = grant;
  while (current.supersedes !== undefined) {
    if (current.supersedes === ancestor) return true;
    if (visited.has(current.supersedes)) return false;
    visited.add(current.supersedes);
    current = index.grants.get(current.supersedes);
    if (current === undefined) return false;
  }
  return false;
}

function checkRunBinding(corpus: Corpus, index: Index, report: Report): void {
  const routeComponents = [
    "runner",
    "provider",
    "system_harness",
    "tool_vocabulary",
    "context_reasoning_policy",
    "authentication_posture",
    "inference_posture",
  ] as const;
  list(corpus.routes).forEach((route, i) => {
    for (const component of routeComponents) {
      const present = route[component] !== undefined;
      const disposition = route.component_dispositions?.[component];
      if (!present && disposition === undefined) {
        report(
          "run.evidence-binding",
          `/routes/${i}/${component}`,
          "route component is silently omitted without an explicit disposition",
          route.id,
        );
      }
    }
  });

  const scopeComponents = [
    "provider_scope",
    "route_scope",
    "task_scope",
    "room_scope",
    "secrecy_integrity_authorization",
  ] as const;
  list(corpus.capability_grants).forEach((grant, i) => {
    for (const component of scopeComponents) {
      const present = grant.scope[component] !== undefined;
      const disposition = grant.scope.scope_dispositions?.[component];
      if (!present && disposition === undefined) {
        report(
          "run.evidence-binding",
          `/capability_grants/${i}/scope/${component}`,
          "grant scope is silently omitted without an explicit disposition",
          grant.id,
        );
      }
    }
  });

  const packetOwner = new Map<string, string>();
  list(corpus.runs).forEach((run, i) => {
    const base = `/runs/${i}`;
    const session = index.sessions.get(run.route_session);
    if (
      session !== undefined &&
      (session.run !== run.id || session.route !== run.route)
    ) {
      report(
        "route.binding",
        `${base}/route_session`,
        "run names a route session owned by another run or route",
        run.id,
      );
    }
    const packet = index.packets.get(run.context_packet);
    if (packet) {
      if (packet.run !== undefined && packet.run !== run.id) {
        report(
          "run.evidence-binding",
          `${base}/context_packet`,
          "run names a context packet owned by a different run",
          run.id,
        );
      }
      if (packet.task !== undefined && packet.task !== run.task) {
        report(
          "run.evidence-binding",
          `${base}/context_packet`,
          "run names a context packet bound to a different task",
          run.id,
        );
      }
      const owner = packetOwner.get(run.context_packet);
      if (owner !== undefined && owner !== run.id) {
        report(
          "run.evidence-binding",
          `${base}/context_packet`,
          "context packet is referenced by more than one run",
          run.id,
        );
      } else {
        packetOwner.set(run.context_packet, run.id);
      }
    }
    const task = index.tasks.get(run.task);
    if (task) {
      const assigned = task.execution_envelope.assigned_agent_spec;
      if (assigned !== run.agent_spec) {
        report(
          "run.evidence-binding",
          `${base}/agent_spec`,
          "run uses an agent specification other than its task's assigned specification",
          run.id,
        );
      }
      const route = index.routes.get(run.route);
      const requiredLane = task.execution_envelope.route_requirements
        .execution_lane;
      if (
        route && requiredLane !== "either" &&
        route.execution_lane !== requiredLane
      ) {
        report(
          "run.evidence-binding",
          `${base}/route`,
          "run route contradicts its task's required execution lane",
          run.id,
        );
      }

      const grant = index.grants.get(run.capability_grant);
      const envelopeGrant = index.grants.get(task.envelope.grant);
      if (grant && envelopeGrant) {
        let permitted = grant.id === envelopeGrant.id;
        if (!permitted && envelopeGrant.supersedes === grant.id) {
          const firstTransition = run.transitions[0];
          const firstUse = firstTransition === undefined
            ? undefined
            : index.events.get(firstTransition.event)?.sequence;
          const successorApproval = envelopeGrant.approval_event === undefined
            ? undefined
            : index.events.get(envelopeGrant.approval_event)?.sequence;
          permitted = firstUse !== undefined &&
            successorApproval !== undefined &&
            firstUse < successorApproval;
        }
        if (
          !permitted &&
          supersedesTransitively(grant, envelopeGrant.id, index) &&
          grant.grantor === envelopeGrant.grantor &&
          grant.grantee === envelopeGrant.grantee &&
          !broadens(grant.scope, envelopeGrant.scope)
        ) {
          permitted = true;
        }
        if (!permitted) {
          report(
            "run.evidence-binding",
            `${base}/capability_grant`,
            "run grant is unrelated to or stale against the effective task envelope",
            run.id,
          );
        }

        const spec = index.specs.get(run.agent_spec);
        if (spec && grant.grantee !== spec.participant) {
          report(
            "run.evidence-binding",
            `${base}/capability_grant`,
            "run grant is issued to a principal other than the run agent",
            run.id,
          );
        }
        const scope = grant.scope;
        if (scope.task_scope !== task.id) {
          report(
            "run.evidence-binding",
            `${base}/capability_grant`,
            "run grant is scoped to another task",
            run.id,
          );
        }
        if (scope.room_scope !== task.room) {
          report(
            "run.evidence-binding",
            `${base}/capability_grant`,
            "run grant is scoped to another room",
            run.id,
          );
        }
        if (
          scope.route_scope === undefined ||
          !scope.route_scope.includes(run.route)
        ) {
          report(
            "run.evidence-binding",
            `${base}/capability_grant`,
            "run grant is scoped to another route",
            run.id,
          );
        }
        if (
          route?.provider !== undefined &&
          (scope.provider_scope === undefined ||
            !scope.provider_scope.includes(route.provider))
        ) {
          report(
            "run.evidence-binding",
            `${base}/capability_grant`,
            "run grant is scoped to another provider",
            run.id,
          );
        }
        const workspaceRank = { none: 0, "read-only": 1, "read-write": 2 };
        if (
          workspaceRank[scope.workspace] >
            workspaceRank[task.execution_envelope.workspace] ||
          scope.budget.currency !== task.execution_envelope.budget.currency ||
          scope.budget.limit_minor_units >
            task.execution_envelope.budget.limit_minor_units ||
          scope.tools.some((tool) =>
            !task.execution_envelope.tools.includes(tool)
          )
        ) {
          report(
            "run.evidence-binding",
            `${base}/capability_grant`,
            "run grant exceeds its task's workspace, tool, or budget envelope",
            run.id,
          );
        }
      }

      if (route) {
        const preparedReportId = session?.phases.find((phase) =>
          phase.phase === "prepare"
        )?.capability_report;
        const capabilityReport = preparedReportId === undefined
          ? undefined
          : index.reports.get(preparedReportId);
        const capabilities = new Map(
          capabilityReport?.capabilities.map((capability) => [
            capability.capability,
            capability.classification,
          ]),
        );
        if (capabilityReport !== undefined) {
          for (
            const required of list(
              task.execution_envelope.route_requirements.required_capabilities,
            )
          ) {
            const classification = capabilities.get(required);
            if (
              classification === undefined || classification === "unavailable"
            ) {
              report(
                "run.evidence-binding",
                `${base}/route`,
                "run route lacks a capability required by its task envelope",
                run.id,
              );
              break;
            }
          }
        }
      }
    }
  });
}

/**
 * An event bears authority when it commits a state transition, belongs to an
 * authority-bearing family, or is acknowledged as an accepted fact.
 */
function bearsAuthority(event: WorkbenchEvent): boolean {
  return event.state_transition !== undefined ||
    AUTHORITY_BEARING_FAMILIES.has(event.family) ||
    event.acknowledgement?.acknowledged === true;
}

/**
 * Resolves an `allowed-with-approval` policy basis to the human-authored
 * approval event it relies on. Returns undefined when the basis names no
 * approval, the approval does not resolve, it is not an approval event, or
 * its author is not a human participant — a machine cannot approve its own
 * conditional authority.
 */
function resolvedHumanApproval(
  basis: PolicyBasis,
  index: Index,
): WorkbenchEvent | undefined {
  if (basis.approval_event === undefined) return undefined;
  const approval = index.events.get(basis.approval_event);
  if (!approval || approval.family !== "approval") return undefined;
  const author = index.participants.get(approval.author);
  return author?.participant_class === "human" ? approval : undefined;
}

function approvalMatchesScope(
  approval: WorkbenchEvent,
  task: string | undefined,
  room: string | undefined,
): boolean {
  return (task === undefined || approval.task === task) &&
    (room === undefined || approval.room === room);
}

function earliestGrantReliance(
  corpus: Corpus,
  index: Index,
): Map<string, number> {
  const earliest = new Map<string, number>();
  const record = (grantId: string | undefined, sequence: number): void => {
    if (grantId === undefined) return;
    const prior = earliest.get(grantId);
    if (prior === undefined || sequence < prior) {
      earliest.set(grantId, sequence);
    }
  };
  for (const event of list(corpus.events)) {
    record(event.authorization_basis.grant, event.sequence);
    record(event.summons_exception_grant, event.sequence);
  }
  for (const run of list(corpus.runs)) {
    const first = run.transitions[0]?.event;
    const event = first === undefined ? undefined : index.events.get(first);
    if (event !== undefined) record(run.capability_grant, event.sequence);
  }
  return earliest;
}

function checkAuthority(corpus: Corpus, index: Index, report: Report): void {
  list(corpus.events).forEach((event, i) => {
    const base = `/events/${i}`;
    const commit = event.durable_commit;
    const authorityBearing = bearsAuthority(event);
    if (authorityBearing && event.asynchronous !== true) {
      if (!commit) {
        report(
          "authority.durable-commit",
          `${base}/durable_commit`,
          "authority-bearing event records no durable-commit evidence",
          event.id,
        );
      } else if (
        !commit.atomic || !commit.state_committed || !commit.event_committed
      ) {
        report(
          "authority.durable-commit",
          `${base}/durable_commit`,
          "state and event were not committed atomically before acknowledgement",
          event.id,
        );
      }
    }
    const acknowledgement = event.acknowledgement;
    if (acknowledgement?.acknowledged === true && commit) {
      if (acknowledgement.sequence < commit.commit_sequence) {
        report(
          "authority.durable-commit",
          `${base}/acknowledgement/sequence`,
          "acknowledgement precedes the durable commit it depends on",
          event.id,
        );
      }
    }
    if (event.asynchronous !== true) return;
    if (!REBUILDABLE_FAMILIES.has(event.family)) {
      report(
        "authority.async-source",
        `${base}/asynchronous`,
        "only rebuildable telemetry families may be recorded asynchronously",
        event.id,
      );
    }
    if (event.state_transition || acknowledgement?.acknowledged === true) {
      report(
        "authority.async-source",
        `${base}/asynchronous`,
        "an asynchronous event carries authority-bearing state or acknowledgement",
        event.id,
      );
    }
    const source = event.authoritative_source
      ? index.events.get(event.authoritative_source)
      : undefined;
    if (!source) {
      report(
        "authority.async-source",
        `${base}/authoritative_source`,
        "asynchronous telemetry names no existing authoritative source",
        event.id,
      );
      return;
    }
    if (
      source.sequence >= event.sequence || source.durable_commit === undefined
    ) {
      report(
        "authority.async-source",
        `${base}/authoritative_source`,
        "asynchronous telemetry precedes the durable source it derives from",
        event.id,
      );
    }
  });
}

/**
 * Effective authorization basis, task-envelope authority, and the approval a
 * conditional policy basis relies on.
 *
 * Naming a grant is not authorization. A grant-authorized event has to name a
 * grant that exists and that was issued to the event's own author; a denied
 * policy basis carries no authority at all; and a basis that says
 * `allowed-with-approval` has to point at a real, human-authored approval.
 * The same approval requirement applies to a grant or route once something in
 * the corpus relies on it.
 *
 * The Task envelope is the other half: a Task reaches `task:completed` only
 * under an approved envelope, and a grant-authorized completing transition
 * uses that envelope's grant. Attributable operator-direct authority does not
 * bypass the separately required envelope approval.
 */
function checkAuthorizationBasis(
  corpus: Corpus,
  index: Index,
  report: Report,
): void {
  list(corpus.events).forEach((event, i) => {
    const base = `/events/${i}`;
    const basis = event.authorization_basis;
    if (basis.kind === "grant") {
      const grant = basis.grant === undefined
        ? undefined
        : index.grants.get(basis.grant);
      if (!grant) {
        report(
          "authority.basis",
          `${base}/authorization_basis/grant`,
          "a grant-authorized event names no resolved capability grant",
          event.id,
        );
      } else if (grant.grantee !== event.author) {
        report(
          "authority.basis",
          `${base}/authorization_basis/grant`,
          "a grant-authorized event is not authored by the grant's grantee",
          event.id,
        );
      } else {
        const run = event.run === undefined
          ? undefined
          : index.runs.get(event.run);
        if (
          (event.task !== undefined && grant.scope.task_scope !== undefined &&
            grant.scope.task_scope !== event.task) ||
          (grant.scope.room_scope !== undefined &&
            grant.scope.room_scope !== event.room) ||
          (run !== undefined &&
            grant.scope.route_scope !== undefined &&
            !list(grant.scope.route_scope).includes(run.route))
        ) {
          report(
            "authority.basis",
            `${base}/authorization_basis/grant`,
            "grant-authorized event lies outside the grant's Task, Room, or Route scope",
            event.id,
          );
        }
      }
    }
    if (!bearsAuthority(event)) return;
    if (event.policy_basis.decision === "denied") {
      report(
        "authority.basis",
        `${base}/policy_basis/decision`,
        "an authority-bearing event rests on a denied policy basis",
        event.id,
      );
      return;
    }
    if (
      event.policy_basis.decision === "allowed-with-approval" &&
      (() => {
        const approval = resolvedHumanApproval(event.policy_basis, index);
        return approval === undefined || approval.sequence >= event.sequence ||
          !approvalMatchesScope(approval, event.task, event.room);
      })()
    ) {
      report(
        "authority.basis",
        `${base}/policy_basis/approval_event`,
        "a conditional policy basis names no resolved human-authored approval",
        event.id,
      );
    }
  });

  // A grant or route is relied upon once the corpus points authority at it.
  const reliedGrants = new Set<string>();
  const reliedRoutes = new Set<string>();
  for (const event of list(corpus.events)) {
    if (event.authorization_basis.grant !== undefined) {
      reliedGrants.add(event.authorization_basis.grant);
    }
    if (event.summons_exception_grant !== undefined) {
      reliedGrants.add(event.summons_exception_grant);
    }
  }
  for (const membership of list(corpus.room_memberships)) {
    const grant = membership.speak_rule.loop_prevention.exception_grant;
    if (grant !== undefined) reliedGrants.add(grant);
  }
  for (const task of list(corpus.tasks)) reliedGrants.add(task.envelope.grant);
  for (const run of list(corpus.runs)) {
    reliedGrants.add(run.capability_grant);
    reliedRoutes.add(run.route);
  }
  for (const session of list(corpus.route_sessions)) {
    reliedRoutes.add(session.route);
  }
  for (const receipt of list(corpus.receipts)) {
    const grant = receipt.body.remaining_authority?.grant;
    if (grant !== undefined) reliedGrants.add(grant);
    const route = receipt.body.route?.route;
    if (route !== undefined) reliedRoutes.add(route);
  }

  // Earliest reliance sequence per grant and route, in the global event
  // sequence scale. Route control phase sequence is a per-session local
  // counter and is never comparable to this scale, so route use is read from
  // the run's own first transition event instead.
  const earliestGrantUse = earliestGrantReliance(corpus, index);
  const earliestRouteUse = new Map<
    string,
    { sequence: number; task: string; room: string }
  >();
  for (const run of list(corpus.runs)) {
    const first = run.transitions[0]?.event;
    const event = first === undefined ? undefined : index.events.get(first);
    if (!event) continue;
    const prior = earliestRouteUse.get(run.route);
    if (prior === undefined || event.sequence < prior.sequence) {
      earliestRouteUse.set(run.route, {
        sequence: event.sequence,
        task: run.task,
        room: event.room,
      });
    }
  }

  list(corpus.capability_grants).forEach((grant, i) => {
    if (!reliedGrants.has(grant.id)) return;
    if (grant.policy_basis.decision === "denied") {
      report(
        "authority.basis",
        `/capability_grants/${i}/policy_basis/decision`,
        "authority is drawn from a grant whose policy basis is denied",
        grant.id,
      );
      return;
    }
    if (grant.policy_basis.decision !== "allowed-with-approval") return;
    const approval = resolvedHumanApproval(grant.policy_basis, index);
    if (approval === undefined) {
      report(
        "authority.basis",
        `/capability_grants/${i}/policy_basis/approval_event`,
        "a conditional grant names no resolved human-authored approval",
        grant.id,
      );
      return;
    }
    const earliestUse = earliestGrantUse.get(grant.id);
    if (
      !approvalMatchesScope(
        approval,
        grant.scope.task_scope,
        grant.scope.room_scope,
      )
    ) {
      report(
        "authority.basis",
        `/capability_grants/${i}/policy_basis/approval_event`,
        "a conditional grant's approval does not match the grant's Task or Room scope",
        grant.id,
      );
      return;
    }
    if (earliestUse !== undefined && approval.sequence >= earliestUse) {
      report(
        "authority.basis",
        `/capability_grants/${i}/policy_basis/approval_event`,
        "a conditional grant's approval is recorded no earlier than the grant's first use",
        grant.id,
      );
    }
  });
  list(corpus.routes).forEach((route, i) => {
    if (!reliedRoutes.has(route.id) || route.policy_basis === undefined) return;
    if (route.policy_basis.decision === "denied") {
      report(
        "authority.basis",
        `/routes/${i}/policy_basis/decision`,
        "a route is used although its policy basis is denied",
        route.id,
      );
      return;
    }
    if (route.policy_basis.decision !== "allowed-with-approval") return;
    const approval = resolvedHumanApproval(route.policy_basis, index);
    if (approval === undefined) {
      report(
        "authority.basis",
        `/routes/${i}/policy_basis/approval_event`,
        "a conditional route basis names no resolved human-authored approval",
        route.id,
      );
      return;
    }
    const earliestUse = earliestRouteUse.get(route.id);
    if (
      earliestUse !== undefined &&
      !approvalMatchesScope(approval, earliestUse.task, earliestUse.room)
    ) {
      report(
        "authority.basis",
        `/routes/${i}/policy_basis/approval_event`,
        "a conditional route's approval does not match the relying Task or Room",
        route.id,
      );
      return;
    }
    if (
      earliestUse !== undefined && approval.sequence >= earliestUse.sequence
    ) {
      report(
        "authority.basis",
        `/routes/${i}/policy_basis/approval_event`,
        "a conditional route's approval is recorded no earlier than the route's first use",
        route.id,
      );
    }
  });

  list(corpus.tasks).forEach((task, i) => {
    task.transitions.forEach((transition, j) => {
      if (transition.to !== "task:completed") return;
      const path = `/tasks/${i}/transitions/${j}`;
      if (!task.envelope.approved) {
        report(
          "authority.task-envelope",
          `/tasks/${i}/envelope/approved`,
          "a task reaches completion without an approved task envelope",
          task.id,
        );
        return;
      }
      const event = index.events.get(transition.event);
      if (!event) return; // reference closure already reported this.
      const basis = event.authorization_basis;
      if (basis.kind === "grant" && basis.grant !== task.envelope.grant) {
        report(
          "authority.task-envelope",
          `${path}/event`,
          "a grant-authorized completing transition uses a grant outside the task envelope",
          task.id,
        );
      }
    });
  });
}

function broadens(next: GrantScope, prior: GrantScope): boolean {
  const wider = (values: string[], base: string[]) =>
    values.some((value) => !base.includes(value));
  const workspaceRank = { none: 0, "read-only": 1, "read-write": 2 };
  const networkRank = { none: 0, loopback: 1, "operator-approved-hosts": 2 };
  const impactRank = { none: 0, reversible: 1, irreversible: 2 };
  const nextAuthorization = next.secrecy_integrity_authorization;
  const priorAuthorization = prior.secrecy_integrity_authorization;
  const broadensLabels = priorAuthorization !== undefined &&
    (nextAuthorization === undefined ||
      wider(
        nextAuthorization.authorized_secrecy_tags,
        priorAuthorization.authorized_secrecy_tags,
      ) ||
      INTEGRITY_RANK[nextAuthorization.minimum_integrity_class] <
        INTEGRITY_RANK[priorAuthorization.minimum_integrity_class]);
  return next.budget.currency !== prior.budget.currency ||
    wider(next.tools, prior.tools) ||
    wider(next.resources, prior.resources) ||
    wider(next.approvals, prior.approvals) ||
    wider(next.destination_classes, prior.destination_classes) ||
    wider(list(next.provider_scope), list(prior.provider_scope)) ||
    wider(list(next.route_scope), list(prior.route_scope)) ||
    (prior.task_scope !== undefined && next.task_scope !== prior.task_scope) ||
    (prior.room_scope !== undefined && next.room_scope !== prior.room_scope) ||
    broadensLabels ||
    workspaceRank[next.workspace] > workspaceRank[prior.workspace] ||
    networkRank[next.network] > networkRank[prior.network] ||
    impactRank[next.external_impact] > impactRank[prior.external_impact] ||
    next.budget.limit_minor_units > prior.budget.limit_minor_units;
}

function checkGrantsAndLeases(
  corpus: Corpus,
  index: Index,
  report: Report,
): void {
  list(corpus.capability_grants).forEach((grant, i) => {
    const base = `/capability_grants/${i}`;
    if (grant.delegable !== false) {
      report(
        "grant.no-self-broadening",
        `${base}/delegable`,
        "a grant declares itself delegable",
        grant.id,
      );
    }
    if (grant.grantor === grant.grantee) {
      report(
        "grant.no-self-broadening",
        `${base}/grantee`,
        "a grant names the same principal as grantor and grantee",
        grant.id,
      );
    }
    if (!grant.supersedes) return;
    const prior = index.grants.get(grant.supersedes);
    if (!prior) return;
    // Revising a grant keeps the same two principals. Changing either one is
    // a new authorization lineage, not a revision of this one, and treating
    // it as a successor would let a grant migrate its authority to another
    // party without a fresh issuance.
    if (grant.grantor !== prior.grantor || grant.grantee !== prior.grantee) {
      report(
        "grant.principal-continuity",
        `${base}/supersedes`,
        "a superseding grant changes the grantor or grantee of the grant it revises",
        grant.id,
      );
      return;
    }
    if (!broadens(grant.scope, prior.scope)) return;
    const earliestUse = earliestGrantReliance(corpus, index).get(grant.id);
    if (
      earliestUse !== undefined &&
      grant.policy_basis.decision === "allowed-with-approval"
    ) {
      const policyApproval = resolvedHumanApproval(grant.policy_basis, index);
      if (
        policyApproval === undefined ||
        !approvalMatchesScope(
          policyApproval,
          grant.scope.task_scope,
          grant.scope.room_scope,
        ) || policyApproval.sequence >= earliestUse
      ) return;
    }
    const approval = grant.approval_event === undefined
      ? undefined
      : resolvedHumanApproval({
        policy_id: grant.policy_basis.policy_id,
        decision: "allowed-with-approval",
        approval_event: grant.approval_event,
      }, index);
    const approved = approval !== undefined &&
      approvalMatchesScope(
        approval,
        grant.scope.task_scope,
        grant.scope.room_scope,
      ) &&
      (earliestUse === undefined || approval.sequence < earliestUse);
    if (!approved) {
      report(
        "grant.no-self-broadening",
        `${base}/scope`,
        "a grant revision broadens authority with no attributable operator approval",
        grant.id,
      );
    }
  });

  list(corpus.registration_leases).forEach((lease, i) => {
    const base = `/registration_leases/${i}`;
    for (const effect of lease.effects_on_expiry) {
      if (
        effect === "availability-withdrawn" || effect === "registration-removed"
      ) {
        continue;
      }
      report(
        "lease.availability-only",
        `${base}/effects_on_expiry`,
        "lease expiry claims an effect beyond withdrawing availability",
        lease.id,
      );
      break;
    }
    if (lease.state !== "expired") return;
    if (
      lease.subject.kind !== "tool" && lease.subject.kind !== "skill" &&
      !index.kinds.has(lease.subject.reference)
    ) {
      report(
        "lease.availability-only",
        `${base}/subject/reference`,
        "an expired lease left its subject identity absent from the corpus",
        lease.id,
      );
    }
  });
}

const EGRESS_DESTINATIONS = new Set([
  "approved-external-host",
  "external-uncontrolled",
]);

/**
 * The deterministic private-and-untrusted-and-egress policy: a grant whose
 * scope both allows network reach and names an egress-capable destination
 * class may not be relied on to act on content that is simultaneously
 * private (carries a secrecy tag) and untrusted.
 */
function checkGrantEgress(corpus: Corpus, index: Index, report: Report): void {
  list(corpus.events).forEach((event, i) => {
    if (event.authorization_basis.kind !== "grant") return;
    const grantId = event.authorization_basis.grant;
    const grant = grantId === undefined ? undefined : index.grants.get(grantId);
    if (!grant) return; // reference closure already reported this.
    const egressCapable = grant.scope.network !== "none" &&
      grant.scope.destination_classes.some((cls) =>
        EGRESS_DESTINATIONS.has(cls)
      );
    if (!egressCapable) return;
    const isPrivate = event.labels.secrecy_tags.length > 0;
    const isUntrusted = INTEGRITY_RANK[event.labels.integrity_class] <
      INTEGRITY_RANK.attested;
    if (isPrivate && isUntrusted) {
      report(
        "grant.egress-policy",
        `/events/${i}/authorization_basis/grant`,
        "an egress-capable grant is relied on to act on private, untrusted content",
        event.id,
      );
    }
  });

  list(corpus.runs).forEach((run, i) => {
    const grant = index.grants.get(run.capability_grant);
    const packet = index.packets.get(run.context_packet);
    if (!grant || !packet) return;
    const egressCapable = grant.scope.network !== "none" &&
      grant.scope.destination_classes.some((cls) =>
        EGRESS_DESTINATIONS.has(cls)
      );
    if (!egressCapable) return;
    const labels = packetLabels(packet);
    if (
      labels === undefined || labels.secrecy_tags.length === 0 ||
      INTEGRITY_RANK[labels.integrity_class] >= INTEGRITY_RANK.attested
    ) {
      return;
    }
    const authorization = grant.scope.secrecy_integrity_authorization;
    const authorized = authorization !== undefined &&
      labels.secrecy_tags.every((tag) =>
        authorization.authorized_secrecy_tags.includes(tag)
      ) &&
      INTEGRITY_RANK[labels.integrity_class] >=
        INTEGRITY_RANK[authorization.minimum_integrity_class];
    if (!authorized) {
      report(
        "grant.egress-policy",
        `/runs/${i}/capability_grant`,
        "an egress-capable run consumes private, untrusted packet content without specific authorization",
        run.id,
      );
    }
  });
}

/**
 * Sole-writer authority: within a declared event family, the first writer_id
 * observed (in event-sequence order) is the inline authority record for that
 * family's cutover sequence and writer. A
 * later event in the same family must name that same writer. A competing or
 * omitted post-cutover writer is rejected; events before the first declared
 * writer remain pre-cutover history.
 */
function checkSoleWriter(corpus: Corpus, report: Report): void {
  const ordered = [...list(corpus.events)].sort((a, b) =>
    a.sequence - b.sequence
  );
  const cutover = new Map<string, { writer: string; eventId: string }>();
  ordered.forEach((event) => {
    const existing = cutover.get(event.family);
    if (event.writer_id === undefined) {
      if (existing !== undefined) {
        const path = `/events/${list(corpus.events).indexOf(event)}/writer_id`;
        report(
          "authority.sole-writer",
          path,
          "an authoritative family event omits its writer after cutover",
          event.id,
        );
      }
      return;
    }
    if (existing === undefined) {
      cutover.set(event.family, { writer: event.writer_id, eventId: event.id });
      return;
    }
    if (existing.writer !== event.writer_id) {
      const path = `/events/${list(corpus.events).indexOf(event)}/writer_id`;
      report(
        "authority.sole-writer",
        path,
        "a competing writer commits into a family after another writer's cutover",
        event.id,
      );
    }
  });
}

const RECEIPT_BODY_REQUIREMENTS: Record<string, (keyof ReceiptBody)[]> = {
  turn: [
    "projection",
    "projected_payload_digest",
    "terminal_reason",
  ],
  run: [
    "task_revision",
    "run_revision",
    "route",
    "context_packet",
    "capability_posture",
    "route_evidence",
    "process_provenance",
    "tools_and_effects",
    "artifacts",
    "cost",
    "verification",
    "preserved_state",
  ],
  interrupt: ["outcome", "preserved_state", "remaining_authority"],
  completion: [
    "artifacts",
    "changes",
    "verification",
    "unresolved_risks",
    "cost",
    "facts",
  ],
};

const RUN_PARTICIPATING_TURN_FIELDS: readonly (keyof ReceiptBody)[] = [
  "route",
  "context_packet",
  "capability_posture",
  "usage",
  "cost",
];

const FACT_CLAIM_SOURCES: Record<string, ClaimSource> = {
  agent_reported_completion: "runner-reported",
  workbench_observed_effects: "workbench-observed",
  independent_verification: "independently-verified",
  operator_acceptance: "operator-accepted",
  closure: "operator-accepted",
};

function receiptEvidenceItems(receipt: Receipt): EvidenceItem[] {
  return [
    ...receipt.evidence,
    ...list(receipt.body.route_evidence),
    ...list(receipt.body.verification?.evidence),
    ...Object.values(receipt.body.facts ?? {}).flatMap((fact) => fact.evidence),
  ];
}

function receiptParticipation(
  receipt: Receipt,
  commit: WorkbenchEvent,
  index: Index,
): { participates: boolean; runIds: Set<string>; taskIds: Set<string> } {
  const runIds = new Set<string>();
  const taskIds = new Set<string>();
  if (receipt.run !== undefined) runIds.add(receipt.run);
  if (commit.run !== undefined) runIds.add(commit.run);
  if (receipt.task !== undefined) taskIds.add(receipt.task);
  if (commit.task !== undefined) taskIds.add(commit.task);
  for (const item of receiptEvidenceItems(receipt)) {
    if (item.run !== undefined) runIds.add(item.run);
    const evidence = item.event === undefined
      ? undefined
      : index.events.get(item.event);
    if (evidence?.run !== undefined) runIds.add(evidence.run);
    if (evidence?.task !== undefined) taskIds.add(evidence.task);
  }
  const packetReference = receipt.body.context_packet?.reference;
  const packet = packetReference === undefined
    ? undefined
    : index.packets.get(packetReference);
  if (packet?.run !== undefined) runIds.add(packet.run);
  if (packet?.task !== undefined) taskIds.add(packet.task);
  const bodySignals = receipt.family === "turn" &&
    RUN_PARTICIPATING_TURN_FIELDS.some((field) =>
      receipt.body[field] !== undefined
    );
  return { participates: bodySignals || runIds.size > 0, runIds, taskIds };
}

function checkReceipts(corpus: Corpus, index: Index, report: Report): void {
  list(corpus.receipts).forEach((receipt, i) => {
    const base = `/receipts/${i}`;
    const attributionAuthor = index.participants.get(
      receipt.attribution.author,
    );
    if (
      (receipt.attribution.claim_source === "operator-accepted" &&
        attributionAuthor?.participant_class !== "human") ||
      (receipt.attribution.claim_source === "runner-reported" &&
        attributionAuthor?.participant_class !== "digital")
    ) {
      report(
        "claim-source.separation",
        `${base}/attribution/claim_source`,
        "receipt attribution claim source disagrees with its author class",
        receipt.id,
      );
    }
    for (const field of RECEIPT_BODY_REQUIREMENTS[receipt.family] ?? []) {
      if (receipt.body[field] === undefined) {
        report(
          "receipt.family-requirements",
          `${base}/body/${field}`,
          "receipt family is missing evidence its family requires",
          receipt.id,
        );
      }
    }
    if (receipt.family === "turn" && receipt.run !== undefined) {
      for (const field of RUN_PARTICIPATING_TURN_FIELDS) {
        if (receipt.body[field] === undefined) {
          report(
            "receipt.family-requirements",
            `${base}/body/${field}`,
            "run-participating turn is missing executable evidence",
            receipt.id,
          );
        }
      }
    }
    if (
      (receipt.family === "run" || receipt.family === "interrupt") &&
      !receipt.run
    ) {
      report(
        "receipt.family-requirements",
        `${base}/run`,
        "receipt family requires the run it reports on",
        receipt.id,
      );
    }
    if (
      (receipt.family === "run" || receipt.family === "interrupt" ||
        receipt.family === "completion") && !receipt.task
    ) {
      report(
        "receipt.family-requirements",
        `${base}/task`,
        "receipt family requires the task it reports on",
        receipt.id,
      );
    }
    const provenance = receipt.body.process_provenance
      ? index.events.get(receipt.body.process_provenance)
      : undefined;
    if (provenance && provenance.family !== "process-provenance") {
      report(
        "receipt.family-requirements",
        `${base}/body/process_provenance`,
        "run receipt process provenance does not reference a process-provenance event",
        receipt.id,
      );
    }
    // current_state is required for run, interrupt, and completion receipts.
    // A turn receipt carries it only when a Run participates; otherwise it
    // must not invent Run lifecycle state for a conversational exchange.
    if (receipt.family === "turn") {
      if (receipt.run !== undefined && receipt.current_state === undefined) {
        report(
          "receipt.family-requirements",
          `${base}/current_state`,
          "a turn receipt with a run must reconcile that run's lifecycle state",
          receipt.id,
        );
      } else if (
        receipt.run === undefined && receipt.current_state !== undefined
      ) {
        report(
          "receipt.family-requirements",
          `${base}/current_state`,
          "a turn receipt without a run must not invent lifecycle state",
          receipt.id,
        );
      }
    } else if (receipt.current_state === undefined) {
      report(
        "receipt.family-requirements",
        `${base}/current_state`,
        "receipt family requires lifecycle current_state",
        receipt.id,
      );
    }
    if (
      receipt.current_state !== undefined &&
      stateKind(receipt.current_state.state) !==
        receipt.current_state.entity_kind
    ) {
      report(
        "lifecycle.state-type",
        `${base}/current_state/state`,
        "receipt state belongs to the other lifecycle type",
        receipt.id,
      );
    }
    const producerIds = new Set<string>();
    const receiptRun = receipt.run === undefined
      ? undefined
      : index.runs.get(receipt.run);
    const runProducer = receiptRun === undefined
      ? undefined
      : index.specs.get(receiptRun.agent_spec)?.participant;
    if (runProducer !== undefined) producerIds.add(runProducer);
    for (const artifactId of list(receipt.body.artifacts)) {
      const artifact = index.artifacts.get(artifactId);
      const producer = artifact?.authoritative_ref.kind === "internal" &&
          artifact.authoritative_ref.reference !== undefined
        ? index.events.get(artifact.authoritative_ref.reference)?.author
        : undefined;
      if (producer !== undefined) producerIds.add(producer);
    }
    const citesIndependentVerification = (fact: Fact): boolean =>
      fact.evidence.some((item) => {
        const event = item.event === undefined
          ? undefined
          : index.events.get(item.event);
        return event?.family === "verification" &&
          event.claim_source === "independently-verified" &&
          !producerIds.has(event.author);
      });
    const verification = receipt.body.verification;
    if (
      verification &&
      verification.state === "satisfied" &&
      (verification.claim_source !== "independently-verified" ||
        !citesIndependentVerification(verification))
    ) {
      report(
        "claim-source.separation",
        `${base}/body/verification`,
        "satisfied verification is claimed without independent verification evidence",
        receipt.id,
      );
    }
    const facts = receipt.body.facts;
    if (!facts) return;
    for (const [name, expected] of Object.entries(FACT_CLAIM_SOURCES)) {
      const fact = facts[name as keyof typeof facts];
      if (fact.state === "absent") continue;
      if (fact.claim_source !== expected) {
        report(
          "claim-source.separation",
          `${base}/body/facts/${name}/claim_source`,
          "a completion fact is claimed from the wrong claim source",
          receipt.id,
        );
      }
    }
    if (
      facts.independent_verification.state === "satisfied" &&
      !citesIndependentVerification(facts.independent_verification)
    ) {
      report(
        "claim-source.separation",
        `${base}/body/facts/independent_verification/evidence`,
        "independent verification is asserted without its own evidence",
        receipt.id,
      );
    }
    const directClose = receipt.task === undefined
      ? undefined
      : list(corpus.events).find((event) =>
        event.state_transition?.entity_kind === "task" &&
        event.state_transition.entity === receipt.task &&
        event.state_transition.from === "task:completed" &&
        event.state_transition.to === "task:closed"
      );
    const directCloseDecision = directClose?.state_transition
        ?.operator_decision === undefined
      ? undefined
      : index.events.get(directClose.state_transition.operator_decision);
    const completedSequence = receipt.task === undefined
      ? 0
      : index.tasks.get(receipt.task)?.transitions.reduce((latest, step) =>
        step.to === "task:completed"
          ? Math.max(latest, index.events.get(step.event)?.sequence ?? 0)
          : latest, 0) ?? 0;
    const directCloseIsResolved = receipt.task !== undefined &&
      directClose !== undefined &&
      isBoundTaskOperatorDecision(
        directCloseDecision,
        receipt.task,
        directClose,
        completedSequence,
        index,
      );
    if (
      facts.closure.state === "closed" &&
      facts.operator_acceptance.state !== "accepted" &&
      !directCloseIsResolved
    ) {
      report(
        "claim-source.separation",
        `${base}/body/facts/closure`,
        "closure is recorded without a separate accepted operator-acceptance fact",
        receipt.id,
      );
    }
  });
}

/**
 * Reconstructs an entity's state and revision as of one event sequence, from
 * its recorded transition history. A receipt describes the moment it was
 * committed, so comparing it to final corpus state would be wrong: the
 * baseline turn receipt truthfully records a running Run that a later event
 * interrupts.
 */
function stateAtSequence(
  kind: "task" | "run",
  transitions: Transition[],
  sequence: number,
  index: Index,
): { state: string; revision: number } {
  let state = kind === "task" ? "task:proposed" : "run:pending";
  let revision = 1;
  for (const transition of transitions) {
    const event = index.events.get(transition.event);
    if (!event || event.sequence > sequence) break;
    state = transition.to;
    revision = transition.revision;
  }
  return { state, revision };
}

/** The transition event a fact must point at, by receipt fact name. */
const ACCEPTANCE_FACT_STATES: Record<string, { fact: string; to: string }> = {
  operator_acceptance: { fact: "accepted", to: "task:accepted" },
  closure: { fact: "closed", to: "task:closed" },
};

/**
 * Receipt subject reconciliation.
 *
 * A receipt is a claim about named entities at a named moment, so every field
 * that names one is checked against it: the commit event must be a durable
 * receipt-family event; Task and Run must belong together; the family's
 * subject must be the entity the receipt reports; state, revision, and the
 * Task/Run revisions in the body must match the history reconstructed at the
 * commit event's sequence; route, packet, projection, and capability posture
 * must match the entities they name; and a completion receipt's acceptance
 * and closure facts must point at the receipt Task's own operator-accepted
 * transition events.
 */
function checkReceiptReconciliation(
  corpus: Corpus,
  index: Index,
  report: Report,
): void {
  list(corpus.receipts).forEach((receipt, i) => {
    const base = `/receipts/${i}`;
    const commit = index.events.get(receipt.commit_event);
    if (!commit) return; // reference closure already reported this.
    if (commit.family !== "receipt" || commit.durable_commit === undefined) {
      report(
        "receipt.subject-reconciliation",
        `${base}/commit_event`,
        "receipt commit event is not a durable receipt-family event",
        receipt.id,
      );
      return;
    }
    const at = commit.sequence;
    const task = receipt.task === undefined
      ? undefined
      : index.tasks.get(receipt.task);
    const run = receipt.run === undefined
      ? undefined
      : index.runs.get(receipt.run);
    const participation = receiptParticipation(receipt, commit, index);
    if (
      participation.participates &&
      (receipt.run === undefined || receipt.task === undefined)
    ) {
      report(
        "receipt.subject-reconciliation",
        `${base}/run`,
        "receipt omits its Task or Run although its evidence shows Run participation",
        receipt.id,
      );
    }
    if (
      receipt.run !== undefined &&
      [...participation.runIds].some((runId) => runId !== receipt.run)
    ) {
      report(
        "receipt.subject-reconciliation",
        `${base}/run`,
        "receipt evidence names a different participating Run",
        receipt.id,
      );
    }
    if (
      receipt.task !== undefined &&
      [...participation.taskIds].some((taskId) => taskId !== receipt.task)
    ) {
      report(
        "receipt.subject-reconciliation",
        `${base}/task`,
        "receipt evidence names a different participating Task",
        receipt.id,
      );
    }
    if (task && run && run.task !== task.id) {
      report(
        "receipt.subject-reconciliation",
        `${base}/run`,
        "receipt names a run belonging to another task",
        receipt.id,
      );
    }
    if (commit.run !== receipt.run) {
      report(
        "receipt.subject-reconciliation",
        `${base}/commit_event`,
        "receipt and its commit event disagree on run participation or identity",
        receipt.id,
      );
    }
    if (commit.task !== receipt.task) {
      report(
        "receipt.subject-reconciliation",
        `${base}/commit_event`,
        "receipt and its commit event disagree on task participation or identity",
        receipt.id,
      );
    }
    if (
      receipt.room !== commit.room ||
      (task !== undefined && receipt.room !== task.room) ||
      (run !== undefined &&
        index.tasks.get(run.task)?.room !== receipt.room)
    ) {
      report(
        "receipt.subject-reconciliation",
        `${base}/room`,
        "receipt Room disagrees with its commit event, Task, or Run",
        receipt.id,
      );
    }

    const currentState = receipt.current_state;
    if (currentState !== undefined) {
      const expectedKind = receipt.family === "completion" ? "task" : "run";
      const subject = expectedKind === "task" ? receipt.task : receipt.run;
      if (
        currentState.entity_kind !== expectedKind ||
        (subject !== undefined && currentState.entity !== subject)
      ) {
        report(
          "receipt.subject-reconciliation",
          `${base}/current_state/entity`,
          "receipt current state does not describe the subject its family reports",
          receipt.id,
        );
      } else {
        const entity = expectedKind === "task"
          ? index.tasks.get(currentState.entity)
          : index.runs.get(currentState.entity);
        if (entity) {
          const observed = stateAtSequence(
            expectedKind,
            entity.transitions,
            at,
            index,
          );
          if (
            observed.state !== currentState.state ||
            observed.revision !== currentState.revision
          ) {
            report(
              "receipt.subject-reconciliation",
              `${base}/current_state`,
              "receipt state or revision disagrees with the history at its commit event",
              receipt.id,
            );
          }
        }
      }
    }

    const body = receipt.body;
    if (run !== undefined && task !== undefined) {
      const grant = index.grants.get(run.capability_grant);
      if (
        body.cost !== undefined &&
        (body.cost.currency !== task.execution_envelope.budget.currency ||
          body.cost.amount_minor_units >
            task.execution_envelope.budget.limit_minor_units)
      ) {
        report(
          "receipt.subject-reconciliation",
          `${base}/body/cost`,
          "receipt cost exceeds the Task execution budget",
          receipt.id,
        );
      }
      for (const [j, effect] of list(body.tools_and_effects).entries()) {
        if (grant !== undefined && !grant.scope.tools.includes(effect.tool)) {
          report(
            "receipt.subject-reconciliation",
            `${base}/body/tools_and_effects/${j}/tool`,
            "receipt claims a tool outside the Run's effective grant",
            receipt.id,
          );
        }
        if (
          grant !== undefined && effect.effect === "external" &&
          grant.scope.external_impact === "none"
        ) {
          report(
            "receipt.subject-reconciliation",
            `${base}/body/tools_and_effects/${j}/effect`,
            "receipt claims external impact outside the Run's effective grant",
            receipt.id,
          );
        }
      }
    }
    if (body.task_revision !== undefined && task) {
      const observed = stateAtSequence("task", task.transitions, at, index);
      if (observed.revision !== body.task_revision) {
        report(
          "receipt.subject-reconciliation",
          `${base}/body/task_revision`,
          "receipt task revision disagrees with the history at its commit event",
          receipt.id,
        );
      }
    }
    if (body.run_revision !== undefined && run) {
      const observed = stateAtSequence("run", run.transitions, at, index);
      if (observed.revision !== body.run_revision) {
        report(
          "receipt.subject-reconciliation",
          `${base}/body/run_revision`,
          "receipt run revision disagrees with the history at its commit event",
          receipt.id,
        );
      }
    }
    if (body.route && run && body.route.route !== run.route) {
      report(
        "receipt.subject-reconciliation",
        `${base}/body/route/route`,
        "receipt names a route the run it reports did not use",
        receipt.id,
      );
    }

    if (receipt.family === "interrupt" && body.outcome === "stopped" && run) {
      const observed = stateAtSequence("run", run.transitions, at, index);
      const session = index.sessions.get(run.route_session);
      const halted = session?.phases.some((phase) =>
        phase.phase === "control" && phase.outcome === "halted"
      ) === true;
      if (observed.state !== "run:interrupted" || !halted) {
        report(
          "receipt.subject-reconciliation",
          `${base}/body/outcome`,
          "interrupt receipt claims stopped without an interrupted Run and halted control phase",
          receipt.id,
        );
      }
    }

    if (receipt.family === "completion") {
      for (const artifactId of list(body.artifacts)) {
        const artifact = index.artifacts.get(artifactId);
        if (artifact !== undefined && artifact.snapshot === undefined) {
          report(
            "provenance.preservation",
            `${base}/body/artifacts`,
            "completion receipt relies on an artifact without immutable version evidence",
            receipt.id,
          );
        }
      }
    }

    const packetClaim = body.context_packet;
    const packet = packetClaim === undefined
      ? undefined
      : index.packets.get(packetClaim.reference);
    if (packetClaim && packet) {
      const mismatchedSubject =
        (receipt.task !== undefined && packet.task !== undefined &&
          packet.task !== receipt.task) ||
        (receipt.run !== undefined && packet.run !== undefined &&
          packet.run !== receipt.run);
      if (mismatchedSubject) {
        report(
          "receipt.subject-reconciliation",
          `${base}/body/context_packet/reference`,
          "receipt names a context packet assembled for another task or run",
          receipt.id,
        );
      }
      if (
        packet.revision !== packetClaim.revision ||
        packet.digest !== packetClaim.digest
      ) {
        report(
          "receipt.subject-reconciliation",
          `${base}/body/context_packet`,
          "receipt context packet revision or digest disagrees with the packet",
          receipt.id,
        );
      }
    }

    const projectionClaim = body.projection;
    const projection = projectionClaim === undefined
      ? undefined
      : index.projections.get(projectionClaim.reference);
    if (projectionClaim && projection) {
      if (projection.revision !== projectionClaim.revision) {
        report(
          "receipt.subject-reconciliation",
          `${base}/body/projection/revision`,
          "receipt projection revision disagrees with the projection",
          receipt.id,
        );
      }
      if (
        body.projected_payload_digest !== undefined &&
        body.projected_payload_digest !== projection.output_digest
      ) {
        report(
          "receipt.subject-reconciliation",
          `${base}/body/projected_payload_digest`,
          "receipt projected payload digest disagrees with the projection output",
          receipt.id,
        );
      }
    }

    const posture = body.capability_posture;
    const postureReport = posture === undefined
      ? undefined
      : index.reports.get(posture.report);
    if (posture && postureReport) {
      if (postureReport.revision !== posture.report_revision) {
        report(
          "receipt.subject-reconciliation",
          `${base}/body/capability_posture/report_revision`,
          "receipt capability posture names another revision of its report",
          receipt.id,
        );
      }
      const routeId = body.route?.route ?? run?.route;
      if (routeId !== undefined && postureReport.route !== routeId) {
        report(
          "receipt.subject-reconciliation",
          `${base}/body/capability_posture/report`,
          "receipt capability posture reads a report for another route",
          receipt.id,
        );
      }
      const unavailable = postureReport.capabilities.some((capability) =>
        capability.required && capability.classification === "unavailable"
      );
      if (unavailable !== posture.unavailable_required) {
        report(
          "receipt.subject-reconciliation",
          `${base}/body/capability_posture/unavailable_required`,
          "receipt capability posture disagrees with the report it names",
          receipt.id,
        );
      }
    }

    // No evidence a receipt names may postdate the commit it was reconciled
    // at: approval, route, and completion evidence must all have landed no
    // later than the moment this receipt was itself committed durably.
    const futureEvidence = (items: EvidenceItem[] | undefined): boolean =>
      list(items).some((item) => {
        if (item.event === undefined) return false;
        const evidenceEvent = index.events.get(item.event);
        return evidenceEvent !== undefined && evidenceEvent.sequence > at;
      });
    const evidenceGroups: [string, EvidenceItem[] | undefined][] = [
      ["evidence", receipt.evidence],
      ["body/route_evidence", body.route_evidence],
      ["body/verification/evidence", body.verification?.evidence],
    ];
    if (body.process_provenance !== undefined) {
      evidenceGroups.push([
        "body/process_provenance",
        [{ kind: "process-provenance", event: body.process_provenance }],
      ]);
    }
    for (const [name, fact] of Object.entries(body.facts ?? {})) {
      evidenceGroups.push([`body/facts/${name}/evidence`, fact.evidence]);
    }
    for (const [name, items] of evidenceGroups) {
      if (futureEvidence(items)) {
        report(
          "receipt.subject-reconciliation",
          `${base}/${name}`,
          "receipt evidence postdates the receipt's own commit sequence",
          receipt.id,
        );
      }
    }

    const facts = body.facts;
    if (!facts || receipt.family !== "completion") return;
    for (const [name, expected] of Object.entries(ACCEPTANCE_FACT_STATES)) {
      const fact = facts[name as keyof typeof facts];
      if (fact.state !== expected.fact) continue;
      const supported = fact.evidence.some((item) => {
        const evidence = item.event === undefined
          ? undefined
          : index.events.get(item.event);
        const transition = evidence?.state_transition;
        return evidence !== undefined && transition !== undefined &&
          transition.entity_kind === "task" &&
          transition.entity === receipt.task &&
          transition.to === expected.to &&
          evidence.sequence <= at &&
          index.participants.get(evidence.author)?.participant_class ===
            "human" &&
          evidence.claim_source === "operator-accepted";
      });
      if (!supported) {
        report(
          "receipt.subject-reconciliation",
          `${base}/body/facts/${name}/evidence`,
          "a completion fact names no operator-accepted transition event of its own task",
          receipt.id,
        );
      }
    }
  });
}

/**
 * Inline-secret and secrecy-tag containment for one payload.
 *
 * There is no allowlist of "secret-looking" tag names here: a fixed list is a
 * bypass, because any tag the list has not heard of would carry its bytes
 * inline. Any secrecy tag at all — on the field or on the envelope around it
 * — forbids inline bytes, and inline content stays legal only where field and
 * envelope are both untagged. A field also cannot be more secret than the
 * envelope carrying it, since the envelope's tags are what a consumer reads
 * to decide disclosure.
 *
 * Which companion form each representation may carry is a shape question and
 * belongs to the payload-field schema, not here.
 */
function checkPayload(
  payload: Payload | undefined,
  path: string,
  entity: string,
  envelopeTags: string[],
  report: Report,
): void {
  const envelope = new Set(envelopeTags);
  list(payload?.fields).forEach((field, i) => {
    const fieldPath = `${path}/fields/${i}`;
    if (field.secrecy_tags.some((tag) => !envelope.has(tag))) {
      report(
        "secrecy.inline-secret",
        `${fieldPath}/secrecy_tags`,
        "a field carries a secrecy tag its enclosing envelope does not carry",
        entity,
      );
    }
    const tagged = field.secrecy_tags.length > 0 || envelope.size > 0;
    if (!tagged) return;
    if (field.representation === "inline-value") {
      report(
        "secrecy.inline-secret",
        `${fieldPath}/representation`,
        "a secrecy-tagged field is represented as an inline value",
        entity,
      );
    }
    if (field.inline_value !== undefined) {
      report(
        "secrecy.inline-secret",
        `${fieldPath}/inline_value`,
        "a secrecy-tagged field carries inline payload bytes",
        entity,
      );
    }
  });
}

function checkSecrecy(corpus: Corpus, report: Report): void {
  list(corpus.events).forEach((event, i) => {
    checkPayload(
      event.payload,
      `/events/${i}/payload`,
      event.id,
      event.labels.secrecy_tags,
      report,
    );
  });
  list(corpus.receipts).forEach((receipt, i) => {
    checkPayload(
      receipt.payload,
      `/receipts/${i}/payload`,
      receipt.id,
      receipt.labels.secrecy_tags,
      report,
    );
  });
}

function checkDeferrals(corpus: Corpus, report: Report): void {
  const deferred = new Set<string>();
  list(corpus.deferrals).forEach((deferral, i) => {
    const base = `/deferrals/${i}`;
    deferred.add(deferral.capability);
    if (deferral.reserved_identifier) {
      deferred.add(deferral.reserved_identifier);
    }
    for (
      const [field, value] of [
        ["required", deferral.required],
        ["implemented", deferral.implemented],
        ["authoritative", deferral.authoritative],
        ["routable", deferral.routable],
      ] as const
    ) {
      if (value) {
        report(
          "deferral.not-required",
          `${base}/${field}`,
          "a deferred capability is marked required, implemented, routable, or authoritative",
          deferral.id,
        );
      }
    }
  });

  const claimed = (name: string, path: string, entity: string): void => {
    if (!deferred.has(name)) return;
    report(
      "deferral.not-required",
      path,
      "a deferred capability is offered as an available first-product capability",
      entity,
    );
  };
  list(corpus.agent_specs).forEach((spec, i) => {
    spec.tools.forEach((tool, j) =>
      claimed(tool, `/agent_specs/${i}/tools/${j}`, spec.id)
    );
  });
  list(corpus.capability_grants).forEach((grant, i) => {
    grant.scope.tools.forEach((tool, j) =>
      claimed(tool, `/capability_grants/${i}/scope/tools/${j}`, grant.id)
    );
    grant.scope.resources.forEach((resource, j) =>
      claimed(
        resource,
        `/capability_grants/${i}/scope/resources/${j}`,
        grant.id,
      )
    );
  });
  list(corpus.route_capability_reports).forEach((entry, i) => {
    entry.capabilities.forEach((capability, j) => {
      if (!capability.required) return;
      claimed(
        capability.capability,
        `/route_capability_reports/${i}/capabilities/${j}`,
        entry.id,
      );
    });
  });

  if (corpus.profile !== "first-product-solo-operator") return;
  for (const capability of REQUIRED_DEFERRALS) {
    if (!deferred.has(capability)) {
      report(
        "deferral.inventory",
        "/deferrals",
        "the first-product profile does not record a required deferral",
      );
    }
  }
}
