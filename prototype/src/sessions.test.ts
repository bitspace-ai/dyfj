import { describe, expect, test } from "vitest";
import {
  buildConversationMessages,
  buildWorkbenchSessionContent,
  buildWorkbenchSessionSlug,
  createProjectWorkbenchSession,
  createWorkbenchSession,
  fetchWorkbenchSessionEvents,
  fetchWorkbenchSessionWorkspace,
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
    expect(calls[0].sql).toContain("ORDER BY created_at ASC");
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
});

describe("buildConversationMessages", () => {
  const event = (
    eventType: string,
    content: string | null,
    tool: {
      name?: string;
      callId?: string;
      arguments?: string;
      result?: string;
    } = {},
  ) => ({
    eventId: "01E",
    eventType,
    traceId: "t",
    principalId: "chris",
    modelId: null,
    provider: null,
    content,
    stopReason: null,
    tokensInput: null,
    tokensOutput: null,
    costTotal: null,
    toolName: tool.name ?? null,
    toolCallId: tool.callId ?? null,
    toolArguments: tool.arguments ?? null,
    toolResult: tool.result ?? null,
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

  test("returns an empty array for sessions with no transcript content", () => {
    expect(buildConversationMessages([event("session_end", null)])).toEqual([]);
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
        arguments: '{"path":"."}',
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

  test("truncation never orphans a tool result from its call", () => {
    // Two turns, each: user -> tool call+result -> assistant. maxTurns=1 must
    // keep the whole most-recent turn (user + assistant-with-toolcall + tool +
    // assistant), never start the window on the dangling tool message.
    const turn = (i: number) => [
      event("session_start", `prompt ${i}`),
      event("tool_call", "list_files allowed", {
        name: "list_files",
        callId: `call_${i}`,
        arguments: "{}",
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
});
