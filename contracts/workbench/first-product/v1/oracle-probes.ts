import type { Corpus } from "./validate.ts";

export type ProbeDisposition = "accept" | "reject";

export interface ProbeFixture {
  id: string;
  probe: string;
  branch: string;
  expected: ProbeDisposition;
  ec: string[];
  mutate(corpus: Corpus): void;
}

function byId<T extends { id: string }>(items: T[] | undefined, id: string): T {
  const item = items?.find((candidate) => candidate.id === id);
  if (item === undefined) {
    throw new Error(`oracle fixture source is missing ${id}`);
  }
  return item;
}

function removeInterruptedRunRecovery(corpus: Corpus): void {
  const task = byId(corpus.tasks, "task-render-summary");
  task.transitions.splice(2, 2);
  task.revision = 6;
  for (const [offset, transition] of task.transitions.entries()) {
    transition.revision = offset + 2;
    const event = byId(corpus.events, transition.event);
    event.state_transition!.entity_revision = offset + 2;
  }
  corpus.events = corpus.events?.filter((event) =>
    event.id !== "ev-task-return-ready" && event.id !== "ev-task-running-again"
  );
  byId(corpus.events, "ev-approval-budget").causal_parents = [
    "ev-run-one-interrupted",
  ];
  byId(corpus.events, "ev-run-two-started").causal_parents = [
    "ev-approval-budget",
  ];
  byId(corpus.receipts, "receipt-completion").current_state!.revision = 6;
}

function makePureConversationalTurn(corpus: Corpus): void {
  const receipt = byId(corpus.receipts, "receipt-turn-one");
  delete receipt.task;
  delete receipt.run;
  delete receipt.current_state;
  delete receipt.body.route;
  delete receipt.body.context_packet;
  delete receipt.body.capability_posture;
  delete receipt.body.usage;
  delete receipt.body.cost;
  const commit = byId(corpus.events, receipt.commit_event);
  delete commit.task;
  delete commit.run;
}

function makeInspectionOnlyDiscovery(corpus: Corpus): void {
  corpus.profile = "focused-rule-fixture";
  corpus.tasks = [byId(corpus.tasks, "task-render-summary")];
  const task = corpus.tasks[0]!;
  task.revision = 1;
  task.state = "task:proposed";
  task.envelope.grant = "grant-primary-envelope";
  task.execution_envelope.budget.limit_minor_units = 500;
  task.transitions = [];
  corpus.runs = [byId(corpus.runs, "run-attempt-one")];
  const run = byId(corpus.runs, "run-attempt-one");
  run.revision = 1;
  run.state = "run:pending";
  run.transitions = [];
  corpus.routes = [byId(corpus.routes, "route-native-local")];
  corpus.route_capability_reports = [
    byId(corpus.route_capability_reports, "report-native-local"),
  ];
  corpus.route_sessions = [
    byId(corpus.route_sessions, "session-attempt-one"),
  ];
  const session = corpus.route_sessions[0]!;
  session.phases = [session.phases[0]!];
  corpus.context_packets = [
    byId(corpus.context_packets, "packet-attempt-one"),
  ];
  corpus.context_packets[0]!.entries = corpus.context_packets[0]!.entries
    .filter(
      (entry) => entry.source.reference === "thread-main",
    );
  corpus.capability_grants = [
    byId(corpus.capability_grants, "grant-primary-envelope"),
  ];
  corpus.registration_leases = [];
  corpus.artifacts = [];
  corpus.events = [];
  corpus.projections = [];
  corpus.receipts = [];
  corpus.deferrals = [];
}

function addRoom(
  corpus: Corpus,
  id: string,
  persistence: "persistent" | "ephemeral",
): void {
  corpus.rooms ??= [];
  corpus.rooms.push({
    id,
    identity_basis: "assigned-opaque",
    revision: 1,
    room_class: "operator-room",
    persistence,
    labels: {
      integrity_class: "attested",
      secrecy_tags: [],
      visibility: "room",
      sensitivity: "low",
    },
  });
}

export const PROBE_FIXTURES: readonly ProbeFixture[] = [
  {
    id: "RP-01",
    probe: "Run omits its ContextPacket",
    branch: "forbidden",
    expected: "reject",
    ec: ["EC-011", "EC-016"],
    mutate: (c) => {
      delete (c.runs![0] as Partial<
        Corpus["runs"] extends (infer R)[] | undefined ? R : never
      >).context_packet;
    },
  },
  {
    id: "RP-02",
    probe: "Run points to another Run's exclusively owned ContextPacket",
    branch: "forbidden",
    expected: "reject",
    ec: ["EC-016"],
    mutate: (c) => {
      c.runs![0]!.context_packet = "packet-attempt-two";
    },
  },
  {
    id: "RP-03",
    probe: "Run omits its RouteSession while the session still names the Run",
    branch: "forbidden",
    expected: "reject",
    ec: ["EC-011", "EC-020"],
    mutate: (c) => {
      delete (c.runs![0] as Partial<
        Corpus["runs"] extends (infer R)[] | undefined ? R : never
      >).route_session;
    },
  },
  {
    id: "RP-04",
    probe: "Run receipt omits Task identity",
    branch: "forbidden",
    expected: "reject",
    ec: ["EC-050", "EC-053"],
    mutate: (c) => {
      delete byId(c.receipts, "receipt-run-one").task;
    },
  },
  {
    id: "RP-05",
    probe: "turn receipt commit event names another Run",
    branch: "forbidden",
    expected: "reject",
    ec: ["EC-049", "EC-053"],
    mutate: (c) => {
      byId(c.events, "ev-turn-receipt-committed").run = "run-attempt-two";
    },
  },
  {
    id: "RP-06",
    probe: "required Route approval follows first use",
    branch: "forbidden",
    expected: "reject",
    ec: ["EC-023", "EC-040"],
    mutate: (c) => {
      const approval = byId(c.events, "ev-approval-budget");
      approval.sequence = 31;
      approval.durable_commit!.commit_sequence = 31;
      approval.acknowledgement!.sequence = 32;
    },
  },
  {
    id: "RP-07",
    probe: "receipt acceptance and closure evidence postdate commit",
    branch: "forbidden",
    expected: "reject",
    ec: ["EC-040", "EC-053"],
    mutate: (c) => {
      const accepted = byId(c.events, "ev-task-accepted");
      accepted.sequence = 31;
      accepted.durable_commit!.commit_sequence = 31;
      accepted.acknowledgement!.sequence = 32;
      const closed = byId(c.events, "ev-task-closed");
      closed.sequence = 32;
      closed.durable_commit!.commit_sequence = 32;
      closed.acknowledgement!.sequence = 33;
    },
  },
  {
    id: "RP-08",
    probe: "interrupted Run has no Task recovery consequence",
    branch: "forbidden",
    expected: "reject",
    ec: ["EC-035"],
    mutate: removeInterruptedRunRecovery,
  },
  {
    id: "RP-09",
    probe: "native hosted Route records provider and adapter",
    branch: "allowed",
    expected: "accept",
    ec: ["EC-017", "EC-018"],
    mutate: (c) => {
      const route = byId(c.routes, "route-native-local");
      route.access_modality = "aggregator-hosted";
      route.provider = "synthetic-provider";
      route.adapter = "synthetic-adapter";
    },
  },
  {
    id: "RP-10",
    probe: "pure conversational turn omits Task, Run, and lifecycle state",
    branch: "allowed",
    expected: "accept",
    ec: ["EC-049"],
    mutate: makePureConversationalTurn,
  },
  {
    id: "RP-11",
    probe: "Task carries its required objective",
    branch: "allowed",
    expected: "accept",
    ec: ["EC-009"],
    mutate: (c) => {
      c.tasks![0]!.execution_envelope.objective =
        "Produce the requested summary.";
    },
  },
  {
    id: "RP-12",
    probe: "AgentSpec carries its required behavior representation",
    branch: "allowed",
    expected: "accept",
    ec: ["EC-008"],
    mutate: (c) => {
      c.agent_specs![0]!.behavior = ["chief-of-staff", "operator-escalating"];
    },
  },
  {
    id: "RP-13",
    probe: "Route records applicable system-harness identity",
    branch: "allowed",
    expected: "accept",
    ec: ["EC-018"],
    mutate: (c) => {
      c.routes![0]!.system_harness = "workbench-native-loop";
    },
  },
  {
    id: "RP-14",
    probe: "grant records destination classes and applicable scopes",
    branch: "allowed",
    expected: "accept",
    ec: ["EC-027"],
    mutate: (c) => {
      const scope =
        byId(c.capability_grants, "grant-primary-envelope-r2").scope;
      scope.task_scope = "task-render-summary";
      scope.room_scope = "room-operator-primary";
      scope.route_scope = ["route-hosted-metered"];
      scope.provider_scope = ["synthetic-provider"];
    },
  },
  {
    id: "RP-15",
    probe: "events record a consistent declared writer and cutover authority",
    branch: "allowed",
    expected: "accept",
    ec: ["EC-045"],
    mutate: (c) => {
      for (const event of c.events ?? []) event.writer_id = "writer-workbench";
    },
  },
  {
    id: "RP-16",
    probe: "ContextPacket omits redundant reverse Task and Run fields",
    branch: "allowed",
    expected: "accept",
    ec: ["EC-016"],
    mutate: (c) => {
      for (const packet of c.context_packets ?? []) {
        delete packet.task;
        delete packet.run;
      }
    },
  },
  {
    id: "RP-16",
    probe:
      "represented ContextPacket reverse field contradicts derived ownership",
    branch: "forbidden",
    expected: "reject",
    ec: ["EC-016"],
    mutate: (c) => {
      c.context_packets![0]!.run = "run-attempt-two";
    },
  },
  {
    id: "RP-17",
    probe: "Run uses an attributable narrower predecessor grant",
    branch: "allowed",
    expected: "accept",
    ec: ["EC-014", "EC-029"],
    mutate: () => {},
  },
  {
    id: "RP-17",
    probe: "Run uses an unrelated or stale grant",
    branch: "forbidden",
    expected: "reject",
    ec: ["EC-014", "EC-029"],
    mutate: (c) => {
      c.runs![1]!.capability_grant = "grant-primary-envelope";
    },
  },
  {
    id: "RP-18",
    probe: "relied-on Run grant scopes another Route and provider",
    branch: "forbidden",
    expected: "reject",
    ec: ["EC-027", "EC-028"],
    mutate: (c) => {
      const scope =
        byId(c.capability_grants, "grant-primary-envelope-r2").scope;
      scope.route_scope = ["route-native-local"];
      scope.provider_scope = ["another-provider"];
    },
  },
  {
    id: "RP-19",
    probe:
      "egress-capable grant acts on private untrusted packet without scoped authorization",
    branch: "forbidden",
    expected: "reject",
    ec: ["EC-030"],
    mutate: (c) => {
      const scope =
        byId(c.capability_grants, "grant-primary-envelope-r2").scope;
      scope.network = "operator-approved-hosts";
      scope.destination_classes = ["external-uncontrolled"];
    },
  },
  {
    id: "RP-20",
    probe: "failed Run directly causes Task completion",
    branch: "forbidden",
    expected: "reject",
    ec: ["EC-036"],
    mutate: (c) => {
      const run = byId(c.runs, "run-attempt-two");
      run.state = "run:failed";
      run.transitions[1]!.to = "run:failed";
      byId(c.events, "ev-run-two-completed").state_transition!.to =
        "run:failed";
      byId(c.events, "ev-task-completed").state_transition!.caused_by_run =
        "run-attempt-two";
    },
  },
  {
    id: "RP-21",
    probe:
      "failed or interrupted Run recovery is replaced by an unrelated note",
    branch: "forbidden",
    expected: "reject",
    ec: ["EC-035"],
    mutate: removeInterruptedRunRecovery,
  },
  {
    id: "RP-22",
    probe: "Task Room disagrees with its Thread and events",
    branch: "forbidden",
    expected: "reject",
    ec: ["EC-007", "EC-038"],
    mutate: (c) => {
      addRoom(c, "room-other", "persistent");
      c.tasks![0]!.room = "room-other";
    },
  },
  {
    id: "RP-23",
    probe: "membership authorization names no effective membership",
    branch: "forbidden",
    expected: "reject",
    ec: ["EC-005"],
    mutate: (c) => {
      delete byId(c.events, "ev-operator-request").authorization_basis
        .membership;
    },
  },
  {
    id: "RP-24",
    probe:
      "digital Participant declares human author class to evade machine-summons policy",
    branch: "forbidden",
    expected: "reject",
    ec: ["EC-003", "EC-006"],
    mutate: (c) => {
      const event = byId(c.events, "ev-task-running");
      event.author_class = "human";
      event.triggers_automated_summons = true;
    },
  },
  {
    id: "RP-25",
    probe: "turn commit event conceals participating Task and Run",
    branch: "forbidden",
    expected: "reject",
    ec: ["EC-049", "EC-053"],
    mutate: (c) => {
      const event = byId(c.events, "ev-turn-receipt-committed");
      delete event.task;
      delete event.run;
    },
  },
  {
    id: "RP-26",
    probe:
      "turn receipt conceals Run participation shown by body and commit evidence",
    branch: "forbidden",
    expected: "reject",
    ec: ["EC-049", "EC-053"],
    mutate: (c) => {
      const receipt = byId(c.receipts, "receipt-turn-one");
      delete receipt.task;
      delete receipt.run;
      delete receipt.current_state;
    },
  },
  {
    id: "RP-27",
    probe: "superseding grant adds egress destination without approval",
    branch: "forbidden",
    expected: "reject",
    ec: ["EC-029"],
    mutate: (c) => {
      const grant = byId(c.capability_grants, "grant-primary-envelope-r2");
      delete grant.approval_event;
      grant.policy_basis = {
        policy_id: "policy-operator-envelope",
        decision: "allowed",
      };
      grant.scope.network = "operator-approved-hosts";
      grant.scope.destination_classes = ["external-uncontrolled"];
    },
  },
  {
    id: "RP-28",
    probe: "authoritative post-cutover event omits writer identity",
    branch: "forbidden",
    expected: "reject",
    ec: ["EC-045"],
    mutate: (c) => {
      byId(c.events, "ev-task-proposed").writer_id = "writer-workbench";
    },
  },
  {
    id: "RP-29",
    probe: "inspection-only session makes no action or terminal claim",
    branch: "allowed",
    expected: "accept",
    ec: ["EC-021", "EC-022", "EC-023", "EC-024"],
    mutate: makeInspectionOnlyDiscovery,
  },
  {
    id: "RP-29",
    probe: "inspection-only session accompanies execution and terminal claims",
    branch: "forbidden",
    expected: "reject",
    ec: ["EC-021", "EC-022", "EC-023", "EC-024"],
    mutate: (c) => {
      c.route_sessions![1]!.phases = [c.route_sessions![1]!.phases[0]!];
    },
  },
  {
    id: "RP-30",
    probe: "actual Route contradicts the Task execution envelope",
    branch: "forbidden",
    expected: "reject",
    ec: ["EC-013", "EC-014", "EC-015", "EC-022"],
    mutate: (c) => {
      c.tasks![0]!.execution_envelope.route_requirements.execution_lane =
        "native";
    },
  },
  {
    id: "RP-31",
    probe: "additional ephemeral Room retains the persistent primary Room",
    branch: "allowed",
    expected: "accept",
    ec: ["EC-001"],
    mutate: (c) => {
      addRoom(c, "room-ephemeral", "ephemeral");
    },
  },
];
