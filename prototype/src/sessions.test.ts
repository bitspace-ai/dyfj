import { describe, expect, test } from "vitest";
import {
  CONVERSATION_SUMMARY_MARKER,
  countTurns,
  formatSummaryMessage,
  partitionForCompression,
  VERBATIM_TAIL_TURNS,
} from "./context-compression";
import {
  buildConversationMessages,
  buildWorkbenchSessionContent,
  buildWorkbenchSessionSlug,
  createProjectWorkbenchSession,
  createWorkbenchSession,
  fetchWorkbenchSessionEvents,
  fetchWorkbenchSessionWorkspace,
  fetchWorkbenchSessionWorkspaceRecord,
  listWorkbenchSessions,
  updateWorkbenchSession,
} from "./sessions";

describe("buildWorkbenchSessionSlug", () => {
  test("derives a stable workbench slug from the session id", () => {
    expect(buildWorkbenchSessionSlug("01ABCDEF0123456789ABCDEF01"))
      .toBe("workbench-01abcdef0123456789abcdef01");
  });
});

describe("buildWorkbenchSessionContent", () => {
  test("captures prompt, mode, trace, context sources, and receipt", () => {
    const content = buildWorkbenchSessionContent({
      mode: "turn",
      prompt: "What next?",
      traceId: "0123456789abcdef0123456789abcdef",
      contextSources: ["AGENTS.md <AGENTS.md>"],
      receipt: "Workbench receipt\nSession: 01TEST",
    });

    expect(content).toContain("# Workbench Session");
    expect(content).toContain("**Mode:** turn");
    expect(content).toContain("**Trace:** 0123456789abcdef0123456789abcdef");
    expect(content).toContain("## Prompt");
    expect(content).toContain("What next?");
    expect(content).toContain("- AGENTS.md <AGENTS.md>");
    expect(content).toContain("## Receipt");
    expect(content).toContain("Workbench receipt");
  });
});

describe("createWorkbenchSession", () => {
  test("inserts an interactive session working view", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];

    await createWorkbenchSession({
      sessionId: "01TESTSESSION00000000000000",
      slug: "workbench-01testsession00000000000000",
      taskDescription: "What next?",
      content: "initial content",
      exec: async (sql, params) => {
        calls.push({ sql, params });
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("INSERT INTO sessions");
    expect(calls[0].sql).toContain("workspace");
    expect(calls[0].params).toEqual([
      "01TESTSESSION00000000000000",
      "workbench-01testsession00000000000000",
      "Workbench Harness Shell",
      "What next?",
      "active",
      "interactive",
      null, // workspace unbound
      "initial content",
    ]);
  });

  test("persists the workspace when bound", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    await createWorkbenchSession({
      sessionId: "01TESTSESSION00000000000000",
      slug: "workbench-01testsession00000000000000",
      taskDescription: "What next?",
      content: "initial content",
      workspace: "/workspace/example-project",
      exec: async (sql, params) => {
        calls.push({ sql, params });
      },
    });
    expect(calls[0].params[6]).toBe("/workspace/example-project");
  });
});

describe("fetchWorkbenchSessionWorkspace", () => {
  test("returns the persisted workspace for a session", async () => {
    const ws = await fetchWorkbenchSessionWorkspace({
      sessionId: "01TESTSESSION00000000000000",
      query: async () => [{ workspace: "/workspace/example-project" }],
    });
    expect(ws).toBe("/workspace/example-project");
  });

  test("returns null when the session has no workspace or does not exist", async () => {
    expect(
      await fetchWorkbenchSessionWorkspace({
        sessionId: "x",
        query: async () => [{ workspace: "" }],
      }),
    ).toBeNull();
    expect(
      await fetchWorkbenchSessionWorkspace({
        sessionId: "x",
        query: async () => [],
      }),
    ).toBeNull();
  });
});

describe("fetchWorkbenchSessionWorkspaceRecord", () => {
  test("distinguishes an existing session without a workspace from a missing session", async () => {
    expect(
      await fetchWorkbenchSessionWorkspaceRecord({
        sessionId: "existing",
        query: async () => [{ workspace: "" }],
      }),
    ).toEqual({ exists: true, workspace: null });
    expect(
      await fetchWorkbenchSessionWorkspaceRecord({
        sessionId: "missing",
        query: async () => [],
      }),
    ).toEqual({ exists: false, workspace: null });
  });
});

describe("updateWorkbenchSession", () => {
  test("marks the session complete with updated content", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];

    await updateWorkbenchSession({
      sessionId: "01TESTSESSION00000000000000",
      content: "final content",
      exec: async (sql, params) => {
        calls.push({ sql, params });
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("UPDATE sessions");
    expect(calls[0].params).toEqual([
      "completed",
      1,
      1,
      "final content",
      "01TESTSESSION00000000000000",
    ]);
  });
});

describe("listWorkbenchSessions", () => {
  const row = (over: Record<string, string>) => ({
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

  test("groups sessions by project with unfiled last", async () => {
    const groups = await listWorkbenchSessions({
      query: () =>
        Promise.resolve([
          row({
            session_id: "01AAAAAAAAAAAAAAAAAAAAAAAB",
            project: "dyfj",
            updated_at: "2026-06-12 12:00:00",
          }),
          row({ session_id: "01AAAAAAAAAAAAAAAAAAAAAAAC", project: "" }),
          row({
            session_id: "01AAAAAAAAAAAAAAAAAAAAAAAD",
            project: "project-b",
            updated_at: "2026-06-12 11:00:00",
          }),
        ]),
    });
    expect(groups.map((g) => g.project)).toEqual(["dyfj", "project-b", null]);
    expect(groups[0].sessions[0].sessionId).toBe("01AAAAAAAAAAAAAAAAAAAAAAAB");
    expect(groups[2].sessions[0].project).toBeNull();
  });

  test("filters by project via SQL parameters", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    await listWorkbenchSessions({
      project: "dyfj",
      query: (sql, params) => {
        calls.push({ sql, params });
        return Promise.resolve([]);
      },
    });
    expect(calls[0].sql).toContain("WHERE project = ?");
    expect(calls[0].params).toEqual(["dyfj"]);
  });
});

describe("createProjectWorkbenchSession", () => {
  test("inserts a project-bound session and returns its identity", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const created = await createProjectWorkbenchSession({
      project: "dyfj",
      taskDescription: "left pane demo",
      sessionId: "01ABCDEF0123456789ABCDEF01",
      exec: (sql, params) => {
        calls.push({ sql, params });
        return Promise.resolve();
      },
    });
    expect(created).toEqual({
      sessionId: "01ABCDEF0123456789ABCDEF01",
      slug: "workbench-01abcdef0123456789abcdef01",
      project: "dyfj",
    });
    expect(calls[0].sql).toContain("INSERT INTO sessions");
    expect(calls[0].params).toContain("dyfj");
    expect(calls[0].params).toContain("left pane demo");
  });

  test("stores a null project when none is given", async () => {
    const calls: Array<{ params: unknown[] }> = [];
    const created = await createProjectWorkbenchSession({
      sessionId: "01ABCDEF0123456789ABCDEF01",
      exec: (_sql, params) => {
        calls.push({ params });
        return Promise.resolve();
      },
    });
    expect(created.project).toBeNull();
    expect(calls[0].params).toContain(null);
  });
});

describe("fetchWorkbenchSessionEvents", () => {
  test("queries events for a session in order", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    await fetchWorkbenchSessionEvents({
      sessionId: "01ABCDEF0123456789ABCDEF01",
      query: (sql, params) => {
        calls.push({ sql, params });
        return Promise.resolve([]);
      },
    });
    expect(calls[0].sql).toContain("WHERE session_id = ?");
    expect(calls[0].sql).toContain(
      "ORDER BY created_at DESC, event_id DESC LIMIT 5000;",
    );
    expect(calls[0].sql).not.toContain("AS OF");
    expect(calls[0].params).toEqual(["01ABCDEF0123456789ABCDEF01"]);
  });

  test("inlines a validated AS OF timestamp", async () => {
    const calls: Array<{ sql: string }> = [];
    await fetchWorkbenchSessionEvents({
      sessionId: "01ABCDEF0123456789ABCDEF01",
      asOf: "2026-06-12T10:00:00",
      query: (sql) => {
        calls.push({ sql });
        return Promise.resolve([]);
      },
    });
    expect(calls[0].sql).toContain("AS OF TIMESTAMP('2026-06-12 10:00:00')");
  });

  test("projects provider-call nulls for an AS OF schema before migration 003", async () => {
    const calls: string[] = [];
    const historicalRow = {
      event_id: "01HISTORICAL",
      event_type: "model_response",
      trace_id: "0123",
      span_id: "historical-span",
      parent_span_id: "",
      principal_id: "workbench",
      model_id: "gemma4",
      provider: "ollama",
      api: "openai-completions",
      content: "historical response",
      stop_reason: "stop",
      tokens_input: "",
      tokens_output: "",
      tokens_cache_read: "",
      tokens_cache_write: "",
      cost_total: "",
      duration_ms: "",
      tool_name: "",
      tool_call_id: "",
      tool_arguments: "",
      tool_result: "",
      tool_is_error: "",
      created_at: "2026-06-12 10:00:00",
    };
    const [event] = await fetchWorkbenchSessionEvents({
      sessionId: "01ABCDEF0123456789ABCDEF01",
      asOf: "2026-06-12 10:00:00",
      query: (sql) => {
        calls.push(sql);
        if (!sql.includes("NULL AS provider_call_order")) {
          return Promise.reject(
            new Error(
              'column "provider_call_order" could not be found in any table in scope',
            ),
          );
        }
        return Promise.resolve([historicalRow]);
      },
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain(
      "provider_call_order, provider_call_purpose, provider_error_class",
    );
    expect(calls[1]).toContain("NULL AS provider_call_order");
    expect(calls[1]).toContain("NULL AS unparsed_tool_call_count");
    expect(calls[1]).toContain("NULL AS trace_flags");
    expect(event).toMatchObject({
      eventId: "01HISTORICAL",
      providerCallOrder: null,
      providerCallPurpose: null,
      providerErrorClass: null,
      unparsedToolCallCount: null,
      unparsedToolCallCountIsLowerBound: null,
      tokensInput: null,
      tokensOutput: null,
    });
  });

  test("projects trace-context nulls for an AS OF schema before migration 007", async () => {
    const calls: string[] = [];
    const [event] = await fetchWorkbenchSessionEvents({
      sessionId: "01ABCDEF0123456789ABCDEF01",
      asOf: "2026-08-11 10:00:00",
      query: (sql) => {
        calls.push(sql);
        if (!sql.includes("NULL AS trace_flags")) {
          return Promise.reject(
            new Error('column "trace_flags" could not be found in any table in scope'),
          );
        }
        return Promise.resolve([{
          event_id: "01PRETRACE",
          event_type: "tool_call",
          trace_id: "0123",
          span_id: "tool-span",
          parent_span_id: "provider-span",
          principal_id: "workbench",
          created_at: "2026-08-11 10:00:00",
        }]);
      },
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("trace_flags, trace_state, span_kind");
    expect(calls[1]).toContain("NULL AS trace_flags");
    expect(event).toMatchObject({
      traceFlags: null,
      traceState: null,
      spanKind: null,
      parentIsRemote: null,
    });
  });

  test("projects unparsed-markup nulls for an AS OF schema before migration 004", async () => {
    const calls: string[] = [];
    const [event] = await fetchWorkbenchSessionEvents({
      sessionId: "01ABCDEF0123456789ABCDEF01",
      asOf: "2026-08-01 10:00:00",
      query: (sql) => {
        calls.push(sql);
        if (!sql.includes("NULL AS unparsed_tool_call_count")) {
          return Promise.reject(
            new Error(
              'column "unparsed_tool_call_count" could not be found in any table in scope',
            ),
          );
        }
        return Promise.resolve([{
          event_id: "01PRE004",
          event_type: "provider_call",
          trace_id: "0123",
          span_id: "provider-span",
          principal_id: "workbench",
          provider_call_order: "1",
          provider_call_purpose: "initial",
          created_at: "2026-08-01 10:00:00",
        }]);
      },
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("provider_call_order, provider_call_purpose");
    expect(calls[1]).toContain("NULL AS unparsed_tool_call_count");
    expect(calls[1]).toContain("NULL AS trace_flags");
    expect(event).toMatchObject({
      providerCallOrder: 1,
      providerCallPurpose: "initial",
      unparsedToolCallCount: null,
      unparsedToolCallCountIsLowerBound: null,
    });
  });

  test("does not retry an AS OF query for an unrelated missing column", async () => {
    const calls: string[] = [];
    const error = new Error(
      'column "tool_name" could not be found in any table in scope',
    );
    await expect(fetchWorkbenchSessionEvents({
      sessionId: "01ABCDEF0123456789ABCDEF01",
      asOf: "2026-06-12 10:00:00",
      query: (sql) => {
        calls.push(sql);
        return Promise.reject(error);
      },
    })).rejects.toThrow(error);
    expect(calls).toHaveLength(1);
  });

  test("retains provider-call fields for a post-migration AS OF query", async () => {
    const calls: string[] = [];
    const [event] = await fetchWorkbenchSessionEvents({
      sessionId: "01ABCDEF0123456789ABCDEF01",
      asOf: "2026-06-12 10:00:00",
      query: (sql) => {
        calls.push(sql);
        return Promise.resolve([{
          event_id: "01POSTMIGRATION",
          event_type: "provider_call",
          trace_id: "0123",
          span_id: "provider-span",
          parent_span_id: "root-span",
          principal_id: "workbench",
          provider_call_order: "2",
          provider_call_purpose: "tool_followup",
          provider_error_class: "",
          unparsed_tool_call_count: "64",
          unparsed_tool_call_count_is_lower_bound: "1",
          created_at: "2026-06-12 10:00:00",
        }]);
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(
      "provider_call_order, provider_call_purpose, provider_error_class",
    );
    expect(event).toMatchObject({
      providerCallOrder: 2,
      providerCallPurpose: "tool_followup",
      providerErrorClass: null,
      unparsedToolCallCount: 64,
      unparsedToolCallCountIsLowerBound: true,
    });
  });

  test("retains migration-005 runner fields when auth evidence is absent", async () => {
    const calls: string[] = [];
    const [event] = await fetchWorkbenchSessionEvents({
      sessionId: "01ABCDEF0123456789ABCDEF01",
      asOf: "2026-08-05 10:00:00",
      query: (sql) => {
        calls.push(sql);
        if (!sql.includes("NULL AS runner_route_source")) {
          return Promise.reject(
            new Error(
              'column "runner_route_source" could not be found in any table in scope',
            ),
          );
        }
        return Promise.resolve([{
          event_id: "01PRE006",
          event_type: "agent_response",
          trace_id: "0123",
          span_id: "runner-span",
          principal_id: "workbench",
          runner_kind: "external_agent",
          runner_profile: "fixture",
          runner_protocol: "acp",
          runner_transport: "local_stdio",
          runner_access_route: "local_sidecar",
          runner_cost_basis: "local_free",
          runner_workspace: "/tmp/workspace",
          runner_capabilities: '["sessionCapabilities.close"]',
          runner_evidence_scope: "outer_only",
          permission_verdict: "approved",
          created_at: "2026-08-05 10:00:00",
        }]);
      },
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("runner_kind, runner_profile");
    expect(calls[1]).toContain("NULL AS runner_route_source");
    expect(event).toMatchObject({
      runnerKind: "external_agent",
      runnerProfile: "fixture",
      runnerAccessRoute: "local_sidecar",
      runnerCostBasis: "local_free",
      runnerRouteSource: null,
      runnerAuthType: null,
    });
  });

  test("rejects a malformed AS OF value before touching SQL", async () => {
    await expect(fetchWorkbenchSessionEvents({
      sessionId: "01ABCDEF0123456789ABCDEF01",
      asOf: "yesterday'); DROP TABLE events;--",
      query: () => Promise.resolve([]),
    })).rejects.toThrow("asOf must be a timestamp");
  });

  test("maps row fields and nulls empty strings", async () => {
    const events = await fetchWorkbenchSessionEvents({
      sessionId: "01ABCDEF0123456789ABCDEF01",
      query: () =>
        Promise.resolve([{
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
    expect(events[0]).toMatchObject({
      eventType: "model_response",
      modelId: "gemma4:e2b",
      content: "hello",
      tokensInput: 10,
      tokensOutput: 4,
    });
  });

  test("round-trips typed external-runner metadata", async () => {
    const queries: string[] = [];
    const [event] = await fetchWorkbenchSessionEvents({
      sessionId: "01ABCDEF0123456789ABCDEF01",
      query: (sql) => {
        queries.push(sql);
        return Promise.resolve([{
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
        }]);
      },
    });
    expect(queries[0]).toContain(
      "CAST(runner_capabilities AS CHAR) AS runner_capabilities",
    );
    expect(event).toMatchObject({
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

  test("returns trace parentage and tool arguments as structured JSON", async () => {
    const [event] = await fetchWorkbenchSessionEvents({
      sessionId: "01ABCDEF0123456789ABCDEF01",
      query: () =>
        Promise.resolve([{
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
    expect(event).toMatchObject({
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

  test("leaves array-valued tool arguments absent", async () => {
    const [event] = await fetchWorkbenchSessionEvents({
      sessionId: "01ABCDEF0123456789ABCDEF01",
      query: () =>
        Promise.resolve([{
          event_id: "01EVENT",
          event_type: "tool_call",
          trace_id: "0123",
          principal_id: "workbench",
          tool_arguments: "[]",
          created_at: "2026-06-12 10:00:00",
        }]),
    });
    expect(event.toolArguments).toBeNull();
  });

  test("maps tool_is_error to a boolean across driver round-trips", async () => {
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
      query: () =>
        Promise.resolve(
          rows.slice().reverse() as unknown as Record<string, string>[],
        ),
    });
    expect(events.map((e) => e.toolIsError)).toEqual([
      true,
      true,
      false,
      false,
      null,
    ]);
  });

  test("preserves persisted tool-history validity instead of normalizing corruption", async () => {
    const valid = {
      event_id: "tool-event",
      event_type: "tool_call",
      trace_id: "trace",
      principal_id: "workbench",
      tool_name: "read_file",
      tool_call_id: "call-1",
      tool_arguments: '{"path":"README.md"}',
      tool_result: "",
      tool_is_error: "0",
      created_at: "2026-06-12 10:00:00",
    };
    const [emptyResult] = await fetchWorkbenchSessionEvents({
      sessionId: "01ABCDEF0123456789ABCDEF01",
      query: () => Promise.resolve([valid]),
    });
    expect(emptyResult.toolHistoryValid).toBe(true);
    expect(buildConversationMessages([emptyResult])).toContainEqual({
      role: "tool",
      toolCallId: "call-1",
      name: "read_file",
      content: "",
    });

    for (
      const corrupted of [
        { ...valid, tool_name: "" },
        { ...valid, tool_call_id: "" },
        { ...valid, tool_arguments: "[]" },
        { ...valid, tool_result: null },
        { ...valid, tool_is_error: "2" },
      ]
    ) {
      const [event] = await fetchWorkbenchSessionEvents({
        sessionId: "01ABCDEF0123456789ABCDEF01",
        query: () =>
          Promise.resolve([
            corrupted as unknown as Record<string, string>,
          ]),
      });
      expect(event.toolHistoryValid).toBe(false);
      expect(() => buildConversationMessages([event])).toThrow(
        "Session contains malformed persisted tool history",
      );
    }
  });
});

describe("buildConversationMessages", () => {
  const event = (
    eventType: string,
    content: string | null,
    tool: {
      name?: string;
      callId?: string;
      arguments?: Record<string, unknown>;
      result?: string;
      isError?: boolean;
      valid?: boolean;
    } = {},
  ) => ({
    eventId: "01E",
    eventType,
    traceId: "t",
    spanId: "s",
    parentSpanId: null,
    traceFlags: null,
    traceState: null,
    spanKind: null,
    parentIsRemote: null,
    principalId: "chris",
    modelId: null,
    provider: null,
    api: null,
    content,
    stopReason: null,
    tokensInput: null,
    tokensOutput: null,
    tokensCacheRead: null,
    tokensCacheWrite: null,
    costTotal: null,
    durationMs: null,
    providerCallOrder: null,
    providerCallPurpose: null,
    providerErrorClass: null,
    unparsedToolCallCount: null,
    unparsedToolCallCountIsLowerBound: null,
    runnerKind: null,
    runnerProfile: null,
    runnerProtocol: null,
    runnerProtocolVersion: null,
    runnerStopReason: null,
    runnerExternalSessionId: null,
    runnerAgentName: null,
    runnerAgentVersion: null,
    runnerTransport: null,
    runnerAccessRoute: null,
    runnerCostBasis: null,
    runnerWorkspace: null,
    runnerCapabilities: null,
    runnerEvidenceScope: null,
    runnerRouteSource: null,
    runnerAuthType: null,
    permissionVerdict: null,
    toolName: tool.name ?? null,
    toolCallId: tool.callId ?? null,
    toolArguments: tool.arguments ?? null,
    toolResult: tool.result ?? null,
    toolIsError: eventType === "tool_call" ? tool.isError ?? false : null,
    toolHistoryValid: eventType === "tool_call" ? tool.valid ?? true : null,
    createdAt: "2026-06-12 10:00:00",
  });

  test("maps prompts to user turns and responses to assistant turns", () => {
    const messages = buildConversationMessages([
      event("session_start", "What is DYFJ?"),
      event("model_response", "A local-first workbench."),
      event("session_end", null),
    ]);
    expect(messages).toEqual([
      { role: "user", content: "What is DYFJ?" },
      { role: "assistant", content: "A local-first workbench." },
    ]);
  });

  test("replays an external-agent response as an assistant turn", () => {
    const messages = buildConversationMessages([
      event("session_start", "delegate this"),
      event("agent_response", "external result"),
    ]);
    expect(messages).toEqual([
      { role: "user", content: "delegate this" },
      { role: "assistant", content: "external result" },
    ]);
  });

  test("refuses a persisted ACP tool-history gap", () => {
    expect(() =>
      buildConversationMessages([
        event("session_start", "run the check"),
        event("tool_call", null, {
          name: "acp.history_unavailable",
          callId: "gap-01",
          arguments: {},
          result: "",
          isError: true,
        }),
      ])
    ).toThrow("Session contains unavailable ACP tool history");
  });

  test("returns an empty array for sessions with no transcript content", () => {
    expect(buildConversationMessages([event("session_end", null)])).toEqual([]);
  });

  test("a context_compressed event replaces the elder turns with the pinned summary", () => {
    const summary = "## Session intent\ncompressed intent";
    const messages = buildConversationMessages([
      event("session_start", "old question one"),
      event("model_response", "old answer one"),
      // One elder turn compressed, nothing retained behind it.
      event(
        "context_compressed",
        JSON.stringify({ summary, turnsRetained: 0 }),
      ),
      event("session_start", "fresh question"),
      event("model_response", "fresh answer"),
    ]);
    // Byte-consistent with what the live session injected: the shared formatter.
    expect(messages[0]).toEqual(formatSummaryMessage(summary));
    expect(messages[0].content).toContain(CONVERSATION_SUMMARY_MARKER);
    // Elder turns are gone; the recent turns after compression remain.
    expect(JSON.stringify(messages)).not.toContain("old question one");
    expect(messages).toContainEqual({
      role: "user",
      content: "fresh question",
    });
    expect(messages).toContainEqual({
      role: "assistant",
      content: "fresh answer",
    });
  });

  test("resume keeps the verbatim tail and current prompt, dropping only elder", () => {
    // Two elder turns, a K=2 verbatim tail, then the current turn: the live path
    // used [summary, tail, current-prompt]; resume must reconstruct the same,
    // not collapse to [summary, answer].
    const summary = "## Session intent\nsummary of the elder turns";
    const messages = buildConversationMessages([
      event("session_start", "elder q1"),
      event("model_response", "elder a1"),
      event("session_start", "elder q2"),
      event("model_response", "elder a2"),
      event("session_start", "tail q1"),
      event("model_response", "tail a1"),
      event("session_start", "tail q2"),
      event("model_response", "tail a2"),
      event("session_start", "the current question"),
      // Two elder turns compressed; the K=2 tail plus the current prompt — three
      // turns — are what the live path kept.
      event(
        "context_compressed",
        JSON.stringify({ summary, turnsRetained: 3 }),
      ),
      event("model_response", "the current answer"),
    ]);
    expect(messages[0].content).toContain(CONVERSATION_SUMMARY_MARKER);
    const s = JSON.stringify(messages);
    expect(s).not.toContain("elder q1");
    expect(s).not.toContain("elder q2");
    expect(messages).toContainEqual({ role: "user", content: "tail q1" });
    expect(messages).toContainEqual({ role: "user", content: "tail q2" });
    expect(messages).toContainEqual({
      role: "user",
      content: "the current question",
    });
    expect(messages).toContainEqual({
      role: "assistant",
      content: "the current answer",
    });
  });

  test("the summary marker survives resume past the recent-turns cap", () => {
    const events = [
      event(
        "context_compressed",
        JSON.stringify({ summary: "pinned summary", turnsRetained: 0 }),
      ),
    ];
    // Far more post-compression turns than maxTurns.
    for (let i = 0; i < 20; i++) {
      events.push(
        event("session_start", `q${i}`),
        event("model_response", `a${i}`),
      );
    }
    const messages = buildConversationMessages(events, { maxTurns: 3 });
    // The pinned summary is still at the head despite 20 following turns...
    expect(messages[0].content).toContain(CONVERSATION_SUMMARY_MARKER);
    // ...and only the most recent 3 turns follow it (summary user + 3 users).
    expect(messages.filter((m) => m.role === "user")).toHaveLength(1 + 3);
    expect(JSON.stringify(messages)).not.toContain("q0");
  });

  test("keeps prior turns when a context_compressed payload is unparseable", () => {
    const messages = buildConversationMessages([
      event("session_start", "keep me"),
      event("context_compressed", "not json"),
    ]);
    expect(messages).toEqual([{ role: "user", content: "keep me" }]);
  });

  test("resumes uncompressed on a payload with no retained count", () => {
    // An event written before the retained count existed carries only the
    // compressed (leading) count, which is meaningless here — replay rebuilds
    // the full history while that count was taken against a capped seed.
    // Applying it would silently drop the wrong turns, so it must fall through
    // the invalid-payload path and resume uncompressed rather than half-apply.
    const messages = buildConversationMessages([
      event("session_start", "elder q"),
      event("model_response", "elder a"),
      event("session_start", "recent q"),
      event(
        "context_compressed",
        JSON.stringify({
          summary: "## Session intent\nold shape",
          turnsCompressed: 1,
        }),
      ),
      event("model_response", "recent a"),
    ]);
    expect(JSON.stringify(messages)).not.toContain(CONVERSATION_SUMMARY_MARKER);
    expect(messages).toEqual([
      { role: "user", content: "elder q" },
      { role: "assistant", content: "elder a" },
      { role: "user", content: "recent q" },
      { role: "assistant", content: "recent a" },
    ]);
  });

  test("resume is byte-identical to the live transcript when history exceeds maxTurns", () => {
    // THE seam regression. The live path seeds from a transcript already capped
    // to the most recent `maxTurns` turns, then compresses within that window;
    // replay rebuilds the FULL history. A leading (compressed) count would mean
    // different things to each side — dropping the oldest turns replay knows
    // about while leaving the summarized ones standing. The retained count is
    // anchored to the tail, which is a suffix of both. This asserts the two
    // paths agree exactly, on a history far longer than the cap.
    const maxTurns = 10;
    const priorEvents = [];
    for (let i = 1; i <= 30; i++) {
      priorEvents.push(
        event("session_start", `question ${i}`),
        event("model_response", `answer ${i}`),
      );
    }

    // ── Live path, exactly as the runtime does it ──
    // buildResume caps the seed to the most recent maxTurns turns (21..30)...
    const seed = buildConversationMessages(priorEvents, { maxTurns });
    expect(countTurns(seed)).toBe(maxTurns);
    // ...and the compressor partitions THAT capped seed.
    const { elder, tail } = partitionForCompression(seed, VERBATIM_TAIL_TURNS);
    expect(countTurns(elder)).toBe(8);
    expect(countTurns(tail)).toBe(2);
    const summary = "## Session intent\nsummary of questions 21-28";
    const liveTranscript = [formatSummaryMessage(summary), ...tail];

    // ── Resume path ──
    const resumed = buildConversationMessages([
      ...priorEvents,
      event(
        "context_compressed",
        JSON.stringify({ summary, turnsRetained: countTurns(tail) }),
      ),
    ], { maxTurns });

    expect(resumed).toEqual(liveTranscript);
    // The summarized turns must not ALSO survive verbatim — the exact corruption
    // a leading count produced (turns 21-28 both summarized and replayed).
    const resumedJson = JSON.stringify(resumed);
    for (const i of [21, 22, 23, 24, 25, 26, 27, 28]) {
      expect(resumedJson).not.toContain(`question ${i}`);
    }
    expect(resumed).toContainEqual({ role: "user", content: "question 29" });
    expect(resumed).toContainEqual({ role: "user", content: "question 30" });
  });

  test("a failed turn (error event, no model_response) rebuilds without a half-turn", () => {
    // e.g. a context-window overflow: the turn fails structured, so the event
    // trail carries the prompt and the error but no model_response. Resume
    // must see the prompt as a plain user turn — no fabricated assistant
    // content — and stay valid for the next turn.
    const messages = buildConversationMessages([
      event("session_start", "What is DYFJ?"),
      event("model_response", "A local-first workbench."),
      event("session_end", null),
      event("session_start", "one more question"),
      event("error", "Context window overflow: ..."),
      event("session_end", null),
    ]);
    expect(messages).toEqual([
      { role: "user", content: "What is DYFJ?" },
      { role: "assistant", content: "A local-first workbench." },
      { role: "user", content: "one more question" },
    ]);
  });

  test("keeps only the most recent maxTurns exchanges, whole turns intact", () => {
    const events = Array.from({ length: 50 }, (_, i) => [
      event("session_start", `prompt ${i}`),
      event("model_response", `response ${i}`),
    ]).flat();
    const messages = buildConversationMessages(events, { maxTurns: 3 });
    // 3 turns => 6 messages, and they are the most recent ones (no truncation).
    expect(messages).toHaveLength(6);
    expect(messages[0]).toEqual({ role: "user", content: "prompt 47" });
    expect(messages.at(-1)).toEqual({
      role: "assistant",
      content: "response 49",
    });
    expect(messages.some((m) => m.content === "prompt 0")).toBe(false);
  });

  test("replays a tool_call event as a paired assistant+tool turn", () => {
    const messages = buildConversationMessages([
      event("session_start", "list the files"),
      event("tool_call", "list_files allowed", {
        name: "list_files",
        callId: "call_1",
        arguments: { path: "." },
        result: "README.md\nsrc/",
      }),
      event("model_response", "There are two entries."),
    ]);
    expect(messages).toEqual([
      { role: "user", content: "list the files" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call_1", name: "list_files", arguments: { path: "." } },
        ],
      },
      {
        role: "tool",
        toolCallId: "call_1",
        name: "list_files",
        content: "README.md\nsrc/",
      },
      { role: "assistant", content: "There are two entries." },
    ]);
    // The tool message is immediately preceded by an assistant carrying the
    // same id — the wire-format pairing invariant.
    const toolIdx = messages.findIndex((m) => m.role === "tool");
    const prior = messages[toolIdx - 1];
    expect(prior.role).toBe("assistant");
    expect(prior.role === "assistant" && prior.toolCalls?.[0]?.id).toBe(
      "call_1",
    );
  });

  test("replays a failed tool_call with its error mark intact", () => {
    // A resumed transcript must serialize a failed result as an error
    // (Anthropic is_error) exactly like the live turn did — otherwise resume
    // silently reclassifies corrective feedback as ordinary tool output.
    const messages = buildConversationMessages([
      event("session_start", "read the friction log"),
      event("tool_call", "read_file denied: invalid arguments", {
        name: "read_file",
        callId: "call_bad",
        arguments: {},
        result:
          "invalid arguments for read_file: missing required argument: path",
        isError: true,
      }),
      event("model_response", "Retrying with a path."),
    ]);
    expect(messages).toContainEqual({
      role: "tool",
      toolCallId: "call_bad",
      name: "read_file",
      content:
        "invalid arguments for read_file: missing required argument: path",
      isError: true,
    });
    // A successful replayed result stays unmarked (absent, not false).
    const ok = buildConversationMessages([
      event("session_start", "list"),
      event("tool_call", "list_files allowed", {
        name: "list_files",
        callId: "call_ok",
        arguments: {},
        result: "README.md",
      }),
    ]);
    const okTool = ok.find((m) => m.role === "tool");
    expect(okTool && "isError" in okTool).toBe(false);
  });

  test("truncation never orphans a tool result from its call", () => {
    // Two turns, each: user -> tool call+result -> assistant. maxTurns=1 must
    // keep the whole most-recent turn (user + assistant-with-toolcall + tool +
    // assistant), never start the window on the dangling tool message.
    const turn = (i: number) => [
      event("session_start", `prompt ${i}`),
      event("tool_call", "list_files allowed", {
        name: "list_files",
        callId: `call_${i}`,
        arguments: {},
        result: `result ${i}`,
      }),
      event("model_response", `response ${i}`),
    ];
    const messages = buildConversationMessages([...turn(0), ...turn(1)], {
      maxTurns: 1,
    });
    expect(messages[0]).toEqual({ role: "user", content: "prompt 1" });
    expect(messages.some((m) => m.content === "prompt 0")).toBe(false);
    // First message is a user turn; no leading orphaned tool message.
    expect(messages[0].role).toBe("user");
    const toolMsg = messages.find((m) => m.role === "tool");
    expect(toolMsg && "toolCallId" in toolMsg && toolMsg.toolCallId).toBe(
      "call_1",
    );
  });

  test("fetchWorkbenchSessionEvents rejects invalid limits", async () => {
    await expect(
      fetchWorkbenchSessionEvents({
        sessionId: "s1",
        limit: 0,
        query: async () => [],
      }),
    ).rejects.toThrow("limit must be a positive integer");

    await expect(
      fetchWorkbenchSessionEvents({
        sessionId: "s1",
        limit: -3,
        query: async () => [],
      }),
    ).rejects.toThrow("limit must be a positive integer");
  });

  test("fetchWorkbenchSessionEvents preserves explicit descending order", async () => {
    const executedSql: string[] = [];
    const events = await fetchWorkbenchSessionEvents({
      sessionId: "s1",
      limit: 10,
      order: "desc",
      query: async (sql) => {
        executedSql.push(sql);
        return [
          {
            event_id: "evt-2",
            event_type: "model_response",
            created_at: "2026-08-15 12:01:00",
          } as any,
          {
            event_id: "evt-1",
            event_type: "session_start",
            created_at: "2026-08-15 12:00:00",
          } as any,
        ];
      },
    });

    expect(executedSql[0]).toContain(
      "ORDER BY created_at DESC, event_id DESC LIMIT 10",
    );
    expect(events.map((e) => e.eventId)).toEqual(["evt-2", "evt-1"]);
  });
});
