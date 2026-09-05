/**
 * Focused contract tests for the Workbench first-product contract package.
 *
 * The fixture corpus is the executable statement of the contract: positive
 * fixtures must be accepted, and every negative fixture must be rejected for
 * exactly the stable rule id it names. A negative fixture that is accepted,
 * or that is rejected for some other rule, fails the suite — otherwise a
 * fixture could appear to prove a rule it never exercised.
 *
 * These tests prove the package only. They do not prove runtime conformance,
 * operator acceptance, or any behaviour of the implemented Workbench.
 */

import {
  type Corpus,
  CORPUS_SCHEMA_ID,
  type Diagnostic,
  formatDiagnostic,
  loadFixtures,
  loadSchemaRegistry,
  PACKAGE_VERSION,
  REQUIRED_DEFERRALS,
  RULE_IDS,
  SCHEMA_FILES,
  validateCorpus,
} from "./validate.ts";
import { auditSchemaDocument, SchemaRegistry } from "./json-schema.ts";

function assertEquals<T>(actual: T, expected: T, context: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${context}: expected ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function render(diagnostics: Diagnostic[]): string {
  return diagnostics.map(formatDiagnostic).join("; ");
}

interface FixtureExpectation {
  outcome: "accept" | "reject";
  rule?: string;
}

interface FixtureDocument {
  schema?: unknown;
  package_version?: unknown;
  profile?: unknown;
  proves?: string[];
  expectation?: FixtureExpectation;
}

// The positive acceptance matrix, as predicates rather than as claims.
//
// A fixture's `proves` list is display metadata: it says what the fixture is
// *for*, and a fixture can keep saying it after the witness that made it true
// is gone. So the matrix is decided here, by inspecting the corpus for the
// facts each item requires. Each predicate returns undefined when the corpus
// carries the witness, or the reason it does not.
//
// These predicates read the fixture. They say nothing about a running
// Workbench.
type Predicate = (corpus: Corpus) => string | undefined;

const IDENTIFIER = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

function collections(
  corpus: Corpus,
): [string, { id: string; identity_basis?: string }[]][] {
  return [
    ["rooms", corpus.rooms ?? []],
    ["participants", corpus.participants ?? []],
    ["room_memberships", corpus.room_memberships ?? []],
    ["threads", corpus.threads ?? []],
    ["agent_specs", corpus.agent_specs ?? []],
    ["tasks", corpus.tasks ?? []],
    ["runs", corpus.runs ?? []],
    ["routes", corpus.routes ?? []],
    ["route_capability_reports", corpus.route_capability_reports ?? []],
    ["route_sessions", corpus.route_sessions ?? []],
    ["context_packets", corpus.context_packets ?? []],
    ["capability_grants", corpus.capability_grants ?? []],
    ["registration_leases", corpus.registration_leases ?? []],
    ["artifacts", corpus.artifacts ?? []],
    ["events", corpus.events ?? []],
    ["projections", corpus.projections ?? []],
    ["receipts", corpus.receipts ?? []],
    ["deferrals", corpus.deferrals ?? []],
  ];
}

const P1: Predicate = (corpus) => {
  const ids = new Set<string>();
  for (const [name, entries] of collections(corpus)) {
    if (entries.length === 0) return `${name} carries no entity`;
    for (const entry of entries) {
      if (!IDENTIFIER.test(entry.id)) return `${name} holds a malformed id`;
      if (ids.has(entry.id)) return `${name} reuses an identifier`;
      ids.add(entry.id);
      if (
        entry.identity_basis !== undefined &&
        entry.identity_basis !== "assigned-opaque"
      ) {
        return `${name} derives identity from an ephemeral detail`;
      }
    }
  }
  const resolves = (id: string | undefined) =>
    id === undefined || ids.has(id) ? undefined : id;
  for (const task of corpus.tasks ?? []) {
    if (resolves(task.thread) || resolves(task.envelope.grant)) {
      return "a task names an unresolved thread or envelope grant";
    }
  }
  for (const run of corpus.runs ?? []) {
    if (resolves(run.task) || resolves(run.route) || resolves(run.agent_spec)) {
      return "a run names an unresolved task, route, or agent specification";
    }
  }
  for (const event of corpus.events ?? []) {
    if (resolves(event.state_transition?.entity) || resolves(event.author)) {
      return "an event names an unresolved subject or author";
    }
  }
  for (const receipt of corpus.receipts ?? []) {
    if (resolves(receipt.commit_event)) {
      return "a receipt names an unresolved commit event";
    }
  }
  return undefined;
};

const P2: Predicate = (corpus) => {
  for (const task of corpus.tasks ?? []) {
    const runs = (corpus.runs ?? []).filter((run) => run.task === task.id);
    if (runs.length < 2) continue;
    const attempts = new Set(runs.map((run) => run.attempt));
    if (attempts.size !== runs.length) continue;
    if (new Set(runs.map((run) => run.id)).size !== runs.length) continue;
    if (!runs.every((run) => run.transitions.length > 0)) continue;
    if (!runs.every((run) => run.state.startsWith("run:"))) continue;
    if (!task.state.startsWith("task:")) continue;
    // The attempts must have their own histories, not one shared history.
    const histories = new Set(
      runs.map((run) => run.transitions.map((step) => step.event).join(">")),
    );
    if (histories.size !== runs.length) continue;
    return undefined;
  }
  return "no task retains two distinct run attempts with their own histories";
};

const P3: Predicate = (corpus) => {
  const rooms = (corpus.rooms ?? []).filter(
    (room) => room.profile === "first-product-solo-operator",
  );
  if (rooms.length !== 1) return "the corpus is not one solo operator room";
  const room = rooms[0]!;
  if (room.persistence !== "persistent") {
    return "the operator room is not persistent";
  }
  const memberships = (corpus.room_memberships ?? []).filter(
    (membership) => membership.room === room.id,
  );
  const classOf = (id: string) =>
    (corpus.participants ?? []).find((participant) => participant.id === id)
      ?.participant_class;
  const humans = memberships.filter((m) => classOf(m.participant) === "human");
  const agents = memberships.filter((m) =>
    classOf(m.participant) === "digital"
  );
  if (humans.length !== 1 || agents.length !== 1) {
    return "the room is not one operator and one primary agent";
  }
  const operator = humans[0]!;
  if (!operator.present || !operator.may_author || !operator.may_speak) {
    return "the operator cannot be present, author, and speak";
  }
  const agent = agents[0]!;
  if (!agent.present || agent.speak_rule.policy !== "always-on") {
    return "the primary agent does not default to always-on";
  }
  for (const membership of corpus.room_memberships ?? []) {
    if (membership.speak_rule.loop_prevention.automated_summons !== "blocked") {
      return "a membership leaves automated summons unblocked";
    }
  }
  if ((corpus.events ?? []).some((event) => event.triggers_automated_summons)) {
    return "an event triggers an automated summons";
  }
  return undefined;
};

const P4: Predicate = (corpus) => {
  for (const task of corpus.tasks ?? []) {
    for (const step of task.transitions) {
      const event = (corpus.events ?? []).find((e) => e.id === step.event);
      const recorded = event?.state_transition;
      const commit = event?.durable_commit;
      if (!event || !recorded || !commit) continue;
      const agrees = recorded.entity === task.id &&
        recorded.entity_kind === "task" && recorded.from === step.from &&
        recorded.to === step.to && recorded.entity_revision === step.revision;
      if (!agrees) continue;
      if (
        !commit.atomic || !commit.state_committed || !commit.event_committed
      ) {
        continue;
      }
      const ack = event.acknowledgement;
      if (!ack?.acknowledged || ack.sequence < commit.commit_sequence) continue;
      return undefined;
    }
  }
  return "no task transition pairs an attributable event with a durable commit";
};

const P5: Predicate = (corpus) => {
  const tagsOf = (id: string): string[] | undefined => {
    const artifact = (corpus.artifacts ?? []).find((a) => a.id === id);
    if (artifact) return artifact.labels.secrecy_tags;
    const packet = (corpus.context_packets ?? []).find((p) => p.id === id);
    if (!packet) return undefined;
    return packet.entries.flatMap((entry) => entry.labels.secrecy_tags);
  };
  const derived = (corpus.artifacts ?? []).find((artifact) => {
    const sources = artifact.derived_from ?? [];
    if (sources.length === 0 || !artifact.derivation || !artifact.correctable) {
      return false;
    }
    return sources.every((source) =>
      (tagsOf(source) ?? []).every((tag) =>
        artifact.labels.secrecy_tags.includes(tag)
      )
    );
  });
  if (!derived) return "no derived artifact carries its sources' labels";
  const projection = (corpus.projections ?? []).find((view) => {
    const tags = [
      ...view.source_packets.flatMap((id) => tagsOf(id) ?? []),
      ...view.source_events.flatMap((id) =>
        (corpus.events ?? []).find((e) => e.id === id)?.labels.secrecy_tags ??
          []
      ),
    ];
    if (tags.length === 0) return false;
    return tags.every((tag) =>
      view.source_labels.secrecy_tags.includes(tag) &&
      view.consumer_clearance.cleared_secrecy_tags.includes(tag)
    );
  });
  if (!projection) return "no projection carries its sources' labels";
  const distinct = (corpus.context_packets ?? []).some((packet) =>
    new Set(packet.entries.map((entry) => entry.claim_source)).size > 1
  );
  return distinct
    ? undefined
    : "context entries collapse into one claim source";
};

const P6: Predicate = (corpus) => {
  const required: Record<string, string[]> = {
    "new": ["fresh-session-established"],
    "warm-reused": ["warm-process-handle", "prior-run"],
    "durably-resumed": ["durable-session-record", "resume-token-accepted"],
    "reconstructed": ["context-packet-rebuild", "source-packet"],
  };
  const sessions = corpus.route_sessions ?? [];
  const classes = new Set(sessions.map((session) => session.continuity.class));
  if (classes.size < 2) {
    return "the corpus states only one continuity class";
  }
  for (const session of sessions) {
    const kinds = new Set(
      session.continuity.evidence.map((item) => item.kind),
    );
    for (const kind of required[session.continuity.class] ?? []) {
      if (!kinds.has(kind)) return "a continuity claim lacks its own evidence";
    }
  }
  const ordered = sessions.find((session) => {
    const phases = session.phases;
    if (phases[0]?.phase !== "inspect") return false;
    for (let i = 1; i < phases.length; i++) {
      if (phases[i]!.sequence <= phases[i - 1]!.sequence) return false;
    }
    const prepare = phases.find((phase) => phase.phase === "prepare");
    if (!prepare || prepare.outcome !== "accepted") return false;
    const report = (corpus.route_capability_reports ?? []).find(
      (entry) => entry.id === prepare.capability_report,
    );
    if (!report || report.route !== session.route) return false;
    const spend = phases.filter((phase) => phase.spend_or_action);
    if (spend.length === 0) return false;
    return spend.every((phase) => phase.sequence > prepare.sequence) &&
      phases.at(-1)?.phase === "finalize";
  });
  return ordered
    ? undefined
    : "no session runs the declared phase order behind an accepted preparation";
};

const P7: Predicate = (corpus) => {
  const survivable = new Set([
    "availability-withdrawn",
    "registration-removed",
  ]);
  for (const lease of corpus.registration_leases ?? []) {
    if (lease.state !== "expired" || !lease.availability_only) continue;
    if (!lease.effects_on_expiry.every((effect) => survivable.has(effect))) {
      continue;
    }
    const session = (corpus.route_sessions ?? []).find(
      (candidate) => candidate.id === lease.subject.reference,
    );
    if (!session) continue;
    const run = (corpus.runs ?? []).find((r) => r.id === session.run);
    if (!run || run.transitions.length === 0) continue;
    const events = new Set((corpus.events ?? []).map((event) => event.id));
    if (!run.transitions.every((step) => events.has(step.event))) continue;
    return undefined;
  }
  return "no expired lease leaves its subject identity and history intact";
};

const P8: Predicate = (corpus) => {
  const receipts = corpus.receipts ?? [];
  for (const family of ["turn", "run", "interrupt", "completion"]) {
    if (!receipts.some((receipt) => receipt.family === family)) {
      return `no ${family} receipt is recorded`;
    }
  }
  const turn = receipts.find((receipt) => receipt.family === "turn")!;
  if (
    !turn.body.route || !turn.body.context_packet || !turn.body.projection ||
    !turn.body.capability_posture || turn.body.terminal_reason === undefined
  ) {
    return "the turn receipt records no route, context, projection, or posture";
  }
  const run = receipts.find((receipt) => receipt.family === "run")!;
  if (!run.body.process_provenance || !run.body.verification) {
    return "the run receipt records no provenance or verification";
  }
  const interrupt = receipts.find((receipt) => receipt.family === "interrupt")!;
  if (
    interrupt.body.outcome === undefined || !interrupt.body.preserved_state ||
    !interrupt.body.remaining_authority
  ) {
    return "the interrupt receipt records no outcome, preserved state, or authority";
  }
  const completion = receipts.find((receipt) =>
    receipt.family === "completion"
  )!;
  const facts = completion.body.facts;
  if (!facts) return "the completion receipt records no separate facts";
  const expected: [keyof typeof facts, string][] = [
    ["agent_reported_completion", "runner-reported"],
    ["workbench_observed_effects", "workbench-observed"],
    ["independent_verification", "independently-verified"],
    ["operator_acceptance", "operator-accepted"],
    ["closure", "operator-accepted"],
  ];
  const evidence: string[] = [];
  for (const [name, claimSource] of expected) {
    const fact = facts[name];
    if (fact.claim_source !== claimSource) {
      return `the ${name} fact is claimed from the wrong source`;
    }
    if (fact.evidence.length === 0) {
      return `the ${name} fact carries no evidence`;
    }
    evidence.push(...fact.evidence.map((item) => item.event ?? item.run ?? ""));
  }
  if (facts.operator_acceptance.state !== "accepted") {
    return "operator acceptance is not recorded as accepted";
  }
  if (facts.closure.state !== "closed") return "closure is not recorded";
  if (new Set(evidence).size !== evidence.length) {
    return "the completion facts share one piece of evidence";
  }
  if (new Set(receipts.map((r) => r.attribution.claim_source)).size < 2) {
    return "every receipt is attributed to the same claim source";
  }
  return undefined;
};

const P9: Predicate = (corpus) => {
  const deferrals = corpus.deferrals ?? [];
  const recorded = new Set(deferrals.map((deferral) => deferral.capability));
  for (const capability of REQUIRED_DEFERRALS) {
    if (!recorded.has(capability)) return `${capability} is not recorded`;
  }
  if (recorded.size !== REQUIRED_DEFERRALS.length) {
    return "the deferral inventory is not exactly the declared set";
  }
  for (const deferral of deferrals) {
    if (
      deferral.status !== "deferred" || deferral.required ||
      deferral.implemented || deferral.authoritative || deferral.routable
    ) {
      return "a deferral is required, implemented, authoritative, or routable";
    }
  }
  const offered = new Set<string>([
    ...(corpus.agent_specs ?? []).flatMap((spec) => spec.tools),
    ...(corpus.capability_grants ?? []).flatMap((grant) => [
      ...grant.scope.tools,
      ...grant.scope.resources,
    ]),
    ...(corpus.route_capability_reports ?? []).flatMap((entry) =>
      entry.capabilities.filter((c) => c.required).map((c) => c.capability)
    ),
  ]);
  for (const deferral of deferrals) {
    const names = [deferral.capability, deferral.reserved_identifier];
    for (const name of names) {
      if (name !== undefined && offered.has(name)) {
        return "a deferred capability is offered as available";
      }
    }
  }
  return undefined;
};

const ACCEPTANCE_MATRIX: readonly [string, Predicate][] = [
  ["P1", P1],
  ["P2", P2],
  ["P3", P3],
  ["P4", P4],
  ["P5", P5],
  ["P6", P6],
  ["P7", P7],
  ["P8", P8],
  ["P9", P9],
];

/** The one fixture that carries the whole first-product baseline. */
const BASELINE_FIXTURE = "first-product-baseline.json";

// The negative-fixture oracle: exhaustive over every stable rule id the
// package declares, structural and semantic alike. A rule with no named
// negative fixture fails this test — the oracle is the full rule inventory,
// never a hand-picked subset and never the fixtures' own `proves` claims.
const REQUIRED_NEGATIVE_RULES: readonly string[] = RULE_IDS;

Deno.test("the package exposes one version and one corpus schema", async () => {
  const registry = await loadSchemaRegistry();
  assertEquals(
    PACKAGE_VERSION,
    "workbench.first-product/v1",
    "package version",
  );
  assertEquals(
    registry.ids.length,
    SCHEMA_FILES.length,
    "schema document count",
  );
  assert(
    registry.ids.includes(CORPUS_SCHEMA_ID),
    "the corpus schema id is not registered",
  );
  const corpus = registry.document(CORPUS_SCHEMA_ID);
  const properties = corpus["properties"] as Record<string, unknown>;
  assertEquals(
    (properties["package_version"] as Record<string, unknown>)["const"],
    PACKAGE_VERSION,
    "corpus schema package version",
  );
});

Deno.test("every schema reference resolves within the package", async () => {
  const registry = await loadSchemaRegistry();
  const references: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string") references.push(value);
      else walk(value);
    }
  };
  for (const id of registry.ids) walk(registry.document(id));
  assert(references.length > 0, "no schema references were found");
  for (const reference of references) {
    const [uri, fragment] = reference.split("#");
    assert(
      uri!.length === 0 || registry.ids.includes(uri!),
      `schema reference names an unknown document: ${reference}`,
    );
    assert(
      fragment !== undefined && fragment.startsWith("/$defs/"),
      `schema reference is not a $defs pointer: ${reference}`,
    );
  }
});

Deno.test("positive fixtures are accepted in full", async () => {
  const registry = await loadSchemaRegistry();
  const fixtures = await loadFixtures("positive");
  assert(fixtures.length > 0, "no positive fixtures were found");
  for (const fixture of fixtures) {
    const document = fixture.document as FixtureDocument;
    assertEquals(
      document.expectation?.outcome,
      "accept",
      `${fixture.name} expectation`,
    );
    assertEquals(
      document.package_version,
      PACKAGE_VERSION,
      `${fixture.name} package version`,
    );
    const result = validateCorpus(registry, fixture.document);
    assert(
      result.accepted,
      `${fixture.name} was rejected: ${render(result.diagnostics)}`,
    );
  }
});

Deno.test("negative-directory fixtures meet their declared outcome", async () => {
  const registry = await loadSchemaRegistry();
  const fixtures = await loadFixtures("negative");
  assert(fixtures.length > 0, "no negative fixtures were found");
  for (const fixture of fixtures) {
    const document = fixture.document as FixtureDocument;
    const outcome = document.expectation?.outcome;
    assert(
      outcome === "accept" || outcome === "reject",
      `${fixture.name} names no supported expectation`,
    );
    const result = validateCorpus(registry, fixture.document);
    if (outcome === "accept") {
      assert(
        result.accepted,
        `${fixture.name} was rejected but must be accepted: ${
          render(result.diagnostics)
        }`,
      );
      continue;
    }
    const rule = document.expectation?.rule;
    assert(
      rule !== undefined && (RULE_IDS as readonly string[]).includes(rule),
      `${fixture.name} names an unknown rule id`,
    );
    assert(
      !result.accepted,
      `${fixture.name} was accepted but must be rejected by ${rule}`,
    );
    assertEquals(
      result.rules,
      [rule!],
      `${fixture.name} rejection rules (${render(result.diagnostics)})`,
    );
  }
});

Deno.test("the baseline carries a witness for every acceptance-matrix item", async () => {
  const positives = await loadFixtures("positive");
  const baseline = positives.find((fixture) =>
    fixture.name === BASELINE_FIXTURE
  );
  assert(baseline !== undefined, `${BASELINE_FIXTURE} is missing`);
  for (const [item, predicate] of ACCEPTANCE_MATRIX) {
    const reason = predicate(baseline.document as Corpus);
    assert(reason === undefined, `${item} has no witness: ${reason}`);
  }
});

// One witness per matrix item, and how to take it away. `proves` is left
// untouched in every case: the point is that a fixture can go on claiming an
// item after the thing that made it true is gone.
const WITHDRAWALS: readonly [string, (corpus: Corpus) => void][] = [
  ["P1", (corpus) => {
    corpus.tasks![0]!.thread = "thread-that-was-removed";
  }],
  ["P2", (corpus) => {
    corpus.runs = corpus.runs!.slice(0, 1);
  }],
  ["P3", (corpus) => {
    corpus.room_memberships![1]!.speak_rule.policy = "mention";
  }],
  ["P4", (corpus) => {
    for (const event of corpus.events!) delete event.durable_commit;
  }],
  ["P5", (corpus) => {
    corpus.artifacts![1]!.labels.secrecy_tags = [];
  }],
  ["P6", (corpus) => {
    for (const session of corpus.route_sessions!) {
      session.continuity.class = "new";
      session.continuity.evidence = [{ kind: "fresh-session-established" }];
    }
  }],
  ["P7", (corpus) => {
    for (const lease of corpus.registration_leases!) lease.state = "active";
  }],
  ["P8", (corpus) => {
    corpus.receipts = corpus.receipts!.filter((receipt) =>
      receipt.family !== "interrupt"
    );
  }],
  ["P9", (corpus) => {
    corpus.deferrals = corpus.deferrals!.slice(1);
  }],
];

Deno.test("the acceptance matrix is decided by witnesses, not by the proves list", async () => {
  // The regression this guards: `proves` is a claim the fixture makes about
  // itself, so it survives the deletion of the very thing it claims. If the
  // matrix were read off that list, every one of these mutilated corpora
  // would still "prove" P1 through P9.
  const positives = await loadFixtures("positive");
  const baseline = positives.find((fixture) =>
    fixture.name === BASELINE_FIXTURE
  );
  assert(baseline !== undefined, `${BASELINE_FIXTURE} is missing`);
  const document = baseline.document as FixtureDocument & Corpus;
  const claimed = document.proves ?? [];
  for (const [item] of ACCEPTANCE_MATRIX) {
    assert(
      claimed.includes(item),
      `the baseline no longer claims ${item}, so this regression proves nothing`,
    );
  }
  for (const [item, withdraw] of WITHDRAWALS) {
    const mutilated = JSON.parse(JSON.stringify(document)) as
      & FixtureDocument
      & Corpus;
    withdraw(mutilated);
    assertEquals(
      mutilated.proves,
      claimed,
      `${item}: the mutilated corpus must keep its original claims`,
    );
    const predicate = ACCEPTANCE_MATRIX.find(([name]) => name === item)![1];
    assert(
      predicate(mutilated) !== undefined,
      `${item} still passed after its witness was removed`,
    );
  }
});

Deno.test("negative fixtures cover every required rejection", async () => {
  const negatives = await loadFixtures("negative");
  const rejected = new Set<string>();
  for (const fixture of negatives) {
    const rule = (fixture.document as FixtureDocument).expectation?.rule;
    if (rule !== undefined) rejected.add(rule);
  }
  for (const rule of REQUIRED_NEGATIVE_RULES) {
    assert(rejected.has(rule), `no negative fixture exercises ${rule}`);
  }
});

Deno.test("structural findings suppress cross-document conclusions", async () => {
  const registry = await loadSchemaRegistry();
  const malformed = {
    schema: "dyfj.workbench.first-product.corpus/v1",
    package_version: PACKAGE_VERSION,
    profile: "focused-rule-fixture",
    expectation: { outcome: "accept" },
    rooms: [
      {
        id: "Room One",
        identity_basis: "derived-from-process",
        revision: 1,
        room_class: "operator-room",
        persistence: "persistent",
        labels: {
          integrity_class: "attested",
          secrecy_tags: [],
          visibility: "room",
          sensitivity: "low",
        },
      },
    ],
  };
  const result = validateCorpus(registry, malformed);
  assert(!result.accepted, "a malformed identifier was accepted");
  assertEquals(
    result.rules,
    ["structure.value-domain"],
    "structural findings must not be mixed with semantic ones",
  );
});

Deno.test("diagnostics stay value-free for untrusted fixture content", async () => {
  const registry = await loadSchemaRegistry();
  const fixtures = [
    ...await loadFixtures("positive"),
    ...await loadFixtures("negative"),
  ];
  for (const fixture of fixtures) {
    const diagnostics = validateCorpus(registry, fixture.document).diagnostics;
    const rendered = diagnostics.map(formatDiagnostic).join("\n");
    if (rendered.length === 0) continue;
    // A diagnostic may name its own rule id and the entity id it points at;
    // nothing else from the document may appear.
    // Permitted names are removed longest-first before the search, so a
    // permitted id never shelters a shorter value that happens to be its
    // prefix.
    const permitted = [
      ...new Set<string>([
        ...(RULE_IDS as readonly string[]),
        ...diagnostics.flatMap((diagnostic) =>
          diagnostic.entity === undefined ? [] : [diagnostic.entity]
        ),
      ]),
    ].sort((left, right) => right.length - left.length);
    let searchable = rendered;
    for (const name of permitted) searchable = searchable.split(name).join(" ");
    const values: string[] = [];
    const walk = (node: unknown): void => {
      if (typeof node === "string") {
        if (node.length > 12) values.push(node);
        return;
      }
      if (Array.isArray(node)) {
        for (const entry of node) walk(entry);
        return;
      }
      if (typeof node === "object" && node !== null) {
        for (const value of Object.values(node)) walk(value);
      }
    };
    walk(fixture.document);
    for (const value of values) {
      assert(
        !searchable.includes(value),
        `${fixture.name} diagnostics echoed a document value`,
      );
    }
  }
});

function thrownMessage(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

Deno.test("the schema evaluator fails closed on an unsupported keyword", () => {
  // The keyword sits on a property the validated instance carries, so this
  // covers the actively evaluated path.
  const message = thrownMessage(() => {
    const registry = new SchemaRegistry([
      {
        $id: "urn:dyfj:contracts:test:unsupported",
        type: "object",
        properties: { name: { type: "string", format: "email" } },
      },
    ]);
    return registry.validate("urn:dyfj:contracts:test:unsupported", {
      name: "value",
    });
  });
  assert(
    message.includes("unsupported schema keyword"),
    "an unsupported keyword did not fail closed",
  );
});

Deno.test("a dormant unsupported keyword fails closed at construction", () => {
  // The regression this guards: evaluation only visits schema nodes the
  // instance reaches, so an unsupported keyword inside an optional property
  // used to pass unnoticed for every document that omits that property.
  const document: Record<string, unknown> = {
    $id: "urn:dyfj:contracts:test:dormant",
    type: "object",
    properties: { name: { type: "string", format: "email" } },
  };
  const message = thrownMessage(() => new SchemaRegistry([document]));
  assert(
    message.includes("unsupported schema keyword"),
    "a dormant unsupported keyword did not fail closed at construction",
  );
  // And the audit is what makes it fail: without construction-time auditing
  // this instance never reaches the offending subschema at all.
  assert(
    thrownMessage(() => auditSchemaDocument(document)).includes(
      "unsupported schema keyword",
    ),
    "the authoring audit did not reject the dormant keyword",
  );
});

Deno.test("the authoring audit reaches every schema-bearing location", () => {
  const offender = { type: "string", format: "email" };
  const locations: [string, Record<string, unknown>][] = [
    ["$defs", { $defs: { spare: offender } }],
    ["properties", { type: "object", properties: { absent: offender } }],
    ["items", { type: "array", items: offender }],
    ["additionalProperties", {
      type: "object",
      additionalProperties: offender,
    }],
    ["allOf", { allOf: [offender] }],
    ["anyOf", { anyOf: [offender] }],
    ["oneOf", { oneOf: [offender] }],
    ["nested", { $defs: { outer: { type: "array", items: offender } } }],
  ];
  for (const [label, body] of locations) {
    const message = thrownMessage(() =>
      new SchemaRegistry([{ $id: `urn:dyfj:contracts:test:${label}`, ...body }])
    );
    assert(
      message.includes("unsupported schema keyword"),
      `an unsupported keyword under ${label} did not fail closed`,
    );
  }
});

Deno.test("const and enum values are data, not schemas", () => {
  // A const or enum member may hold any JSON, including an object whose keys
  // look like keywords. Auditing them as schemas would reject valid authoring.
  const registry = new SchemaRegistry([
    {
      $id: "urn:dyfj:contracts:test:data-values",
      type: "object",
      properties: {
        marker: { const: { format: "email", unsupported: true } },
        choice: { enum: [{ format: "email" }, "plain"] },
      },
    },
  ]);
  assertEquals(
    registry.validate("urn:dyfj:contracts:test:data-values", {
      marker: { format: "email", unsupported: true },
      choice: "plain",
    }),
    [],
    "a document matching its const and enum data was rejected",
  );
});

Deno.test("malformed supported-keyword values fail closed", () => {
  // Each of these would otherwise be skipped at evaluation time and assert
  // nothing at all, so the schema would silently stop checking.
  const malformed: [string, Record<string, unknown>][] = [
    ["required", { type: "object", required: "id" }],
    ["required-member", { type: "object", required: [7] }],
    ["properties", { type: "object", properties: "name" }],
    ["items", { type: "array", items: 7 }],
    ["additionalProperties", { type: "object", additionalProperties: 7 }],
    ["allOf", { allOf: {} }],
    ["anyOf", { anyOf: [] }],
    ["type-name", { type: "text" }],
    ["type-shape", { type: 7 }],
    ["pattern-type", { type: "string", pattern: 7 }],
    ["pattern-syntax", { type: "string", pattern: "[" }],
    ["minLength", { type: "string", minLength: "3" }],
    ["maxItems", { type: "array", maxItems: 1.5 }],
    ["minimum", { type: "number", minimum: "1" }],
    ["uniqueItems", { type: "array", uniqueItems: "yes" }],
    ["enum", { enum: {} }],
    ["title", { title: 7 }],
    ["dormant", { $defs: { spare: { type: "string", minItems: "2" } } }],
  ];
  for (const [label, body] of malformed) {
    const message = thrownMessage(() =>
      new SchemaRegistry([{ $id: `urn:dyfj:contracts:test:${label}`, ...body }])
    );
    assert(
      message.includes("malformed schema keyword value"),
      `a malformed ${label} value did not fail closed`,
    );
  }
});

Deno.test("the package schemas pass the authoring audit", async () => {
  // loadSchemaRegistry constructs the registry, and construction audits; this
  // states the property directly so a regression names itself.
  const registry = await loadSchemaRegistry();
  for (const id of registry.ids) auditSchemaDocument(registry.document(id));
});
