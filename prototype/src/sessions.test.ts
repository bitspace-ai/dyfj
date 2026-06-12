import { describe, expect, test } from "vitest";
import {
  buildConversationContext,
  buildWorkbenchSessionContent,
  buildWorkbenchSessionSlug,
  createProjectWorkbenchSession,
  createWorkbenchSession,
  fetchWorkbenchSessionEvents,
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
    expect(calls[0].params).toEqual([
      "01TESTSESSION00000000000000",
      "workbench-01testsession00000000000000",
      "Workbench Harness Shell",
      "What next?",
      "execute",
      "interactive",
      "initial content",
    ]);
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
      "complete",
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
    phase: "",
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
            project: "dyfj-home",
            updated_at: "2026-06-12 11:00:00",
          }),
        ]),
    });
    expect(groups.map((g) => g.project)).toEqual(["dyfj", "dyfj-home", null]);
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

describe("buildConversationContext", () => {
  const event = (
    eventType: string,
    content: string | null,
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
    createdAt: "2026-06-12 10:00:00",
  });

  test("pairs prompts and responses into a transcript", () => {
    const transcript = buildConversationContext([
      event("session_start", "What is DYFJ?"),
      event("model_response", "A local-first workbench."),
      event("session_end", null),
    ]);
    expect(transcript).toContain("Conversation so far");
    expect(transcript).toContain("Operator: What is DYFJ?");
    expect(transcript).toContain("Assistant: A local-first workbench.");
  });

  test("returns undefined for sessions with no transcript content", () => {
    expect(buildConversationContext([event("session_end", null)]))
      .toBeUndefined();
  });

  test("caps the transcript length", () => {
    const events = Array.from({ length: 50 }, (_, i) => [
      event("session_start", `prompt ${i} ${"x".repeat(400)}`),
      event("model_response", `response ${i} ${"y".repeat(400)}`),
    ]).flat();
    const transcript = buildConversationContext(events, {
      maxTurns: 3,
      maxChars: 1500,
    });
    expect(transcript!.length).toBeLessThan(1700);
    expect(transcript).toContain("response 49");
    expect(transcript).not.toContain("prompt 0 ");
  });
});
