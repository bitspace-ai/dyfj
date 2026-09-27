import {
  assertEquals,
  assertObjectMatch,
  assertRejects,
  assertStrictEquals,
  assertStringIncludes,
} from "@std/assert";
import {
  buildWorkbenchSessionContent,
  buildWorkbenchSessionSlug,
  createWorkbenchSession,
  fetchWorkbenchSessionEvents,
  fetchWorkbenchSessionWorkspace,
  fetchWorkbenchSessionWorkspaceRecord,
  listWorkbenchSessions,
  updateWorkbenchSession,
} from "./sessions.ts";
import {
  type CommitBatch,
  type EventReader,
  type Journal,
  MemoryStore,
  type SessionEventsQuery,
  type SessionReader,
  type TextRow,
} from "./mod.ts";

Deno.test("buildWorkbenchSessionSlug: derives a stable workbench slug from the session id", () => {
  assertStrictEquals(
    buildWorkbenchSessionSlug("01ABCDEF0123456789ABCDEF01"),
    "workbench-01abcdef0123456789abcdef01",
  );
});

Deno.test("buildWorkbenchSessionContent: captures prompt, mode, trace, context sources, and receipt", () => {
  const content = buildWorkbenchSessionContent({
    mode: "turn",
    prompt: "What next?",
    traceId: "0123456789abcdef0123456789abcdef",
    contextSources: ["AGENTS.md <AGENTS.md>"],
    receipt: "Workbench receipt\nSession: 01TEST",
  });

  assertStringIncludes(content, "# Workbench Session");
  assertStringIncludes(content, "**Mode:** turn");
  assertStringIncludes(
    content,
    "**Trace:** 0123456789abcdef0123456789abcdef",
  );
  assertStringIncludes(content, "## Prompt");
  assertStringIncludes(content, "What next?");
  assertStringIncludes(content, "- AGENTS.md <AGENTS.md>");
  assertStringIncludes(content, "## Receipt");
  assertStringIncludes(content, "Workbench receipt");
});

/** A recording journal: the batches committed through it. */
function recordingJournal(): Journal & { batches: CommitBatch[] } {
  const batches: CommitBatch[] = [];
  return {
    batches,
    commit: (batch) => {
      batches.push(batch);
      return Promise.resolve({
        eventIds: [],
        mutations: batch.mutations?.length ?? 0,
      });
    },
  };
}

/** An event reader that serves these rows (in this order) for any session. */
function eventsReturning(
  rows: Record<string, unknown>[],
  calls: SessionEventsQuery[] = [],
): EventReader {
  return {
    exists: () => Promise.resolve(false),
    countBySession: () => Promise.resolve(rows.length),
    bySession: (query) => {
      calls.push(query);
      return Promise.resolve(rows.map((row) => ({ ...row })) as TextRow[]);
    },
  };
}

function sessionsReturning(
  rows: { workspace?: TextRow | null; list?: TextRow[] },
  listCalls: unknown[] = [],
): SessionReader {
  return {
    workspace: () => Promise.resolve(rows.workspace ?? null),
    summary: () => Promise.resolve(null),
    list: (query) => {
      listCalls.push(query);
      return Promise.resolve(rows.list ?? []);
    },
    recent: () => Promise.resolve([]),
    detail: () => Promise.resolve(null),
  };
}

Deno.test("createWorkbenchSession: commits an interactive session working view as a session_insert", async () => {
  const journal = recordingJournal();

  await createWorkbenchSession({
    sessionId: "01TESTSESSION00000000000000",
    slug: "workbench-01testsession00000000000000",
    taskDescription: "What next?",
    content: "initial content",
    journal,
  });

  assertEquals(journal.batches, [{
    events: [],
    mutations: [{
      kind: "session_insert",
      sessionId: "01TESTSESSION00000000000000",
      slug: "workbench-01testsession00000000000000",
      sessionName: "Workbench Harness Shell",
      taskDescription: "What next?",
      status: "active",
      mode: "interactive",
      workspace: null, // workspace unbound
      content: "initial content",
      progressDone: 0,
      progressTotal: 0,
    }],
  }]);
});

Deno.test("createWorkbenchSession: persists the workspace when bound and caps the task description", async () => {
  const store = new MemoryStore();
  await createWorkbenchSession({
    sessionId: "01TESTSESSION00000000000000",
    slug: "workbench-01testsession00000000000000",
    taskDescription: "x".repeat(300),
    content: "initial content",
    workspace: "/workspace/example-project",
    journal: store.journal,
  });
  assertStrictEquals(
    await fetchWorkbenchSessionWorkspace({
      sessionId: "01TESTSESSION00000000000000",
      sessions: store.sessions,
    }),
    "/workspace/example-project",
  );
  const summary = await store.sessions.summary("01TESTSESSION00000000000000");
  assertStrictEquals(summary?.task_description?.length, 256);
});

Deno.test("fetchWorkbenchSessionWorkspace: returns the persisted workspace for a session", async () => {
  const ws = await fetchWorkbenchSessionWorkspace({
    sessionId: "01TESTSESSION00000000000000",
    sessions: sessionsReturning({
      workspace: { workspace: "/workspace/example-project" },
    }),
  });
  assertStrictEquals(ws, "/workspace/example-project");
});

Deno.test("fetchWorkbenchSessionWorkspace: returns null when the session has no workspace or does not exist", async () => {
  assertStrictEquals(
    await fetchWorkbenchSessionWorkspace({
      sessionId: "x",
      sessions: sessionsReturning({ workspace: { workspace: "" } }),
    }),
    null,
  );
  assertStrictEquals(
    await fetchWorkbenchSessionWorkspace({
      sessionId: "x",
      sessions: sessionsReturning({ workspace: null }),
    }),
    null,
  );
});

Deno.test("fetchWorkbenchSessionWorkspaceRecord: distinguishes an existing session without a workspace from a missing session", async () => {
  assertEquals(
    await fetchWorkbenchSessionWorkspaceRecord({
      sessionId: "existing",
      sessions: sessionsReturning({ workspace: { workspace: "" } }),
    }),
    { exists: true, workspace: null },
  );
  assertEquals(
    await fetchWorkbenchSessionWorkspaceRecord({
      sessionId: "missing",
      sessions: sessionsReturning({ workspace: null }),
    }),
    { exists: false, workspace: null },
  );
});

Deno.test("updateWorkbenchSession: marks the session complete with updated content", async () => {
  const journal = recordingJournal();

  await updateWorkbenchSession({
    sessionId: "01TESTSESSION00000000000000",
    content: "final content",
    journal,
  });

  assertEquals(journal.batches, [{
    events: [],
    mutations: [{
      kind: "session_update",
      sessionId: "01TESTSESSION00000000000000",
      status: "completed",
      progressDone: 1,
      progressTotal: 1,
      content: "final content",
    }],
  }]);
});

const listRow = (over: Record<string, string>) => ({
  session_id: "01AAAAAAAAAAAAAAAAAAAAAAAA",
  slug: "workbench-x",
  session_name: "Workbench Harness Shell",
  task_description: "demo",
  project: "",
  status: "active",
  created_at: "2026-06-12 10:00:00",
  updated_at: "2026-06-12 10:00:00",
  ...over,
});

Deno.test("listWorkbenchSessions: groups sessions by project with unfiled last", async () => {
  const groups = await listWorkbenchSessions({
    sessions: sessionsReturning({
      list: [
        listRow({
          session_id: "01AAAAAAAAAAAAAAAAAAAAAAAB",
          project: "dyfj",
          updated_at: "2026-06-12 12:00:00",
        }),
        listRow({ session_id: "01AAAAAAAAAAAAAAAAAAAAAAAC", project: "" }),
        listRow({
          session_id: "01AAAAAAAAAAAAAAAAAAAAAAAD",
          project: "project-b",
          updated_at: "2026-06-12 11:00:00",
        }),
      ],
    }),
  });
  assertEquals(groups.map((g) => g.project), ["dyfj", "project-b", null]);
  assertStrictEquals(
    groups[0].sessions[0].sessionId,
    "01AAAAAAAAAAAAAAAAAAAAAAAB",
  );
  assertStrictEquals(groups[2].sessions[0].project, null);
});

Deno.test("listWorkbenchSessions: passes the project filter and a clamped limit to the reader", async () => {
  const calls: unknown[] = [];
  await listWorkbenchSessions({
    project: "dyfj",
    sessions: sessionsReturning({}, calls),
  });
  await listWorkbenchSessions({
    limit: 5000.7,
    sessions: sessionsReturning({}, calls),
  });
  await listWorkbenchSessions({
    limit: -1,
    sessions: sessionsReturning({}, calls),
  });
  assertEquals(calls, [
    { project: "dyfj", limit: 200 },
    { limit: 1000 },
    { limit: 1 },
  ]);
});

Deno.test("fetchWorkbenchSessionEvents: reads a session's newest events and returns them oldest first", async () => {
  const calls: SessionEventsQuery[] = [];
  const events = await fetchWorkbenchSessionEvents({
    sessionId: "01ABCDEF0123456789ABCDEF01",
    events: eventsReturning([
      { event_id: "evt-2", event_type: "model_response", created_at: "b" },
      { event_id: "evt-1", event_type: "session_start", created_at: "a" },
    ], calls),
  });
  assertEquals(calls, [{
    sessionId: "01ABCDEF0123456789ABCDEF01",
    limit: 5000,
    order: "desc",
  }]);
  assertEquals(events.map((e) => e.eventId), ["evt-1", "evt-2"]);
});

Deno.test("fetchWorkbenchSessionEvents: passes asOf and an event id through, capping an event lookup at 10", async () => {
  const calls: SessionEventsQuery[] = [];
  await fetchWorkbenchSessionEvents({
    sessionId: "01ABCDEF0123456789ABCDEF01",
    eventId: "01EVENT",
    asOf: "2026-06-12T10:00:00",
    events: eventsReturning([], calls),
  });
  assertEquals(calls, [{
    sessionId: "01ABCDEF0123456789ABCDEF01",
    eventId: "01EVENT",
    asOf: "2026-06-12T10:00:00",
    limit: 10,
    order: "desc",
  }]);
});

Deno.test("fetchWorkbenchSessionEvents: maps row fields and nulls empty strings", async () => {
  const events = await fetchWorkbenchSessionEvents({
    sessionId: "01ABCDEF0123456789ABCDEF01",
    events: eventsReturning([{
      event_id: "01EVENT",
      event_type: "model_response",
      trace_id: "0123",
      principal_id: "chris",
      model_id: "gemma4:e2b",
      provider: "ollama",
      content: "hello",
      stop_reason: "stop",
      tokens_input: "10",
      tokens_output: "4",
      cost_total: "0.000000",
      created_at: "2026-06-12 10:00:00",
    }]),
  });
  assertObjectMatch({ ...events[0] }, {
    eventType: "model_response",
    modelId: "gemma4:e2b",
    content: "hello",
    tokensInput: 10,
    tokensOutput: 4,
  });
});

Deno.test("fetchWorkbenchSessionEvents: round-trips typed external-runner metadata", async () => {
  const [event] = await fetchWorkbenchSessionEvents({
    sessionId: "01ABCDEF0123456789ABCDEF01",
    events: eventsReturning([{
      event_id: "01RUNNER",
      event_type: "agent_response",
      trace_id: "0123",
      span_id: "runner-span",
      principal_id: "workbench",
      content: "external answer",
      stop_reason: "stop",
      runner_kind: "external_agent",
      runner_profile: "fixture",
      runner_protocol: "acp",
      runner_protocol_version: "1",
      runner_stop_reason: "end_turn",
      runner_external_session_id: "fixture-1",
      runner_agent_name: "dyfj-acp-fixture",
      runner_agent_version: "1.0.0",
      runner_transport: "local_stdio",
      runner_access_route: "local_sidecar",
      runner_cost_basis: "local_free",
      runner_workspace: "/tmp/workspace",
      runner_capabilities: '["sessionCapabilities.close"]',
      runner_evidence_scope: "outer_only",
      runner_route_source: "agent_auth_status",
      runner_auth_type: "chat-gpt",
      permission_verdict: "approved",
      created_at: "2026-08-05 10:00:00",
    }]),
  });
  assertObjectMatch({ ...event }, {
    eventType: "agent_response",
    runnerKind: "external_agent",
    runnerProfile: "fixture",
    runnerProtocol: "acp",
    runnerProtocolVersion: "1",
    runnerStopReason: "end_turn",
    runnerExternalSessionId: "fixture-1",
    runnerTransport: "local_stdio",
    runnerAccessRoute: "local_sidecar",
    runnerCostBasis: "local_free",
    runnerCapabilities: ["sessionCapabilities.close"],
    runnerEvidenceScope: "outer_only",
    runnerRouteSource: "agent_auth_status",
    runnerAuthType: "chat-gpt",
    permissionVerdict: "approved",
  });
});

Deno.test("fetchWorkbenchSessionEvents: returns trace parentage and tool arguments as structured JSON", async () => {
  const [event] = await fetchWorkbenchSessionEvents({
    sessionId: "01ABCDEF0123456789ABCDEF01",
    events: eventsReturning([{
      event_id: "01EVENT",
      event_type: "tool_call",
      trace_id: "0123",
      span_id: "tool-span",
      parent_span_id: "provider-span",
      trace_flags: "1",
      trace_state: "vendor=value",
      span_kind: "client",
      parent_is_remote: "0",
      principal_id: "workbench",
      api: "responses",
      tokens_cache_read: "3",
      tokens_cache_write: "1",
      duration_ms: "25",
      provider_call_order: "2",
      provider_call_purpose: "tool_followup",
      provider_error_class: "",
      tool_arguments: '{"path":"README.md","max":20}',
      created_at: "2026-06-12 10:00:00",
    }]),
  });
  assertObjectMatch({ ...event }, {
    spanId: "tool-span",
    parentSpanId: "provider-span",
    traceFlags: 1,
    traceState: "vendor=value",
    spanKind: "client",
    parentIsRemote: false,
    api: "responses",
    tokensCacheRead: 3,
    tokensCacheWrite: 1,
    durationMs: 25,
    providerCallOrder: 2,
    providerCallPurpose: "tool_followup",
    providerErrorClass: null,
    toolArguments: { path: "README.md", max: 20 },
  });
});

Deno.test("fetchWorkbenchSessionEvents: leaves array-valued tool arguments absent", async () => {
  const [event] = await fetchWorkbenchSessionEvents({
    sessionId: "01ABCDEF0123456789ABCDEF01",
    events: eventsReturning([{
      event_id: "01EVENT",
      event_type: "tool_call",
      trace_id: "0123",
      principal_id: "workbench",
      tool_arguments: "[]",
      created_at: "2026-06-12 10:00:00",
    }]),
  });
  assertStrictEquals(event.toolArguments, null);
});

Deno.test("fetchWorkbenchSessionEvents: maps tool_is_error to a boolean across driver round-trips", async () => {
  // tinyint(1) reaches this mapper as a number (1/0) or a numeric string
  // ("1"/"0") depending on the driver path; a failed tool_call must normalize
  // to boolean true so resume replays it as an error, and absent stays null.
  const rows = [
    { event_id: "e1", event_type: "tool_call", tool_is_error: 1 },
    { event_id: "e2", event_type: "tool_call", tool_is_error: "1" },
    { event_id: "e3", event_type: "tool_call", tool_is_error: 0 },
    { event_id: "e4", event_type: "tool_call", tool_is_error: "0" },
    { event_id: "e5", event_type: "model_response", tool_is_error: null },
  ].map((r) => ({
    trace_id: "0123",
    principal_id: "test-operator",
    created_at: "2026-06-12 10:00:00",
    ...r,
  }));
  const events = await fetchWorkbenchSessionEvents({
    sessionId: "01ABCDEF0123456789ABCDEF01",
    events: eventsReturning(
      rows.slice().reverse() as unknown as Record<string, string>[],
    ),
  });
  assertEquals(events.map((e) => e.toolIsError), [
    true,
    true,
    false,
    false,
    null,
  ]);
});

Deno.test("fetchWorkbenchSessionEvents: rejects invalid limits", async () => {
  await assertRejects(
    () =>
      fetchWorkbenchSessionEvents({
        sessionId: "s1",
        limit: 0,
        events: eventsReturning([]),
      }),
    Error,
    "limit must be a positive integer",
  );

  await assertRejects(
    () =>
      fetchWorkbenchSessionEvents({
        sessionId: "s1",
        limit: -3,
        events: eventsReturning([]),
      }),
    Error,
    "limit must be a positive integer",
  );
});

Deno.test("fetchWorkbenchSessionEvents: preserves explicit descending order", async () => {
  const calls: SessionEventsQuery[] = [];
  const events = await fetchWorkbenchSessionEvents({
    sessionId: "s1",
    limit: 10,
    order: "desc",
    events: eventsReturning([
      {
        event_id: "evt-2",
        event_type: "model_response",
        created_at: "2026-08-15 12:01:00",
      },
      {
        event_id: "evt-1",
        event_type: "session_start",
        created_at: "2026-08-15 12:00:00",
      },
    ], calls),
  });

  assertObjectMatch({ ...calls[0] }, { limit: 10, order: "desc" });
  assertEquals(events.map((e) => e.eventId), ["evt-2", "evt-1"]);
});
